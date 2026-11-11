/**
 * Mnemon Memory Spaces Provider entry for LongMemory.
 *
 * This module is NOT loaded by the dsh-cloud-memory bundle itself. Mnemon's
 * Memory Spaces source mounts it as a child when the user adds it to the
 * source's provider list:
 *
 *   providers:
 *     - use: dsh-cloud-memory/mnemon-provider
 *       instanceId: longmemory
 *
 * Registration is deliberately a user step: until then this file is inert
 * and the rest of the plugin behaves exactly as before.
 */
import {
  MEMORY_SPACE_PROVIDER_API_VERSION,
  defineMemorySpaceProvider,
  defineMemorySpaceProviderDefinition,
} from 'dsh-mnemon-source-memory-spaces/provider-sdk'
import { descriptor } from './descriptor.ts'
import { LongMemoryProvider } from './driver.ts'

export { LongMemoryProvider, descriptor }

/** Keep in sync with the package version (asserted by the verify script). */
const PROVIDER_VERSION = '0.4.1'

export const definition = defineMemorySpaceProviderDefinition({
  manifest: {
    apiVersion: MEMORY_SPACE_PROVIDER_API_VERSION,
    kind: 'provider',
    typeId: descriptor.id,
    packageName: 'dsh-cloud-memory',
    version: PROVIDER_VERSION,
    label: descriptor.label,
    icon: descriptor.icon,
    summary: descriptor.summary,
    origin: descriptor.origin,
    locality: descriptor.kind,
    workspaceBinding: descriptor.workspaceBinding,
    capabilities: descriptor.capabilities,
    fields: descriptor.fields,
    secrets: descriptor.fields.filter((field) => field.input === 'secret').map((field) => field.key),
    scoreSemantics: 'provider-native',
  },
  create: (context) => new LongMemoryProvider(
    context.memorySpaces ?? context.memoryBodies,
    { requestTimeoutMs: context.config.timeoutMs },
  ),
})

export default defineMemorySpaceProvider<undefined>({
  id: descriptor.id,
  apply(ctx, host) {
    host.install(ctx, definition)
  },
})
