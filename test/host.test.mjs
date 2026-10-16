/**
 * Unit test for @local/dsh-plugin-session-delete's host half, run against a
 * throwaway fake DSH_HOME so no real conversation is touched.
 *
 *   node test/host.test.mjs
 */
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = fileURLToPath(new URL('..', import.meta.url))

let passed = 0
const failures = []
function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const root = await mkdtemp(join(tmpdir(), 'dsh-session-delete-test-'))
const project = '--D-AI-Code--'
const sessionDir = (id) => join(root, 'sessions', project, id)
const cacheFile = (id) => join(root, 'storages', 'session_projcache', 'sessions', `${id}.json`)

async function seedSession(id) {
  await mkdir(sessionDir(id), { recursive: true })
  await writeFile(join(sessionDir(id), 'session.v4.jsonl.zstd'), `payload of ${id}`, 'utf8')
  await mkdir(join(root, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  await writeFile(cacheFile(id), '{"title":"x"}', 'utf8')
}

await seedSession('session-gone')
await seedSession('session-current')
await seedSession('session-live')
await seedSession('session-open-idle')
await seedSession('session-agent')
await seedSession('session-purge')

process.env.DSH_HOME = root
process.env.DSH_SESSION_ID = 'session-current'

// Sessions with a RUNNING turn, as the shipped `workspace/session-activity`
// providers would report them (agent registry / jobs / subagents / schedules).
const ACTIVITY = new Map([['session-live', [{ kind: 'agent', items: ['turn-1'] }]]])

const tools = []
const routes = []
const effects = []
// What the plugin asked the workspace registry to do. Archiving is the state
// the sidebar filters on, so it is what makes an OPEN conversation leave the
// list without a DSH restart.
const registryCalls = { archived: [], unarchived: [] }
const ctx = {
  tools: { register: (tool) => (tools.push(tool), () => { tools.splice(tools.indexOf(tool), 1) }) },
  webServer: { register: (route) => (routes.push(route), () => { routes.splice(routes.indexOf(route), 1) }) },
  workspaceRegistry: {
    // Mirrors the durable archive set DSH exposes, so the plugin can tell an
    // archive it created from one that already existed.
    archivedSessionIds: [],
    async archiveSession(sessionId) {
      registryCalls.archived.push(sessionId)
      this.archivedSessionIds.push(sessionId)
    },
    async unarchiveSession(sessionId) {
      registryCalls.unarchived.push(sessionId)
      this.archivedSessionIds = this.archivedSessionIds.filter((id) => id !== sessionId)
    },
  },
  // Cordis runs the effect callback immediately and calls what it returns when
  // the fiber is disposed. The plugin must register here, NOT via `apply`'s
  // return value, which Cordis ignores.
  effect(callback) {
    const cleanup = callback()
    effects.push(cleanup)
    return () => cleanup?.()
  },
  connection: { admit: () => ({ ok: true }) },
  // The exact seam @deepseek-ai/dsh-workspace asks before archiving a session.
  async waterfall(event, payload) {
    if (event !== 'workspace/session-activity') return []
    return ACTIVITY.get(payload.sessionId) ?? []
  },
  // An OPENED-but-idle conversation still has a live agent; it must not block.
  agents: { get: (id) => (id === 'session-open-idle' ? { id } : undefined) },
  get(key) {
    return key === 'agents' ? this.agents : null
  },
}

const mod = await import(pathToFileURL(join(PLUGIN, 'lib', 'index.js')).href)
console.log(`plugin name=${mod.name} inject=${JSON.stringify(mod.inject)}`)
const returned = mod.apply(ctx, {})
check('apply routes cleanup through ctx.effect, not its return value', returned === undefined, String(returned))
const dispose = effects[effects.length - 1]
check('ctx.effect captured the combined cleanup', typeof dispose === 'function', typeof dispose)

check('registers one tool', tools.length === 1, `got ${tools.length}`)
check('tool name is dsh_delete_conversation', tools[0]?.name === 'dsh_delete_conversation', tools[0]?.name)
check('registers one web route', routes.length === 1, `got ${routes.length}`)
check('web route path is the plugin API prefix', routes[0]?.path === '/dsh-session-delete-api', routes[0]?.path)

// ── deletion (default trash mode)
const trashed = await tools[0].execute({ sessionId: 'session-gone' })
check('trash mode reports deleted', trashed.deleted === true, JSON.stringify(trashed))
check('trash mode reports mode=trash', trashed.mode === 'trash', trashed.mode)
check('session directory is gone', !existsSync(sessionDir('session-gone')))
check('session directory landed in trash', existsSync(trashed.trashPath ?? ''), String(trashed.trashPath))
check('trashed payload is intact', (await readFile(join(trashed.trashPath ?? '', 'session.v4.jsonl.zstd'), 'utf8')).startsWith('payload of'))
check('projection cache removed', !existsSync(cacheFile('session-gone')))
check('projectionRemoved flag', trashed.projectionRemoved === true)
check('audit log written', existsSync(join(root, 'plugins', 'dsh-session-delete', 'deleted.jsonl')))
check(
  'audit log records the deletion',
  (await readFile(join(root, 'plugins', 'dsh-session-delete', 'deleted.jsonl'), 'utf8')).includes('session-gone'),
)
// The sidebar renders from the registry's archive set, so archiving is how a
// deleted conversation actually leaves the list while DSH keeps running.
check('deleting archives the conversation', registryCalls.archived.includes('session-gone'), JSON.stringify(registryCalls.archived))
check('the result reports it was archived', trashed.archived === true, JSON.stringify(trashed.archived))
check('the audit log records the archive', (await readFile(join(root, 'plugins', 'dsh-session-delete', 'deleted.jsonl'), 'utf8')).includes('"archived":true'))
check('the success message mentions the sidebar', String(trashed.message).includes('侧边栏'), trashed.message)

// ── guards
const current = await tools[0].execute({ sessionId: 'session-current' })
check('refuses the current session', current.deleted === false && current.reason === 'current-session', JSON.stringify(current))
check('current session survived', existsSync(sessionDir('session-current')))

const live = await tools[0].execute({ sessionId: 'session-live' })
check('refuses a session with a running turn', live.deleted === false && live.reason === 'active', JSON.stringify(live))
check('the refusal names the activity family', String(live.message).includes('agent'), live.message)
check('running session survived', existsSync(sessionDir('session-live')))
check('a refused delete archives nothing', !registryCalls.archived.includes('session-live'), JSON.stringify(registryCalls.archived))

// REGRESSION (user-reported): selecting a conversation used to make it
// undeletable, because the guard enumerated every PERSISTED session. Only the
// activity waterfall decides, so an opened-but-idle conversation is deletable.
const openIdle = await tools[0].execute({ sessionId: 'session-open-idle' })
check('an opened-but-idle conversation is deletable', openIdle.deleted === true, JSON.stringify(openIdle))
check('that conversation left the store', !existsSync(sessionDir('session-open-idle')))

const invalid = await tools[0].execute({ sessionId: '../escape' })
check('refuses a path-traversal id', invalid.deleted === false && invalid.reason === 'invalid-id', JSON.stringify(invalid))

const missing = await tools[0].execute({ sessionId: 'session-nope' })
check('reports not-found', missing.deleted === false && missing.reason === 'not-found', JSON.stringify(missing))

const badMode = await tools[0].execute({ sessionId: 'session-purge', mode: 'shred' })
check('refuses an unknown mode', badMode.deleted === false && badMode.reason === 'invalid-mode', JSON.stringify(badMode))

// ── purge
const purged = await tools[0].execute({ sessionId: 'session-purge', mode: 'purge' })
check('purge reports deleted', purged.deleted === true && purged.mode === 'purge', JSON.stringify(purged))
check('purge leaves no session directory', !existsSync(sessionDir('session-purge')))
check('purge leaves no trash entry', purged.trashPath === null)

// ── HTTP surface (handler invoked directly, no server needed)
function makeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}
function makeRes() {
  return {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status
    },
    end(value) {
      this.body = value
    },
  }
}

