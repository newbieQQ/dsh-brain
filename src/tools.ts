/**
 * Agent-facing memory tools.
 *
 * These definitions are hand-written `ToolDefinition` objects rather than
 * `defineTool(...)` calls: `defineTool` only compiles an authoring DSL into the
 * same raw JSON Schema, and importing `@deepseek-ai/dsh-tools` at runtime would
 * risk a second module instance (and a second class identity) inside a linked
 * plugin.
 *
 * Failure contract: `execute` throws and the registry turns that into
 * `isError: true`. A missing token is a normal, explainable failure — never a
 * crash in the host.
 */
import { randomUUID } from 'node:crypto'
import type { CloudClient, MemoryHit } from './api.ts'
import { describeError } from './api.ts'
import type { ToolDefinitionLike } from './context-types.ts'

/** Everything the tools need from the plugin core. */
export interface MemoryToolDeps {
  /** The configured client (rebuilt lazily; settings may change at runtime). */
  client: () => CloudClient
  /** Memory token, or empty when unconfigured. */
  memoryToken: () => string
  /** Effective settings. */
  settings: () => { enabled: boolean; defaultK: number }
}

/** Text block shape the harness renders. */
interface TextBlock {
  type: 'text'
  text: string
}

/** Sectors the service accepts for `metadata.primary_sector`. */
export const SECTORS = ['semantic', 'episodic', 'procedural', 'emotional', 'reflective'] as const

