/**
 * Multi-source skill tree.
 *
 * The card groups skills the way the user thinks about them: by the software
 * that owns the directory (DSH, 公共 Agent, Codex, WorkBuddy, …), then by
 * user-defined categories inside that source.
 *
 * Two rules keep this honest:
 *
 * 1. A category is metadata only. Creating, renaming or deleting one never
 *    moves or removes a skill file; deleting a category just sends its skills
 *    back to 未分类. That is what the "分类只记在这个来源里，不移动文件" note
 *    promises, and it is the only reason a delete button is safe here.
 * 2. Only the DSH source is ours to switch. Parking a DSH skill is the same
 *    directory move the rest of the plugin uses. Another software's directory
 *    is never touched: its switch is recorded for this card only and the view
 *    says so, instead of pretending Codex stopped loading something.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { dshHome, migrateLegacyFile } from "./store.js";
const MAX_GROUP_NAME = 40;
const MAX_GROUPS_PER_SOURCE = 40;
/** Sidecar path. */
export function skillGroupsPath() {
    const target = join(dshHome(), 'dsh-brain-skill-groups.json');
    migrateLegacyFile(target, join(dshHome(), 'cloud-memory-skill-groups.json'));
    return target;
}
/**
 * The known sources.
 *
 * A source is listed even when its directory is missing (0 skills, "未安装"),
 * because that is how a user learns the software exists; it is never invented
 * as present.
 */
