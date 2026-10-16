/**
 * Smoke test for @local/dsh-plugin-session-delete's client bundle, executed
 * with stub globals: proves the file self-registers under the package id,
 * exports the Cordis plugin shape, registers into the right slots, and that the
 * whole interaction — menu row → dialog → confirm → request → toast → refresh
 * backstop — actually runs.
 *
 * The React stub is a real (if tiny) hook runtime: per-mount hook state, effects
 * flushed after render, and a re-render on every state update. A stub that
 * returned `[initial, () => {}]` and never ran effects would make every
 * interaction assertion below vacuous.
 *
 *   node test/client.test.mjs
 */
import { readFile } from 'node:fs/promises'

const BUNDLE = new URL('../lib/client.js', import.meta.url)

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

// ── stub browser + shell
const realSetImmediate = setImmediate
let registration = null
const windowListeners = new Map()
const fetchCalls = []
let reloads = 0
let rowStillListed = false
let nextResponse = { ok: true, status: 200, body: { ok: true, result: { deleted: true } } }

// Timers are parked and released by hand, so the 900 ms refresh backstop can be
// observed before and after it fires without slowing the test down.
const timers = []
globalThis.setTimeout = (fn) => {
  timers.push(fn)
  return timers.length
}
globalThis.clearTimeout = (id) => {
  if (id > 0) timers[id - 1] = null
}
function runTimers() {
  for (const fn of timers.splice(0)) {
    try {
      fn?.()
    } catch {
      /* a parked callback must not break the suite */
    }
  }
}
const tick = () => new Promise((resolve) => realSetImmediate(resolve))

globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      registration = value
    },
  },
  fetch: (url, init) => {
    fetchCalls.push([url, init])
    const response = nextResponse
    return Promise.resolve({
      ok: response.ok,
      status: response.status,
      json: () => Promise.resolve(response.body),
    })
  },
  addEventListener: (type, handler) => windowListeners.set(type, handler),
  removeEventListener: (type) => windowListeners.delete(type),
  location: {
    reload() {
      reloads += 1
    },
  },
}
globalThis.document = { querySelector: () => (rowStillListed ? { row: true } : null) }

// ── a minimal hook runtime (state, effects, re-render)
const elements = []
let current = null
function sameDeps(previous, next) {
  if (!previous || !next) return false
  if (previous.length !== next.length) return false
  return previous.every((value, index) => Object.is(value, next[index]))
}
const React = {
  useState(initial) {
    const instance = current
    const index = instance.index++
    if (!(index in instance.hooks)) {
      instance.hooks[index] = typeof initial === 'function' ? initial() : initial
    }
    return [
      instance.hooks[index],
      (next) => {
        const value = typeof next === 'function' ? next(instance.hooks[index]) : next
        if (Object.is(value, instance.hooks[index])) return
        instance.hooks[index] = value
        if (!instance.rendering) renderInstance(instance)
      },
    ]
  },
  useEffect(fn, deps) {
    const instance = current
    const index = instance.index++
    const previous = instance.effects[index]
    if (previous && sameDeps(previous.deps, deps)) return undefined
    if (previous?.cleanup) {
      try {
        previous.cleanup()
      } catch {
        /* cleanup failures are the component's problem */
      }
    }
    const slot = { deps, fn, cleanup: null }
    instance.effects[index] = slot
    instance.pending.push(slot)
    return undefined
  },
  createElement(type, props, ...children) {
    const node = { type, props: props ?? {}, children: children.flat() }
    elements.push(node)
    return node
  },
}
const resolve = (specifier) => {
  if (specifier === 'react') return React
  throw new Error(`unexpected require("${specifier}")`)
}

function renderInstance(instance) {
  instance.rendering = true
  instance.index = 0
  current = instance
  let tree
  try {
    tree = instance.component(instance.props)
  } finally {
    current = null
    instance.rendering = false
  }
  for (const slot of instance.pending.splice(0)) {
    try {
      const cleanup = slot.fn()
      slot.cleanup = typeof cleanup === 'function' ? cleanup : null
    } catch {
      /* an effect that throws must not abort the render */
    }
  }
  instance.tree = tree
  return tree
}

function mount(component, props) {
  const instance = { component, props: props ?? {}, hooks: [], effects: [], pending: [], index: 0, rendering: false, tree: null }
  const handle = {
    instance,
    render: () => renderInstance(instance),
    setProps(next) {
      instance.props = next ?? {}
      return renderInstance(instance)
    },
    get tree() {
      return renderInstance(instance)
    },
  }
  renderInstance(instance)
  return handle
}

