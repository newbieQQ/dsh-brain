/**
 * Structural types for the cordis services this plugin consumes.
 *
 * A third-party plugin resolves outside the DSH monorepo's single cordis
 * instance, so the upstream `declare module` augmentations never reach this
 * Context. Every shape below mirrors only the members this plugin touches;
 * drift is contained to this one file.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'

/** One named webserver route (mirror of the host-webserver WebRoute). */
export interface CloudMemoryWebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse, body?: unknown) => void | Promise<void>
}

/** The webServer service face this plugin uses. */
export interface CloudMemoryWebServer {
  register(route: CloudMemoryWebRoute): () => void
}

/** Minimal tool-definition shape accepted by the host tool registry. */
export interface ToolDefinitionLike {
  name: string
  description: string
  parameters: unknown
  output?: {
    schema: unknown
    render: (args: unknown, value: unknown) => unknown[]
  }
  execute: (args: Record<string, unknown>, exec?: unknown) => Promise<unknown>
}

/** The host tool registry face this plugin uses. */
export interface ToolRegistryLike {
  register(definition: ToolDefinitionLike): () => void
}

/** Cordis Context augmented with the services this plugin needs. */
export interface CloudMemoryContext extends Context {
  webServer?: CloudMemoryWebServer
  tools?: ToolRegistryLike
}

/** The session object as far as turn reporting is concerned. */
export interface SessionLike {
  id?: string
  sessionId?: string
}

/** One `session/event` payload. */
export interface SessionEventLike {
  type?: string
  seq?: number
  time?: number | string
  data?: Record<string, unknown>
}
