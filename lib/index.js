/**
 * @local/dsh-plugin-session-delete — host half.
 *
 * DSH ships no session-deletion API: `sessionPersistence` is append-only and
 * `@deepseek-ai/dsh-workspace` only archives (hides) a session. Deleting a
 * conversation therefore has to be out-of-band maintenance on the storage
 * layout that `dsh-session-persistence-jsonl` owns:
 *
 *   <DSH_HOME>/sessions/<projectSlug>/<sessionId>/session.v4.jsonl.zstd
 *   <DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json
 *
 * Removing the session directory is what makes the conversation disappear.
 * The default mode MOVES it into this plugin's trash directory so an accident
 * stays recoverable; `purge` removes it for good.
 */
import { appendFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-session-delete'

export const inject = ['tools', 'webServer', 'connection']

const API = '/dsh-session-delete-api'
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const MODES = new Set(['trash', 'purge'])

function dshHome() {
  const configured = process.env.DSH_HOME?.trim()
  return configured && configured.length > 0 ? configured : join(homedir(), '.dsh')
}

const sessionsRoot = () => join(dshHome(), 'sessions')
const projectionRoot = () => join(dshHome(), 'storages', 'session_projcache', 'sessions')
const pluginRoot = () => join(dshHome(), 'plugins', 'dsh-session-delete')
const trashRoot = () => join(pluginRoot(), 'trash')
const auditLog = () => join(pluginRoot(), 'deleted.jsonl')

/**
 * Read a service without letting a missing/foreign implementation break the plugin.
 *
 * `ctx.get(name)` comes first on purpose: Cordis gates a direct `ctx[name]` read
 * on the fiber's `inject` list, and an injected-only read of a service this
 * plugin does not declare is *reported* as a guard failure even when the local
 * try/catch swallows the throw. The reflective lookup is the sanctioned way to
 * reach an optional service, and this plugin stays usable in runtimes that
 * compose only some of them.
 */
function service(ctx, key) {
  try {
    const resolved = ctx?.get?.(key)
    if (resolved !== undefined && resolved !== null) return resolved
  } catch {
    /* a context without a reflective lookup falls through to the property read */
  }
  try {
    return ctx?.[key] ?? null
  } catch {
    return null
  }
}

/** One-line description of a thrown value, for messages and the audit log. */
function describeError(error) {
  const name = typeof error?.name === 'string' && error.name.length > 0 ? error.name : 'Error'
  const message = typeof error?.message === 'string' ? error.message : String(error)
  return `${name}: ${message}`
}

function collectIds(value, into) {
  if (Array.isArray(value)) {
    for (const entry of value) collectIds(entry, into)
    return
  }
  if (value === null || typeof value !== 'object') return
  if (typeof value.id === 'string') into.add(value.id)
  if (typeof value.sessionId === 'string') into.add(value.sessionId)
}

/**
 * Ask the composed `workspace/session-activity` providers what still runs for a
 * Session — the same gate DSH uses for archive admission in `@deepseek-ai/dsh-workspace`
 * (`lib/index.js`: `ctx.waterfall("workspace/session-activity", { sessionId }, () => Promise.resolve([]))`).
 *
 * The shipped providers report the running turn, owned jobs, running subagents
 * and active reminders; an empty answer means the conversation is idle.
 * Merely having it OPEN in the UI is not activity, so an idle conversation
 * stays deletable. Returns `null` when this runtime exposes no waterfall, so
 * the caller degrades to a conservative agent probe instead of guessing.
 */
async function sessionActivity(ctx, sessionId) {
  if (typeof ctx?.waterfall !== 'function') return null
  try {
    const reported = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
    return Array.isArray(reported) ? reported : []
  } catch {
    return null
  }
}

/**
 * Fallback for a runtime without the activity waterfall: a live Agent is the
 * best conservative signal available. Deliberately NOT based on
 * `sessions.list()`, which enumerates every PERSISTED session and would block
 * every deletion.
 */
function hasLiveAgent(ctx, sessionId) {
  const agents = service(ctx, 'agents')
  if (!agents) return false
  try {
    if (typeof agents.get === 'function') {
      const agent = agents.get(sessionId)
      return agent !== undefined && agent !== null
    }
    if (typeof agents.list === 'function') {
      return collectIds(agents.list(), new Set()).has(sessionId)
    }
  } catch {
    /* an agent registry that refuses to answer must not block the caller */
  }
  return false
}

/** Human-readable summary of the activity families a provider reported. */
function describeActivity(activity) {
  const kinds = activity
    .map((entry) => (entry && typeof entry === 'object' ? entry.kind : entry))
    .filter((kind) => typeof kind === 'string' && kind.length > 0)
  return kinds.length > 0 ? kinds.join('、') : '有活动'
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function directories(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    // Sorted so every sweep visits project slugs in the same order: the trash
    // name a copy gets (`-1`, `-2`, …) then depends on the slug, not on the
    // filesystem's enumeration order.
    return entries
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))
  } catch {
    return []
  }
}

