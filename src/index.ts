/**
 * Plugin entry — host half.
 *
 * Responsibilities:
 * 1. report one activity record per finished conversation round,
 * 2. expose the memory tools to the agent,
 * 3. serve the configuration page under `/cloud-memory`.
 *
 * Everything registers through `ctx.effect(...)` so a plugin reload tears down
 * its routes, timer, listeners, and tools without leftovers.
 */
import { CloudClient } from './api.ts'
import type { CloudMemoryContext, SessionEventLike, SessionLike } from './context-types.ts'
import { Reporter } from './reporter.ts'
import { createRoutes } from './routes.ts'
import { SettingsStore } from './store.ts'
import { createMemoryTools } from './tools.ts'

/** Package name; also the client bundle id. */
export const name = 'dsh-cloud-memory'

/** Services required before `apply` runs. */
export const inject = ['webServer']

/** Version reported by the status card. */
const VERSION = '0.1.0'

/** How often queued reports are retried. */
const RETRY_INTERVAL_MS = 30_000

/** Register the plugin with the host. */
export function apply(ctx: CloudMemoryContext, config: unknown): void {
  const logger = ctx.logger('cloud-memory')
  const store = new SettingsStore(config)
  const settings = () => store.settings()

  // One client per instance; the settings closures keep it live across edits.
  const client = new CloudClient({
    baseUrl: () => settings().baseUrl,
    token: () => store.memoryToken(),
    timeoutMs: () => settings().requestTimeoutMs,
  })

  const reporter = new Reporter({
    client,
    settings: () => ({ enabled: settings().enabled, clientId: settings().clientId }),
    activityToken: () => store.activityToken(),
    summary: () => ({ enabled: settings().summaryEnabled, maxChars: settings().summaryMaxChars }),
    summaryToken: () => store.summaryToken(),
    log: (message) => logger.warn(message),
  })

  // Announce at most once per activation so a missing token is obvious in logs.
  const effective = settings()
  if (!effective.enabled) {
    logger.info('disabled by settings')
  } else if (store.activityToken() === '') {
    logger.warn(`reporting enabled but no activity token; configure one at ${store.path} or open /cloud-memory`)
  } else {
    logger.info(`reporting to ${effective.baseUrl} as ${effective.clientId}`)
  }
  if (effective.summaryEnabled && store.summaryToken() === '') {
    logger.info('turn summaries are enabled but no summary token is configured; nothing will be staged')
  }

  // The host's `Events` map is augmented by @deepseek-ai/dsh-session, which a
  // third-party bundle cannot rely on; bind the listener through a local shape.
  const onEvent = ctx.on as unknown as (
    name: 'session/event',
    listener: (session: SessionLike, event: SessionEventLike) => void,
  ) => () => void

  ctx.effect(
    () => onEvent('session/event', (session, event) => {
      try {
        reporter.handleEvent(session, event)
      } catch (error) {
        logger.warn(`turn event handling failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }),
    'dsh-cloud-memory: turn reporting',
  )

  ctx.inject(['tools'], (toolsCtx) => {
    const tools = (toolsCtx as CloudMemoryContext).tools
    if (tools === undefined) return
    for (const tool of createMemoryTools({
      client: () => client,
      memoryToken: () => store.memoryToken(),
      settings: () => ({ enabled: settings().enabled, defaultK: settings().defaultK }),
    })) {
      toolsCtx.effect(() => tools.register(tool), `dsh-cloud-memory: tool ${tool.name}`)
    }
  })

  const webServer = ctx.webServer
  if (webServer === undefined) {
    logger.warn('webServer service unavailable; the configuration page stays disabled')
  } else {
    const routes = createRoutes({ version: VERSION, store, reporter, client: () => client })
    for (const route of routes) {
      ctx.effect(() => webServer.register(route), `dsh-cloud-memory: route ${route.path}`)
    }
  }

  ctx.effect(() => {
    const timer = setInterval(() => {
      if (store.activityToken() !== '' && settings().enabled) {
        void reporter.flush().catch((error: unknown) => {
          logger.warn(`retry flush failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
    }, RETRY_INTERVAL_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'dsh-cloud-memory: retry timer')
}