function flatten(node, into = []) {
  if (node === null || typeof node !== 'object') return into
  into.push(node)
  for (const child of node.children ?? []) flatten(child, into)
  return into
}
const labelOf = (node) => (node.children ?? []).filter((child) => typeof child === 'string').join('')
const textsOf = (node) => flatten(node).filter((entry) => typeof entry.type === 'string').map(labelOf)
const findButton = (node) => flatten(node).find((entry) => entry.type === 'button')
const findButtonByLabel = (node, label) =>
  flatten(node).find((entry) => entry.type === 'button' && labelOf(entry) === label)

// ── run the bundle
const source = await readFile(BUNDLE, 'utf8')
check('bundle has no ESM export statement', !/^\s*export\s/mu.test(source))
check('bundle registers through __ModuleLoader__.load', source.includes('window.__ModuleLoader__.load'))
// eslint-disable-next-line no-new-func
new Function('window', source)(globalThis.window)

check('bundle registered a module', registration !== null)
check('registration id is the package name', registration?.id === '@local/dsh-plugin-session-delete', registration?.id)
check('registration carries a factory', typeof registration?.factory === 'function')

const exportsObject = registration.factory(resolve)
check('exports.inject is [slots]', JSON.stringify(exportsObject.inject) === JSON.stringify(['slots']), JSON.stringify(exportsObject.inject))
check('exports.apply is a function', typeof exportsObject.apply === 'function')

// ── apply against a stub slot service. `get` answers nothing, so this runtime
// has no client `workspaces` service: the archive seam is exercised separately.
const registered = []
const injected = []
const ctx = {
  slots: {
    inject(key, callback) {
      injected.push(key)
      return callback()
    },
    register(config, component) {
      registered.push({ config, component })
      return () => {}
    },
  },
  get: () => null,
}
exportsObject.apply(ctx)

check('injects the session menu slot', injected.includes('sidebar.workspaces.session.menu.item'), injected.join(','))
check('injects the overlay slot', injected.includes('shell.overlay'), injected.join(','))
check('registers two occupants', registered.length === 2, String(registered.length))

const menu = registered.find((entry) => entry.config.name === 'sidebar.workspaces.session.menu.item')
const overlay = registered.find((entry) => entry.config.name === 'shell.overlay')
check('menu occupant id', menu?.config.id === 'session-delete', menu?.config.id)
check('menu occupant order is 500 (after shipped archive=400)', menu?.config.order === 500, String(menu?.config.order))
check('menu occupant label', typeof menu?.config.label === 'function' && menu.config.label() === '删除对话')
check('overlay occupant id', overlay?.config.id === 'session-delete-overlay', overlay?.config.id)

// ── the menu row renders for a session, and nothing without one
elements.length = 0
const menuMount = mount(menu.component, { sessionId: 'session-x', displayTitle: 'T' })
check('menu item renders a role=menuitem button', findButton(menuMount.tree)?.props?.role === 'menuitem')
check('menu item without a sessionId renders nothing', mount(menu.component, {}).tree === null)
check('menu item renders nothing for empty props', mount(menu.component, undefined).tree === null)
// REGRESSION: the slot hook is called unconditionally, so a mount without the
// slot's hookContext must still render instead of throwing.
check('menu item renders without the slot hook context', mount(menu.component, { sessionId: 'session-nohook' }).tree !== null)

// ── the interaction, through the real store subscription: using the menu row
// must re-render the overlay into a dialog without any manual re-render.
elements.length = 0
const overlayMount = mount(overlay.component, {})
check('overlay renders nothing while idle', overlayMount.tree === null)

let dismissed = null
menuMount.setProps({
  sessionId: 'session-x',
  displayTitle: 'T',
  useMenuOpenState: () => [true, (open) => (dismissed = open)],
})
findButton(menuMount.tree).props.onClick({ preventDefault() {}, stopPropagation() {} })
check('menu dismissal called with false', dismissed === false)
check('overlay shows a dialog after the menu is used', overlayMount.tree !== null)

const dialog = flatten(overlayMount.tree)
check('dialog offers the permanent-delete checkbox', dialog.some((node) => node.type === 'input' && node.props?.type === 'checkbox'))
check('dialog states the recoverable default', textsOf(overlayMount.tree).some((text) => text.includes('trash 目录')))
check('dialog offers 取消', textsOf(overlayMount.tree).includes('取消'))
check('dialog offers 删除', textsOf(overlayMount.tree).includes('删除'))
// The tokens the app actually publishes (Theme.listTokens), not invented names.
check(
  'the dialog uses the app theme tokens',
  flatten(overlayMount.tree).some((node) => JSON.stringify(node.props?.style ?? {}).includes('--dsw-alias-')),
)