/**
 * Locate every storage directory of one session across all project slugs.
 *
 * A Session normally lives under exactly one project slug, but the same id can
 * be left behind under a second slug when its working directory changed.
 * Stopping at the first hit would delete one copy, leave the other, and still
 * report success.
 */
async function findSessionDirs(sessionId) {
  const found = []
  for (const project of await directories(sessionsRoot())) {
    const candidate = join(sessionsRoot(), project.name, sessionId)
    if (await isDirectory(candidate)) found.push(candidate)
  }
  return found
}

async function directorySize(path) {
  let total = 0
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile()) {
      total += await stat(join(path, entry.name)).then((info) => info.size, () => 0)
    }
  }
  return total
}

/** Every persisted conversation on disk, newest first. */
async function scanSessions() {
  const found = []
  for (const project of await directories(sessionsRoot())) {
    for (const session of await directories(join(sessionsRoot(), project.name))) {
      const dir = join(sessionsRoot(), project.name, session.name)
      const info = await stat(dir).catch(() => null)
      found.push({
        sessionId: session.name,
        project: project.name,
        dir,
        bytes: await directorySize(dir),
        modifiedAt: info ? info.mtime.toISOString() : null,
      })
    }
  }
  found.sort((left, right) => String(right.modifiedAt).localeCompare(String(left.modifiedAt)))
  return found
}

