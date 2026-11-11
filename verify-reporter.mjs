// Runtime verification for the P0-4 client (turn reporter + CloudClient).
// Runs against the built lib/ output; no DSH host, no network, no real token.
import http from 'node:http'
import { Reporter } from './lib/reporter.js'
import { CloudClient } from './lib/api.js'
import { DEFAULT_SETTINGS, settingsFromConfig } from './lib/config.js'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${detail}`}`)
}

const session = { id: 'conv-1' }
const startEvent = { type: 'turn/start', time: 1_700_000_000_000, data: { turn: 7 } }
const endEvent = { type: 'turn/end', time: 1_700_000_010_000, data: { turn: 7 } }

function reporterWith(client, overrides = {}) {
  return new Reporter({
    client,
    settings: () => ({ enabled: true, clientId: 'dsh-desktop' }),
    activityToken: () => 'cmt_activity_token_for_test',
    summary: () => ({ enabled: false, maxChars: 6000 }),
    summaryToken: () => '',
    log: () => {},
    ...overrides,
  })
}

// ---- 1. Payload shape: exactly six fields, no conversation content ----------
{
  const sent = []
  const client = { reportTurn: async (payload, token) => { sent.push({ payload, token }); return { ok: true, status: 201, data: { recorded: true, duplicate: false } } } }
  const reporter = reporterWith(client)
  reporter.handleEvent(session, startEvent)
  reporter.handleEvent(session, endEvent)
  await new Promise(r => setTimeout(r, 20))
  const payload = sent[0]?.payload
  const keys = payload === undefined ? [] : Object.keys(payload).sort()
  check('payload has exactly 6 fields', JSON.stringify(keys) === JSON.stringify(['client_id', 'completed_at', 'conversation_id', 'started_at', 'status', 'turn_id']), keys.join(','))
  check('payload carries the activity token only', sent[0]?.token === 'cmt_activity_token_for_test')
  check('payload has no chat body/tool/path fields', !keys.some(k => /content|prompt|message|tool|path|text|body/i.test(k)), keys.join(','))
  check('started_at <= completed_at', payload.started_at <= payload.completed_at && payload.status === 'completed', `${payload.started_at}..${payload.completed_at}`)
  check('conversation and turn ids are the contract shape', payload.conversation_id === 'conv-1' && payload.turn_id === 'conv-1:7', payload.turn_id)
}

// ---- 2. Disabled settings never touch the network ---------------------------
{
  let called = 0
  const reporter = reporterWith({ reportTurn: async () => { called += 1; return { ok: true, status: 201, data: {} } } }, { settings: () => ({ enabled: false, clientId: 'dsh-desktop' }) })
  reporter.handleEvent(session, endEvent)
  await new Promise(r => setTimeout(r, 20))
  check('disabled settings skip without sending', called === 0 && reporter.snapshot().skipped === 1)
}

// ---- 3. Missing token never sends -------------------------------------------
{
  let called = 0
  const reporter = reporterWith({ reportTurn: async () => { called += 1; return { ok: true, status: 201, data: {} } } }, { activityToken: () => '' })
  reporter.handleEvent(session, endEvent)
  await new Promise(r => setTimeout(r, 20))
  check('missing activity token skips without sending', called === 0 && reporter.snapshot().skipped === 1)
}

// ---- 4. 4xx (other than 429) is not retried --------------------------------
{
  let called = 0
  const reporter = reporterWith({ reportTurn: async () => { called += 1; return { ok: false, error: { status: 400, code: 'invalid_input', message: 'bad' } } } })
  reporter.handleEvent(session, endEvent)
  await new Promise(r => setTimeout(r, 20))
  const flush = await reporter.flush()
  check('400 is not queued for retry', called === 1 && flush.remaining === 0 && reporter.snapshot().queued === 0, `calls=${called}`)
}

// ---- 5. 503 is queued and retried, then bounded ----------------------------
{
  let calls = 0
  const client = { reportTurn: async () => { calls += 1; return { ok: false, error: { status: 503, code: 'upstream_unavailable', message: 'try later' } } } }
  const reporter = reporterWith(client)
  reporter.handleEvent(session, endEvent)
  await new Promise(r => setTimeout(r, 20))
  check('503 is queued', reporter.snapshot().queued === 1)
  for (let i = 0; i < 10; i += 1) await reporter.flush()
  check('retries are bounded (queue drains after 5 attempts)', reporter.snapshot().queued === 0 && calls === 6, `calls=${calls}`)
}

// ---- 6. Transport timeout is enforced by CloudClient -----------------------
{
  const server = http.createServer((req, res) => { /* never answer */ })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const client = new CloudClient({ baseUrl: () => `http://127.0.0.1:${port}`, token: () => '', timeoutMs: () => 1000 })
  const started = Date.now()
  const result = await client.reportTurn({ client_id: 'c', conversation_id: 'v', turn_id: 'v:1', status: 'completed', started_at: 1, completed_at: 2 }, 'cmt_activity')
  const elapsed = Date.now() - started
  server.close()
  check('timeout aborts the request', result.ok === false && result.error.status === 0, `elapsed=${elapsed}ms code=${result.ok ? '-' : result.error.code}`)
  check('timeout lands near the configured 1s', elapsed >= 900 && elapsed < 3000, `${elapsed}ms`)
}

// ---- 7. Default and configurable timeout settings -------------------------
{
  check('default request timeout is 5s', DEFAULT_SETTINGS.requestTimeoutMs === 5000, String(DEFAULT_SETTINGS.requestTimeoutMs))
  check('config cannot raise timeout beyond 60s', settingsFromConfig({ requestTimeoutMs: 120000 }).requestTimeoutMs === 60000)
  check('config cannot lower timeout below 1s', settingsFromConfig({ requestTimeoutMs: 10 }).requestTimeoutMs === 1000)
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