export function detectSources() {
    const home = homedir();
    return [
        { id: 'dsh', label: 'DSH', root: join(dshHome(), 'skills'), writable: true, manager: 'DSH' },
        {
            id: 'agents',
            label: '公共 Agent',
            root: join(home, '.agents', 'skills'),
            writable: false,
            manager: '公共 Agent 约定目录',
            note: '由使用该目录的各客户端自行加载，本卡只读',
        },
        {
            id: 'codex',
            label: 'Codex',
            root: join(home, '.codex', 'skills'),
            writable: false,
            manager: 'Codex',
            note: '由 Codex 自行加载，本卡不修改它的目录',
        },
        {
            id: 'workbuddy',
            label: 'WorkBuddy',
            root: join(home, '.workbuddy', 'skills'),
            writable: false,
            manager: 'WorkBuddy',
            note: '由 WorkBuddy 自行加载，本卡不修改它的目录',
        },
        {
            id: 'claude',
            label: 'Claude Code',
            root: join(home, '.claude', 'skills'),
            writable: false,
            manager: 'Claude Code',
            note: '由 Claude Code 自行加载，本卡不修改它的目录',
        },
        {
            id: 'opencode',
            label: 'OpenCode',
            root: join(home, '.config', 'opencode', 'skills'),
            writable: false,
            manager: 'OpenCode',
            note: '由 OpenCode 自行加载，本卡不修改它的目录',
        },
    ];
}
function groupId() {
    return `g_${randomUUID().slice(0, 8)}`;
}
/** Trim and bound one user-supplied category name. */
function cleanGroupName(value) {
    const name = typeof value === 'string' ? value.trim() : '';
    if (name === '' || name.length > MAX_GROUP_NAME) {
        throw new SkillGroupError('invalid_name', '分类名需要 1–40 个字符。');
    }
    return name;
}
/** A group failure with a stable code, mapped to an HTTP status by the route. */
export class SkillGroupError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'SkillGroupError';
    }
}
/** Read one skill directory without following links. */
async function readSkill(root, folder) {
    const dir = join(root, folder);
    try {
        const info = statSync(dir);
        if (!info.isDirectory())
            return undefined;
    }
    catch {
        return undefined;
    }
    const markdown = await readFile(join(dir, 'SKILL.md'), 'utf8').catch(() => undefined);
    if (markdown === undefined)
        return undefined;
    const frontmatter = /^---\s*([\s\S]*?)\s*---/.exec(markdown);
    const name = frontmatter === null ? '' : (/^name:\s*(.+)$/m.exec(frontmatter[1] ?? '')?.[1] ?? '').trim();
    const description = frontmatter === null ? '' : (/^description:\s*(.+)$/m.exec(frontmatter[1] ?? '')?.[1] ?? '').trim();
    let files = 0;
    let bytes = 0;
    const walk = async (sub) => {
        if (files > 2000)
            return;
        for (const entry of await readdir(join(dir, sub), { withFileTypes: true }).catch(() => [])) {
            if (entry.name === '.git')
                continue;
            const rel = sub === '' ? entry.name : `${sub}/${entry.name}`;
            if (entry.isDirectory()) {
                await walk(rel);
                continue;
            }
            if (!entry.isFile())
                continue;
            files += 1;
            try {
                bytes += statSync(join(dir, rel)).size;
            }
            catch {
                // A file removed mid-walk only affects the size hint.
            }
        }
    };
    await walk('');
    return {
        folder,
        name: name === '' ? folder : name,
        description: description.slice(0, 300),
        enabled: true,
        enabledEditable: false,
        files,
        bytes,
        inCardDisabled: false,
    };
}
/** List the folders of one source that look like skills. */
async function readSource(root) {
    const skills = [];
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_'))
            continue;
        const skill = await readSkill(root, entry.name);
        if (skill !== undefined)
            skills.push(skill);
    }
    skills.sort((a, b) => (a.folder < b.folder ? -1 : 1));
    return skills;
}
export class SkillGroupManager {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    file() {
        return this.deps.storePath?.() ?? skillGroupsPath();
    }
    read() {
        try {
            const parsed = JSON.parse(readFileSync(this.file(), 'utf8'));
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                const doc = parsed;
                if (doc.sources !== null && typeof doc.sources === 'object')
                    return { version: 1, sources: doc.sources };
            }
        }
        catch {
            // Missing or torn sidecar: start from "everything unassigned".
        }
        return { version: 1, sources: {} };
    }
    write(next) {
        const path = this.file();
        mkdirSync(resolve(path, '..'), { recursive: true });
        const temporary = `${path}.tmp`;
        writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        renameSync(temporary, path);
    }
    source(id) {
        const sourceId = typeof id === 'string' ? id : '';
        const found = this.deps.sources().find((source) => source.id === sourceId);
        if (found === undefined)
            throw new SkillGroupError('unknown_source', `未知来源：${String(id)}`);
        return found;
    }
    /** Skills of one source, with this plugin's own enable state for DSH. */
    async skillsOf(source) {
        if (source.writable) {
            const inventory = await this.deps.admin.list();
            return inventory.skills.map((skill) => ({
                folder: skill.folder,
                name: skill.name,
                description: skill.description,
                enabled: skill.enabled,
                enabledEditable: true,
                files: skill.files,
                bytes: skill.bytes,
                origin: skill.origin,
                ...(skill.revision === undefined ? {} : { revision: skill.revision }),
                inCardDisabled: false,
            }));
        }
        return readSource(source.root);
    }
    /** Everything the tree renders: sources → groups → skills. */
    async overview() {
        const doc = this.read();
        const sources = [];
        for (const source of this.deps.sources()) {
            const skills = await this.skillsOf(source);
            const state = doc.sources[source.id] ?? {};
            const groups = Array.isArray(state.groups) ? state.groups : [];
            const assigned = new Set();
            const views = [];
            for (const group of groups) {
                const members = skills.filter((skill) => group.skills.includes(skill.folder));
                for (const member of members)
                    assigned.add(member.folder);
                const enabled = group.enabled !== false;
                // A group switch is real only where the source is real.
                const cardOnly = !source.writable;
                views.push({
                    id: group.id,
                    name: group.name,
                    enabled,
                    enabledEditable: true,
                    cardOnly,
                    total: members.length,
                    enabledCount: members.filter((skill) => skill.enabled && enabled).length,
                    skills: members.map((skill) => ({ ...skill, enabled: skill.enabled && enabled, inCardDisabled: enabled === false })),
                });
            }
            const rest = skills.filter((skill) => !assigned.has(skill.folder));
            views.push({
                id: 'unassigned',
                name: '未分类',
                // The bucket's own switch is "every skill that has no category": it is
                // on only when all of them are, and switching it parks/restores them
                // one by one like any other group.
                enabled: rest.length === 0 || rest.every((skill) => skill.enabled),
                enabledEditable: rest.length > 0,
                cardOnly: !source.writable,
                total: rest.length,
                enabledCount: rest.filter((skill) => skill.enabled).length,
                skills: rest,
            });
            const sourceEnabled = state.enabled !== false;
            sources.push({
                id: source.id,
                label: source.label,
                root: source.root,
                exists: existsSync(source.root),
                writable: source.writable,
                manager: source.manager,
                ...(source.note === undefined ? {} : { note: source.note }),
                enabled: sourceEnabled,
                enabledEditable: true,
                cardOnly: !source.writable,
                total: skills.length,
                enabledCount: skills.filter((skill) => skill.enabled && sourceEnabled).length,
                groups: views,
            });
        }
        return {
            sources,
            note: '分类只记在这个来源里，不移动文件。只有 DSH 来源的开关会真实启停技能目录；其他软件的目录本卡不修改。',
        };
    }
    /** Create one category inside a source. */
    async createGroup(sourceInput, nameInput) {
        const source = this.source(sourceInput);
        const name = cleanGroupName(nameInput);
        const doc = this.read();
        const state = doc.sources[source.id] ?? {};
        const groups = state.groups ?? [];
        if (groups.length >= MAX_GROUPS_PER_SOURCE)
            throw new SkillGroupError('too_many', `每个来源最多 ${MAX_GROUPS_PER_SOURCE} 个分类。`);
        if (groups.some((group) => group.name === name))
            throw new SkillGroupError('duplicate', `这个来源里已经有分类「${name}」。`);
        const id = groupId();
        doc.sources[source.id] = { ...state, groups: [...groups, { id, name, enabled: true, skills: [] }] };
        this.write(doc);
        this.deps.log?.(`skill category created: ${source.id}/${name}`);
        return { groupId: id, name };
    }
    /** Rename one category; membership and files are untouched. */
    async renameGroup(sourceInput, groupInput, nameInput) {
        const source = this.source(sourceInput);
        const id = typeof groupInput === 'string' ? groupInput : '';
        const name = cleanGroupName(nameInput);
        const doc = this.read();
        const state = doc.sources[source.id] ?? {};
        const groups = state.groups ?? [];
        const target = groups.find((group) => group.id === id);
        if (target === undefined)
            throw new SkillGroupError('not_found', '没有找到这个分类。');
        if (groups.some((group) => group.name === name && group.id !== id)) {
            throw new SkillGroupError('duplicate', `这个来源里已经有分类「${name}」。`);
        }
        target.name = name;
        doc.sources[source.id] = { ...state, groups };
        this.write(doc);
        return { groupId: id, name };
    }
    /**
     * Delete one category. Its skills move back to 未分类; no file is touched,
     * which is why this needs no impact plan of its own.
     */
    async deleteGroup(sourceInput, groupInput) {
        const source = this.source(sourceInput);
        const id = typeof groupInput === 'string' ? groupInput : '';
        const doc = this.read();
        const state = doc.sources[source.id] ?? {};
        const groups = state.groups ?? [];
        const target = groups.find((group) => group.id === id);
        if (target === undefined)
            throw new SkillGroupError('not_found', '没有找到这个分类。');
        doc.sources[source.id] = { ...state, groups: groups.filter((group) => group.id !== id) };
        this.write(doc);
        this.deps.log?.(`skill category removed: ${source.id}/${target.name}`);
        return { groupId: id, released: target.skills.length };
    }
    /** Move skills into (or out of) a category. Membership only. */
    async assign(sourceInput, groupInput, foldersInput) {
        const source = this.source(sourceInput);
        const id = typeof groupInput === 'string' ? groupInput : '';
        const folders = Array.isArray(foldersInput)
            ? foldersInput.filter((value) => typeof value === 'string' && value !== '' && !value.includes('/') && !value.includes('\\'))
            : [];
        const doc = this.read();
        const state = doc.sources[source.id] ?? {};
        const groups = state.groups ?? [];
        if (id === 'unassigned' || folders.length === 0) {
            // Clearing a selection means "back to 未分类" for every other group.
            for (const group of groups)
                group.skills = group.skills.filter((folder) => !folders.includes(folder));
            doc.sources[source.id] = { ...state, groups };
            this.write(doc);
            return { groupId: 'unassigned', members: [] };
        }
        const target = groups.find((group) => group.id === id);
        if (target === undefined)
            throw new SkillGroupError('not_found', '没有找到这个分类。');
        // A skill belongs to at most one category: remove it everywhere else first.
        for (const group of groups) {
            if (group === target)
                continue;
            group.skills = group.skills.filter((folder) => !folders.includes(folder));
        }
        target.skills = [...new Set([...target.skills, ...folders])].sort();
        doc.sources[source.id] = { ...state, groups };
        this.write(doc);
        return { groupId: id, members: target.skills };
    }
    /**
     * Switch one category on or off.
     *
     * DSH groups are really parked or restored, one folder at a time, and a
     * failure leaves the remaining folders untouched. Foreign groups only record
     * the switch here, and the answer says `cardOnly: true`.
     */
    async toggleGroup(sourceInput, groupInput, enabled) {
        const source = this.source(sourceInput);
        const id = typeof groupInput === 'string' ? groupInput : '';
        const doc = this.read();
        const state = doc.sources[source.id] ?? {};
        const groups = state.groups ?? [];
        let targets = [];
        if (id === 'unassigned') {
            // "未分类" is the bucket of everything no category claims; its switch
            // applies to exactly those skills and is not persisted.
            const assigned = new Set(groups.flatMap((group) => group.skills));
            const skills = await this.skillsOf(source);
            targets = skills.filter((skill) => !assigned.has(skill.folder)).map((skill) => skill.folder);
            if (!source.writable)
                return { groupId: id, enabled, cardOnly: true, applied: [], failed: [] };
        }
        else {
            const target = groups.find((group) => group.id === id);
            if (target === undefined)
                throw new SkillGroupError('not_found', '没有找到这个分类。');
            target.enabled = enabled;
            doc.sources[source.id] = { ...state, groups };
            this.write(doc);
            if (!source.writable)
                return { groupId: id, enabled, cardOnly: true, applied: [], failed: [] };
            targets = target.skills;
        }
        const applied = [];
        const failed = [];
        for (const folder of targets) {
            try {
                await this.deps.admin.setEnabled(folder, enabled);
                applied.push(folder);
            }
            catch (failure) {
                failed.push({ folder, reason: failure instanceof Error ? failure.message : String(failure) });
            }
        }
        return { groupId: id, enabled, cardOnly: false, applied, failed };
    }
    /** Switch a whole source. DSH really moves every skill; others record it. */
    async toggleSource(sourceInput, enabled) {
        const source = this.source(sourceInput);
        const doc = this.read();
        const state = doc.sources[source.id] ?? {};
        doc.sources[source.id] = { ...state, enabled };
        this.write(doc);
        if (!source.writable)
            return { sourceId: source.id, enabled, cardOnly: true, applied: 0, failed: [] };
        const skills = await this.skillsOf(source);
        const failed = [];
        let applied = 0;
        for (const skill of skills) {
            try {
                await this.deps.admin.setEnabled(skill.folder, enabled);
                applied += 1;
            }
            catch (failure) {
                failed.push({ folder: skill.folder, reason: failure instanceof Error ? failure.message : String(failure) });
            }
        }
        return { sourceId: source.id, enabled, cardOnly: false, applied, failed };
    }
    /** Open one source directory in the OS file manager (explicit user click). */
    async reveal(sourceInput) {
        const source = this.source(sourceInput);
        if (!existsSync(source.root))
            throw new SkillGroupError('not_found', `${source.label} 的技能目录还不存在：${source.root}`);
        const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
        await new Promise((resolvePromise) => {
            execFile(command, [source.root], { windowsHide: false }, () => resolvePromise());
        });
        return { path: source.root };
    }
}