async function call(method, route, body) {
  const res = makeRes()
  await routes[0].handler(makeReq(method, `/dsh-session-delete-api/${route}`, body), res)
  return { status: res.status, json: JSON.parse(res.body) }
}

const status = await call('GET', 'status')
check('GET status → 200', status.status === 200, String(status.status))
check('GET status reports ok', status.json.ok === true)
check('GET status counts remaining sessions', status.json.sessionCount === 3, String(status.json.sessionCount))
check('GET status exposes the trash root', typeof status.json.trashRoot === 'string')

const listed = await call('GET', 'sessions')
check('GET sessions → 3 entries', listed.json.sessions?.length === 3, String(listed.json.sessions?.length))
check('GET sessions entries carry ids', typeof listed.json.sessions?.[0]?.sessionId === 'string')

await seedSession('session-http')
const viaHttp = await call('POST', 'delete', { sessionId: 'session-http' })
check('POST delete → ok', viaHttp.json.ok === true, JSON.stringify(viaHttp.json))
check('POST delete removed the directory', !existsSync(sessionDir('session-http')))
check('POST delete removed the projection cache', !existsSync(cacheFile('session-http')))

const unknown = await call('GET', 'nope')
check('unknown route → 404', unknown.status === 404, String(unknown.status))

// ── concurrency: two deletes of one id must not fight over the same files, and
// the loser must not undo the winner's archive of an unrelated state.
await seedSession('session-race')
let releaseArchive
let archiveEntered
const enteredGate = new Promise((resolve) => {
  archiveEntered = resolve
})
const archiveGate = new Promise((resolve) => {
  releaseArchive = resolve
})
const realArchive = ctx.workspaceRegistry.archiveSession
ctx.workspaceRegistry.archiveSession = async function (sessionId) {
  archiveEntered()
  await archiveGate
  return realArchive.call(this, sessionId)
}
const racingFirst = tools[0].execute({ sessionId: 'session-race' })
await enteredGate
const racingSecond = await tools[0].execute({ sessionId: 'session-race' })
check(
  'a second delete of the same id is refused as busy',
  racingSecond.deleted === false && racingSecond.reason === 'busy',
  JSON.stringify(racingSecond),
)
releaseArchive()
const racingResult = await racingFirst
check('the first delete still completes', racingResult.deleted === true, JSON.stringify(racingResult))
ctx.workspaceRegistry.archiveSession = realArchive