/** Trim a memory body down to a display-sized snippet. */
function snippet(text: string | undefined, limit = 600): string {
  if (typeof text !== 'string') return ''
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}…`
}

/** Project one hit into the compact shape returned to the model. */
function toHitView(hit: MemoryHit): Record<string, unknown> {
  return {
    id: hit.id,
    content: snippet(hit.content),
    tags: hit.tags ?? [],
    project_id: hit.project_id ?? null,
    sector: hit.primary_sector ?? null,
    revision: hit.revision ?? null,
    created_at: hit.created_at ?? null,
  }
}

/** Render any tool value as one JSON text block. */
function renderJson(_args: unknown, value: unknown): TextBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

/** Assert the memory scope is usable, or throw a message the model can act on. */
function requireMemoryToken(deps: MemoryToolDeps): string {
  if (!deps.settings().enabled) {
    throw new Error('云端记忆插件当前已禁用（enabled=false）。请在 /cloud-memory 页面开启后再试。')
  }
  const token = deps.memoryToken()
  if (token === '') {
    throw new Error('未配置记忆令牌。请在 /cloud-memory 页面填入 mem_… 或 cmt_… 记忆令牌（需要 memory:read / memory:write 权限）。')
  }
  return token
}

/** Search stored memories by keyword. */
function searchTool(deps: MemoryToolDeps): ToolDefinitionLike {
  return {
    name: 'memory_search',
    description:
      '在云端长期记忆库中按关键词检索历史记忆片段。返回命中的记忆 id、内容摘要、标签与所属项目；' +
      '需要更多正文时用 memory_read 按 id 取全文。纯关键词匹配，不会做语义相似度检索。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词或短语（必填）。' },
        k: { type: 'integer', description: '最多返回条数，默认取配置值（1..1000）。' },
        project_id: { type: 'string', description: '可选：只在这些项目 id 内检索。' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          total: { type: 'number' },
          search_mode: { type: 'string' },
          matches: { type: 'array', items: { type: 'object' } },
        },
        required: ['query', 'matches'],
        additionalProperties: true,
      },
      render: renderJson,
    },
    async execute(args: Record<string, unknown>): Promise<unknown> {
      requireMemoryToken(deps)
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (query === '') throw new Error('query 不能为空。')
      const requested = typeof args.k === 'number' && Number.isFinite(args.k) ? Math.trunc(args.k) : deps.settings().defaultK
      const k = Math.min(1000, Math.max(1, requested))
      const project = typeof args.project_id === 'string' && args.project_id !== '' ? args.project_id : undefined
      const result = await deps.client().search(query, k, project)
      if (!result.ok) throw new Error(`检索失败：${describeError(result.error)}`)
      const matches = result.data.matches ?? []
      return {
        query,
        total: result.data.total ?? matches.length,
        search_mode: result.data.search_mode ?? 'keyword',
        matches: matches.map(toHitView),
      }
    },
  }
}

/** Read one memory by id. */
function readTool(deps: MemoryToolDeps): ToolDefinitionLike {
  return {
    name: 'memory_read',
    description: '按 id 读取一条云端记忆的完整内容（正文、标签、项目、修订号与时间戳）。id 可先用 memory_search 或 memory_list 获得。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆条目 id（必填）。' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { id: { type: 'string' }, content: { type: 'string' } }, required: ['id'], additionalProperties: true },
      render: renderJson,
    },
    async execute(args: Record<string, unknown>): Promise<unknown> {
      requireMemoryToken(deps)
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      if (id === '') throw new Error('id 不能为空。')
      const result = await deps.client().read(id)
      if (!result.ok) {
        if (result.error.status === 404) throw new Error(`没有找到 id=${id} 的记忆（可能已删除）。`)
        throw new Error(`读取失败：${describeError(result.error)}`)
      }
      return result.data
    },
  }
}

/** Store one new memory. */
function addTool(deps: MemoryToolDeps): ToolDefinitionLike {
  return {
    name: 'memory_add',
    description:
      '向云端长期记忆库写入一条新记忆。content 上限 7000 字节，适合存结论、决策、待办与可复用事实；' +
      '不要写入密钥、令牌或完整源码。写入用 operation_id 保证幂等，重复调用不会产生重复条目。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要长期保存的正文（≤7000 字节）。' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选标签，最多 30 个，每个不超过 100 字符。' },
        project_id: { type: 'string', description: '可选：归属项目 id（≤128 字符）。' },
        sector: { type: 'string', enum: [...SECTORS], description: '可选：记忆分类（semantic/episodic/procedural/emotional/reflective）。' },
        operation_id: { type: 'string', description: '可选：幂等键（uuid）；省略时自动生成。重试同一次写入时请复用同一个值。' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          revision: { type: 'number' },
          remote_saved: { type: 'boolean' },
          state: { type: 'string' },
          operation_id: { type: 'string' },
        },
        required: ['id'],
        additionalProperties: true,
      },
      render: renderJson,
    },
    async execute(args: Record<string, unknown>): Promise<unknown> {
      requireMemoryToken(deps)
      const content = typeof args.content === 'string' ? args.content : ''
      if (content.trim() === '') throw new Error('content 不能为空。')
      const bytes = Buffer.byteLength(content, 'utf8')
      if (bytes > 7000) throw new Error(`content 过大：${bytes} 字节，上限 7000 字节。`)
      const rawTags = Array.isArray(args.tags) ? args.tags : []
      const tags = rawTags.filter((tag): tag is string => typeof tag === 'string' && tag !== '').slice(0, 30)
      const project = typeof args.project_id === 'string' && args.project_id !== '' ? args.project_id : undefined
      const sector = typeof args.sector === 'string' && (SECTORS as readonly string[]).includes(args.sector) ? args.sector : undefined
      const candidate = typeof args.operation_id === 'string' ? args.operation_id.trim() : ''
      const operationId = /^[0-9a-f-]{36}$/i.test(candidate) ? candidate : randomUUID()
      const result = await deps.client().add({ content, tags, project, sector, operationId })
      if (!result.ok) {
        if (result.error.status === 409 && result.error.code === 'storage_not_configured') {
          throw new Error('云端主存储尚未配置（WebDAV），服务端拒绝写入。请先在云端设置里完成存储配置。')
        }
        throw new Error(`写入失败：${describeError(result.error)}`)
      }
      return {
        id: result.data.id,
        revision: result.data.revision,
        remote_saved: result.data.remote_saved,
        state: result.data.state,
        operation_id: result.data.operation_id ?? operationId,
      }
    },
  }
}

/** List recent memories. */
function listTool(deps: MemoryToolDeps): ToolDefinitionLike {
  return {
    name: 'memory_list',
    description: '按时间倒序列出云端记忆（可分页，可按项目过滤）。适合浏览最近保存了什么，再决定是否 memory_read 取全文。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '返回条数，默认 20，上限 100。' },
        offset: { type: 'integer', description: '跳过条数，默认 0。' },
        project_id: { type: 'string', description: '可选：只看某个项目。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { total: { type: 'number' }, items: { type: 'array', items: { type: 'object' } } }, required: ['items'], additionalProperties: true },
      render: renderJson,
    },
    async execute(args: Record<string, unknown>): Promise<unknown> {
      requireMemoryToken(deps)
      const rawLimit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.trunc(args.limit) : 20
      const limit = Math.min(100, Math.max(1, rawLimit))
      const rawOffset = typeof args.offset === 'number' && Number.isFinite(args.offset) ? Math.trunc(args.offset) : 0
      const offset = Math.max(0, rawOffset)
      const project = typeof args.project_id === 'string' && args.project_id !== '' ? args.project_id : undefined
      const result = await deps.client().list({ limit, offset, project })
      if (!result.ok) throw new Error(`列表读取失败：${describeError(result.error)}`)
      const items = result.data.items ?? []
      return { total: result.data.total ?? items.length, items: items.map(toHitView) }
    },
  }
}

/** List projects known to the account. */
function projectsTool(deps: MemoryToolDeps): ToolDefinitionLike {
  return {
    name: 'memory_projects',
    description: '列出云端账号下的记忆项目（project_id 与名称），用于给 memory_add 选择归属项目。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { projects: { type: 'array', items: { type: 'object' } } }, required: ['projects'], additionalProperties: true },
      render: renderJson,
    },
    async execute(): Promise<unknown> {
      requireMemoryToken(deps)
      const result = await deps.client().projects()

      if (!result.ok) throw new Error(`项目列表读取失败：${describeError(result.error)}`)
      return { projects: result.data.projects ?? [] }
    },
  }
}

/** Build every memory tool for one plugin instance. */
export function createMemoryTools(deps: MemoryToolDeps): ToolDefinitionLike[] {
  return [searchTool(deps), readTool(deps), addTool(deps), listTool(deps), projectsTool(deps)]
}

/** List the cloud skill center inventory (skills sync keeps local copies current). */
function skillListTool(deps: MemoryToolDeps): ToolDefinitionLike {
  return {
    name: 'skill_list',
    description: '列出云端技能中心的全部技能（名称、说明、版本）。技能会自动同步到本机技能目录，由 DSH 直接加载；此工具只用于查看云端有哪些技能。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { skills: { type: 'array', items: { type: 'object' } } }, required: ['skills'], additionalProperties: true },
      render: renderJson,
    },
    async execute(): Promise<unknown> {
      requireMemoryToken(deps)
      const result = await deps.client().listSkills()
      if (!result.ok) throw new Error(`技能列表读取失败：${describeError(result.error)}`)
      const skills = (result.data.items ?? []).map((item) => ({
        name: item.name,
        description: item.description ?? '',
        revision: item.revision ?? null,
        files: item.files ?? null,
        enabled: item.enabled ?? true,
      }))
      return { skills }
    },
  }
}

/** Build the skill-facing tools for one plugin instance. */
export function createSkillTools(deps: MemoryToolDeps): ToolDefinitionLike[] {
  return [skillListTool(deps)]
}
