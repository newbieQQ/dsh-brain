import type { MemoryProviderDescriptor } from 'dsh-mnemon-source-memory-spaces/provider-sdk'

/**
 * Browser-safe metadata for the LongMemory Provider.
 *
 * The Provider is the Mnemon face of this package: Mnemon keeps the hot,
 * per-turn presence local, while every long-term read and write passes
 * through to the user's own LongMemory service in real time. The cloud
 * store is the source of truth — nothing long-term is mirrored locally.
 */
export const descriptor: MemoryProviderDescriptor = {
  id: 'longmemory',
  label: 'LongMemory',
  icon: {
    kind: 'glyph',
    value: '☁',
  },
  kind: 'remote',
  workspaceBinding: 'provider-global',
  summary: 'Your self-hosted LongMemory service as a live memory space: reads and writes pass through in real time, nothing is mirrored locally.',
  origin: 'third-party',
  capabilities: {
    search: true,
    browse: true,
    graph: false,
    entities: false,
    related: false,
    remember: true,
    link: false,
    forget: false,
    writeMode: 'exact',
    deletionMode: 'unsupported',
  },
  fields: [
    {
      key: 'endpoint',
      label: 'Endpoint',
      scope: 'service',
      input: 'url',
      required: false,
      placeholder: 'https://mem.example.com/api/longmemory',
      help: 'LongMemory base URL. Leave empty to reuse the dsh-cloud-memory settings (cloud-memory.json).',
      normalize: 'trim-trailing-slash',
    },
    {
      key: 'token',
      label: 'Memory token',
      scope: 'service',
      input: 'secret',
      required: false,
      help: 'Scoped memory token (memory:write). Leave empty to reuse the token already configured for dsh-cloud-memory.',
    },
    {
      key: 'projectId',
      label: 'Project ID',
      scope: 'memory',
      input: 'text',
      required: false,
      help: 'LongMemory project this space maps to. Empty means the account-wide default scope.',
    },
  ],
}