// ── a registry that is present but REFUSES the archive must NOT cancel the
// delete. `sessionKnown()` reads the whole store, so one inconsistent log
// anywhere raises for every id — obeying that refusal would make every
// conversation undeletable, exactly the bug this plugin exists to fix. The files
// go, and the caller is told the row may stay.
await seedSession('session-archrefuse')
ctx.workspaceRegistry.archiveSession = async () => {
  const error = new Error('duplicate JSONL session id "x" appears in multiple project directories')
  error.name = 'SessionPersistenceCorruptionError'
  throw error
}
const refusedArchive = await tools[0].execute({ sessionId: 'session-archrefuse' })
check(
  'a refused archive does not cancel the delete',
  refusedArchive.deleted === true && refusedArchive.archived === false,
  JSON.stringify(refusedArchive),
)
check(
  'a refused archive is reported to the caller',
  typeof refusedArchive.archiveError === 'string' &&
    refusedArchive.archiveError.includes('SessionPersistenceCorruptionError'),
  String(refusedArchive.archiveError),
)
check('the refused-archive delete still moved the files', !existsSync(sessionDir('session-archrefuse')))
check(
  'the refusal is visible in the message',
  String(refusedArchive.message).includes('侧边栏'),
  String(refusedArchive.message),
)
ctx.workspaceRegistry.archiveSession = realArchive

// ── a refusal that NAMES activity is reported as activity, from the list the
// registry itself returned. Taking a second look at the waterfall instead could
// come back empty when the activity ended in between, and calling that
// "archive failed" would blame the wrong thing.
await seedSession('session-archactive')
const activeError = new Error('session is active')
activeError.name = 'WorkspaceActiveSessionError'
activeError.activity = [{ kind: 'schedule', items: ['reminder-1'] }]
ctx.workspaceRegistry.archiveSession = async () => {
  throw activeError
}
const activeRefusal = await tools[0].execute({ sessionId: 'session-archactive' })
check(
  'an archive refusal that names activity is reported as activity',
  activeRefusal.deleted === false &&
    activeRefusal.reason === 'active' &&
    String(activeRefusal.message).includes('schedule'),
  JSON.stringify(activeRefusal),
)
check('nothing was deleted when the archive named activity', existsSync(sessionDir('session-archactive')))
ctx.workspaceRegistry.archiveSession = realArchive

