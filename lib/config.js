/**
 * Settings model: the cordis row config supplies defaults, the user-editable
 * sidecar (`$DSH_HOME/dsh-brain.json`) overrides them, and secrets live ONLY
 * in the sidecar. Nothing here ever reaches the conversation or a model context.
 */
/** Defaults written into cordis.patch.yml; also the fallback for missing keys. */
export const DEFAULT_SETTINGS = {
    enabled: true,
    baseUrl: 'https://your-memory-host/api/longmemory',
    clientId: 'dsh-desktop',
    requestTimeoutMs: 5000,
    defaultK: 10,
    summaryEnabled: true,
    summaryMaxChars: 6000,
    skillsSyncEnabled: true,
    skillsDir: '',
};
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 60_000;
/** Trim truncation guard for the free-form identifiers. */
function shortString(value) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    if (trimmed === '')
        return undefined;
    return trimmed.slice(0, 128);
}
/**
 * Normalize a base URL: require http(s), drop trailing slashes and any query.
 * Returns undefined when the input is unusable, so callers can fall back.
 */
export function normalizeBaseUrl(value) {
    if (typeof value !== 'string' || value.trim() === '')
        return undefined;
    try {
        const url = new URL(value.trim());
        if (url.protocol !== 'http:' && url.protocol !== 'https:')
            return undefined;
        return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    }
    catch {
        return undefined;
    }
}
/** Clamp a numeric config value into an integer range, else undefined. */
function boundedInt(value, min, max) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return undefined;
    return Math.min(max, Math.max(min, Math.round(value)));
}
/** Extract the recognized settings from an untrusted row config object. */
export function settingsFromConfig(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        return {};
    const source = raw;
    const result = {};
    if (typeof source.enabled === 'boolean')
        result.enabled = source.enabled;
    const baseUrl = normalizeBaseUrl(source.baseUrl);
    if (baseUrl !== undefined)
        result.baseUrl = baseUrl;
    const clientId = shortString(source.clientId);
    if (clientId !== undefined)
        result.clientId = clientId;
    const timeout = boundedInt(source.requestTimeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
    if (timeout !== undefined)
        result.requestTimeoutMs = timeout;
    const defaultK = boundedInt(source.defaultK, 1, 100);
    if (defaultK !== undefined)
        result.defaultK = defaultK;
    if (typeof source.summaryEnabled === 'boolean')
        result.summaryEnabled = source.summaryEnabled;
    const summaryMaxChars = boundedInt(source.summaryMaxChars, 1000, 16_000);
    if (summaryMaxChars !== undefined)
        result.summaryMaxChars = summaryMaxChars;
    if (typeof source.skillsSyncEnabled === 'boolean')
        result.skillsSyncEnabled = source.skillsSyncEnabled;
    if (typeof source.skillsDir === 'string')
        result.skillsDir = source.skillsDir.trim().slice(0, 512);
    return result;
}