// ── the client→host seam: confirming must POST the delete to the host half,
// surface the outcome, and only then run the refresh backstop.
rowStillListed = true
nextResponse = {
  ok: true,
  status: 200,
  body: {
    ok: true,
    result: { deleted: true, archived: false, message: '对话已移入回收站，可从 trash 目录恢复。' },
  },
}
const confirm = findButtonByLabel(overlayMount.tree, '删除')
check('confirmation button exists', confirm !== undefined)
const confirming = confirm.props.onClick()
await tick()
check('confirming issues exactly one request', fetchCalls.length === 1, String(fetchCalls.length))
const [url, init] = fetchCalls[0] ?? []
check('request targets the plugin API', url === '/dsh-session-delete-api/delete', url)
check('request is a POST', init?.method === 'POST', init?.method)
check('request is same-origin credentialed', init?.credentials === 'same-origin', init?.credentials)
check('request carries the session id', JSON.parse(init?.body ?? '{}').sessionId === 'session-x', init?.body)
check('request defaults to trash mode', JSON.parse(init?.body ?? '{}').mode === 'trash', init?.body)
check(
  'recovery instructions are surfaced after a successful delete',
  textsOf(overlayMount.tree).some((text) => text.includes('回收站')),
)
// `archived: false` + no client workspaces service: the user must be told the
// row may still be listed instead of being left to wonder.
check(
  'an unarchived delete warns that the row may remain',
  textsOf(overlayMount.tree).some((text) => text.includes('侧边栏可能仍显示')),
  textsOf(overlayMount.tree).join(' | '),
)
check('nothing reloads the page while the request is in flight', reloads === 0, String(reloads))
runTimers()
await confirming
await tick()
check('a still-listed row is never reloaded away (a reload cannot fix it)', reloads === 0, String(reloads))
check(
  'a still-listed row is reported as needing a DSH restart',
  textsOf(overlayMount.tree).some((text) => text.includes('重启 DSH')),
  textsOf(overlayMount.tree).join(' | '),
)

// ── and when the row is already gone there is nothing to report
fetchCalls.length = 0
menuMount.setProps({ sessionId: 'session-x2', displayTitle: 'T2' })
findButton(menuMount.tree).props.onClick({ preventDefault() {}, stopPropagation() {} })
rowStillListed = false
nextResponse = { ok: true, status: 200, body: { ok: true, result: { deleted: true, archived: true, message: '对话已移入回收站。已从侧边栏移除。' } } }
const confirmingQuiet = findButtonByLabel(overlayMount.tree, '删除').props.onClick()
await tick()
await tick()
// Check the toast BEFORE running timers: the 6s dismiss timer for it is parked
// among them, and firing it would empty the overlay and make this pass for the
// wrong reason.
check('the archived delete still shows a result toast', textsOf(overlayMount.tree).length > 0, textsOf(overlayMount.tree).join(' | '))
check(
  'an archived delete does not warn about the sidebar',
  !textsOf(overlayMount.tree).some((text) => text.includes('侧边栏可能仍显示')),
  textsOf(overlayMount.tree).join(' | '),
)
runTimers()
await confirmingQuiet
await tick()
check(
  'a row that disappeared is not reported as stuck',
  !textsOf(overlayMount.tree).some((text) => text.includes('重启 DSH')),
  textsOf(overlayMount.tree).join(' | '),
)
check('nothing reloads when the row is already gone', reloads === 0, String(reloads))

// ── a host too old to report `archived` at all: an absent field is not a
// success, so the warning must still appear rather than letting the user think
// the row is gone.
rowStillListed = false
menuMount.setProps({ sessionId: 'session-x3', displayTitle: 'T3' })
findButton(menuMount.tree).props.onClick({ preventDefault() {}, stopPropagation() {} })
nextResponse = {
  ok: true,
  status: 200,
  body: { ok: true, result: { deleted: true, message: '对话已移入回收站，可从 trash 目录恢复。' } },
}
const confirmingLegacy = findButtonByLabel(overlayMount.tree, '删除').props.onClick()
await tick()
await tick()
// Same ordering rule as above: the toast must be inspected before the parked
// timers (including its own dismiss timer) run.
check(
  'a host that does not report archiving still warns',
  textsOf(overlayMount.tree).some((text) => text.includes('侧边栏可能仍显示')),
  textsOf(overlayMount.tree).join(' | '),
)
runTimers()
await confirmingLegacy
await tick()

