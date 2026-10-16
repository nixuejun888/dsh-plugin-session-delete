/**
 * END-TO-END acceptance test against the REAL session store, on ONE real
 * session directory chosen automatically, fully reversible:
 *
 *   1. snapshot the chosen session dir (per-file sha256) and any projection
 *      cache files belonging to it
 *   2. drive the plugin's real `POST /delete` handler with mode=trash
 *   3. assert the dir left the store, landed in trash byte-identically, the
 *      projection cache was dropped and the audit journal recorded the move
 *   4. RESTORE everything (move back + rewrite cache) and assert the store is
 *      byte-identical to step 1 — the restore runs in `finally`, so a failure
 *      still puts the store back
 *
 *   DSH_SESSION_DELETE_E2E=1 DSH_HOME=~/.dsh node test/e2e-real.mjs
 */
import { createHash } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rm, rename, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = fileURLToPath(new URL('..', import.meta.url))
const REAL_HOME = process.env.DSH_HOME?.trim() ?? ''
const SESSIONS = join(REAL_HOME, 'sessions')
const CACHE = join(REAL_HOME, 'storages', 'session_projcache', 'sessions')
const BACKUP = join(tmpdir(), 'dsh-session-delete-e2e-backup')
const CURRENT = process.env.DSH_SESSION_ID?.trim() ?? ''

if (process.env.DSH_SESSION_DELETE_E2E !== '1') {
  console.log('This test drives REAL deletes against your DSH session store.')
  console.log('It restores everything it touches, but it still appends one line to the')
  console.log('real audit journal and leaves one empty trash entry behind.')
  console.log('')
  console.log('  DSH_SESSION_DELETE_E2E=1 DSH_HOME=~/.dsh node test/e2e-real.mjs')
  process.exit(0)
}
if (REAL_HOME === '') {
  console.error('DSH_HOME is not set; point it at your DSH home directory.')
  process.exit(1)
}

process.env.DSH_HOME = REAL_HOME
process.env.DSH_SESSION_ID = CURRENT

const failures = []
function check(label, ok, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}
async function snapshotTree(dir) {
  const out = {}
  async function walk(current, prefix) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const abs = join(current, entry.name)
      const key = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) await walk(abs, key)
      else out[key] = `${(await stat(abs)).size}:${await sha256(abs)}`
    }
  }
  await walk(dir, '')
  return out
}

// ── pick a target: an unowned session dir not in the workspace registry
const registry = JSON.parse(await readFile(join(REAL_HOME, 'storages', 'workspace.json'), 'utf8'))
const owned = new Set()
for (const workspace of Object.values(registry.tables?.workspaces ?? {})) {
  for (const id of workspace.sessionIds ?? []) owned.add(id)
}

const candidates = []
for (const project of await readdir(SESSIONS, { withFileTypes: true })) {
  if (!project.isDirectory()) continue
  for (const session of await readdir(join(SESSIONS, project.name), { withFileTypes: true })) {
    if (!session.isDirectory()) continue
    if (owned.has(session.name) || session.name === CURRENT) continue
    const dir = join(SESSIONS, project.name, session.name)
    const files = await readdir(dir)
    if (!files.some((name) => name.startsWith('session.v'))) continue
    candidates.push({ project: project.name, id: session.name, dir, bytes: (await stat(dir)).size })
  }
}
candidates.sort((a, b) => a.bytes - b.bytes)
const target = candidates[0]
if (!target) throw new Error('no deletable candidate session found')
console.log(`target: ${target.id}\n        ${target.dir}\n        ${target.bytes} B, ${candidates.length} unowned candidates\n`)

// ── 1. snapshot
const before = await snapshotTree(target.dir)
const cacheFiles = (await readdir(CACHE)).filter((name) => name === `${target.id}.json` || name === `session-${target.id}.json` || name === `${target.id.replace(/^session-/, '')}.json`)
await rm(BACKUP, { recursive: true, force: true })
await mkdir(BACKUP, { recursive: true })
for (const name of cacheFiles) await cp(join(CACHE, name), join(BACKUP, name))
console.log(`snapshot: ${Object.keys(before).length} files, ${cacheFiles.length} projection-cache file(s)\n`)

// ── plugin host half. The candidate is deliberately one the workspace registry
// does NOT own: `archiveSession` accepts any Session that still exists ("its
// workspace accounting — or lack of one — is irrelevant"), which is exactly the
// case the live-refresh fix has to cover.
const registryCalls = { archived: [], unarchived: [] }
let dirExistedAtArchive = null
const routes = []
const ctx = {
  tools: { register: () => () => {} },
  webServer: { register: (route) => (routes.push(route), () => {}) },
  connection: { admit: () => ({ ok: true }) },
  workspaceRegistry: {
    archivedSessionIds: [],
    async archiveSession(sessionId) {
      // Archiving must run BEFORE the files move: the registry refuses an
      // unknown id, and the sidebar only drops the row while the Session still
      // exists. Recording the filesystem here is what proves the order.
      dirExistedAtArchive = existsSync(target.dir)
      registryCalls.archived.push(sessionId)
      this.archivedSessionIds.push(sessionId)
    },
    async unarchiveSession(sessionId) {
      registryCalls.unarchived.push(sessionId)
      this.archivedSessionIds = this.archivedSessionIds.filter((id) => id !== sessionId)
    },
  },
  sessions: { async list() { return [] } },
  get() { return null },
}
const mod = await import(pathToFileURL(join(PLUGIN, 'lib', 'index.js')).href)
mod.apply(ctx, {})
const route = routes[0]