// ── a registry that simply does not know the Session must not block the
// removal: there is no row of it to retire either.
await seedSession('session-unknown-id')
const unknownError = new Error('unknown session')
unknownError.name = 'WorkspaceUnknownSessionError'
ctx.workspaceRegistry.archiveSession = async () => {
  throw unknownError
}
const unknownResult = await tools[0].execute({ sessionId: 'session-unknown-id' })
check('an unknown-to-the-registry session is still deletable', unknownResult.deleted === true, JSON.stringify(unknownResult))
check('that delete reports it was not archived', unknownResult.archived === false, JSON.stringify(unknownResult.archived))
ctx.workspaceRegistry.archiveSession = realArchive

// ── one id stored under two project slugs must be removed from both, or the
// copy left behind would put the conversation back in the sidebar.
const secondSlugDir = join(root, 'sessions', '--second-slug--', 'session-dup')
await seedSession('session-dup')
await mkdir(secondSlugDir, { recursive: true })
await writeFile(join(secondSlugDir, 'session.v4.jsonl.zstd'), 'second copy', 'utf8')
const dupResult = await tools[0].execute({ sessionId: 'session-dup' })
check(
  'every stored copy of an id is removed',
  dupResult.deleted === true && !existsSync(sessionDir('session-dup')) && !existsSync(secondSlugDir),
  JSON.stringify(dupResult),
)
const trashEntries = (await readdir(join(root, 'plugins', 'dsh-session-delete', 'trash'))).filter((name) =>
  name.startsWith('session-dup--'),
)
check('each copy gets its own trash entry', trashEntries.length === 2, String(trashEntries.length))

// ── an id that was ALREADY archived before this delete must not be
// un-archived when a later storage step fails.
const trashDirPath = join(root, 'plugins', 'dsh-session-delete', 'trash')
await seedSession('session-preal')
ctx.workspaceRegistry.archivedSessionIds.push('session-preal')
await rm(trashDirPath, { recursive: true, force: true })
await writeFile(trashDirPath, 'not a directory', 'utf8')
const prealResult = await tools[0].execute({ sessionId: 'session-preal' })
check(
  'a failing storage operation still reports io-error',
  prealResult.deleted === false && prealResult.reason === 'io-error',
  JSON.stringify(prealResult),
)
check('a pre-existing archive is left alone', !registryCalls.unarchived.includes('session-preal'), JSON.stringify(registryCalls.unarchived))
ctx.workspaceRegistry.archivedSessionIds = ctx.workspaceRegistry.archivedSessionIds.filter((id) => id !== 'session-preal')
await rm(trashDirPath, { force: true })
await rm(sessionDir('session-preal'), { recursive: true, force: true })

