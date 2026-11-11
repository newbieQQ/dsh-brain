/**
 * Settings sidecar: `$DSH_HOME/dsh-brain.json` (pre-rename `cloud-memory.json` is migrated on first load).
 *
 * Why a file and not the DSH credentials service: the desktop profile has no
 * stable host-side credentials face this plugin can depend on (the client-side
 * `remote.credentials` proxy is a browser service), and a missed dependency
 * would silently disable reporting. A 0600-ish file under the user's DSH home
 * directory is the smallest thing that always works; Windows ACLs on
 * `C:\Users\<user>` already restrict it to that account.
 *
 * The file holds the two bearer tokens and the UI-editable overrides. It is
 * NEVER uploaded, never printed, and `describe()` only exposes a mask.
 */
import { existsSync, copyFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { DEFAULT_SETTINGS, isPlaceholderBaseUrl, normalizeBaseUrl, originOf, settingsFromConfig, type Settings } from './config.ts'

/** Persisted document schema. */
export interface PersistedState {
  version: 1
  enabled?: boolean
  baseUrl?: string
  clientId?: string
  requestTimeoutMs?: number
  defaultK?: number
  activityToken?: string
  memoryToken?: string
  summaryEnabled?: boolean
  summaryMaxChars?: number
  summaryToken?: string
}

/** Masked token view handed to the browser. */
export interface TokenView {
  configured: boolean
  masked: string
}

/** Browser-facing settings snapshot (no secrets). */
export interface SettingsView extends Settings {
  activityToken: TokenView
  memoryToken: TokenView
  summaryToken: TokenView
  statePath: string
  /** False when the address is still the packaged placeholder. */
  baseUrlConfigured: boolean
  /** Origin of the effective address, for the change-confirmation UI. */
  baseUrlOrigin: string
}

/** `$DSH_HOME` (or `~/.dsh`) — the same resolution DSH core uses. */
export function dshHome(): string {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv
  return resolve(homedir(), '.dsh')
}

/** Absolute path of the settings sidecar. */
export function settingsPath(): string {
  return resolve(dshHome(), 'dsh-brain.json')
}

/** Pre-rename (<=0.7.x) settings sidecar name. */
export function legacySettingsPath(): string {
  return resolve(dshHome(), 'cloud-memory.json')
}

/**
 * One-time rename carry-over: when `target` does not exist yet but the
 * pre-rename `legacy` file does, copy it over so settings and tokens survive
 * the dsh-cloud-memory -> dsh-brain rename. The legacy file is left in place
 * (never deleted automatically). Returns true when a copy happened.
 */
export function migrateLegacyFile(target: string, legacy: string): boolean {
  try {
    if (target === legacy || existsSync(target) || !existsSync(legacy)) return false
    copyFileSync(legacy, target)
    return true
  } catch {
    return false
  }
}

/** Read a token from an env var (an alternative to the sidecar for CI use). */
function envToken(name: string): string | undefined {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') return undefined
  return value.trim()
}

/** Mask a secret for display: `cmt_abc…9f2c`. */
export function maskToken(token: string): string {
  if (token.length <= 12) return `${token.slice(0, 3)}…`
  return `${token.slice(0, 7)}…${token.slice(-4)}`
}

/** Validate one sidecar field; returns the normalized value or undefined. */
function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Coerce one numeric field into a clamped integer. */
function clampInt(value: unknown, min: number, max: number): number | undefined {
  const numeric = typeof value === 'string' ? Number(value) : value
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return undefined
  return Math.min(max, Math.max(min, Math.trunc(numeric)))
}

/** Parse an on-disk document defensively (a torn file must not break boot). */
function parseState(raw: string): PersistedState {
  try {
    const value: unknown = JSON.parse(raw)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { version: 1 }
    const source = value as Record<string, unknown>
    const state: PersistedState = { version: 1 }
    if (typeof source.enabled === 'boolean') state.enabled = source.enabled
    const baseUrl = normalizeBaseUrl(source.baseUrl)
    if (baseUrl !== undefined) state.baseUrl = baseUrl
    const clientId = cleanString(source.clientId)
    if (clientId !== undefined) state.clientId = clientId.slice(0, 128)
    const requestTimeoutMs = clampInt(source.requestTimeoutMs, 1000, 60_000)
    if (requestTimeoutMs !== undefined) state.requestTimeoutMs = requestTimeoutMs
    const defaultK = clampInt(source.defaultK, 1, 100)
    if (defaultK !== undefined) state.defaultK = defaultK
    const activityToken = cleanString(source.activityToken)
    if (activityToken !== undefined) state.activityToken = activityToken
    const memoryToken = cleanString(source.memoryToken)
    if (memoryToken !== undefined) state.memoryToken = memoryToken
    if (typeof source.summaryEnabled === 'boolean') state.summaryEnabled = source.summaryEnabled
    const summaryMaxChars = clampInt(source.summaryMaxChars, 1000, 16_000)
    if (summaryMaxChars !== undefined) state.summaryMaxChars = summaryMaxChars
    const summaryToken = cleanString(source.summaryToken)
    if (summaryToken !== undefined) state.summaryToken = summaryToken
    return state
  } catch {
    return { version: 1 }
  }
}

/**
 * In-memory + on-disk settings holder.
 *
 * Writes are atomic (tmp file + rename) and best-effort chmod 0600; the reader
 * is tolerant, so one corrupt document degrades to defaults instead of
 * failing the whole plugin activation.
 */
export class SettingsStore {
  private state: PersistedState
  private readonly file: string
  private readonly configDefaults: Settings

  constructor(rawConfig: unknown, file: string = settingsPath()) {
    this.file = file
    if (file === settingsPath()) migrateLegacyFile(file, legacySettingsPath())
    this.configDefaults = { ...DEFAULT_SETTINGS, ...settingsFromConfig(rawConfig) }
    this.state = this.read()
  }

  /** Absolute sidecar path (exposed for the status card). */
  get path(): string {
    return this.file
  }

  private read(): PersistedState {
    try {
      return parseState(readFileSync(this.file, 'utf8'))
    } catch {
      return { version: 1 }
    }
  }

  private write(next: PersistedState): void {
    const directory = dirname(this.file)
    mkdirSync(directory, { recursive: true })
    const temporary = `${this.file}.tmp`
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, this.file)
    try {
      chmodSync(this.file, 0o600)
    } catch {
      // Windows has no POSIX mode bits; the profile ACL is the real boundary.
    }
  }

  /** Effective settings: config defaults, overridden by sidecar values. */
  settings(): Settings {
    const resolved: Settings = { ...this.configDefaults }
    if (this.state.enabled !== undefined) resolved.enabled = this.state.enabled
    if (this.state.baseUrl !== undefined) resolved.baseUrl = this.state.baseUrl
    if (this.state.clientId !== undefined) resolved.clientId = this.state.clientId
    if (this.state.requestTimeoutMs !== undefined) resolved.requestTimeoutMs = this.state.requestTimeoutMs
    if (this.state.defaultK !== undefined) resolved.defaultK = this.state.defaultK
    if (this.state.summaryEnabled !== undefined) resolved.summaryEnabled = this.state.summaryEnabled
    if (this.state.summaryMaxChars !== undefined) resolved.summaryMaxChars = this.state.summaryMaxChars
    return resolved
  }

  /** The activity:write bearer token (sidecar first, env fallback). */
  activityToken(): string {
    return this.state.activityToken ?? envToken('DSH_BRAIN_ACTIVITY_TOKEN') ?? envToken('DSH_CLOUD_MEMORY_ACTIVITY_TOKEN') ?? ''
  }

  /** The memory:read / memory:write bearer token. */
  memoryToken(): string {
    return this.state.memoryToken ?? envToken('DSH_BRAIN_MEMORY_TOKEN') ?? envToken('DSH_CLOUD_MEMORY_MEMORY_TOKEN') ?? ''
  }

  /** The summary:write bearer token (optional; absent disables summaries). */
  summaryToken(): string {
    return this.state.summaryToken ?? envToken('DSH_BRAIN_SUMMARY_TOKEN') ?? envToken('DSH_CLOUD_MEMORY_SUMMARY_TOKEN') ?? ''
  }

  /** Masked snapshot for the browser card. */
  describe(): SettingsView {
    const settings = this.settings()
    const activity = this.activityToken()
    const memory = this.memoryToken()
    const summary = this.summaryToken()
    return {
      ...settings,
      activityToken: { configured: activity !== '', masked: activity === '' ? '' : maskToken(activity) },
      memoryToken: { configured: memory !== '', masked: memory === '' ? '' : maskToken(memory) },
      summaryToken: { configured: summary !== '', masked: summary === '' ? '' : maskToken(summary) },
      statePath: this.file,
      baseUrlConfigured: !isPlaceholderBaseUrl(settings.baseUrl),
      baseUrlOrigin: originOf(settings.baseUrl),
    }
  }

  /**
   * Apply a partial patch from the settings card.
   *
   * Token fields follow "absent means keep": only a non-empty string replaces a
   * stored token, and an explicit boolean `clear*` flag removes one. That way
   * the browser never has to round-trip a secret it cannot read.
   */
  patch(patch: Record<string, unknown>): { ok: boolean; error?: string; clearedTokens?: string[] } {
    const next: PersistedState = { ...this.state }
    const beforeOrigin = originOf(this.settings().baseUrl)
    /** Tokens this very request supplied; they survive an address change. */
    const provided: string[] = []
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') return { ok: false, error: 'enabled must be a boolean' }
      next.enabled = patch.enabled
    }
    if (patch.baseUrl !== undefined) {
      const baseUrl = normalizeBaseUrl(patch.baseUrl)
      if (baseUrl === undefined) return { ok: false, error: 'baseUrl must be an http(s) URL' }
      next.baseUrl = baseUrl
    }
    if (patch.clientId !== undefined) {
      const clientId = cleanString(patch.clientId)
      if (clientId === undefined) return { ok: false, error: 'clientId must be a non-empty string' }
      next.clientId = clientId.slice(0, 128)
    }
    const activityToken = cleanString(patch.activityToken)
    if (activityToken !== undefined) {
      if (!activityToken.startsWith('cmt_')) return { ok: false, error: 'activity token must start with cmt_' }
      next.activityToken = activityToken
      provided.push('activity')
    }
    const memoryToken = cleanString(patch.memoryToken)
    if (memoryToken !== undefined) {
      if (!memoryToken.startsWith('cmt_')) return { ok: false, error: 'memory token must start with cmt_' }
      next.memoryToken = memoryToken
      provided.push('memory')
    }
    if (patch.requestTimeoutMs !== undefined) {
      const requestTimeoutMs = clampInt(patch.requestTimeoutMs, 1000, 60_000)
      if (requestTimeoutMs === undefined) return { ok: false, error: 'requestTimeoutMs must be a number' }
      next.requestTimeoutMs = requestTimeoutMs
    }
    if (patch.defaultK !== undefined) {
      const defaultK = clampInt(patch.defaultK, 1, 100)
      if (defaultK === undefined) return { ok: false, error: 'defaultK must be a number' }
      next.defaultK = defaultK
    }
    if (patch.summaryEnabled !== undefined) {
      if (typeof patch.summaryEnabled !== 'boolean') return { ok: false, error: 'summaryEnabled must be a boolean' }
      next.summaryEnabled = patch.summaryEnabled
    }
    if (patch.summaryMaxChars !== undefined) {
      const summaryMaxChars = clampInt(patch.summaryMaxChars, 1000, 16_000)
      if (summaryMaxChars === undefined) return { ok: false, error: 'summaryMaxChars must be a number' }
      next.summaryMaxChars = summaryMaxChars
    }
    const summaryToken = cleanString(patch.summaryToken)
    if (summaryToken !== undefined) {
      if (!summaryToken.startsWith('cmt_')) return { ok: false, error: 'summary token must start with cmt_' }
      next.summaryToken = summaryToken
      provided.push('summary')
    }
    if (patch.clearSummaryToken === true) delete next.summaryToken
    if (patch.clearActivityToken === true) delete next.activityToken
    if (patch.clearMemoryToken === true) delete next.memoryToken

    // Switching the service origin must not hand the previous service's
    // bearer tokens to the new one: everything this request did not explicitly
    // replace is dropped, and the caller is told so it can ask to re-authenticate.
    const afterOrigin = originOf(next.baseUrl ?? this.configDefaults.baseUrl)
    const clearedTokens: string[] = []
    if (beforeOrigin !== '' && afterOrigin !== '' && beforeOrigin !== afterOrigin) {
      const credentials = [
        ['activity', 'activityToken'],
        ['memory', 'memoryToken'],
        ['summary', 'summaryToken'],
      ] as const
      for (const [label, key] of credentials) {
        if (next[key] === undefined) continue
        if (provided.includes(label)) continue
        delete next[key]
        clearedTokens.push(label)
      }
    }
    this.write(next)
    this.state = next
    return clearedTokens.length === 0 ? { ok: true } : { ok: true, clearedTokens }
  }

  /** File size in bytes, for a "sidecar exists" hint in the card. */
  size(): number | undefined {
    try {
      return statSync(this.file).size
    } catch {
      return undefined
    }
  }
}
