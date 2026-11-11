/**
 * Skill update & rollback (P3).
 *
 * Works only for skills that carry a `.skill-source.json` provenance record
 * (written by the market / git install pipeline). Nothing here talks to the
 * cloud center: it re-reads the pinned git source, shows a diff, keeps a local
 * backup before touching the folder, and restores that backup on rollback.
 *
 * Safety rules baked in:
 * - the source record is the only thing trusted for a repository URL;
 * - a fresh clone happens in `$DSH_HOME/.dsh-brain-staging` and the copy is
 *   filtered (no `.git`, no symlinks);
 * - a backup is always taken before an update so rollback is possible even
 *   when the update is interrupted;
 * - a repository in-flight sync blocks any write.
 */
import { execFile } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { readSkillSourceRecord, SkillAdminError } from "./skill-admin.js";
import { dshHome } from "./store.js";
/** Where pre-update backups are kept (one folder per skill, one dir per run). */
export function skillBackupsDir() {
    return join(dshHome(), '.dsh-brain-backups');
}
/** Run git and return stdout. */
function git(args, timeoutMs = 120_000) {
    return new Promise((resolvePromise, rejectPromise) => {
        execFile('git', args, { timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => (error ? rejectPromise(error) : resolvePromise(String(stdout))));
    });
}
async function isSymlink(path) {
    return lstat(path).then((s) => s.isSymbolicLink()).catch(() => true);
}
/** Hash every regular file under one directory (skips `.git` and symlinks). */
async function hashTree(dir) {
    const out = new Map();
    const walk = async (sub) => {
        for (const entry of await readdir(join(dir, sub), { withFileTypes: true }).catch(() => [])) {
            if (entry.name === '.git')
                continue;
            const rel = sub === '' ? entry.name : `${sub}/${entry.name}`;
            const abs = join(dir, rel);
            if (entry.isSymbolicLink())
                continue;
            if (entry.isDirectory()) {
                await walk(rel);
                continue;
            }
            if (!entry.isFile())
                continue;
            const buffer = await readFile(abs).catch(() => undefined);
            if (buffer === undefined)
                continue;
            out.set(rel, { path: rel, sha256: createHash('sha256').update(buffer).digest('hex'), bytes: buffer.byteLength });
        }
    };
    await walk('');
    return out;
}
/** A short human bucket for what changed. */
function diffTrees(before, after) {
    const added = [];
    const removed = [];
    const changed = [];
    for (const [path, file] of after) {
        const old = before.get(path);
        if (old === undefined)
            added.push(path);
        else if (old.sha256 !== file.sha256)
            changed.push(path);
    }
    for (const path of before.keys())
        if (!after.has(path))
            removed.push(path);
    added.sort();
    removed.sort();
    changed.sort();
    return { added, removed, changed };
}
/** Copy a skill tree, dropping `.git` and symlinks (same rule as install). */
async function copySkillTree(source, target) {
    await cp(source, target, {
        recursive: true,
        filter: (path) => !path.split(/[\\/]/).includes('.git') && (() => {
            try {
                return !lstatSync(path).isSymbolicLink();
            }
            catch {
                return false;
            }
        })(),
    });
}
export class SkillUpdater {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    backupsRoot() {
        return this.deps.backupsDir?.() ?? skillBackupsDir();
    }
    guard() {
        if (this.deps.syncRunning())
            throw new SkillAdminError('sync_running', '技能同步正在进行，请稍候再试。');
    }
    async find(folder) {
        const found = await this.deps.admin.locate(folder);
        if (found === undefined)
            throw new SkillAdminError('not_found', `没有找到技能：${folder}`);
        const source = await readSkillSourceRecord(found.dir);
        if (source === undefined) {
            throw new SkillAdminError('no_source', `该技能没有来源记录（不是从 Git 或市场安装的），无法更新或回退。`);
        }
        return { dir: found.dir, source };
    }
    /** Clone the pinned source at its latest commit into a scratch directory. */
    async cloneLatest(source) {
        const root = join(dshHome(), '.dsh-brain-staging');
        await mkdir(root, { recursive: true });
        const dir = join(root, `update_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
        try {
            await git(['clone', '--depth', '1', '--no-tags', '--', source.repoUrl, dir]);
            // A commit SHA is a pin, not a moving ref: leave the default-branch head
            // in place so an update check compares against the latest upstream. A
            // branch/tag name is fetched and checked out instead.
            const isSha = /^[0-9a-f]{7,40}$/i.test(source.ref);
            if (!isSha && source.ref !== '') {
                try {
                    await git(['-C', dir, 'fetch', '--depth', '1', 'origin', source.ref]);
                    await git(['-C', dir, 'checkout', '--detach', 'FETCH_HEAD']);
                }
                catch {
                    // Fall back to the default branch head.
                }
            }
        }
        catch (error) {
            await rm(dir, { recursive: true, force: true }).catch(() => { });
            const code = error.code;
            throw new SkillAdminError('git_failed', code === 'ENOENT'
                ? '本机没有 git 命令，无法检查更新。'
                : '无法读取来源仓库（地址不可达、需要登录，或仓库已删除）。');
        }
        const commit = (await git(['-C', dir, 'rev-parse', 'HEAD'], 20_000)).trim();
        return { dir, commit, cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => { }) };
    }
    /** Compare the installed folder against the source's latest commit. */
    async checkUpdate(folderInput) {
        const folder = typeof folderInput === 'string' ? folderInput : '';
        if (folder === '')
            throw new SkillAdminError('invalid_name', '缺少技能目录名。');
        const fetchedAt = Date.now();
        const found = await this.deps.admin.locate(folder);
        if (found === undefined)
            throw new SkillAdminError('not_found', `没有找到技能：${folder}`);
        const source = await readSkillSourceRecord(found.dir);
        if (source === undefined) {
            return { folder, updatable: false, reason: 'no_source', available: false, fetchedAt };
        }
        const clone = await this.cloneLatest(source);
        try {
            if (clone.commit === source.commit) {
                return {
                    folder, updatable: true, available: false, provider: source.provider,
                    repoUrl: source.repoUrl, currentCommit: source.commit, remoteCommit: clone.commit, fetchedAt,
                };
            }
            const remoteDir = source.sourcePath === '' ? clone.dir : resolve(clone.dir, source.sourcePath);
            const before = await hashTree(found.dir);
            const after = await hashTree(remoteDir);
            // The provenance file is ours, not the source's: never show it as removed.
            before.delete('.skill-source.json');
            const diff = diffTrees(before, after);
            return {
                folder, updatable: true, available: true, provider: source.provider,
                repoUrl: source.repoUrl, currentCommit: source.commit, remoteCommit: clone.commit,
                ...diff, fetchedAt,
            };
        }
        finally {
            await clone.cleanup();
        }
    }
    /** Back up the current folder, then replace it with the source's latest. */
    async applyUpdate(folderInput, expectedCommit) {
        this.guard();
        const folder = typeof folderInput === 'string' ? folderInput : '';
        if (folder === '')
            throw new SkillAdminError('invalid_name', '缺少技能目录名。');
        const { dir, source } = await this.find(folder);
        const check = await this.checkUpdate(folder);
        if (!check.available)
            throw new SkillAdminError('up_to_date', '已经是最新版本，无需更新。');
        if (typeof expectedCommit === 'string' && expectedCommit !== '' && check.remoteCommit !== expectedCommit) {
            throw new SkillAdminError('stale_plan', '来源在上次检查后已更新，请重新检查差异再更新。');
        }
        return this.replaceWith(dir, source, { commit: check.remoteCommit ?? source.commit, ref: source.ref });
    }
    /** Restore the most recent pre-update backup. */
    async rollback(folderInput) {
        this.guard();
        const folder = typeof folderInput === 'string' ? folderInput : '';
        if (folder === '')
            throw new SkillAdminError('invalid_name', '缺少技能目录名。');
        const { dir, source } = await this.find(folder);
        const root = join(this.backupsRoot(), folder);
        const entries = (await readdir(root, { withFileTypes: true }).catch(() => []))
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort();
        const latest = entries[entries.length - 1];
        if (latest === undefined)
            throw new SkillAdminError('no_backup', '没有可回退的备份。');
        const backupDir = join(root, latest);
        const restored = await readSkillSourceRecord(backupDir);
        // Restore in place: move the current aside, copy the backup over, then drop
        // the aside copy only after the backup has landed.
        const aside = `${dir}.rollbacking-${Date.now().toString(36)}`;
        await mkdir(join(dir, '..'), { recursive: true });
        await rename(dir, aside);
        try {
            await copySkillTree(backupDir, dir);
        }
        catch (error) {
            await rm(dir, { recursive: true, force: true }).catch(() => { });
            await rename(aside, dir).catch(() => { });
            throw new SkillAdminError('rollback_failed', `回退失败，原目录已尽量还原：${error instanceof Error ? error.message : String(error)}`);
        }
        await rm(aside, { recursive: true, force: true }).catch(() => { });
        this.deps.log(`skill rolled back: ${folder} <- ${latest}`);
        const beforeFiles = await hashTree(backupDir);
        beforeFiles.delete('.skill-source.json');
        const nowFiles = await hashTree(dir);
        nowFiles.delete('.skill-source.json');
        const diff = diffTrees(nowFiles, beforeFiles);
        return {
            folder,
            from: source.commit,
            to: restored?.commit ?? source.commit,
            backup: backupDir,
            ...diff,
        };
    }
    /** Shared write path: backup, copy new tree, rewrite provenance. */
    async replaceWith(dir, source, next) {
        const clone = await this.cloneLatest({ ...source, ref: next.ref });
        let newDir = source.sourcePath === '' ? clone.dir : resolve(clone.dir, source.sourcePath);
        try {
            if (clone.commit !== next.commit) {
                // A different head landed between check and apply: refuse, never guess.
                throw new SkillAdminError('stale_plan', '来源在更新过程中已变化，请重新检查。');
            }
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupDir = join(this.backupsRoot(), this.lastSegment(dir), stamp);
            await mkdir(join(backupDir, '..'), { recursive: true });
            await copySkillTree(dir, backupDir);
            const before = await hashTree(dir);
            const after = await hashTree(newDir);
            const diff = diffTrees(before, after);
            const aside = `${dir}.updating-${Date.now().toString(36)}`;
            await rename(dir, aside);
            try {
                await copySkillTree(newDir, dir);
                await writeFile(join(dir, '.skill-source.json'), `${JSON.stringify({
                    ...source, commit: next.commit, ref: next.ref, installedAt: new Date().toISOString(),
                }, null, 2)}\n`, 'utf8');
            }
            catch (error) {
                await rm(dir, { recursive: true, force: true }).catch(() => { });
                await rename(aside, dir).catch(() => { });
                throw new SkillAdminError('update_failed', `更新失败，原目录已还原：${error instanceof Error ? error.message : String(error)}`);
            }
            await rm(aside, { recursive: true, force: true }).catch(() => { });
            this.deps.log(`skill updated: ${this.lastSegment(dir)} -> ${next.commit}`);
            return { folder: this.lastSegment(dir), from: source.commit, to: next.commit, backup: backupDir, ...diff };
        }
        finally {
            await clone.cleanup();
        }
    }
    lastSegment(path) {
        const parts = path.split(/[\\/]/).filter((part) => part !== '');
        return parts[parts.length - 1] ?? path;
    }
}