// ── a PARTIAL failure must never pretend nothing happened. Two stored copies,
// the second locked by `withLocked` — so the first copy is destroyed before the
// second fails. The row must NOT be put back, and the failure must reach the
// audit log.
const auditPath = join(root, 'plugins', 'dsh-session-delete', 'deleted.jsonl')
async function lastAuditFor(sessionId) {
  const lines = (await readFile(auditPath, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
  for (const line of lines.reverse()) {
    const entry = JSON.parse(line)
    if (entry.sessionId === sessionId) return entry
  }
  return null
}
const heldCwd = process.cwd()
/**
 * Run `task` while `dir` cannot be removed or renamed, so a storage failure can
 * be injected deterministically in the middle of a multi-directory delete.
 *
 * There is no portable "busy directory": POSIX happily unlinks open files and
 * even a live working directory, so each platform needs its own lock —
 * Windows refuses to remove or rename a live working directory, POSIX refuses
 * both once the parent directory is not writable.
 */
async function withLocked(dir, task) {
  if (process.platform === 'win32') {
    process.chdir(dir)
    try {
      return await task()
    } finally {
      process.chdir(heldCwd)
    }
  }
  const parent = dirname(dir)
  await chmod(parent, 0o500)
  try {
    return await task()
  } finally {
    await chmod(parent, 0o755)
  }
}

await seedSession('session-purge-partial')
const purgeLocked = join(root, 'sessions', '--zz-locked--', 'session-purge-partial')
await mkdir(purgeLocked, { recursive: true })
await writeFile(join(purgeLocked, 'session.v4.jsonl.zstd'), 'locked copy', 'utf8')
const partial = await withLocked(purgeLocked, () =>
  tools[0].execute({ sessionId: 'session-purge-partial', mode: 'purge' }),
)
check(
  'a partial purge reports io-error',
  partial.deleted === false && partial.reason === 'io-error',
  JSON.stringify(partial),
)
check('a partial purge is not reported as restored', partial.restored === false, JSON.stringify(partial))
check('a partial purge names what it destroyed', partial.destroyed?.length === 1, JSON.stringify(partial.destroyed))
check(
  'a partial purge does not put the sidebar row back',
  partial.archived === true && !registryCalls.unarchived.includes('session-purge-partial'),
  JSON.stringify({ archived: partial.archived, unarchived: registryCalls.unarchived }),
)
check(
  'the destroyed copy really is gone and the locked one survives',
  !existsSync(sessionDir('session-purge-partial')) && existsSync(purgeLocked),
)
const partialAudit = await lastAuditFor('session-purge-partial')
check(
  'a failed delete is audited',
  partialAudit?.ok === false && partialAudit?.reason === 'io-error' && partialAudit?.restored === false,
  JSON.stringify(partialAudit),
)
ctx.workspaceRegistry.archivedSessionIds = ctx.workspaceRegistry.archivedSessionIds.filter(
  (id) => id !== 'session-purge-partial',
)
registryCalls.unarchived = registryCalls.unarchived.filter((id) => id !== 'session-purge-partial')

// ── and when the rollback DOES succeed the row comes back: nothing was lost, so
// the archive this delete created must be undone. This is also the only case
// that runs the restore loop with a copy actually moved.
await seedSession('session-restore')
const restoreLocked = join(root, 'sessions', '--zz-locked--', 'session-restore')
await mkdir(restoreLocked, { recursive: true })
await writeFile(join(restoreLocked, 'session.v4.jsonl.zstd'), 'locked copy', 'utf8')
const rolled = await withLocked(restoreLocked, () => tools[0].execute({ sessionId: 'session-restore' }))
check(
  'a fully rolled-back delete reports io-error',
  rolled.deleted === false && rolled.reason === 'io-error',
  JSON.stringify(rolled),
)
check(
  'a fully rolled-back delete says it restored everything',
  rolled.restored === true && rolled.stranded?.length === 0,
  JSON.stringify(rolled),
)
check('the restored copy is back where it was', existsSync(sessionDir('session-restore')))
check(
  'nothing is left behind in trash',
  (await readdir(trashDirPath)).filter((name) => name.startsWith('session-restore--')).length === 0,
)
check(
  'the archive this delete created was rolled back',
  registryCalls.unarchived.includes('session-restore'),
  JSON.stringify(registryCalls.unarchived),
)

// ── guard order: the current conversation is refused by identity even when its
// storage directory is already gone (it used to answer not-found instead).
await rm(sessionDir('session-current'), { recursive: true, force: true })
const currentGone = await tools[0].execute({ sessionId: 'session-current' })
check(
  'the current session is refused by identity without files',
  currentGone.deleted === false && currentGone.reason === 'current-session',
  JSON.stringify(currentGone),
)
await seedSession('session-current')

// ── a delete with no projection cache must still succeed and say so.
await seedSession('session-nocache')
await rm(cacheFile('session-nocache'), { force: true })
const noCache = await tools[0].execute({ sessionId: 'session-nocache' })
check('a delete without a projection cache still succeeds', noCache.deleted === true, JSON.stringify(noCache))
check('projectionRemoved is false when there was no cache', noCache.projectionRemoved === false, JSON.stringify(noCache))

// ── HTTP refusals: an untrusted caller and a malformed body must both be
// rejected without touching the filesystem.
function makeRawReq(method, url, text) {
  const chunks = text === undefined ? [] : [Buffer.from(text, 'utf8')]
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}
const rejectingRoutes = []
mod.apply(
  {
    tools: { register: () => () => {} },
    webServer: { register: (route) => (rejectingRoutes.push(route), () => {}) },
    connection: { admit: () => ({ rejection: { status: 401, message: 'untrusted' } }) },
    get: () => null,
  },
  {},
)
const rejected = makeRes()
await rejectingRoutes[0].handler(
  makeReq('POST', '/dsh-session-delete-api/delete', { sessionId: 'session-live' }),
  rejected,
)
check('an untrusted caller is rejected with 401', rejected.status === 401, String(rejected.status))
check('the rejected request deleted nothing', existsSync(sessionDir('session-live')))

const malformedRoutes = []
mod.apply(
  {
    tools: { register: () => () => {} },
    webServer: { register: (route) => (malformedRoutes.push(route), () => {}) },
    connection: { admit: () => ({ ok: true }) },
    get: () => null,
  },
  {},
)
const malformed = makeRes()
await malformedRoutes[0].handler(
  makeRawReq('POST', '/dsh-session-delete-api/delete', '{not json'),
  malformed,
)
check('a malformed body is reported as 400', malformed.status === 400, String(malformed.status))

// ── fail closed: without the connection service the route must refuse rather
// than serve an unauthenticated delete to anything that reaches the port.
const noAuthTools = []
const noAuthRoutes = []
mod.apply(
  {
    tools: { register: (tool) => (noAuthTools.push(tool), () => {}) },
    webServer: { register: (route) => (noAuthRoutes.push(route), () => {}) },
    get: () => null,
  },
  {},
)
const refused = makeRes()
await noAuthRoutes[0].handler(makeReq('POST', '/dsh-session-delete-api/delete', { sessionId: 'session-live' }), refused)
check('a runtime without connection refuses the route', refused.status === 503, String(refused.status))
check('that refusal deleted nothing', existsSync(sessionDir('session-live')))

// ── graceful degradation: a runtime with no activity waterfall falls back to
// the agent registry instead of guessing that everything is idle.
const degradedTools = []
const ctxNoWaterfall = {
  tools: { register: (tool) => (degradedTools.push(tool), () => {}) },
  webServer: { register: () => () => {} },
  connection: { admit: () => ({ ok: true }) },
  agents: { get: (id) => (id === 'session-agent' ? { id } : undefined) },
  get(key) {
    return key === 'agents' ? this.agents : null
  },
}
mod.apply(ctxNoWaterfall, {})
const degradedTool = degradedTools[0]
check('second apply registered its own tool', degradedTools.length === 1, String(degradedTools.length))
check(
  'a context without ctx.effect still gets a usable cleanup back',
  typeof (mod.apply({ ...ctxNoWaterfall, tools: { register: () => () => {} }, webServer: undefined })) === 'function',
)
const blockedWithoutWaterfall = await degradedTool.execute({ sessionId: 'session-agent' })
check(
  'without the waterfall, a live agent still blocks deletion',
  blockedWithoutWaterfall.deleted === false && blockedWithoutWaterfall.reason === 'active',
  JSON.stringify(blockedWithoutWaterfall),
)
check('that session survived', existsSync(sessionDir('session-agent')))
const allowedWithoutAgents = await degradedTool.execute({ sessionId: 'session-live' })
check(
  'without the waterfall and without an agent, deletion proceeds',
  allowedWithoutAgents.deleted === true,
  JSON.stringify(allowedWithoutAgents),
)
check('without a registry the delete still proceeds, unarchived', allowedWithoutAgents.archived === false, JSON.stringify(allowedWithoutAgents.archived))

// ── archive rollback: a conversation must not stay hidden from the sidebar
// when the storage operation failed and the conversation is still on disk.
const trashDir = join(root, 'plugins', 'dsh-session-delete', 'trash')
await rm(trashDir, { recursive: true, force: true })
await writeFile(trashDir, 'not a directory', 'utf8')
await seedSession('session-io')
const rollback = await tools[0].execute({ sessionId: 'session-io' })
check('a failing storage operation reports io-error', rollback.deleted === false && rollback.reason === 'io-error', JSON.stringify(rollback))
check('the conversation survived the failed delete', existsSync(sessionDir('session-io')))
check('the archive was rolled back', registryCalls.unarchived.includes('session-io'), JSON.stringify(registryCalls.unarchived))
await rm(trashDir, { force: true })

// ── disposal (REGRESSION: the unloaded fiber used to leave a live tool and a
// zombie web route that answered 500 "inactive context" until a restart)
let disposeThrew = false
try {
  dispose()
} catch {
  disposeThrew = true
}
check('dispose does not throw', disposeThrew === false)
check('dispose unregisters the tool', tools.length === 0, `still ${tools.length}`)
check('dispose unregisters the web route', routes.length === 0, `still ${routes.length}`)

await rm(root, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log(`failures: ${failures.join(' | ')}`)
  process.exitCode = 1
}