// ── permanent deletion: ticking the box must switch the request to mode=purge
fetchCalls.length = 0
rowStillListed = false
menuMount.setProps({ sessionId: 'session-y', displayTitle: 'Y' })
findButton(menuMount.tree).props.onClick({ preventDefault() {}, stopPropagation() {} })
const permanentDialog = flatten(overlayMount.tree)
const checkbox = permanentDialog.find((node) => node.type === 'input' && node.props?.type === 'checkbox')
check('checkbox starts unticked', checkbox?.props?.checked === false, JSON.stringify(checkbox?.props?.checked))
checkbox.props.onChange()
check('ticking it warns about irreversibility', textsOf(overlayMount.tree).some((text) => text === '永久删除'))
const purging = findButtonByLabel(overlayMount.tree, '永久删除').props.onClick()
await tick()
check('permanent deletion sends mode=purge', JSON.parse(fetchCalls[0]?.[1]?.body ?? '{}').mode === 'purge', fetchCalls[0]?.[1]?.body)
runTimers()
await purging

// ── the live-refresh seam: a successful delete must also retire the row through
// the client's own workspaces service. An OPEN conversation stays resident in
// the host's in-memory session store, so its files disappearing is not enough
// for the sidebar to drop it.
const archiveCalls = []
const unarchiveCalls = []
/** How many requests had been sent when each archive ran (ordering proof). */
const requestsAtArchive = []
const liveRegistered = []
exportsObject.apply({
  slots: {
    inject: (key, callback) => callback(),
    register(config, component) {
      liveRegistered.push({ config, component })
      return () => {}
    },
  },
  get: (key) =>
    key === 'workspaces'
      ? {
          archiveSession: async (id) => {
            archiveCalls.push(id)
            requestsAtArchive.push(fetchCalls.length)
          },
          unarchiveSession: async (id) => unarchiveCalls.push(id),
        }
      : null,
})
const liveMenu = liveRegistered.find((entry) => entry.config.name === 'sidebar.workspaces.session.menu.item')
const liveOverlay = liveRegistered.find((entry) => entry.config.name === 'shell.overlay')
fetchCalls.length = 0
rowStillListed = false
nextResponse = { ok: true, status: 200, body: { ok: true, result: { deleted: true, archived: false, message: '对话已移入回收站。' } } }
const liveMenuMount = mount(liveMenu.component, { sessionId: 'session-z', displayTitle: 'Z' })
const liveOverlayMount = mount(liveOverlay.component, {})
findButton(liveMenuMount.tree).props.onClick({ preventDefault() {}, stopPropagation() {} })
const liveConfirming = findButtonByLabel(liveOverlayMount.tree, '删除').props.onClick()
await tick()
runTimers()
await liveConfirming
check('a confirmed delete archives through the client workspaces service', archiveCalls.includes('session-z'), JSON.stringify(archiveCalls))
check(
  'the row is hidden BEFORE the host is asked (the registry needs a live Session)',
  requestsAtArchive[0] === 0,
  JSON.stringify(requestsAtArchive),
)
check(
  'an archive performed client-side suppresses the sidebar warning',
  !textsOf(liveOverlayMount.tree).some((text) => text.includes('侧边栏可能仍显示')),
  textsOf(liveOverlayMount.tree).join(' | '),
)

// ── a failed request must surface the host's message, and must put back the row
// this client hid optimistically.
fetchCalls.length = 0
rowStillListed = false
nextResponse = { ok: true, status: 200, body: { ok: false, result: { deleted: false, reason: 'active', message: '这个对话仍在运行（agent），请先结束它再删除。' } } }
const failureMenuMount = mount(liveMenu.component, { sessionId: 'session-w', displayTitle: 'W' })
const failureOverlayMount = mount(liveOverlay.component, {})
findButton(failureMenuMount.tree).props.onClick({ preventDefault() {}, stopPropagation() {} })
await findButtonByLabel(failureOverlayMount.tree, '删除').props.onClick()
check(
  'a refused delete shows the host reason',
  textsOf(failureOverlayMount.tree).some((text) => text.includes('仍在运行')),
  textsOf(failureOverlayMount.tree).join(' | '),
)
check(
  'a refused delete puts the row back',
  archiveCalls.includes('session-w') && unarchiveCalls.includes('session-w'),
  JSON.stringify({ archiveCalls, unarchiveCalls }),
)

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log(`failures: ${failures.join(' | ')}`)
  process.exitCode = 1
}