function body(payload) {
  const text = JSON.stringify(payload)
  return { method: 'POST', url: '/dsh-session-delete-api/delete', headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield Buffer.from(text) } }
}
function makeRes() {
  return {
    status: 0,
    body: '',
    writeHead(status) { this.status = status },
    end(value) { this.body = value },
  }
}
async function post(payload) {
  const res = makeRes()
  await route.handler(body(payload), res)
  return { status: res.status, json: JSON.parse(res.body) }
}

const trashRoot = join(REAL_HOME, 'plugins', 'dsh-session-delete', 'trash')
let movedTo = null
try {
  // ── 2. delete for real (mode=trash is the default)
  const response = await post({ sessionId: target.id, mode: 'trash' })
  console.log(`POST /delete → ${response.status} ${JSON.stringify(response.json)}\n`)
  check('delete succeeded', response.status === 200 && response.json.ok === true, JSON.stringify(response.json))

  // ── the live-refresh step: without it a conversation that is still open in
  // the host's memory keeps its sidebar row until DSH restarts.
  check('the delete archived the conversation', response.json.result?.archived === true, JSON.stringify(response.json.result))
  check('the registry now holds it', registryCalls.archived.includes(target.id), JSON.stringify(registryCalls.archived))
  check('archiving ran while the files were still there', dirExistedAtArchive === true, String(dirExistedAtArchive))

  // ── 3. assert the store changed the way we promised
  check('session dir left the store', !existsSync(target.dir))
  const trashEntries = existsSync(trashRoot) ? await readdir(trashRoot) : []
  const moved = trashEntries.filter((name) => name.startsWith(target.id))
  check('session dir landed in trash', moved.length === 1, trashEntries.join(', '))
  movedTo = moved.length === 1 ? join(trashRoot, moved[0]) : null
  if (movedTo) {
    const after = await snapshotTree(movedTo)
    check('trashed copy is byte-identical', JSON.stringify(after) === JSON.stringify(before), `${Object.keys(before).length} vs ${Object.keys(after).length} files`)
  }
  for (const name of cacheFiles) check(`projection cache ${name} removed`, !existsSync(join(CACHE, name)))
  const journal = join(REAL_HOME, 'plugins', 'dsh-session-delete', 'deleted.jsonl')
  const lines = existsSync(journal) ? (await readFile(journal, 'utf8')).trim().split('\n').filter(Boolean) : []
  const last = lines.length > 0 ? JSON.parse(lines.at(-1)) : null
  check('audit journal recorded the deletion', last?.sessionId === target.id && last?.mode === 'trash', JSON.stringify(last))
  const listing = await post({ sessionId: target.id, mode: 'trash' })
  // HTTP status is transport-level here; `ok` carries the outcome.
  check(
    'deleting again reports not-found',
    listing.status === 200 && listing.json.ok === false && listing.json.result?.reason === 'not-found',
    JSON.stringify(listing.json),
  )
} finally {
  // ── 4. restore: byte-identical put-back, always — including the archive set,
  // which is durable state the delete changed.
  if (registryCalls.archived.includes(target.id)) {
    await ctx.workspaceRegistry.unarchiveSession(target.id)
    check(
      'RESTORED: the archive was rolled back',
      !ctx.workspaceRegistry.archivedSessionIds.includes(target.id),
      JSON.stringify(ctx.workspaceRegistry.archivedSessionIds),
    )
  }
  if (movedTo && existsSync(movedTo)) {
    await mkdir(join(SESSIONS, target.project), { recursive: true })
    await rename(movedTo, target.dir)
  }
  for (const name of cacheFiles) await cp(join(BACKUP, name), join(CACHE, name))
  const restored = await snapshotTree(target.dir)
  check('RESTORED: session dir is byte-identical to the snapshot', JSON.stringify(restored) === JSON.stringify(before))
  for (const name of cacheFiles) check(`RESTORED: projection cache ${name}`, existsSync(join(CACHE, name)))
  const left = existsSync(trashRoot) ? (await readdir(trashRoot)).filter((name) => name.startsWith(target.id)) : []
  check('RESTORED: nothing left in trash for this session', left.length === 0, left.join(', '))
  await rm(BACKUP, { recursive: true, force: true })
}

console.log(`\n${failures.length === 0 ? 'ALL PASSED' : `${failures.length} FAILED`}`)
if (failures.length > 0) {
  console.log(`failures: ${failures.join(' | ')}`)
  process.exitCode = 1
}
