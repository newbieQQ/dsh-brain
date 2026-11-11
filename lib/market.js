/**
 * Skill market providers (P3).
 *
 * A provider answers `search` / `getDetail` / `resolveArtifact` for ONE
 * configured, verified source. The browser half never passes a repository URL:
 * it only names a provider id and an entry id, so no request can make the host
 * fetch an arbitrary address or clone an arbitrary repository.
 *
 * First provider: the Claude Code plugin marketplace manifest that lives at
 * `.claude-plugin/marketplace.json` in a public GitHub repository. That format
 * lists plugins, each with a description and the relative folders of the skills
 * it ships. Installing an entry reuses the same staged plan/commit pipeline as
 * a manual git install, pinned to the commit resolved here.
 */
import { parseSkillFrontmatter } from "./skill-sync.js";
/** Typed failure so routes can map it to a status code. */
export class MarketError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'MarketError';
    }
}
/** Normalize a manifest skill path to a folder name (its basename). */
function folderOf(skillPath) {
    const trimmed = skillPath.replace(/^\.\//, '').replace(/\/+$/, '');
    const parts = trimmed.split('/');
    return parts[parts.length - 1] ?? trimmed;
}
/** Provider over a Claude Code plugin marketplace manifest on GitHub. */
export class ClaudePluginMarketplaceProvider {
    options;
    cache = new Map();
    fetchImpl;
    constructor(options) {
        this.options = options;
        this.fetchImpl = options.fetchImpl ?? fetch;
    }
    info() {
        return {
            id: this.options.id,
            label: this.options.label,
            description: this.options.description,
            source: this.options.repo,
            homepage: this.options.homepage ?? `https://github.com/${this.options.repo}`,
        };
    }
    ref() {
        return this.options.ref ?? 'main';
    }
    timeoutMs() {
        return this.options.timeoutMs ?? 8000;
    }
    rawUrl(path) {
        const clean = path.replace(/^\.\//, '');
        return `https://raw.githubusercontent.com/${this.options.repo}/${encodeURIComponent(this.ref())}/${clean}`;
    }
    async fetchText(url) {
        let response;
        try {
            response = await this.fetchImpl(url, {
                headers: { accept: 'application/json, text/plain, */*', 'user-agent': 'dsh-brain-market' },
                signal: AbortSignal.timeout(this.timeoutMs()),
            });
        }
        catch (error) {
            throw new MarketError('unreachable', `市场来源不可达：${error instanceof Error ? error.message : String(error)}`);
        }
        if (!response.ok) {
            throw new MarketError('http_' + String(response.status), `市场来源返回 HTTP ${response.status}`);
        }
        return response.text();
    }
    async fetchJson(url, ttlMs = 60_000) {
        const hit = this.cache.get(url);
        if (hit !== undefined && Date.now() - hit.at < ttlMs)
            return hit.value;
        const text = await this.fetchText(url);
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch {
            throw new MarketError('invalid_manifest', '市场清单不是合法 JSON。');
        }
        this.cache.set(url, { at: Date.now(), value: parsed });
        return parsed;
    }
    async manifest() {
        const parsed = await this.fetchJson(this.rawUrl('.claude-plugin/marketplace.json'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new MarketError('invalid_manifest', '市场清单结构不正确。');
        }
        return parsed;
    }
    entriesOf(manifest) {
        const list = Array.isArray(manifest.plugins) ? manifest.plugins : [];
        const version = manifest.metadata?.version;
        const author = manifest.owner?.name;
        const entries = [];
        for (const plugin of list) {
            const name = typeof plugin.name === 'string' ? plugin.name : '';
            if (name === '')
                continue;
            const paths = Array.isArray(plugin.skills) ? plugin.skills.filter((p) => typeof p === 'string') : [];
            const entry = {
                id: name,
                providerId: this.options.id,
                name,
                description: typeof plugin.description === 'string' ? plugin.description : '',
                skills: paths.map(folderOf),
                skillPaths: paths,
                sourceRepo: this.options.repo,
                sourceUrl: `https://github.com/${this.options.repo}`,
            };
            if (typeof version === 'string')
                entry.version = version;
            if (typeof author === 'string')
                entry.author = author;
            entries.push(entry);
        }
        return entries;
    }
    async search(query, cursor) {
        const entries = this.entriesOf(await this.manifest());
        const needle = query.trim().toLowerCase();
        const filtered = needle === ''
            ? entries
            : entries.filter((entry) => `${entry.name}\n${entry.description}\n${entry.skills.join(' ')}`.toLowerCase().includes(needle));
        const pageSize = 10;
        const start = Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0;
        const page = filtered.slice(start, start + pageSize);
        const next = start + pageSize < filtered.length ? start + pageSize : undefined;
        return next === undefined ? { entries: page } : { entries: page, nextCursor: next };
    }
    findEntry(manifest, entryId) {
        const entry = this.entriesOf(manifest).find((item) => item.id === entryId);
        if (entry === undefined)
            throw new MarketError('not_found', `市场里没有条目：${entryId}`);
        return entry;
    }
    async getDetail(entryId) {
        const entry = this.findEntry(await this.manifest(), entryId);
        const skillDetails = [];
        // Bound the fan-out: a manifest can list dozens of skills.
        for (const path of entry.skillPaths.slice(0, 24)) {
            const folder = folderOf(path);
            try {
                const markdown = await this.fetchText(this.rawUrl(`${path.replace(/^\.\//, '')}/SKILL.md`));
                const frontmatter = parseSkillFrontmatter(markdown);
                const detail = { folder, path, ok: true };
                if (typeof frontmatter.name === 'string')
                    detail.name = frontmatter.name;
                if (typeof frontmatter.description === 'string')
                    detail.description = frontmatter.description.slice(0, 300);
                skillDetails.push(detail);
            }
            catch {
                skillDetails.push({ folder, path, ok: false });
            }
        }
        return { ...entry, skillDetails, fetchedAt: Date.now() };
    }
    async resolveArtifact(entryId, _version) {
        const entry = this.findEntry(await this.manifest(), entryId);
        let commit;
        try {
            const payload = await this.fetchJson(`https://api.github.com/repos/${this.options.repo}/commits/${encodeURIComponent(this.ref())}`, 30_000);
            if (typeof payload.sha === 'string' && /^[0-9a-f]{7,40}$/i.test(payload.sha))
                commit = payload.sha;
        }
        catch {
            // Rate-limited or offline: fall back to the branch ref; git checkout pins
            // the actual commit at clone time and the install records it.
        }
        const artifact = {
            repoUrl: `https://github.com/${this.options.repo}.git`,
            ref: commit ?? this.ref(),
            folders: entry.skills,
        };
        if (commit !== undefined)
            artifact.commit = commit;
        if (entry.version !== undefined)
            artifact.version = entry.version;
        return artifact;
    }
}
/** A small registry of providers; the browser can only ask for one by id. */
export class MarketService {
    byId = new Map();
    constructor(providers) {
        for (const provider of providers)
            this.byId.set(provider.info().id, provider);
    }
    list() {
        return [...this.byId.values()].map((provider) => provider.info());
    }
    has(providerId) {
        return this.byId.has(providerId);
    }
    get(providerId) {
        const provider = this.byId.get(providerId);
        if (provider === undefined)
            throw new MarketError('unknown_provider', `未知的市场来源：${providerId}`);
        return provider;
    }
    search(providerId, query, cursor) {
        return this.get(providerId).search(query, cursor);
    }
    detail(providerId, entryId) {
        return this.get(providerId).getDetail(entryId);
    }
    resolve(providerId, entryId, version) {
        return this.get(providerId).resolveArtifact(entryId, version);
    }
}
