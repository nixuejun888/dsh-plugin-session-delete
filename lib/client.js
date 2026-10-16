/**
 * @local/dsh-plugin-session-delete — client half.
 *
 * Hand-written `__ModuleLoader__` bundle (no build step): the host serves this
 * file verbatim and the browser shell calls `load({ id, factory })`, where
 * `id` must equal the package name and the factory returns the Cordis plugin
 * shape `{ inject, apply }`.
 *
 * UI surface:
 *   - `sidebar.workspaces.session.menu.item` → 「删除对话」 entry in each
 *     session's "..." menu (props: `{ sessionId, displayTitle }`).
 *   - `shell.overlay` → confirmation dialog + result toast.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-plugin-session-delete',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const API = '/dsh-session-delete-api'

    const runtime = { ctx: null }

    // ── tiny subscription store (menu item and overlay live in different slots)
    const store = { pending: null, busy: false, error: null, done: null }
    const listeners = new Set()
    function update(patch) {
      Object.assign(store, patch)
      for (const listener of Array.from(listeners)) {
        try {
          listener()
        } catch {
          /* a broken subscriber must not break the rest */
        }
      }
    }
    function useStore() {
      const [, bump] = React.useState(0)
      React.useEffect(() => {
        const listener = () => bump((value) => value + 1)
        listeners.add(listener)
        return () => listeners.delete(listener)
      }, [])
      return store
    }

    const itemStyle = {
      display: 'block',
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 10px',
      border: '0',
      borderRadius: '6px',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      textAlign: 'left',
      whiteSpace: 'nowrap',
      cursor: 'pointer',
    }
    const dangerHover = {
      background: 'rgba(220, 38, 38, 0.12)',
      color: 'var(--dsw-alias-state-error-primary, #dc2626)',
    }

    /** The `[open, setOpen]` pair every row in this slot is handed. */
    function noMenuState() {
      const [open, setOpen] = React.useState(false)
      return [open, setOpen]
    }

    function DeleteSessionMenuItem(props) {
      const owner = props || {}
      const sessionId = owner.sessionId
      const displayTitle = owner.displayTitle || ''
      const [hover, setHover] = React.useState(false)
      // The slot's `hookContext` (MenuOpenState) supplies `useMenuOpenState`,
      // returning `[open, setOpen]`. It is always called — exactly once per
      // render, like the entries DSH ships in this slot — so the hook order
      // cannot drift; the fallback only covers a mount without the context.
      const useMenuOpenState =
        typeof owner.useMenuOpenState === 'function' ? owner.useMenuOpenState : noMenuState
      const menuOpenState = useMenuOpenState()
      const closeMenu = () => {
        if (menuOpenState && typeof menuOpenState[1] === 'function') menuOpenState[1](false)
      }
      if (!sessionId) return null
      return h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          'data-dsh-session-delete': 'menu-item',
          style: hover ? Object.assign({}, itemStyle, dangerHover) : itemStyle,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          onClick: (event) => {
            event.preventDefault()
            event.stopPropagation()
            closeMenu()
            update({ pending: { sessionId, displayTitle }, error: null, done: null })
          },
        },
        '删除对话',
      )
    }

    /**
     * Retire the conversation from the sidebar through the app's own registry
     * call. The archive set is what the sidebar filters on, and this is the one
     * form of it the Client can update without a DSH restart.
     *
     * It runs BEFORE the request on purpose: the registry only accepts a Session
     * that still exists, and by the time the Host answers, the stored Log that
     * made it exist is gone. The Host archives the same way inside the delete, so
     * against a current Host this is a no-op; against a Host that has not been
     * restarted it is the only thing that clears an open conversation from the
     * sidebar, because the Host keeps every opened Session resident in memory.
     * {@link unarchiveQuietly} puts the row back when the delete then fails.
     */
    async function archiveQuietly(ctx, sessionId) {
      try {
        const workspaces = safeService(ctx, 'workspaces')
        if (typeof workspaces?.archiveSession === 'function') {
          await workspaces.archiveSession(sessionId)
          return true
        }
      } catch {
        /* the Host still archives as part of the delete */
      }
      return false
    }

    /** Put back a row {@link archiveQuietly} hid for a delete that failed. */
    async function unarchiveQuietly(ctx, sessionId) {
      try {
        const workspaces = safeService(ctx, 'workspaces')
        if (typeof workspaces?.unarchiveSession === 'function') {
          await workspaces.unarchiveSession(sessionId)
          return true
        }
      } catch {
        /* nothing more can be undone from here */
      }
      return false
    }

    /**
     * Whether the sidebar still renders the conversation a moment after the
     * delete — reported, never acted on.
     *
     * The row survives exactly when the Host still holds the conversation
     * resident in memory, and `sessionQuery.listSessions()` overlays those
     * resident Sessions on top of the persisted ones. Reloading the page asks
     * that same Host for that same list, so a reload cannot remove the row — it
     * would only throw away unsent composer text and scroll position. Only a DSH
     * restart clears it, so the user is told that instead.
     */
    async function rowStillListed(sessionId, waitMs) {
      await new Promise((resolve) => setTimeout(resolve, waitMs))
      const selector =
        '[data-row-key="session:' + sessionId + '"], [data-session-id="' + sessionId + '"]'
      try {
        return document.querySelector(selector) !== null
      } catch {
        return false
      }
    }

    function DeleteSessionOverlay() {
      const state = useStore()
      const pending = state.pending

      React.useEffect(() => {
        if (!pending) return undefined
        const onKey = (event) => {
          // Escape must not release a delete that is already in flight: its
          // answer would arrive with no dialog left to explain it.
          if (event.key === 'Escape' && !store.busy) update({ pending: null, busy: false, error: null })
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [pending])

      React.useEffect(() => {
        if (!state.done) return undefined
        const timer = setTimeout(() => update({ done: null }), 6000)
        return () => clearTimeout(timer)
      }, [state.done])

      if (!pending && !state.done) return null

      const card = {
        position: 'relative',
        minWidth: '320px',
        maxWidth: '440px',
        padding: '20px',
        borderRadius: '12px',
        background: 'var(--dsw-alias-bg-overlay, #1f2023)',
        color: 'var(--dsw-alias-label-primary, #f5f5f5)',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.35))',
        boxShadow: '0 18px 50px rgba(0,0,0,0.45)',
        font: 'inherit',
        textAlign: 'left',
      }
      const button = (extra) =>
        Object.assign(
          {
            padding: '7px 14px',
            borderRadius: '8px',
            border: '1px solid rgba(127,127,127,0.4)',
            background: 'transparent',
            color: 'inherit',
            font: 'inherit',
            cursor: 'pointer',
          },
          extra,
        )

      const permanent = pending != null && pending.permanent === true
      const children = []
      if (pending) {
        children.push(
          h('div', { key: 'title', style: { fontSize: '15px', fontWeight: 600, marginBottom: '10px' } }, '删除对话'),
          h(
            'div',
            { key: 'body', style: { fontSize: '13px', lineHeight: 1.6, opacity: 0.85 } },
            '将删除 ',
            h('strong', null, pending.displayTitle || pending.sessionId),
            ' 的会话日志与投影缓存。',
          ),
          h(
            'label',
            {
              key: 'permanent',
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                marginTop: '12px',
                fontSize: '12px',
                cursor: 'pointer',
                color: permanent ? 'var(--dsw-alias-state-error-primary, #f87171)' : 'inherit',
              },
            },
            h('input', {
              type: 'checkbox',
              checked: permanent,
              disabled: state.busy,
              onChange: () =>
                update({ pending: Object.assign({}, pending, { permanent: pending.permanent !== true }) }),
            }),
            '永久删除（不可恢复，不进入回收站）',
          ),
          h(
            'div',
            { key: 'hint', style: { fontSize: '12px', opacity: 0.65, marginTop: '6px' } },
            permanent
              ? '会话目录会被直接删除，无法恢复。'
              : '默认移入插件的 trash 目录，可以从那里恢复。',
          ),
          h(
            'div',
            { key: 'id', style: { fontSize: '11px', opacity: 0.6, marginTop: '8px', wordBreak: 'break-all' } },
            pending.sessionId,
          ),
        )
        if (state.error) {
          children.push(
            h(
              'div',
              { key: 'error', style: { marginTop: '12px', fontSize: '12px', color: 'var(--dsw-alias-state-error-primary, #f87171)' } },
              state.error,
            ),
          )
        }
        children.push(
          h(
            'div',
            { key: 'actions', style: { display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '18px' } },
            h(
              'button',
              {
                type: 'button',
                style: button(null),
                disabled: state.busy,
                onClick: () => update({ pending: null, busy: false, error: null }),
              },
              '取消',
            ),
            h(
              'button',
              {
                type: 'button',
                disabled: state.busy,
                style: button({
                  background: 'var(--dsw-alias-state-error-primary, #dc2626)',
                  borderColor: 'var(--dsw-alias-state-error-primary, #dc2626)',
                  color: '#fff',
                }),
                onClick: async () => {
                  // Two clicks can land before React re-renders the disabled
                  // button, and the second would race the first for the same id.
                  if (store.busy) return
                  update({ busy: true, error: null })
                  const sessionId = pending.sessionId
                  // Hide the row now, while the registry can still see the
                  // Session it belongs to (see `archiveQuietly`).
                  const archivedLocally = await archiveQuietly(runtime.ctx, sessionId)
                  const fail = async (message) => {
                    if (archivedLocally) await unarchiveQuietly(runtime.ctx, sessionId)
                    update({ busy: false, error: message })
                  }
                  try {
                    const response = await window.fetch(API + '/delete', {
                      method: 'POST',
                      credentials: 'same-origin',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({
                        sessionId,
                        mode: pending.permanent === true ? 'purge' : 'trash',
                      }),
                    })
                    const payload = await response.json().catch(() => ({}))
                    const result = payload && payload.result
                    if (!response.ok || !result || result.deleted !== true) {
                      await fail(
                        (result && result.message) ||
                          (payload && payload.error) ||
                          '删除失败（HTTP ' + response.status + '）',
                      )
                      return
                    }
                    // Anything short of a confirmed archive means the row may
                    // still be listed — including a Host too old to report it.
                    const note =
                      result.archived !== true && !archivedLocally
                        ? ' 侧边栏可能仍显示这个对话。'
                        : ''
                    update({
                      busy: false,
                      error: null,
                      pending: null,
                      done: {
                        title: pending.displayTitle || sessionId,
                        message: (result.message || '') + note,
                      },
                    })
                    // Report, do not act: see `rowStillListed`.
                    if (await rowStillListed(sessionId, 900)) {
                      const shown = store.done || {}
                      update({
                        done: Object.assign({}, shown, {
                          message:
                            (shown.message || '') + '侧边栏还在显示它：重启 DSH 后这一行会消失。',
                        }),
                      })
                    }
                  } catch (error) {
                    await fail(String((error && error.message) || error))
                  }
                },
              },
              state.busy ? '删除中…' : permanent ? '永久删除' : '删除',
            ),
          ),
        )
      } else {
        children.push(
          h(
            'div',
            { key: 'done', style: { fontSize: '13px', lineHeight: 1.6 } },
            '已删除 ',
            h('strong', null, state.done.title),
            '。',
            state.done.message ? ' ' + state.done.message : '',
          ),
        )
      }

      return h(
        'div',
        {
          'data-dsh-session-delete': pending ? 'dialog' : 'toast',
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 2147483000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: pending ? 'rgba(0,0,0,0.45)' : 'transparent',
            pointerEvents: pending ? 'auto' : 'none',
          },
          onClick: pending
            ? (event) => {
                if (event.target === event.currentTarget && !state.busy) {
                  update({ pending: null, busy: false, error: null })
                }
              }
            : undefined,
        },
        // The toast must stay click-through: the wrapper covers the whole
        // frame, so re-enabling pointer events here would swallow every click in
        // the middle of the app for as long as the result is on screen.
        h('div', { style: card }, children),
      )
    }

    /**
     * Read a service this plugin does not declare in `inject`.
     *
     * `ctx.get(name)` comes first deliberately: the client runtime gates a
     * direct `ctx[name]` read on the fiber's `inject` list and *reports* the
     * violation upstream even when the local try/catch swallows the throw. Adding
     * `workspaces` to `inject` instead would park the whole package wherever no
     * workspace service is composed, taking the menu entry with it.
     */
    function safeService(ctx, key) {
      try {
        const resolved = ctx && ctx.get && ctx.get(key)
        if (resolved !== undefined && resolved !== null) return resolved
      } catch {
        /* a context without a reflective lookup falls through */
      }
      try {
        return (ctx && ctx[key]) || null
      } catch {
        return null
      }
    }

    const inject = ['slots']

    function apply(ctx) {
      runtime.ctx = ctx
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
        ctx.slots.register(
          {
            name: 'sidebar.workspaces.session.menu.item',
            id: 'session-delete',
            order: 500,
            label: () => '删除对话',
          },
          DeleteSessionMenuItem,
        ),
      )
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          { name: 'shell.overlay', id: 'session-delete-overlay', order: 900 },
          DeleteSessionOverlay,
        ),
      )
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