async function audit(entry) {
  try {
    await mkdir(pluginRoot(), { recursive: true })
    await appendFile(auditLog(), `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {
    /* auditing is best effort */
  }
}

/** The registry that owns the sidebar's archive set. */
function workspaceRegistry(ctx) {
  return service(ctx, 'workspaceRegistry') ?? service(ctx, 'workspaceController')
}

/**
 * Hide one Session from every grouping surface through the app's own mechanism.
 *
 * This is not decoration: a conversation that is currently OPEN stays resident
 * in the host's in-memory session store, and `sessionQuery.listSessions()`
 * overlays those resident Sessions on top of the persisted ones — so removing
 * the files alone leaves the row in the sidebar until DSH restarts (`ctx.sessions`
 * exposes create/prepare/enter/announce/flush/get/list/fork and nothing that
 * removes an entry). Archiving is the one supported way to make it disappear
 * live, and the registry accepts any Session that still exists, owned or not.
 *
 * Must run BEFORE the files are removed: the registry refuses an unknown id.
 *
 * @returns `{ state: 'archived', created }` when the call went through —
 * `created` saying whether this call is the one that added the id (and therefore
 * the only one allowed to undo it) — `{ state: 'already' }` when it was already
 * in the durable archive set, `{ state: 'unknown' }` when the registry does not
 * know the Session at all, `{ state: 'unavailable' }` when this runtime composes
 * no registry, and `{ state: 'refused', activity, error }` when the registry
 * rejected the archive — `activity` being the very list the registry reported
 * (or `null`), `error` a description of anything else it threw.
 */
async function archiveSession(ctx, sessionId) {
  const registry = workspaceRegistry(ctx)
  if (typeof registry?.archiveSession !== 'function') return { state: 'unavailable', created: false }
  const already = isArchivedAlready(registry, sessionId)
  if (already === true) return { state: 'already', created: false }
  try {
    await registry.archiveSession(sessionId)
    // `already === null` means the durable set could not be read, so the id may
    // have been archived by someone else: report it hidden, but do not claim the
    // right to undo it.
    return { state: 'archived', created: already === false }
  } catch (error) {
    if (isUnknownSessionError(error)) return { state: 'unknown', created: false }
    // `WorkspaceActiveSessionError` carries the authoritative list, so this
    // refusal never has to re-ask (and cannot be raced by a second look).
    if (isActiveSessionError(error)) {
      return { state: 'refused', created: false, activity: Array.isArray(error.activity) ? error.activity : [] }
    }
    // Everything else — a store-wide persistence fault raised while the registry
    // looked the id up, "registry not started yet", a durable write failure — is
    // described, not obeyed. See the caller for why.
    return { state: 'refused', created: false, activity: null, error: describeError(error) }
  }
}

/**
 * Whether the registry's durable archive set already holds this id.
 *
 * `true`/`false` answer the question; `null` means the set could not be read at
 * all, which the caller must not mistake for "not archived".
 */
function isArchivedAlready(registry, sessionId) {
  try {
    const archived = registry.archivedSessionIds
    return Array.isArray(archived) ? archived.includes(sessionId) : null
  } catch {
    return null
  }
}

function isUnknownSessionError(error) {
  return error?.name === 'WorkspaceUnknownSessionError'
}

function isActiveSessionError(error) {
  return error?.name === 'WorkspaceActiveSessionError'
}

/** Undo {@link archiveSession}; used when the file removal fails. */
async function unarchiveSession(ctx, sessionId) {
  const registry = workspaceRegistry(ctx)
  if (typeof registry?.unarchiveSession !== 'function') return false
  try {
    await registry.unarchiveSession(sessionId)
    return true
  } catch {
    return false
  }
}

/**
 * Delete one conversation.
 *
 * Refusals carry a `reason`: `invalid-id`, `invalid-mode`, `current-session`,
 * `busy` (another delete of the same id is in flight), `not-found`, `active`
 * (something is running), or `io-error` (storage refused; whatever could be put
 * back was put back and the rest is reported).
 *
 * A refused *archive* is not a refusal: hiding the row is cosmetic, while the
 * registry's lookup throws for the entire store as soon as any single log is
 * inconsistent — obeying it would make every conversation undeletable. Such a
 * delete goes through with `archived: false` and `archiveError` set.
 *
 * @returns `{ sessionId, deleted, reason?, message, trashPath?, trashPaths?,
 * projectionRemoved?, archived, archiveError? }`
 */
/** Session ids a delete is currently working on, so two callers cannot race. */
const inFlight = new Set()

/** `config.defaultMode`, adopted whenever a caller omits `mode`. */
let defaultMode = 'trash'

async function deleteSession(ctx, sessionId, mode) {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    return { sessionId: String(sessionId), deleted: false, reason: 'invalid-id', message: '无效的会话 id。' }
  }
  if (mode !== undefined && !MODES.has(mode)) {
    return { sessionId, deleted: false, reason: 'invalid-mode', message: `mode 只能是 trash 或 purge，收到 ${String(mode)}。` }
  }
  const effectiveMode = mode ?? defaultMode

  // Refuse the conversation this host is running by identity, before any
  // storage lookup, so it never degrades into 'not-found' for a folder that is
  // already gone. Opened-but-idle conversations are deliberately deletable.
  if (sessionId === process.env.DSH_SESSION_ID?.trim()) {
    return { sessionId, deleted: false, reason: 'current-session', message: '不能删除当前正在进行的对话。' }
  }
  if (inFlight.has(sessionId)) {
    return { sessionId, deleted: false, reason: 'busy', message: '这个对话正在被另一个删除操作处理，请稍候。' }
  }

  inFlight.add(sessionId)
  try {
    const dirs = await findSessionDirs(sessionId)
    if (dirs.length === 0) {
      return { sessionId, deleted: false, reason: 'not-found', message: '没有找到这个对话的存储目录，可能已经删除。' }
    }

    const activity = await sessionActivity(ctx, sessionId)
    if (activity === null) {
      if (hasLiveAgent(ctx, sessionId)) {
        return {
          sessionId,
          deleted: false,
          reason: 'active',
          message: '这个对话仍有活动中的 Agent，请先结束它再删除。',
        }
      }
    } else if (activity.length > 0) {
      return {
        sessionId,
        deleted: false,
        reason: 'active',
        message: `这个对话仍在运行（${describeActivity(activity)}），请先结束它再删除。`,
      }
    }

    // Retire it from the sidebar first, while the Session still exists, and roll
    // that back if the storage operation fails below.
    const archive = await archiveSession(ctx, sessionId)
    let archived = archive.state === 'archived' || archive.state === 'already'
    let archiveError = null
    if (archive.state === 'refused') {
      // Only activity is a real refusal. Anything else the registry threw while
      // looking the Session up is a bookkeeping fault — `sessionKnown()` reads
      // the whole store, so a single inconsistent log elsewhere raises for every
      // id — and obeying it would leave the user unable to delete anything at
      // all. The row may stay behind; the conversation's files are what matter.
      const reported = archive.activity ?? (await sessionActivity(ctx, sessionId)) ?? []
      if (reported.length > 0) {
        return {
          sessionId,
          deleted: false,
          reason: 'active',
          message: `这个对话仍在运行（${describeActivity(reported)}），请先结束它再删除。`,
        }
      }
      archived = false
      archiveError = archive.error ?? 'workspace registry refused the archive'
    }
    // 'unknown' and 'unavailable' both mean "nothing to retire here": the
    // registry either does not know the Session (so the sidebar has no row for
    // it either) or is not part of this runtime at all.

    const at = new Date().toISOString()
    const entry = { sessionId, dir: dirs[0], dirs, mode: effectiveMode, archived, at }
    const moved = []
    const removed = []
    try {
      if (effectiveMode === 'purge') {
        for (const dir of dirs) {
          await rm(dir, { recursive: true, force: true })
          removed.push(dir)
        }
      } else {
        await mkdir(trashRoot(), { recursive: true })
        const stamp = at.replace(/[:.]/gu, '-')
        for (const [index, dir] of dirs.entries()) {
          const target = join(trashRoot(), `${sessionId}--${stamp}${index === 0 ? '' : `-${index}`}`)
          await rename(dir, target)
          moved.push({ from: dir, to: target })
        }
      }
    } catch (error) {
      // Put back whatever can still be put back, and say plainly what cannot:
      // a purge that already removed a sibling directory cannot be undone, and a
      // copy whose restore failed is stranded in trash. Only a delete that left
      // the store exactly as it found it may put the sidebar row back too.
      const restoreFailures = []
      for (const item of [...moved].reverse()) {
        try {
          await rename(item.to, item.from)
        } catch (restoreError) {
          restoreFailures.push({ ...item, error: describeError(restoreError) })
        }
      }
      const destroyed = removed.slice()
      const stranded = restoreFailures.map((item) => item.to)
      const intact = destroyed.length === 0 && stranded.length === 0
      if (archive.created && intact) await unarchiveSession(ctx, sessionId)
      const archivedAfter = intact && archive.created ? false : archived
      entry.ok = false
      entry.reason = 'io-error'
      entry.error = describeError(error)
      entry.restored = intact
      entry.destroyed = destroyed
      entry.stranded = stranded
      entry.archived = archivedAfter
      entry.archiveError = archiveError
      await audit(entry)
      const notes = []
      if (destroyed.length > 0) notes.push(`有 ${destroyed.length} 份日志已被永久删除，无法恢复`)
      if (stranded.length > 0) notes.push(`有 ${stranded.length} 份副本滞留在回收站：${stranded.join('、')}`)
      if (archivedAfter) notes.push('侧边栏仍会显示这个对话')
      return {
        sessionId,
        deleted: false,
        reason: 'io-error',
        restored: intact,
        destroyed,
        stranded,
        archived: archivedAfter,
        archiveError,
        message: `删除失败：${describeError(error)}${notes.length > 0 ? `（${notes.join('；')}）` : ''}`,
      }
    }
    entry.trashPath = moved[0] ? moved[0].to : null
    entry.trashPaths = moved.map((item) => item.to)
    entry.removed = removed.slice()
    entry.archiveError = archiveError

    const cacheFile = join(projectionRoot(), `${sessionId}.json`)
    // `rm(..., {force:true})` succeeds on a missing file, so the flag is only
    // honest if the cache is known to have existed.
    const hadCache = await stat(cacheFile).then(() => true, () => false)
    let projectionRemoved = false
    if (hadCache) {
      try {
        await rm(cacheFile, { force: true })
        projectionRemoved = true
      } catch {
        /* a projection cache that refuses to go is not a failed delete */
      }
    }

    await audit(entry)
    return {
      sessionId,
      deleted: true,
      mode: effectiveMode,
      archived,
      archiveError,
      trashPath: entry.trashPath,
      trashPaths: entry.trashPaths,
      projectionRemoved,
      message:
        (effectiveMode === 'purge' ? '对话已永久删除。' : '对话已移入回收站，可从 trash 目录恢复。') +
        (archived
          ? '已从侧边栏移除。'
          : '侧边栏可能仍显示这个对话：重启 DSH 后会消失。'),
    }
  } finally {
    inFlight.delete(sessionId)
  }
}

function send(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const deleteTool = {
  name: 'dsh_delete_conversation',
  description:
    '删除一个已保存的 DSH 对话（会话日志与投影缓存）。默认 mode=trash 把会话目录移到插件的 trash 目录（可人工恢复），mode=purge 则永久删除。正在运行或当前正在进行的对话会被拒绝。',
  parameters: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: '要删除的会话 id，例如 session-1d47cd6e-... 或裸 UUID。' },
      mode: {
        type: 'string',
        enum: ['trash', 'purge'],
        description: 'trash（默认）移入回收站可恢复；purge 永久删除。',
      },
    },
    required: ['sessionId'],
    additionalProperties: false,
  },
  output: {
    schema: { type: 'object' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  },
  isConcurrencySafe: () => false,
}

/** Register everything this plugin exposes and hand back one combined cleanup. */
function registerSurfaces(ctx, config) {
  const pluginCtx = ctx
  defaultMode = config?.defaultMode === 'purge' ? 'purge' : 'trash'
  const tool = {
    ...deleteTool,
    async execute(args, exec) {
      return deleteSession(pluginCtx ?? exec?.agent?.ctx, args?.sessionId, args?.mode)
    },
  }
  const disposers = []
  if (typeof ctx.tools?.register === 'function') {
    disposers.push(ctx.tools.register(tool))
  }

  const handler = async (req, res) => {
    try {
      // Fail closed. Without the connection service there is no way to tell a
      // logged-in DSH page from any other local client, so the route refuses
      // rather than serving a delete unauthenticated.
      const connection = service(ctx, 'connection')
      if (typeof connection?.admit !== 'function') {
        send(res, 503, { ok: false, error: '连接鉴权服务不可用，已拒绝请求。' })
        return
      }
      const admission = connection.admit(req)
      if (admission && typeof admission === 'object' && 'rejection' in admission) {
        // Pass the real verdict through: the service distinguishes an untrusted
        // caller from a missing credential, and flattening both to 401 misleads
        // whoever reads the log.
        const rejection = admission.rejection ?? {}
        const status = Number.isInteger(rejection.status) ? rejection.status : 401
        const reason = rejection.message ?? rejection.reason ?? rejection.kind
        send(res, status, { ok: false, error: typeof reason === 'string' && reason ? reason : '未登录 DSH' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const route = url.pathname.startsWith(API) ? url.pathname.slice(API.length).replace(/^\/+/u, '') : ''
      const method = (req.method ?? 'GET').toUpperCase()

      if (method === 'GET' && (route === 'status' || route === '')) {
        const sessions = await scanSessions()
        send(res, 200, {
          ok: true,
          version: '0.2.0',
          sessionsRoot: sessionsRoot(),
          trashRoot: trashRoot(),
          sessionCount: sessions.length,
          defaultMode: config.defaultMode === 'purge' ? 'purge' : 'trash',
        })
        return
      }
      if (method === 'GET' && route === 'sessions') {
        send(res, 200, { ok: true, sessions: await scanSessions() })
        return
      }
      if (method === 'POST' && route === 'delete') {
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          // A caller's malformed request is not this server's fault.
          send(res, 400, { ok: false, error: `请求体无效：${describeError(error)}` })
          return
        }
        const result = await deleteSession(ctx, body?.sessionId, body?.mode)
        send(res, 200, { ok: result.deleted === true, result })
        return
      }
      send(res, 404, { ok: false, error: `unknown route: ${method} ${route}` })
    } catch (error) {
      send(res, 500, { ok: false, error: error?.message ?? String(error) })
    }
  }

  if (typeof ctx.webServer?.register === 'function') {
    disposers.push(ctx.webServer.register({ kind: 'prefix', path: API, handler }))
  }

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose?.()
      } catch {
        /* disposal must not throw */
      }
    }
  }
}

/**
 * Cordis ignores whatever a plugin's `apply` returns, so a cleanup returned
 * from `apply` never runs and every unload leaks a live tool and web route.
 * Registrations therefore go through `ctx.effect`, which runs them now and
 * calls the returned function when this plugin's fiber is disposed.
 */
export function apply(ctx, config = {}) {
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => registerSurfaces(ctx, config), 'dsh-session-delete')
    return
  }
  // Bare context (no Cordis effects): register directly and expose the cleanup.
  return registerSurfaces(ctx, config)
}
