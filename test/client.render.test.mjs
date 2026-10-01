// Client render smoke tests: load lib/client.js the way the dsh client kernel
// does (window.__ModuleLoader__ + a require shim), mount the settings section
// through its slot generator, and drive it with real React inside jsdom.
// Guards the render paths that host tests cannot see (hooks/TDZ errors, the
// pending-banner branches, row filtering).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import './client-test-env.mjs'
import React from 'react'
import { createRoot } from 'react-dom/client'

// Every symbol lib/client.js pulls out of the official primitives package is a
// hard upgrade dependency, and a renamed one arrives as `undefined` rather than
// as an error. That is how dsh 0.1.7's size-neutral icon rename
// (`IconArchiveOutline20` → `IconArchiveOutlineRegular`) threw React error #130
// and blanked the whole settings pane. The Proxy below turns the next rename
// into a loud failure at require time instead.
//
// `MenuItemButton` is stubbed as a real clickable `role="menuitem"` button: the
// menu-item tests must click it, so the icons' bare `() => null` would make the
// behaviour under test unreachable. It also RECORDS the props it was given —
// `danger`/`separatorBefore`/`icon` are invisible in a text snapshot, so before
// this the "red destructive row" was asserted only by a manual e2e run and
// dropping them kept the suite green.
const PRIMITIVE_NAMES = ['IconArchiveOutlineRegular', 'IconCheckOutlineRegular', 'IconLoadingOutlineRegular', 'IconRefreshOutlineRegular', 'IconTrashOutlineRegular', 'IconWarningOutlineRegular']
/** Props of the most recent `MenuItemButton` render (see `renderMenuItem`). */
let lastMenuButtonProps = null
const requireShim = (name) => {
  if (name === 'react') return React
  if (name === '@deepseek-ai/dsh-client-ui-primitives') {
    const stubs = Object.fromEntries(PRIMITIVE_NAMES.map((icon) => [icon, () => null]))
    stubs.MenuItemButton = (props) => {
      lastMenuButtonProps = props
      return React.createElement('button', { type: 'button', role: 'menuitem', onClick: props.onSelect }, props.children)
    }
    return new Proxy(stubs, {
      get(target, prop) {
        if (typeof prop === 'string' && !(prop in target)) {
          throw new Error(`lib/client.js requires @deepseek-ai/dsh-client-ui-primitives.${prop}, which the installed dsh does not export — check the name`)
        }
        return target[prop]
      },
    })
  }
  throw new Error(`unexpected require: ${name}`)
}

let moduleDef = null
globalThis.window.__ModuleLoader__ = { load: (def) => { moduleDef = def } }
await import('../lib/client.js')

const mod = moduleDef.factory(requireShim)
assert.equal(typeof mod.apply, 'function')
assert.deepEqual(mod.inject, ['slots', 'locale'])
const act = React.act ?? ((fn) => fn())

function makeCtx(registry = services) {
  const components = new Map()
  const specs = new Map()
  // Cleanups are captured BY LABEL so a test can run exactly one of them.
  // `effect` used to just call fn() and drop the disposer, which made every
  // teardown path (dialog close, injected DOM removal, subscription release)
  // structurally untestable.
  const disposers = new Map()
  let dict = null
  const ctx = {
    // The locale dictionaries are captured here (production registers the same
    // object through the same call) so the parity test can compare zh against en.
    locale: { register(_ns, dictionaries) { dict = dictionaries }, bind: () => (key) => key },
    // Services resolve through this mutable registry: the fakes below mirror the
    // OFFICIAL client surface, so a component that asks for something the real
    // service does not carry fails loudly instead of silently skipping.
    // A second ctx can be given its own registry (see the retry/debounce tests).
    get: (name) => registry[name],
    effect: (fn, label) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.set(label ?? `effect-${disposers.size}`, dispose)
      return dispose
    },
    logger: {},
    slots: {
      inject(_name, generator) {
        const iterator = generator()
        let step = iterator.next()
        while (!step.done) step = iterator.next(step.value)
      },
      register(spec, component) {
        // Keyed by slot name. apply() registers into two slots now, and the
        // single shared variable this used to be would leave the LAST
        // registration winning — every settings test below would silently
        // mount the menu item instead.
        components.set(spec.name, component)
        specs.set(spec.name, spec)
        return { id: spec.id ?? 'session-manager' }
      },
    },
  }
  return {
    ctx,
    section: () => components.get('settings.section'),
    sectionSpec: () => specs.get('settings.section'),
    menuItem: () => components.get('sidebar.workspaces.session.menu.item'),
    menuSpec: () => specs.get('sidebar.workspaces.session.menu.item'),
    dict: () => dict,
    /** Run the cleanup registered under `label` (no-op when there is none). */
    runDisposer: (label) => {
      const dispose = disposers.get(label)
      if (typeof dispose === 'function') dispose()
    },
  }
}

const services = { sessions: undefined, workspaces: undefined, connection: undefined, remote: undefined }
const { ctx, section, sectionSpec, menuItem, menuSpec, dict, runDisposer } = makeCtx()
mod.apply(ctx)

// ── service fakes: the OFFICIAL surface only ────────────────────────────────
//
// The real `ctx.get('sessions')` service carries `list` (a snapshot store) and
// `refresh()` — never `refreshList()`, which lives on its internal manager. The
// guard below is the primitives-guard trick again: a stale name must fail here
// rather than silently disabling the refresh path in production.
function guardSurface(target, label) {
  return new Proxy(target, {
    get(t, prop) {
      if (typeof prop === 'string' && !(prop in t)) {
        throw new Error(`${label}.${String(prop)} is not on the official dsh client service surface — check the installed module`)
      }
      return t[prop]
    },
  })
}

/** Static snapshot store (workspaces: push-driven, no public refresh). */
const makeStore = (snapshot) => ({ subscribe: () => () => {}, getSnapshot: () => snapshot })

/**
 * Sessions service fake. `onRefresh(snapshot)` may return the next snapshot,
 * modelling the server list: the default drops the id, which is exactly how the
 * real `refreshUntilGone` reaches its success path.
 */
function makeSessionsService(initial, { onRefresh } = {}) {
  let snapshot = initial
  const listeners = new Set()
  const list = {
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot: () => snapshot,
  }
  const refresh = async () => {
    if (typeof onRefresh !== 'function') return
    const next = await onRefresh(snapshot)
    if (next === undefined) return
    snapshot = next
    for (const listener of [...listeners]) listener()
  }
  return guardSurface({ list, refresh }, 'sessions')
}

/** Refresh hook that removes one id from the snapshot (the server-list effect). */
const dropsId = (sessionId) => (snapshot) => ({
  byId: Object.fromEntries(Object.entries(snapshot.byId).filter(([id]) => id !== sessionId)),
  ids: snapshot.ids.filter((id) => id !== sessionId),
  phase: snapshot.phase,
})

const ID = 'session-3012b8a0-1fef-4f34-8d9c-a6c5b7aa84d2'
const TOMBSTONE = 'session-7c9f1d2e-4a5b-4c8d-9e0f-1a2b3c4d5e6f'
const sessions = makeSessionsService(
  { byId: { [ID]: { displayTitle: 'Hello world', cwd: 'C:\\x', updatedAt: 100, running: false } }, ids: [ID], phase: 'ready' },
  { onRefresh: dropsId(ID) },
)
const workspaces = guardSurface(
  { list: makeStore({ items: [{ workspaceId: 'w1', title: 'test', path: 'C:/x', sessionIds: [ID] }], archivedSessionIds: [ID, TOMBSTONE] }) },
  'workspaces',
)
services.sessions = sessions
services.workspaces = workspaces

/**
 * Point BOTH the component props and the closure's `ctx.get('sessions')` at one
 * fake. `refreshUntilGone` resolves the service itself, so overriding only the
 * prop would leave the real polling path talking to the default fake.
 * @returns a restore function for the test's finally block.
 */
function useSessionsService(service) {
  const previous = services.sessions
  services.sessions = service
  return () => { services.sessions = previous }
}

/**
 * Mount the settings section with the props PRODUCTION injects — taken from the
 * registered spec's own inject face, so the real `refreshUntilGone` closure takes
 * part instead of a test double. `rpc` is overridden when one is given; call it
 * with NO arguments to keep the production wrapper (the `ctx.get('connection')`
 * path) and drive that instead.
 *
 * An override patches BOTH the value and the LIVE getter: the inject face
 * carries `getSessions`/`getWorkspaces` because the renderer caches `inject()`
 * per entry for the entry's lifetime, and the component prefers the getter —
 * overriding only the value would be silently ignored.
 */
async function renderSection(rpc, sessionsOverride, workspacesOverride, extraProps) {
  const base = sectionSpec().inject()
  const props = {
    ...base,
    // Only spread the override when one was supplied: `{ ...base, rpc: undefined }`
    // would ERASE the production wrapper, which is exactly what the tests that
    // drive the real one must not do.
    ...(rpc === undefined ? {} : { rpc }),
    ...(sessionsOverride === undefined ? {} : { sessions: sessionsOverride, getSessions: () => sessionsOverride }),
    ...(workspacesOverride === undefined ? {} : { workspaces: workspacesOverride, getWorkspaces: () => workspacesOverride }),
    ...(extraProps ?? {}),
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(React.createElement(section(), props)) })
  // Macrotask flush: the mount effects (deferred/list, ping) settle through
  // promise chains + the host RPC envelope; a plain microtask turn is not
  // enough to drain the resulting state updates inside act().
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return { text: container.textContent, container, cleanup: async () => { await act(async () => { root.unmount() }); container.remove() } }
}

test('settings section renders rows and collapses cleaned-up (data-gone) pending ids', async () => {
  const rpc = (endpoint) => {
    if (endpoint === 'deferred/list') return Promise.resolve({ sessionIds: [TOMBSTONE], recoverable: [] })
    if (endpoint === 'ping') return Promise.resolve({ version: '0.2.0', menuDeleteAvailable: true })
    return new Promise(() => {})
  }
  const { text, cleanup } = await renderSection(rpc)
  try {
    assert.ok(text.includes('Hello world'), 'visible archived row renders')
    assert.ok(!text.includes('unknownSession'), 'tombstoned id without a summary must be filtered out of the rows')
    // A cleaned-up entry has nothing left to act on: it collapses into one
    // summary line (plus an expander) instead of occupying a banner row.
    assert.ok(text.includes('pendingFinalizedBanner'), 'cleaned-up entries collapse into their own summary line')
    assert.ok(!text.includes('pendingBanner'), 'the actionable banner heading is not used when nothing is cancellable')
    assert.ok(!text.includes('pendingCancel'), 'no cancel button without files on disk')
    assert.ok(!text.includes('pendingFinalizing'), 'the per-entry finalizing row stays collapsed')
    assert.ok(text.includes('pendingShowFinalized'), 'an expander is offered for the ids')
    assert.ok(!text.includes(TOMBSTONE), 'the collapsed id is not rendered until expanded')
  } finally {
    await cleanup()
  }
})

test('expanding the cleaned-up list reveals the ids and their hint', async () => {
  const rpc = (endpoint) => {
    if (endpoint === 'deferred/list') return Promise.resolve({ sessionIds: [TOMBSTONE], recoverable: [] })
    if (endpoint === 'ping') return Promise.resolve({ version: '0.2.0', menuDeleteAvailable: true })
    return new Promise(() => {})
  }
  const { container, cleanup } = await renderSection(rpc)
  try {
    const expander = [...container.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'pendingShowFinalized')
    assert.ok(expander, 'the expander button renders')
    assert.equal(expander.getAttribute('aria-expanded'), 'false', 'it starts collapsed')
    await act(async () => { expander.click() })
    assert.ok(container.textContent.includes(TOMBSTONE), 'expanding reveals the queued id')
    assert.ok(container.textContent.includes('pendingFinalizing'), 'expanding reveals the per-entry hint')
    assert.ok(!container.textContent.includes('pendingCancel'), 'a data-gone entry still offers no cancel')
    const collapse = [...container.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'pendingHideFinalized')
    assert.equal(collapse.getAttribute('aria-expanded'), 'true', 'the expander flips its state')
    await act(async () => { collapse.click() })
    assert.ok(!container.textContent.includes(TOMBSTONE), 'collapsing hides the id again')
  } finally {
    await cleanup()
  }
})

test('a mixed queue keeps the actionable rows while collapsing the cleaned-up ones', async () => {
  const GHOST = 'session-4d5e6f70-8a9b-4c1d-9e2f-3a4b5c6d7e8f'
  const rpc = (endpoint) => {
    if (endpoint === 'deferred/list') return Promise.resolve({ sessionIds: [TOMBSTONE, GHOST], recoverable: [TOMBSTONE] })
    if (endpoint === 'ping') return Promise.resolve({ version: '0.2.0', menuDeleteAvailable: true })
    return new Promise(() => {})
  }
  const { text, cleanup } = await renderSection(rpc)
  try {
    assert.ok(text.includes('pendingBanner'), 'the actionable heading reflects the cancellable count')
    assert.ok(text.includes('pendingCancel'), 'the recoverable entry keeps its cancel button')
    assert.ok(text.includes(TOMBSTONE), 'the cancellable id is listed')
    assert.ok(!text.includes(GHOST), 'the cleaned-up id stays collapsed away')
    assert.ok(text.includes('pendingShowFinalized'), 'the collapsed group is still discoverable')
  } finally {
    await cleanup()
  }
})

test('recoverable pending entry keeps its cancel button', async () => {
  const rpc = (endpoint) => {
    if (endpoint === 'deferred/list') return Promise.resolve({ sessionIds: [TOMBSTONE], recoverable: [TOMBSTONE] })
    if (endpoint === 'ping') return Promise.resolve({ version: '0.2.1', menuDeleteAvailable: true })
    return new Promise(() => {})
  }
  const { text, cleanup } = await renderSection(rpc)
  try {
    assert.ok(text.includes('pendingCancel'), 'recoverable entry offers cancel deletion')
    assert.ok(text.includes('pendingBanner'), 'the actionable heading is used when something is cancellable')
    assert.ok(!text.includes('pendingFinalizing'), 'no finalizing hint for a recoverable entry')
    assert.ok(!text.includes('pendingShowFinalized'), 'no cleaned-up expander when every entry is actionable')
  } finally {
    await cleanup()
  }
})

test('refresh button spins while a refresh is in flight', async () => {
  let resolveRefresh
  const sessionsRefreshing = makeSessionsService(
    sessions.list.getSnapshot(),
    { onRefresh: () => new Promise((resolve) => { resolveRefresh = resolve }) },
  )
  const rpc = (endpoint) => {
    if (endpoint === 'deferred/list') return Promise.resolve({ sessionIds: [], recoverable: [] })
    if (endpoint === 'ping') return Promise.resolve({ version: '0.2.1', menuDeleteAvailable: true })
    return new Promise(() => {})
  }
  // The Refresh button now pulls through the injected helper, which resolves
  // `getSessions()` itself — so the fake must be installed in the registry too,
  // not only handed to the component as a prop.
  const restoreSessions = useSessionsService(sessionsRefreshing)
  const { container, cleanup } = await renderSection(rpc, sessionsRefreshing)
  try {
    const button = [...container.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'refresh')
    assert.ok(button, 'refresh button renders')
    await act(async () => { button.click(); await Promise.resolve() })
    const spinner = container.querySelector('span[style*="sm-spin"]')
    assert.ok(spinner, 'icon spins while the refresh is in flight')
    assert.equal(button.disabled, true, 'button is disabled while refreshing')
    await act(async () => { resolveRefresh(); await Promise.resolve() })
    assert.ok(container.querySelector('span[style*="sm-spin"]'), 'spin persists for the minimum turn even after an instant refresh')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 900)) })
    assert.equal(container.querySelector('span[style*="sm-spin"]'), null, 'spin stops after the minimum turn')
    assert.equal(button.disabled, false, 'button re-enabled after the refresh')
  } finally {
    await cleanup()
    restoreSessions()
  }
})

test('confirm dialog card uses the official opaque modal surface, not the translucent menu one', async () => {
  const calls = []
  const rpc = (endpoint) => {
    calls.push([endpoint])
    if (endpoint === 'deferred/list') return Promise.resolve({ sessionIds: [], recoverable: [] })
    if (endpoint === 'ping') return Promise.resolve({ version: '0.4.1', menuDeleteAvailable: true })
    return new Promise(() => {})
  }
  const { container, cleanup } = await renderSection(rpc)
  const originalRect = window.HTMLElement.prototype.getBoundingClientRect
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, width: 1200, height: 800, bottom: 800, right: 1200, toJSON() {} })
  try {
    const deleteButton = [...container.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'delete')
    assert.ok(deleteButton, 'row delete button renders')
    await act(async () => { deleteButton.click(); await new Promise((resolve) => setTimeout(resolve, 0)) })
    const overlay = document.querySelector('[data-sm-confirm]')
    assert.ok(overlay, 'the confirm dialog opened')
    // `--dsw-specific-menu` is a 94%-alpha popover fill; taking it made the
    // dialog read as see-through. A modal card must use the opaque layer-2
    // surface with the official panel geometry (Modal.module.css).
    const card = overlay.firstElementChild
    assert.ok(card, 'the dialog card renders')
    assert.ok(card.style.background.includes('--dsw-alias-bg-layer-2'), 'the card sits on the opaque layer-2 surface')
    assert.ok(!card.style.background.includes('--dsw-specific-menu'), 'the translucent menu surface is gone from the dialog')
    assert.ok(card.style.borderRadius.includes('--dsw-radius-panel'), 'the card uses the official panel radius')
    assert.ok(card.style.boxShadow.includes('--dsw-elevation-prominent'), 'the card uses the official prominent elevation')
    assert.ok(overlay.style.background.includes('--dsw-alias-bg-mask-1'), 'the backdrop uses the official mask token')
    const confirmButton = [...overlay.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'confirm')
    assert.equal(confirmButton.style.height, '36px', 'the confirm action uses the official control height (Button md)')
    assert.ok(confirmButton.style.borderRadius.includes('--dsw-radius-md'), 'and the shared control radius')
    await act(async () => {
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    assert.equal(document.querySelector('[data-sm-confirm]'), null, 'Escape closes the dialog again')
  } finally {
    window.HTMLElement.prototype.getBoundingClientRect = originalRect
    await cleanup()
  }
})

test('confirm dialog: cancel-focused safe defaults, Enter never confirms, Delete click does', async () => {
  const calls = []
  const rpc = (endpoint, payload) => {
    calls.push([endpoint, payload && payload.sessionId])
    if (endpoint === 'deferred/list') return Promise.resolve({ sessionIds: [], recoverable: [] })
    if (endpoint === 'ping') return Promise.resolve({ version: '0.3.0', menuDeleteAvailable: true })
    return new Promise(() => {})
  }
  const { container, cleanup } = await renderSection(rpc)
  // The dialog self-checks its overlay covers the viewport (degraded-CSS
  // defense); jsdom reports all-zero rects, so emulate a laid-out page.
  const originalRect = window.HTMLElement.prototype.getBoundingClientRect
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, width: 1200, height: 800, bottom: 800, right: 1200, toJSON() {} })
  try {
    const deleteButton = [...container.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'delete')
    assert.ok(deleteButton, 'row delete button renders')
    await act(async () => { deleteButton.click(); await new Promise((resolve) => setTimeout(resolve, 0)) })
    const overlay = document.querySelector('[data-sm-confirm]')
    assert.ok(overlay, 'the irreversible-delete confirm opens')
    const buttons = [...overlay.querySelectorAll('button')]
    const cancelButton = buttons.find((b) => (b.textContent || '').trim() === 'cancel')
    const confirmButton = buttons.find((b) => (b.textContent || '').trim() === 'confirm')
    assert.ok(cancelButton && confirmButton, 'both dialog buttons render')
    assert.equal(document.activeElement, cancelButton, 'cancel carries the default focus')

    // Enter alone must NOT confirm an irreversible physical delete.
    await act(async () => {
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    assert.ok(document.querySelector('[data-sm-confirm]'), 'Enter does not dismiss the dialog')
    assert.ok(!calls.some(([endpoint]) => endpoint === 'delete'), 'Enter never reaches the host RPC')

    // Escape cancels.
    await act(async () => {
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    assert.equal(document.querySelector('[data-sm-confirm]'), null, 'Escape closes the dialog')
    assert.ok(!calls.some(([endpoint]) => endpoint === 'delete'), 'Escape performs no delete')

    // An explicit Delete click still performs the delete.
    await act(async () => { deleteButton.click(); await new Promise((resolve) => setTimeout(resolve, 0)) })
    const overlay2 = document.querySelector('[data-sm-confirm]')
    assert.ok(overlay2, 'the dialog reopens for a fresh decision')
    await act(async () => {
      ;[...overlay2.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'confirm').click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    assert.ok(calls.some(([endpoint, id]) => endpoint === 'delete' && id === ID), 'explicit Delete click calls the RPC')
  } finally {
    window.HTMLElement.prototype.getBoundingClientRect = originalRect
    await cleanup()
  }
})

// ── bulk delete (select-all) ------------------------------------------------
const ID2 = 'session-9a1f2b3c-4d5e-4f60-8a71-2b3c4d5e6f70'
const ID3 = 'session-5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7081'

/** Three archived rows: two idle, one running. */
function bulkFixture() {
  const byId = {
    [ID]: { displayTitle: 'Alpha', cwd: 'C:/x', updatedAt: 300, running: false },
    [ID2]: { displayTitle: 'Beta', cwd: 'C:/x', updatedAt: 200, running: false },
    [ID3]: { displayTitle: 'Gamma', cwd: 'C:/x', updatedAt: 100, running: true },
  }
  const sess = makeSessionsService({ byId, ids: [ID, ID2, ID3], phase: 'ready' })
  const ws = guardSurface({
    list: makeStore({ items: [{ workspaceId: 'w1', title: 'test', path: 'C:/x', sessionIds: [ID, ID2, ID3] }], archivedSessionIds: [ID, ID2, ID3] }),
  }, 'workspaces')
  return { sess, ws }
}

/** jsdom lays nothing out; the dialog's degraded-CSS self-check needs a rect. */
function withLayout(fn) {
  const original = window.HTMLElement.prototype.getBoundingClientRect
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, width: 1200, height: 800, bottom: 800, right: 1200, toJSON() {} })
  return Promise.resolve().then(fn).finally(() => { window.HTMLElement.prototype.getBoundingClientRect = original })
}

const rowBoxes = (container) => [...container.querySelectorAll('input[type="checkbox"]')].filter((box) => box.getAttribute('aria-label') !== 'selectAll')
const rowCheckbox = (container, index) => rowBoxes(container)[index]
const selectAllBox = (container) => [...container.querySelectorAll('input[type="checkbox"]')].find((box) => box.getAttribute('aria-label') === 'selectAll')
const bulkButton = (container) => [...container.querySelectorAll('button')].find((b) => (b.textContent || '').trim().startsWith('deleteSelected'))

// ── the per-row actions, driven through real clicks ─────────────────────────
//
// These three paths had NO click coverage: the section's Restore button, its
// Cancel-deletion button, and the `origin === 'subagent'` row filter were only
// asserted by reading their presence in the rendered text, so a refactor that
// wired the wrong handler (or dropped the filter) kept the suite green.

const OK_PING_AND_QUEUE = (sessionIds = [], recoverable = []) => (endpoint) => {
  if (endpoint === 'ping') return Promise.resolve({ version: '0.2.0', menuDeleteAvailable: true })
  if (endpoint === 'deferred/list') return Promise.resolve({ sessionIds, recoverable })
  return new Promise(() => {})
}

test('the Restore button restores the row and reports it', async () => {
  const calls = []
  const base = OK_PING_AND_QUEUE()
  const rpc = (endpoint, payload) => {
    calls.push([endpoint, payload?.sessionId])
    if (endpoint === 'restore') return Promise.resolve({ sessionId: payload.sessionId, restored: true })
    return base(endpoint)
  }
  const { container, cleanup } = await renderSection(rpc)
  try {
    const button = [...container.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'restore')
    assert.ok(button, 'the row offers Restore')
    assert.equal(button.disabled, false, 'and it is enabled')
    await act(async () => { button.click(); await settle() })
    assert.deepEqual(calls.filter(([endpoint]) => endpoint === 'restore'), [['restore', ID]], 'the click calls rpc restore with the exact id')
    assert.ok(container.textContent.includes('restoreOk'), 'the success toast names the key')
  } finally {
    await cleanup()
  }
})

test('a refused Restore reaches the alert region', async () => {
  const base = OK_PING_AND_QUEUE()
  const rpc = (endpoint) => {
    if (endpoint === 'restore') return Promise.reject(Object.assign(new Error('session/not-found'), { code: 'session/not-found' }))
    return base(endpoint)
  }
  const { container, cleanup } = await renderSection(rpc)
  try {
    const button = [...container.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'restore')
    await act(async () => { button.click(); await settle() })
    const alert = container.querySelector('[role="alert"]')
    assert.ok(alert, 'the failure is surfaced in the alert region')
    assert.ok(alert.textContent.includes('session/not-found'), 'and it keeps the host code for support')
  } finally {
    await cleanup()
  }
})

test('the settings Cancel-deletion button cancels the queued deletion', async () => {
  const calls = []
  const base = OK_PING_AND_QUEUE([TOMBSTONE], [TOMBSTONE])
  const rpc = (endpoint, payload) => {
    calls.push([endpoint, payload?.sessionId])
    if (endpoint === 'deferred/cancel') return Promise.resolve({ sessionIds: [], reattached: [], warnings: [] })
    return base(endpoint)
  }
  const { container, cleanup } = await renderSection(rpc)
  try {
    const button = [...container.querySelectorAll('button')].find((b) => (b.textContent || '').trim().startsWith('pendingCancel'))
    assert.ok(button, 'a recoverable entry offers Cancel deletion')
    await act(async () => { button.click(); await settle() })
    assert.deepEqual(calls.filter(([endpoint]) => endpoint === 'deferred/cancel'), [['deferred/cancel', TOMBSTONE]], 'the click cancels THAT id')
    assert.ok(container.textContent.includes('pendingCancelOk'), 'and it confirms')
  } finally {
    await cleanup()
  }
})

test('a cancel that could not restore the workspace slot says so', async () => {
  // The host restores the slot the delete removed; when it cannot, the session
  // comes back UNGROUPED — the user must be told, not left to hunt for it.
  const base = OK_PING_AND_QUEUE([TOMBSTONE], [TOMBSTONE])
  const rpc = (endpoint) => {
    if (endpoint === 'deferred/cancel') {
      return Promise.resolve({ sessionIds: [], reattached: [], warnings: ['workspace "ws-1" no longer exists; the session was restored but not re-grouped'] })
    }
    return base(endpoint)
  }
  const { container, cleanup } = await renderSection(rpc)
  try {
    const button = [...container.querySelectorAll('button')].find((b) => (b.textContent || '').trim().startsWith('pendingCancel'))
    await act(async () => { button.click(); await settle() })
    const alert = container.querySelector('[role="alert"]')
    assert.ok(alert, 'the host warning is surfaced')
    assert.ok(alert.textContent.includes('not re-grouped'), 'and it explains what the user will see instead')
  } finally {
    await cleanup()
  }
})

test('a subagent-origin archived row is filtered out of the settings page', async () => {
  const ID4 = 'session-1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
  const byId = {
    [ID]: { displayTitle: 'Alpha', cwd: 'C:/x', updatedAt: 300, running: false },
    [ID2]: { displayTitle: 'Beta', cwd: 'C:/x', updatedAt: 200, running: false },
    [ID3]: { displayTitle: 'Gamma', cwd: 'C:/x', updatedAt: 100, running: true },
    [ID4]: { displayTitle: 'Subagent work', cwd: 'C:/x', updatedAt: 400, running: false, origin: 'subagent' },
  }
  const sessions = makeSessionsService({ byId, ids: [ID, ID2, ID3, ID4], phase: 'ready' })
  const workspaces = guardSurface({
    list: makeStore({ items: [{ workspaceId: 'w1', title: 'test', path: 'C:/x', sessionIds: [ID, ID2, ID3, ID4] }], archivedSessionIds: [ID, ID2, ID3, ID4] }),
  }, 'workspaces')
  const { container, text, cleanup } = await renderSection(OK_PING_AND_QUEUE(), sessions, workspaces)
  try {
    assert.ok(text.includes('Alpha'), 'operator rows still render')
    assert.ok(!text.includes('Subagent work'), 'a subagent-origin row never renders')
    assert.ok(!container.textContent.includes(ID4), 'and its id is not rendered either')
  } finally {
    await cleanup()
  }
})

test('a row whose title is EMPTY falls back to the placeholder, not a blank line', async () => {
  // `??` only rejects null/undefined, so an empty displayTitle rendered as a
  // blank row — indistinguishable from a render failure.
  const ID_EMPTY = 'session-2b3c4d5e-6f70-4a1b-8c2d-3e4f5a6b7c8d'
  const sessions = makeSessionsService({
    byId: {
      [ID]: { displayTitle: 'Alpha', cwd: 'C:/x', updatedAt: 300, running: false },
      [ID_EMPTY]: { displayTitle: '', title: '', cwd: 'C:/x', updatedAt: 200, running: false },
    },
    ids: [ID, ID_EMPTY],
    phase: 'ready',
  })
  const workspaces = guardSurface({
    list: makeStore({ items: [{ workspaceId: 'w1', title: 'test', path: 'C:/x', sessionIds: [ID, ID_EMPTY] }], archivedSessionIds: [ID, ID_EMPTY] }),
  }, 'workspaces')
  const { text, cleanup } = await renderSection(OK_PING_AND_QUEUE(), sessions, workspaces)
  try {
    assert.ok(text.includes('Alpha'), 'a titled row still shows its title')
    assert.ok(text.includes('unknownSession'), 'an empty title renders the placeholder instead of nothing')
  } finally {
    await cleanup()
  }
})

test('a toast timer is pruned when it fires', async (t) => {
  // `toastTimers` is only ever cleared wholesale on unmount, so without pruning a
  // long-lived page accumulates one dead handle per toast, forever.
  //
  // The mock clock is enabled AFTER the mount on purpose: `renderSection`'s
  // macrotask flush (and `settle`) use a REAL setTimeout, so trapping timers
  // first would hang the mount.
  const base = OK_PING_AND_QUEUE([TOMBSTONE], [TOMBSTONE])
  const rpc = (endpoint) => (endpoint === 'deferred/cancel'
    ? Promise.resolve({ sessionIds: [], reattached: [], warnings: [] })
    : base(endpoint))
  const { container, cleanup } = await renderSection(rpc)

  t.mock.timers.enable({ apis: ['setTimeout'] })
  const scheduled = []
  const originalSet = globalThis.setTimeout
  const originalClear = globalThis.clearTimeout
  const cleared = []
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const handle = originalSet(fn, ms, ...rest)
    scheduled.push({ handle, ms })
    return handle
  }
  globalThis.clearTimeout = (handle) => {
    cleared.push(handle)
    return originalClear(handle)
  }
  const flushImmediate = () => new Promise((resolve) => setImmediate(resolve))
  try {
    const button = [...container.querySelectorAll('button')].find((b) => (b.textContent || '').trim().startsWith('pendingCancel'))
    await act(async () => { button.click(); await flushImmediate() })
    assert.ok(container.textContent.includes('pendingCancelOk'), 'a toast was raised')
    const toastTimer = scheduled.find((entry) => entry.ms === 5000)
    assert.ok(toastTimer, 'and it scheduled its own 5s dismissal')

    // Everything scheduled has now fired (the toast plus the 800ms spinner).
    t.mock.timers.tick(6000)
    await act(async () => { await flushImmediate() })
    await cleanup()
    assert.ok(!cleared.includes(toastTimer.handle), 'a FIRED timer is gone from the list, so unmount does not clear a dead handle')
  } finally {
    globalThis.setTimeout = originalSet
    globalThis.clearTimeout = originalClear
  }
})
const idleRpc = (calls, extra) => (endpoint, payload) => {
  calls.push([endpoint, payload && payload.sessionId])
  if (endpoint === 'deferred/list') return Promise.resolve({ sessionIds: [], recoverable: [] })
  if (endpoint === 'ping') return Promise.resolve({ version: '0.3.4', menuDeleteAvailable: true })
  if (endpoint === 'delete' && extra !== undefined) return extra(payload)
  if (endpoint === 'delete') return Promise.resolve({ sessionId: payload.sessionId, deleted: true })
  return new Promise(() => {})
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const confirmBulk = async (overlay) => {
  const label = [...overlay.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'deleteBulkConfirmLabel')
  await act(async () => { label.click(); await settle() })
}

test('select-all checkbox drives the selection and the delete button count', async () => {
  const { sess, ws } = bulkFixture()
  const calls = []
  const { container, cleanup } = await renderSection(idleRpc(calls), sess, ws)
  try {
    assert.ok(selectAllBox(container), 'the select-all checkbox renders')
    const bulk = bulkButton(container)
    assert.ok(bulk, 'the bulk delete button renders')
    assert.equal(bulk.disabled, true, 'bulk delete is disabled with an empty selection')
    assert.ok(bulk.textContent.includes('deleteSelected'), 'the button localizes its label')

    await act(async () => { rowCheckbox(container, 0).click() })
    assert.equal(bulkButton(container).disabled, false, 'bulk delete enables once a row is selected')
    assert.equal(selectAllBox(container).indeterminate, true, 'the header checkbox is indeterminate on a partial selection')

    await act(async () => { selectAllBox(container).click() })
    assert.equal(selectAllBox(container).checked, true, 'select-all checks every row')
    assert.equal(selectAllBox(container).indeterminate, false, 'no indeterminate state when all rows are selected')
    assert.equal(rowBoxes(container).every((box) => box.checked), true, 'every row checkbox mirrors select-all')

    await act(async () => { selectAllBox(container).click() })
    assert.equal(bulkButton(container).disabled, true, 'a second click clears the selection')
    assert.equal(rowBoxes(container).some((box) => box.checked), false, 'no row stays checked')
    assert.ok(!calls.some(([endpoint]) => endpoint === 'delete'), 'selection alone never deletes anything')
  } finally {
    await cleanup()
  }
})

test('bulk delete deletes the selected idle sessions and skips running ones', async () => {
  const { sess, ws } = bulkFixture()
  const calls = []
  await withLayout(async () => {
    const { container, cleanup } = await renderSection(idleRpc(calls), sess, ws)
    try {
      await act(async () => { selectAllBox(container).click() })
      await act(async () => { bulkButton(container).click(); await settle() })

      const overlay = document.querySelector('[data-sm-confirm]')
      assert.ok(overlay, 'the bulk confirm dialog opens')
      assert.ok(overlay.textContent.includes('deleteBulkConfirmTitle'), 'the title names the bulk action')
      assert.ok(overlay.textContent.includes('deleteBulkRunningNote'), 'the dialog warns that running sessions are skipped')
      const cancel = [...overlay.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'cancel')
      assert.equal(document.activeElement, cancel, 'cancel keeps the default focus')

      await confirmBulk(overlay)

      const deleted = calls.filter(([endpoint]) => endpoint === 'delete').map(([, id]) => id)
      assert.deepEqual(deleted, [ID, ID2], 'both idle sessions are deleted, the running one is skipped')
      assert.ok(!deleted.includes(ID3), 'the running session is never sent to the host')
      assert.ok(container.textContent.includes('deleteBulkOk'), 'a clean run reports the total')
    } finally {
      await cleanup()
    }
  })
})

test('cancelling the bulk confirm deletes nothing and keeps the selection', async () => {
  const { sess, ws } = bulkFixture()
  const calls = []
  await withLayout(async () => {
    const { container, cleanup } = await renderSection(idleRpc(calls), sess, ws)
    try {
      await act(async () => { rowCheckbox(container, 0).click() })
      await act(async () => { bulkButton(container).click(); await settle() })
      assert.ok(document.querySelector('[data-sm-confirm]'), 'the dialog opened')

      // Escape cancels — the same safe default as the single-row confirm.
      await act(async () => { document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
      assert.equal(document.querySelector('[data-sm-confirm]'), null, 'Escape closes the dialog')
      assert.ok(!calls.some(([endpoint]) => endpoint === 'delete'), 'a cancelled bulk delete performs no host call')
      assert.equal(rowCheckbox(container, 0).checked, true, 'the selection survives the cancellation')
    } finally {
      await cleanup()
    }
  })
})

test('a failing session in the batch is reported without aborting the rest', async () => {
  const { sess, ws } = bulkFixture()
  const calls = []
  const rpc = idleRpc(calls, (payload) => {
    // Beta fails; Alpha still goes through (rows sort newest-first).
    if (payload.sessionId === ID2) return Promise.reject(new Error('boom'))
    return Promise.resolve({ sessionId: payload.sessionId, deleted: true })
  })
  await withLayout(async () => {
    const { container, cleanup } = await renderSection(rpc, sess, ws)
    try {
      await act(async () => { rowCheckbox(container, 0).click(); rowCheckbox(container, 1).click() })
      await act(async () => { bulkButton(container).click(); await settle() })
      await confirmBulk(document.querySelector('[data-sm-confirm]'))
      const deleted = calls.filter(([endpoint]) => endpoint === 'delete').map(([, id]) => id)
      assert.deepEqual(deleted, [ID, ID2], 'the failing session does not stop its neighbours')
      assert.ok(container.textContent.includes('deleteBulkPartial'), 'the partial failure is reported')
    } finally {
      await cleanup()
    }
  })
})

test('selecting only running sessions refuses before opening the dialog', async () => {
  const { sess, ws } = bulkFixture()
  const calls = []
  await withLayout(async () => {
    const { container, cleanup } = await renderSection(idleRpc(calls), sess, ws)
    try {
      // Gamma is the running row (oldest updatedAt, rendered last).
      await act(async () => { rowCheckbox(container, 2).click() })
      await act(async () => { bulkButton(container).click(); await settle() })
      assert.equal(document.querySelector('[data-sm-confirm]'), null, 'no dialog for an all-running selection')
      assert.ok(container.textContent.includes('deleteBulkAllRunning'), 'the refusal is explained in place')
      assert.ok(!calls.some(([endpoint]) => endpoint === 'delete'), 'nothing reaches the host')
    } finally {
      await cleanup()
    }
  })
})

// ── session "..." menu item ─────────────────────────────────────────────────
//
// The item is a plain component registered into the official slot
// `sidebar.workspaces.session.menu.item`. These tests exist because the DOM +
// React-fiber augmentation it replaced had no coverage at all: when dsh
// 0.1.7-rc.2 appended a shortcut hint to every menu row's text, the item
// vanished from the menu with a fully green suite.

const toasts = () => [...document.querySelectorAll('[data-sm-toast]')]
const clearToasts = () => { for (const node of toasts()) node.remove() }
const confirmOverlay = () => document.querySelector('[data-sm-confirm]')
const dialogButton = (overlay, label) => [...overlay.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === label)

const menuRpc = (calls, extra) => (endpoint, payload) => {
  calls.push([endpoint, payload && payload.sessionId])
  if (endpoint === 'delete' && extra !== undefined) return extra(payload)
  if (endpoint === 'delete') return Promise.resolve({ sessionId: payload.sessionId, deleted: true })
  return new Promise(() => {})
}

/** Mount the menu item with the props the official slot hands a registrant. */
async function renderMenuItem(options = {}) {
  const {
    rpc, menuEnabled = true, displayTitle = 'Hello world', sessionId = ID,
    refreshAfterDelete = async () => true, onError, translate,
    getMenuEnabled, requestMenuPing,
  } = options
  clearToasts()
  lastMenuButtonProps = null
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const menuOpenCalls = []
  const props = {
    sessionId,
    displayTitle,
    // The framework binds this hook to the row's own open-state pair.
    useMenuOpenState: () => [true, (open) => { menuOpenCalls.push(open) }],
    t: translate ?? ((key) => key),
    rpc: rpc ?? (() => new Promise(() => {})),
    sessions,
    refreshAfterDelete,
    menuEnabled,
    onError,
    ...(getMenuEnabled === undefined ? {} : { getMenuEnabled }),
    ...(requestMenuPing === undefined ? {} : { requestMenuPing }),
  }
  await act(async () => { root.render(React.createElement(menuItem(), props)) })
  await act(async () => { await settle() })
  let mounted = true
  return {
    container,
    menuOpenCalls,
    item: () => container.querySelector('[role="menuitem"]'),
    /** Unmount the row while its dialog is open — what the real menu does the
     *  moment it closes, and the only faithful way to make the dialog's opener
     *  genuinely unreachable (`document.contains(opener) === false`). Removing
     *  the node by hand instead throws inside React's own teardown. */
    unmount: async () => {
      if (!mounted) return
      mounted = false
      await act(async () => { root.unmount() })
    },
    cleanup: async () => {
      // Leaving a dialog open would strand the plugin's one-at-a-time guard
      // and silently neuter every later menu test.
      if (confirmOverlay() !== null) {
        await act(async () => {
          document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
          await settle()
        })
      }
      if (mounted) {
        mounted = false
        await act(async () => { root.unmount() })
      }
      container.remove()
      clearToasts()
    },
  }
}

test('the menu row asks the official primitive for the danger styling', async () => {
  // `danger` / `separatorBefore` / the icon are invisible in a text snapshot, so
  // before the stub recorded them the README's promise ("native danger colors,
  // separator, keyboard behaviour from the menu itself") was asserted only by a
  // manual e2e run — dropping any of them kept this suite green.
  const item = await renderMenuItem({ menuEnabled: true })
  try {
    assert.ok(lastMenuButtonProps, 'MenuItemButton was rendered')
    assert.equal(lastMenuButtonProps.danger, true, 'the row asks for the danger colour')
    assert.equal(lastMenuButtonProps.separatorBefore, true, 'and for the separator above it')
    assert.ok(lastMenuButtonProps.icon, 'and it carries an icon')
    assert.equal(lastMenuButtonProps.icon.props.size, 14, 'at the size the shipped rows use')
  } finally {
    await item.cleanup()
  }
})

test('menu item registers into the official session-menu slot at order 500', () => {
  const spec = menuSpec()
  assert.ok(spec, 'registers into sidebar.workspaces.session.menu.item')
  assert.equal(spec.name, 'sidebar.workspaces.session.menu.item')
  assert.equal(spec.id, 'session-manager-delete', 'the id is package-namespaced')
  assert.equal(spec.order, 500, 'lands after the shipped archive row (order 400)')
  assert.equal(typeof menuItem(), 'function', 'the registration carries the row component')
})

test('menu item renders one menuitem row with the plugin-localized label', async () => {
  const { item, cleanup } = await renderMenuItem()
  try {
    const node = item()
    assert.ok(node, 'the row renders')
    assert.equal(node.getAttribute('role'), 'menuitem', 'it joins the menu keyboard walk')
    assert.equal(node.textContent.trim(), 'menuDelete', 'the label comes from the plugin locale namespace')
  } finally {
    await cleanup()
  }
})

test('menu item stays hidden until the host ping confirms it is welcome', async () => {
  const disabled = await renderMenuItem({ menuEnabled: false })
  try {
    assert.equal(disabled.item(), null, 'menuDeleteAvailable === false hides the row')
  } finally {
    await disabled.cleanup()
  }
  // `null` is the "ping has not answered yet" state; the pre-slot
  // implementation waited on that same answer before appending anything.
  const unanswered = await renderMenuItem({ menuEnabled: null })
  try {
    assert.equal(unanswered.item(), null, 'an unanswered ping hides the row too')
  } finally {
    await unanswered.cleanup()
  }
})

test('selecting the menu item dismisses the menu and opens the confirm dialog', async () => {
  const calls = []
  const { item, menuOpenCalls, cleanup } = await renderMenuItem({
    rpc: menuRpc(calls),
    // Render the row title into the body so the assertion proves the owner's
    // `displayTitle` actually reaches the dialog (identity `t` would only
    // echo the bare key).
    translate: (key) => (key === 'deleteConfirmBody' ? 'body:{title}' : key),
  })
  await withLayout(async () => {
    try {
      await act(async () => { item().click(); await settle() })
      assert.deepEqual(menuOpenCalls, [false], 'the row dismisses the menu it sits in')
      const overlay = confirmOverlay()
      assert.ok(overlay, 'the irreversible-delete confirm opens')
      assert.ok(overlay.textContent.includes('deleteConfirmTitle'), 'the dialog titles itself from the plugin locale')
      assert.ok(overlay.textContent.includes('body:Hello world'), 'the dialog names the row it was opened from')
      assert.ok(!calls.some(([endpoint]) => endpoint === 'delete'), 'opening the dialog deletes nothing')
    } finally {
      await cleanup()
    }
  })
})

test('confirming the menu item deletes exactly the row it came from', async () => {
  const calls = []
  const { item, cleanup } = await renderMenuItem({ rpc: menuRpc(calls), sessionId: ID })
  await withLayout(async () => {
    try {
      await act(async () => { item().click(); await settle() })
      const overlay = confirmOverlay()
      await act(async () => { dialogButton(overlay, 'confirm').click(); await settle() })
      const deletes = calls.filter(([endpoint]) => endpoint === 'delete')
      assert.equal(deletes.length, 1, 'one confirm means one delete')
      assert.equal(deletes[0][1], ID, 'the id is the row the item belonged to')
      assert.equal(confirmOverlay(), null, 'the dialog closes after the decision')
      assert.ok(toasts().some((node) => node.textContent.includes('deleteOk')), 'success is reported')
    } finally {
      await cleanup()
    }
  })
})

test('cancelling the menu item deletes nothing', async () => {
  const calls = []
  const { item, cleanup } = await renderMenuItem({ rpc: menuRpc(calls) })
  await withLayout(async () => {
    try {
      await act(async () => { item().click(); await settle() })
      await act(async () => {
        document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        await settle()
      })
      assert.equal(confirmOverlay(), null, 'Escape closes the dialog')
      assert.ok(!calls.some(([endpoint]) => endpoint === 'delete'), 'nothing reaches the host')
      assert.equal(toasts().length, 0, 'a cancelled delete says nothing')
    } finally {
      await cleanup()
    }
  })
})

test('a running refusal is explained and never reported as success', async () => {
  const calls = []
  const refusal = Object.assign(new Error('session/running: the session is running'), { code: 'session/running' })
  const { item, cleanup } = await renderMenuItem({
    rpc: menuRpc(calls, () => Promise.reject(refusal)),
  })
  await withLayout(async () => {
    try {
      await act(async () => { item().click(); await settle() })
      await act(async () => { dialogButton(confirmOverlay(), 'confirm').click(); await settle() })
      const text = toasts().map((node) => node.textContent).join(' | ')
      assert.ok(text.includes('runningRefused'), 'the refusal is explained in the user\'s language')
      assert.ok(!text.includes('deleteOk'), 'a refused delete is never reported as success')
    } finally {
      await cleanup()
    }
  })
})

test('the menu item opens one dialog at a time', async () => {
  const calls = []
  const { item, cleanup } = await renderMenuItem({ rpc: menuRpc(calls) })
  await withLayout(async () => {
    try {
      await act(async () => { item().click(); await settle() })
      // A second select (double click, or Enter then click) must not stack a
      // second irreversible-delete confirmation on top of the first.
      await act(async () => { item().click(); await settle() })
      assert.equal(document.querySelectorAll('[data-sm-confirm]').length, 1, 'only one dialog exists')
      assert.ok(!calls.some(([endpoint]) => endpoint === 'delete'), 'neither select deleted anything yet')
    } finally {
      await cleanup()
    }
  })
})

const confirmButtonIn = (overlay) => [...overlay.querySelectorAll('button')]
  // The harness translates with an identity function (`t: (key) => key`), so the
  // confirm button reads `confirm`, not the localized label.
  .find((b) => /^(删除|Delete|confirm)$/.test((b.textContent || '').trim()))

test('a second delete while the first is still running says so instead of doing nothing', async () => {
  // `menuConfirmBusy` covers the whole confirm → delete → refresh window, and a
  // select landing inside it used to `return` with no dialog, no toast and no
  // error. Verified by probe against the real component: the flagship entry
  // point silently ignored the click, which reads as "the plugin is broken" —
  // and this file's own rule is that the menu path must never fail silently.
  //
  // `menuConfirmBusy` is MODULE-level (shared by every menu row), so this test
  // must leave it false: the in-flight delete is released through `releaseDelete`
  // in the finally block, otherwise every later menu test would be answered with
  // the busy toast instead of a dialog.
  const calls = []
  let releaseDelete
  const heldDelete = new Promise((resolve) => { releaseDelete = resolve })
  const rpc = (endpoint, payload) => {
    calls.push([endpoint, payload && payload.sessionId])
    if (endpoint === 'deferred/list') return Promise.resolve({ sessionIds: [], recoverable: [] })
    if (endpoint === 'ping') return Promise.resolve({ version: '0.4.6', menuDeleteAvailable: true })
    // Held open: the first delete stays in flight while the second is attempted.
    if (endpoint === 'delete') return heldDelete.then(() => ({ sessionId: payload.sessionId, deleted: true }))
    return new Promise(() => {})
  }
  await withLayout(async () => {
    const first = await renderMenuItem({ rpc, sessionId: ID, refreshAfterDelete: async () => true })
    const second = await renderMenuItem({ rpc, sessionId: TOMBSTONE, refreshAfterDelete: async () => true })
    try {
      // Start + confirm the first delete through the same path a user takes.
      await act(async () => { first.item().click(); await settle() })
      const confirmButton = confirmButtonIn(confirmOverlay())
      assert.ok(confirmButton, 'the first dialog is up')
      await act(async () => { confirmButton.click(); await settle() })
      assert.ok(calls.some(([endpoint]) => endpoint === 'delete'), 'the first delete left for the host')

      clearToasts()
      // The second menu row is a DIFFERENT mounted component sharing the same
      // module closure: the second session's menu, opened while the first delete
      // is still in flight.
      await act(async () => { second.item().click(); await settle() })

      assert.equal(document.querySelectorAll('[data-sm-confirm]').length, 0, 'no second dialog is stacked')
      assert.equal(calls.filter(([endpoint]) => endpoint === 'delete').length, 1, 'and no second delete is issued')
      assert.ok(toasts().some((node) => node.textContent.includes('menuBusy')),
        `the second attempt is REPORTED, not swallowed (toasts: ${JSON.stringify(toasts().map((n) => n.textContent))})`)
      assert.ok(!calls.some(([endpoint, sessionId]) => endpoint === 'delete' && sessionId === TOMBSTONE), 'the second session is untouched')
    } finally {
      // Release the held delete FIRST (and let it drain), so the module-level
      // busy flag is false again before the next test runs.
      releaseDelete()
      await act(async () => { await settle(); await settle() })
      await second.cleanup()
      await first.cleanup()
    }
  })
})

test('a confirmed delete ASKS a stable element for focus instead of dropping it on <body>', async () => {
  // The dialog restores focus to its opener on close, but a CONFIRMED delete
  // unmounts the row that opened it (the list refreshes), so the restore landed
  // on <body> — measured in the real GUI, and a WCAG 2.4.3 (Level A) failure.
  //
  // jsdom does not move `document.activeElement` for a programmatic `.focus()`
  // on every one of these elements, so asserting on activeElement here would be
  // a test of jsdom rather than of the plugin. What IS observable — and what the
  // fix controls — is WHICH element is asked for focus, in preference to the
  // opener: never a disabled control, a surviving row's own control when there
  // is one, and the section as the fallback. (This paragraph used to defer the
  // real-browser half to `scripts/e2e-focus.mjs`, a file that was never
  // written — which is how a fix whose only assertion was "something was asked"
  // shipped broken.)
  const { sess, ws } = bulkFixture()
  const calls = []
  await withLayout(async () => {
    const { container, cleanup } = await renderSection(idleRpc(calls), sess, ws)
    try {
      const opener = rowDeleteButton(container)
      assert.ok(opener, 'the row delete control renders')

      // Count the focus requests the landing target receives.
      const target = container.querySelector('[data-sm-section]')
      assert.ok(target, 'the section declares itself as the landing target')
      let focused = 0
      const realFocus = target.focus.bind(target)
      target.focus = () => { focused += 1; realFocus() }

      await act(async () => { opener.click(); await settle() })
      const confirmButton = confirmButtonIn(confirmOverlay())
      assert.ok(confirmButton, 'the confirmation dialog is up')
      // Instrument the delete button of EVERY row, not just the first: after the
      // refresh the surviving row's control is the intended landing spot, and it
      // may be a different DOM node than the opener.
      const hits = []
      for (const button of container.querySelectorAll('[data-sm-row-delete], [data-sm-bulk-delete], [data-sm-section]')) {
        const real = button.focus.bind(button)
        button.focus = () => { hits.push(button.getAttribute('data-sm-row-delete') === '1' ? 'row-delete' : button.getAttribute('data-sm-section') === '1' ? 'section' : 'bulk'); real() }
      }
      await act(async () => { confirmButton.click(); await settle() })
      await act(async () => { await settle() })

      // The row is gone (the delete landed) and the landing target was asked.
      assert.equal(calls.filter(([endpoint]) => endpoint === 'delete').length, 1, 'the delete actually ran')
      assert.ok(hits.length > 0,
        `focus was handed to a stable element (dialog still open: ${confirmOverlay() !== null}; activeElement: ${document.activeElement === null ? 'null' : document.activeElement.tagName})`)
      // WHICH element matters, not just that one was asked: the bulk button is
      // FIRST in document order and `disabled` with an empty selection, and
      // `.focus()` on a disabled control is a spec'd no-op — so asking it left
      // focus on `<body>` and made the section fallback unreachable. Asserting
      // `hits.length > 0` alone passed while that bug shipped.
      assert.ok(!hits.includes('bulk'),
        `the disabled bulk button is never asked for focus (hits: ${JSON.stringify(hits)})`)
      if (container.querySelectorAll('[data-sm-row-delete]').length > 0) {
        assert.ok(hits.includes('row-delete'), `a surviving row's own control is preferred (hits: ${JSON.stringify(hits)})`)
      } else {
        assert.ok(hits.includes('section'), `with no row left, focus falls through to the section (hits: ${JSON.stringify(hits)})`)
      }
    } finally {
      await cleanup()
    }
  })
})

test('the settings section exposes a stable focus target for the after-delete landing', async () => {
  const { container, cleanup } = await renderSection(idleRpc([]))
  try {
    assert.ok(container.querySelector('[data-sm-section]'), 'the section root is addressable')
    assert.ok(container.querySelector('[data-sm-row-delete]'), 'and each row delete control is too')
  } finally {
    await cleanup()
  }
})

// ── the refresh seam, and the dialog/keyboard contract ----------------------
//
// The plugin used to call `sessions.refreshList()`, a name no published version
// of the client service carries (0.1.5-rc.1 / 0.1.7-alpha.1 / 0.1.7-rc.1 /
// 0.1.7-rc.2 all expose only `refresh()`). Every guard therefore skipped,
// `refreshUntilGone` answered false immediately, and a SUCCESSFUL cold delete
// painted "the session list could not refresh" in red. The fakes above now
// mirror the real surface — the same mistake dies at the Proxy — and these tests
// pin the user-visible outcome the fix is for.

test('a successful cold delete refreshes through refresh() and reports no failure', async () => {
  let refreshCalls = 0
  const counting = makeSessionsService(
    sessions.list.getSnapshot(),
    { onRefresh: (snapshot) => { refreshCalls += 1; return dropsId(ID)(snapshot) } },
  )
  const calls = []
  const rpc = (endpoint, payload) => {
    calls.push([endpoint, payload && payload.sessionId])
    if (endpoint === 'deferred/list') return Promise.resolve({ sessionIds: [], recoverable: [] })
    if (endpoint === 'ping') return Promise.resolve({ version: '0.3.8', menuDeleteAvailable: true })
    if (endpoint === 'delete') return Promise.resolve({ sessionId: payload.sessionId, deleted: true })
    return new Promise(() => {})
  }
  await withLayout(async () => {
    const restoreSessions = useSessionsService(counting)
    const { container, cleanup } = await renderSection(rpc)
    try {
      const remove = [...container.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'delete')
      assert.ok(remove, 'the row delete button renders')
      await act(async () => { remove.click(); await settle() })
      await act(async () => { dialogButton(confirmOverlay(), 'confirm').click(); await settle() })

      assert.ok(calls.some(([endpoint]) => endpoint === 'delete'), 'the delete reached the host')
      assert.ok(container.textContent.includes('deleteOk'), 'success is still reported')
      assert.ok(refreshCalls > 0, 'the delete must re-pull the list through the service\'s refresh()')
      assert.ok(!container.textContent.includes('refreshFailed'), 'a refreshed list must NEVER be reported as a failed refresh')
    } finally {
      await cleanup()
      restoreSessions()
    }
  })
})

test('a delete whose row never disappears still reports the failed refresh', async () => {
  const rpc = (endpoint, payload) => {
    if (endpoint === 'deferred/list') return Promise.resolve({ sessionIds: [], recoverable: [] })
    if (endpoint === 'ping') return Promise.resolve({ version: '0.3.8', menuDeleteAvailable: true })
    if (endpoint === 'delete') return Promise.resolve({ sessionId: payload.sessionId, deleted: true })
    return new Promise(() => {})
  }
  await withLayout(async () => {
    // A stub that answers "the row is still there" keeps the assertion instant;
    // the real polling loop is covered by the test above.
    const { container, cleanup } = await renderSection(rpc, undefined, undefined, { refreshAfterDelete: async () => false })
    try {
      const remove = [...container.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'delete')
      await act(async () => { remove.click(); await settle() })
      await act(async () => { dialogButton(confirmOverlay(), 'confirm').click(); await settle() })
      assert.ok(container.textContent.includes('refreshFailed'), 'a genuinely stale list still gets the hint')
    } finally {
      await cleanup()
    }
  })
})

test('the menu toast drops the refresh-failure suffix once the row is gone', async () => {
  const calls = []
  const { item, cleanup } = await renderMenuItem({ rpc: menuRpc(calls), refreshAfterDelete: async () => true })
  await withLayout(async () => {
    try {
      await act(async () => { item().click(); await settle() })
      await act(async () => { dialogButton(confirmOverlay(), 'confirm').click(); await settle() })
      const text = toasts().map((node) => node.textContent).join(' | ')
      assert.ok(text.includes('deleteOk'), 'the delete is reported')
      assert.ok(!text.includes('refreshFailed'), 'and carries no stale-list advice')
    } finally {
      await cleanup()
    }
  })
})

test('the menu toast keeps the refresh-failure suffix when the row stayed', async () => {
  const calls = []
  const { item, cleanup } = await renderMenuItem({ rpc: menuRpc(calls), refreshAfterDelete: async () => false })
  await withLayout(async () => {
    try {
      await act(async () => { item().click(); await settle() })
      await act(async () => { dialogButton(confirmOverlay(), 'confirm').click(); await settle() })
      const text = toasts().map((node) => node.textContent).join(' | ')
      assert.ok(text.includes('refreshFailed'), 'the stale-list advice survives for a row that is still listed')
    } finally {
      await cleanup()
    }
  })
})

test('the confirm dialog is a modal dialog whose Tab cycle stays inside', async () => {
  const rpc = (endpoint) => {
    if (endpoint === 'deferred/list') return Promise.resolve({ sessionIds: [], recoverable: [] })
    if (endpoint === 'ping') return Promise.resolve({ version: '0.3.8', menuDeleteAvailable: true })
    return new Promise(() => {})
  }
  await withLayout(async () => {
    const { container, cleanup } = await renderSection(rpc)
    try {
      const remove = [...container.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'delete')
      await act(async () => { remove.click(); await settle() })
      const overlay = confirmOverlay()
      assert.ok(overlay, 'the dialog opened')
      assert.equal(overlay.getAttribute('role'), 'dialog')
      assert.equal(overlay.getAttribute('aria-modal'), 'true')
      const labelledBy = overlay.getAttribute('aria-labelledby')
      assert.ok(labelledBy !== null && document.getElementById(labelledBy) !== null, 'the dialog is labelled by its title node')

      const cancelButton = dialogButton(overlay, 'cancel')
      const confirmButton = dialogButton(overlay, 'confirm')
      assert.equal(document.activeElement, cancelButton, 'cancel keeps the default focus')
      // aria-modal="true" promises the page behind is inert: Tab must cycle the
      // two buttons instead of walking into the app.
      await act(async () => { document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true })) })
      assert.equal(document.activeElement, confirmButton, 'Tab moves to Delete')
      await act(async () => { document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true })) })
      assert.equal(document.activeElement, cancelButton, 'Tab wraps back to Cancel')
      await act(async () => { document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })) })
      assert.equal(document.activeElement, confirmButton, 'Shift+Tab wraps the other way')
      await act(async () => { document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
      assert.equal(document.activeElement === null || confirmOverlay() === null, true, 'Escape still closes the dialog')
      assert.equal(confirmOverlay(), null, 'the dialog is gone')
    } finally {
      await cleanup()
    }
  })
})

test('the zh and en dictionaries carry exactly the same keys', () => {
  const dictionaries = dict()
  assert.ok(dictionaries !== null && dictionaries !== undefined, 'apply() must register the locale dictionaries')
  assert.deepEqual(Object.keys(dictionaries.zh).sort(), Object.keys(dictionaries.en).sort(), 'a key added to one language must be added to both')
  for (const language of ['zh', 'en']) {
    for (const [key, value] of Object.entries(dictionaries[language])) {
      assert.ok(String(value).trim() !== '', `${language}.${key} must not be empty`)
    }
  }
})

// ── timing and identity rules ───────────────────────────────────────────────
//
// The ping retry, the removal debounce and the one-dialog rule are not visible
// in a rendered snapshot, and were previously covered only by reading the code.
// They drive a SECOND client registration — `mod.apply` is re-invocable and every
// RPC closure reads `ctx.get` per apply — with its own service registry, so each
// test controls the clock and the failure sequence exactly.

/** Flush microtasks without touching the mocked timer queue. */
const flush = () => new Promise((resolve) => setImmediate(resolve))
const OK_PING = { ok: true, value: { menuDeleteAvailable: true } }

test('the menu ping retries twice, so a transient failure cannot hide the row', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const attempts = []
  const countOf = (endpoint) => attempts.filter((method) => method === `session-manager/${endpoint}`).length
  const flaky = makeCtx({
    sessions: undefined,
    workspaces: undefined,
    remote: undefined,
    connection: { rpc: { call: async (_channel, method) => {
      attempts.push(method)
      if (method === 'session-manager/ping' && countOf('ping') < 3) throw new Error('transient')
      return OK_PING
    } } },
  })
  mod.apply(flaky.ctx)
  await flush()
  assert.equal(countOf('ping'), 1, 'the first ping is attempted right away')
  assert.equal(flaky.menuSpec().inject().menuEnabled, null, 'nothing is decided while a retry is pending')
  t.mock.timers.tick(1000)
  await flush()
  assert.equal(countOf('ping'), 2, 'the first retry fires after 1s')
  t.mock.timers.tick(3000)
  await flush()
  assert.equal(countOf('ping'), 3, 'the second retry fires 3s later')
  assert.equal(flaky.menuSpec().inject().menuEnabled, true, 'the retries settle the value before the entry first renders')
  // The first successful ping is also the client's reachability handshake: it
  // reads the pending-delete queue exactly once (the residue watch's seed).
  assert.equal(countOf('deferred/list'), 1, 'the pending queue is seeded once, on the first successful ping')
})

test('the menu ping gives up after the retries and keeps the row hidden', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let attempts = 0
  const dead = makeCtx({
    sessions: undefined,
    workspaces: undefined,
    remote: undefined,
    connection: { rpc: { call: async () => { attempts += 1; throw new Error('down') } } },
  })
  mod.apply(dead.ctx)
  await flush()
  t.mock.timers.tick(1000)
  await flush()
  t.mock.timers.tick(3000)
  await flush()
  assert.equal(attempts, 3, 'three attempts in total, then it stops')
  assert.equal(dead.menuSpec().inject().menuEnabled, false, 'an unconfirmed row stays hidden instead of appearing anyway')
})

test('a failed boot ping is retried when the menu is next opened, and the row recovers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let up = false
  const attempts = []
  const pings = () => attempts.filter((method) => method === 'session-manager/ping').length
  const dead = makeCtx({
    sessions: undefined,
    workspaces: undefined,
    remote: undefined,
    connection: { rpc: { call: async (_channel, method) => {
      attempts.push(method)
      if (method !== 'session-manager/ping') return { ok: true, value: {} }
      if (!up) throw new Error('down')
      return OK_PING
    } } },
  })
  mod.apply(dead.ctx)
  await flush()
  t.mock.timers.tick(1000)
  await flush()
  t.mock.timers.tick(3000)
  await flush()
  const spec = dead.menuSpec().inject()
  assert.equal(pings(), 3, 'three attempts, then it stops')
  assert.equal(spec.getMenuEnabled(), false, 'the live answer is "hidden" while the host is down')

  // The host comes back. Opening the menu re-arms exactly one ping, and the
  // LIVE answer flips — the frozen `menuEnabled` value never would have.
  up = true
  spec.requestMenuPing()
  await flush()
  assert.equal(pings(), 4, 'the menu open re-armed one ping')
  assert.equal(spec.getMenuEnabled(), true, 'and the row can appear on the next open')
})

test('a host that answered "no" is never re-pinged (an answer is not a failure)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let pings = 0
  const dead = makeCtx({
    sessions: undefined,
    workspaces: undefined,
    remote: undefined,
    connection: { rpc: { call: async (_channel, method) => {
      if (method !== 'session-manager/ping') return { ok: true, value: {} }
      pings += 1
      return { ok: true, value: { menuDeleteAvailable: false } }
    } } },
  })
  mod.apply(dead.ctx)
  await flush()
  const spec = dead.menuSpec().inject()
  assert.equal(spec.menuEnabled, false, 'the host said no')
  spec.requestMenuPing()
  await flush()
  assert.equal(pings, 1, 're-pinging on every menu open would be one request per open, forever')
})

test('the menu row reads the live ping answer, not the frozen inject value', async () => {
  // The renderer caches inject() per entry for the entry's lifetime, so a plain
  // `menuEnabled` captured while the ping was still in flight stayed `null` for
  // the whole page. The component reads the getter and asks for another ping.
  let enabled = null
  const requested = []
  const first = await renderMenuItem({
    menuEnabled: null, // the FROZEN value: stale forever
    getMenuEnabled: () => enabled,
    requestMenuPing: () => requested.push('ping'),
  })
  try {
    assert.equal(first.item(), null, 'hidden while the answer is unknown')
    assert.deepEqual(requested, ['ping'], 'opening the menu re-arms a ping instead of waiting for a reload')
    enabled = true // the host answered in the meantime
    const second = await renderMenuItem({ menuEnabled: null, getMenuEnabled: () => enabled })
    try {
      assert.ok(second.item(), 'the NEXT open shows the row even though the injected value is still the frozen null')
    } finally {
      await second.cleanup()
    }
  } finally {
    await first.cleanup()
  }
})

test('a burst of api-session/removed events collapses into one pull', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let handler = null
  let pulls = 0
  const counting = makeSessionsService({ byId: {}, ids: [], phase: 'ready' }, { onRefresh: () => { pulls += 1 } })
  const noisy = makeCtx({
    sessions: counting,
    workspaces: undefined,
    connection: undefined,
    remote: { $on: (event, callback) => { if (event === 'api-session/removed') handler = callback; return () => {} } },
  })
  mod.apply(noisy.ctx)
  await flush()
  assert.equal(typeof handler, 'function', 'the plugin subscribes to api-session/removed')
  handler('session-a')
  handler('session-b')
  handler('session-c')
  assert.equal(pulls, 0, 'the pull waits out the debounce window')
  t.mock.timers.tick(250)
  await flush()
  assert.equal(pulls, 1, 'three events in one burst must cost one pull, not three')
})

test('one dialog at a time, a fresh label id per dialog, and focus back on the opener', async () => {
  const { sess, ws } = bulkFixture()
  const calls = []
  await withLayout(async () => {
    const { container, cleanup } = await renderSection(idleRpc(calls), sess, ws)
    try {
      const deletes = [...container.querySelectorAll('button')].filter((b) => (b.textContent || '').trim() === 'delete')
      assert.ok(deletes.length >= 2, 'the fixture renders at least two row delete buttons')
      await act(async () => { deletes[0].focus(); deletes[0].click(); await settle() })
      const first = confirmOverlay()
      assert.ok(first, 'the first dialog opens')
      const firstLabel = first.getAttribute('aria-labelledby')
      assert.equal(document.getElementById(firstLabel)?.textContent, 'deleteConfirmTitle', 'the label resolves to THIS dialog\'s title')

      // jsdom clicks pass through the overlay (a real pointer would hit the
      // overlay instead), so this exercises the guard rather than the geometry.
      await act(async () => { deletes[1].click(); await settle() })
      assert.equal(document.querySelectorAll('[data-sm-confirm]').length, 1, 'a second dialog cannot stack on the first')
      assert.ok(!calls.some(([endpoint]) => endpoint === 'delete'), 'and nothing was deleted yet')

      await act(async () => {
        document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        await settle()
      })
      assert.equal(confirmOverlay(), null, 'Escape closes the dialog')
      assert.equal(document.activeElement, deletes[0], 'focus returns to the button that opened it')

      await act(async () => { deletes[0].click(); await settle() })
      const second = confirmOverlay()
      assert.ok(second, 'the dialog can be opened again once the first is closed')
      assert.notEqual(second.getAttribute('aria-labelledby'), firstLabel, 'each dialog labels itself with a fresh id')
      await act(async () => {
        document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        await settle()
      })
    } finally {
      await cleanup()
    }
  })
})

// ── pending-deletion residue (open-session tombstones) ──────────────────────
//
// A permanent delete of an OPEN session cannot close the host's in-memory copy,
// so the id stays queued and the host keeps listing it. Two client rules keep
// that residue out of the store: no list pull for a queued id, and exactly one
// host queue read per residue episode (a configured host answers it with a
// fresh `api-session/removed`).

test('a removal event for a queued id never pulls the list back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let handler = null
  let pulls = 0
  let queueReads = 0
  const counting = makeSessionsService(
    { byId: { [ID]: { displayTitle: 'Hello world', cwd: 'C:\\x', running: false } }, ids: [ID], phase: 'ready' },
    { onRefresh: () => { pulls += 1 } },
  )
  const client = makeCtx({
    sessions: counting,
    workspaces: undefined,
    connection: { rpc: { call: async (_channel, method) => {
      if (method === 'session-manager/ping') return OK_PING
      if (method === 'session-manager/deferred/list') {
        queueReads += 1
        return { ok: true, value: { sessionIds: [ID], recoverable: [] } }
      }
      throw new Error(`unexpected method ${method}`)
    } } },
    remote: { $on: (event, callback) => { if (event === 'api-session/removed') handler = callback; return () => {} } },
  })
  mod.apply(client.ctx)
  await flush()
  assert.equal(typeof handler, 'function', 'the plugin subscribes to api-session/removed')
  assert.equal(queueReads, 1, 'the first successful ping seeds the pending queue exactly once')

  // The seeded id is an OPEN delete: its removal must NOT pull the list, or the
  // still-live host copy comes straight back into the store.
  handler(ID)
  t.mock.timers.tick(250)
  await flush()
  assert.equal(pulls, 0, 'a queued id is never pulled back into the store')

  // Any other removal keeps the original belt-and-braces pull.
  handler('session-ffffffff-0000-4000-8000-00000000000f')
  t.mock.timers.tick(250)
  await flush()
  assert.equal(pulls, 1, 'a removal for an unqueued id still refreshes the list')

  // The seeded id IS in the store, so the residue watch asks the host once.
  t.mock.timers.tick(500)
  await flush()
  const readsAfterRepair = queueReads
  assert.ok(readsAfterRepair >= 2, 'a queued id that reappears in the store triggers one host queue read')

  // A host that keeps returning the id (or one without the repair hook) must
  // never be polled in a loop: the episode flag holds until the id is gone.
  t.mock.timers.tick(60000)
  await flush()
  assert.equal(queueReads, readsAfterRepair, 'one repair per residue episode, never a poll loop')
})

test('a removal event that outruns its own delete response does not pull the id back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let handler = null
  let pulls = 0
  const counting = makeSessionsService(
    { byId: { [ID]: { displayTitle: 'Hello world', cwd: 'C:\\x', running: false } }, ids: [ID], phase: 'ready' },
    { onRefresh: () => { pulls += 1 } },
  )
  const client = makeCtx({
    sessions: counting,
    workspaces: undefined,
    connection: { rpc: { call: async (_channel, method, payload) => {
      if (method === 'session-manager/ping') return OK_PING
      if (method === 'session-manager/deferred/list') return { ok: true, value: { sessionIds: [], recoverable: [] } }
      if (method === 'session-manager/delete') return { ok: true, value: { sessionId: payload.sessionId, deleted: true, openAtDelete: true } }
      throw new Error(`unexpected method ${method}`)
    } } },
    remote: { $on: (event, callback) => { if (event === 'api-session/removed') handler = callback; return () => {} } },
  })
  mod.apply(client.ctx)
  await flush()
  assert.equal(typeof handler, 'function', 'the plugin subscribes to api-session/removed')
  // The rpc the inject face hands to the components IS the closure rpc, so this
  // is the same call path the menu item uses in production.
  const clientRpc = client.menuSpec().inject().rpc

  // Host order: the removal EVENT reaches the browser before the delete RESPONSE
  // (different channels), so the pull is scheduled while the id is not yet known
  // to be queued. The fire-time re-check is what must stop it.
  handler(ID)
  await clientRpc('delete', { sessionId: ID })
  t.mock.timers.tick(250)
  await flush()
  assert.equal(pulls, 0, 'a pull scheduled before its own delete response landed must not resurrect the id')
})

test('a failed first queue read does not disarm the residue repair', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let handler = null
  let pulls = 0
  let queueReads = 0
  const counting = makeSessionsService(
    { byId: { [ID]: { displayTitle: 'Hello world', cwd: 'C:\\x', running: false } }, ids: [ID], phase: 'ready' },
    { onRefresh: () => { pulls += 1 } },
  )
  const client = makeCtx({
    sessions: counting,
    workspaces: undefined,
    connection: { rpc: { call: async (_channel, method) => {
      if (method === 'session-manager/ping') return OK_PING
      if (method === 'session-manager/deferred/list') {
        queueReads += 1
        // One transient failure of the very read that arms the residue block.
        if (queueReads === 1) throw new Error('transient queue read failure')
        return { ok: true, value: { sessionIds: [ID], recoverable: [] } }
      }
      throw new Error(`unexpected method ${method}`)
    } } },
    remote: { $on: (event, callback) => { if (event === 'api-session/removed') handler = callback; return () => {} } },
  })
  mod.apply(client.ctx)
  await flush()
  assert.equal(queueReads, 1, 'the seed read is attempted as soon as the host answers the ping')

  // The read FAILED, so the block is not armed yet: `pendingDeleteIds` is empty
  // and no store watch exists. Marking the seed from the ping alone (which only
  // proves the host is reachable) left it that way for the page's lifetime — the
  // removal event below would then pull the husk straight back into the store
  // and the host repair would never be asked: the 0.4.1 field bug, silently.
  t.mock.timers.tick(1000)
  await flush()
  assert.equal(queueReads, 2, 'a failed seed read is retried, so the repair cannot be disarmed by one failure')

  handler(ID)
  t.mock.timers.tick(250)
  await flush()
  assert.equal(pulls, 0, 'once a read has landed, a queued id is never pulled back')

  // That landed read is also what arms the host repair.
  t.mock.timers.tick(1000)
  await flush()
  assert.equal(queueReads, 3, 'the residue watch asks the host once per episode')
  t.mock.timers.tick(60000)
  await flush()
  assert.equal(queueReads, 3, 'and the repair is never a poll loop')
})

test('a bulk run made only of open deletes skips the whole-run list pull', async () => {
  const fixture = bulkFixture()
  let refreshes = 0
  const counting = makeSessionsService(fixture.sess.list.getSnapshot(), { onRefresh: () => { refreshes += 1 } })
  const calls = []
  const rpc = idleRpc(calls, (payload) => Promise.resolve({ sessionId: payload.sessionId, deleted: true, openAtDelete: true }))
  await withLayout(async () => {
    const { container, cleanup } = await renderSection(rpc, counting, fixture.ws)
    try {
      await act(async () => { selectAllBox(container).click() })
      await act(async () => { bulkButton(container).click(); await settle() })
      await confirmBulk(document.querySelector('[data-sm-confirm]'))

      const deleted = calls.filter(([endpoint]) => endpoint === 'delete')
      assert.equal(deleted.length, 2, 'both idle rows are deleted')
      assert.equal(refreshes, 0, 'a run of open deletes must not re-pull the still-live sessions')
      assert.ok(container.textContent.includes('deleteBulkOkOpen'), `the open-session accounting reaches the user: ${container.textContent.slice(0, 300)}`)
    } finally {
      await cleanup()
    }
  })
})

test('a mixed bulk run does not re-pull the list over its queued open delete', async () => {
  const fixture = bulkFixture()
  let refreshes = 0
  const counting = makeSessionsService(fixture.sess.list.getSnapshot(), { onRefresh: () => { refreshes += 1 } })
  const calls = []
  // One COLD delete (ID2) and one OPEN delete (ID) in the same run. The pull
  // exists to catch up on the cold id, but it re-learns the still-live open id
  // as well — the host keeps listing that in-memory copy, so the tombstone lands
  // back in the store. ANY open delete in the run therefore skips the pull; the
  // cold id is already dropped locally by `api-session/removed`.
  const rpc = idleRpc(calls, (payload) => Promise.resolve({
    sessionId: payload.sessionId,
    deleted: true,
    ...(payload.sessionId === ID ? { openAtDelete: true } : {}),
  }))
  await withLayout(async () => {
    // The closure's `getSessions()` is what a pull resolves, so the fake has to
    // be installed there too — not just handed to the component as a prop.
    const restoreSessions = useSessionsService(counting)
    const { container, cleanup } = await renderSection(rpc, counting, fixture.ws)
    try {
      await act(async () => { selectAllBox(container).click() })
      await act(async () => { bulkButton(container).click(); await settle() })
      await confirmBulk(document.querySelector('[data-sm-confirm]'))

      const deleted = calls.filter(([endpoint]) => endpoint === 'delete')
      assert.equal(deleted.length, 2, 'both idle rows are deleted')
      assert.equal(refreshes, 0, 'a run containing an open delete must not pull the queued husk back')
    } finally {
      await cleanup()
      restoreSessions()
    }
  })
})

test('an explicit list pull re-checks the residue even when the store cannot be watched', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let queueReads = 0
  // The store starts WITHOUT the husk (a fresh page) and every pull re-learns
  // the host's list, which still holds the live copy of the queued id. Its
  // subscription THROWS here, so `watchSessionStore` cannot install the store
  // watch — the seam the repair normally rides on. A pull must therefore
  // re-check the residue itself, or the tombstone it just pulled back stays
  // rendered in the archived-views sidebar until some later queue read.
  const husk = { byId: { [ID]: { displayTitle: 'Hello world', cwd: 'C:\\x', running: false } }, ids: [ID], phase: 'ready' }
  const empty = { byId: {}, ids: [], phase: 'ready' }
  let snapshot = empty
  const unwatchable = {
    list: {
      subscribe: () => { throw new Error('this store cannot be observed') },
      getSnapshot: () => snapshot,
    },
    refresh: async () => { snapshot = husk },
  }
  const client = makeCtx({
    sessions: unwatchable,
    workspaces: undefined,
    connection: { rpc: { call: async (_channel, method) => {
      if (method === 'session-manager/ping') return OK_PING
      if (method === 'session-manager/deferred/list') {
        queueReads += 1
        return { ok: true, value: { sessionIds: [ID], recoverable: [] } }
      }
      throw new Error(`unexpected method ${method}`)
    } } },
    remote: undefined,
  })
  mod.apply(client.ctx)
  await flush()
  assert.equal(queueReads, 1, 'the seed read lands and arms the block')
  t.mock.timers.tick(60000)
  await flush()
  assert.equal(queueReads, 1, 'nothing to repair while the husk is not in the store')

  const pull = client.sectionSpec().inject().pullSessions
  assert.equal(typeof pull, 'function', 'the surfaces must receive the pull that re-checks the residue')
  await pull()
  t.mock.timers.tick(300)
  await flush()
  assert.equal(queueReads, 2, 'the pull brought the husk back, so the host is asked to repair it')

  await pull()
  t.mock.timers.tick(3000)
  await flush()
  assert.equal(queueReads, 2, 'one repair per residue episode — a repeated pull never starts a poll loop')
})

// ── P2: dialog lifecycle, feedback channels, a11y ───────────────────────────
//
// These are the shapes the earlier rounds could not see: a dialog that outlives
// its plugin, a failure that never reaches the user, two messages collapsing
// into one, and accessible names that do not identify their row.

const rowDeleteButton = (container, index = 0) =>
  [...container.querySelectorAll('button')].filter((b) => (b.textContent || '').trim() === 'delete')[index]
const escapeDialog = async () => {
  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()
  })
}

test('teardown closes an open dialog instead of wedging the one-at-a-time guard', async () => {
  const { sess, ws } = bulkFixture()
  const calls = []
  await withLayout(async () => {
    const { container, cleanup } = await renderSection(idleRpc(calls), sess, ws)
    try {
      await act(async () => { rowDeleteButton(container).click(); await settle() })
      assert.ok(confirmOverlay(), 'the dialog is open')

      // Plugin teardown (unload / re-apply) must take the overlay AND release
      // `confirmOpen`: leaving it set makes every later confirm resolve null, so
      // the delete button would open nothing and delete nothing, silently.
      await act(async () => { runDisposer('session-manager: injected DOM teardown') })
      assert.equal(confirmOverlay(), null, 'teardown removed the open dialog')
      assert.ok(!container.textContent.includes('errorPrefix'), 'and reported no error')

      await act(async () => { rowDeleteButton(container).click(); await settle() })
      assert.ok(confirmOverlay(), 'the guard was released, so a later confirm still opens')
      await escapeDialog()
      assert.equal(confirmOverlay(), null)
    } finally {
      await cleanup()
    }
  })
})

test('a dialog that cannot be attached resolves as cancelled and frees the guard', async () => {
  const { sess, ws } = bulkFixture()
  const calls = []
  await withLayout(async () => {
    const { container, cleanup } = await renderSection(idleRpc(calls), sess, ws)
    const originalAppend = document.body.appendChild
    try {
      // The host DOM refuses the overlay. Before the fix this rejected the
      // promise (unhandled — both settings call sites await it outside any try)
      // AND left `confirmOpen` set forever.
      document.body.appendChild = () => { throw new Error('appendChild refused') }
      await act(async () => { rowDeleteButton(container).click(); await settle() })
      assert.equal(confirmOverlay(), null, 'no overlay is left behind')
      assert.ok(container.textContent.includes('confirmRenderFailed'), 'the failure reaches the user, localized')
      assert.ok(!calls.some(([endpoint]) => endpoint === 'delete'), 'and nothing was deleted')

      document.body.appendChild = originalAppend
      await act(async () => { rowDeleteButton(container).click(); await settle() })
      assert.ok(confirmOverlay(), 'the next confirm opens normally')
      await escapeDialog()
    } finally {
      document.body.appendChild = originalAppend
      await cleanup()
    }
  })
})

test('a failed pending-queue read is reported instead of silently emptying the banner', async () => {
  const rpc = (endpoint) => {
    if (endpoint === 'deferred/list') {
      return Promise.reject(Object.assign(new Error('queue read failed'), { code: 'session-manager/internal' }))
    }
    if (endpoint === 'ping') return Promise.resolve({ version: 'test', menuDeleteAvailable: true })
    return new Promise(() => {})
  }
  const { container, cleanup } = await renderSection(rpc)
  try {
    // With the read swallowed, `pendingIds` stays empty: a queued session shows
    // up as an ordinary archived row (whose Restore the host refuses) and the
    // banner disappears — with no feedback at all.
    const alert = container.querySelector('[role="alert"]')
    assert.ok(alert, 'the failure is surfaced in the alert region')
    assert.ok(alert.textContent.includes('queue read failed'), `the cause is named: ${alert.textContent}`)
  } finally {
    await cleanup()
  }
})

test('host warnings and a failed refresh both reach the user', async () => {
  const { sess, ws } = bulkFixture()
  const rpc = (endpoint, payload) => {
    if (endpoint === 'deferred/list') return Promise.resolve({ sessionIds: [], recoverable: [] })
    if (endpoint === 'ping') return Promise.resolve({ version: 'test', menuDeleteAvailable: true })
    if (endpoint === 'delete') return Promise.resolve({ sessionId: payload.sessionId, deleted: true, warnings: ['artifact not found'] })
    return new Promise(() => {})
  }
  await withLayout(async () => {
    // A partial delete (bookkeeping done, a file seam degraded) whose list
    // refresh also fails: two distinct messages stand, one operation.
    const { container, cleanup } = await renderSection(rpc, sess, ws, { refreshAfterDelete: async () => false })
    try {
      await act(async () => { rowDeleteButton(container).click(); await settle() })
      await act(async () => { dialogButton(confirmOverlay(), 'confirm').click(); await settle() })
      const alert = container.querySelector('[role="alert"]')
      assert.ok(alert, 'the alert region carries the outcome')
      assert.ok(alert.textContent.includes('artifact not found'), `the host warning survives: ${alert.textContent}`)
      assert.ok(alert.textContent.includes('refreshFailed'), 'and so does the refresh failure')
    } finally {
      await cleanup()
    }
  })
})

test('the REAL rpc wrapper attaches the host error code (structural matching, not message scraping)', async () => {
  // Every other test here overrides the `rpc` prop, so the wrapper that actually
  // talks to the connection service had ZERO coverage: `error.code = …` could be
  // deleted and 165 tests stayed green (verified by mutation). It is the
  // implementation of the documented "domain errors are matched structurally"
  // contract, and `isRunningError(error)` reads exactly that property — so drive
  // it through the same connection seam production uses, with the rpc prop left
  // alone.
  const calls = []
  const previous = services.connection
  services.connection = {
    rpc: {
      async call(channel, method, payload) {
        calls.push({ channel, method, payload })
        // The host's failure envelope, verbatim (see `errorEnvelope`) — for one
        // endpoint; every other call answers with a shapeless result so the
        // transport-shaped branch is exercised too.
        if (method === 'session-manager/deferred/cancel') {
          return { ok: false, error: { code: 'session/running', message: 'session is running', details: {} } }
        }
        return undefined
      },
    },
  }
  try {
    // The wrapper is exposed on the inject face, so it can be called DIRECTLY.
    // Asserting on its throw (not on a component's rendering) is the whole
    // point: `isRunningError` has a message-scraping fallback, so any
    // UI-level assertion stays green when the code is dropped — the fallback
    // only fails to save you the day the host phrase or the locale changes,
    // which is exactly the regression this guards.
    const realRpc = sectionSpec().inject().rpc
    assert.equal(typeof realRpc, 'function', 'the inject face carries the production wrapper')

    const failure = await realRpc('deferred/cancel', { sessionId: ID }).then(
      () => null,
      (error) => error,
    )
    assert.notEqual(failure, null, 'a host failure envelope must reject')
    assert.equal(failure.code, 'session/running', 'STRUCTURAL matching: the host code is copied onto the thrown error')
    // The message keeps the code readable for logs, but nothing may depend on it.
    assert.match(failure.message, /session\/running/)

    // A result that is not a failure envelope at ALL carries no code: it must
    // fall back to the localized transport message rather than interpolating
    // `undefined`.
    const transportFailure = await realRpc('list', {}).then(() => null, (error) => error)
    assert.equal(transportFailure.code, undefined, 'no domain code in a shapeless answer')
    assert.ok(!/undefined/.test(transportFailure.message), 'and no `undefined` leaks into the message')

    // The component path still works end to end through the same seam.
    const { container, cleanup } = await renderSection()
    try {
      assert.ok(calls.length > 0, 'the real wrapper reached the connection service')
      for (const call of calls) {
        assert.equal(call.channel, '/api', 'every call goes through the plugin channel')
        assert.match(call.method, /^session-manager\/[a-z/]+$/, 'and addresses a real endpoint, namespaced')
      }
      assert.ok(calls.some((call) => call.method === 'session-manager/ping'), 'the header ping went through the wrapper too')
      assert.ok(container.textContent.includes('rpcUnreachable'), 'a failed host call surfaces as unreachable, not as a raw message')
    } finally {
      await cleanup()
    }
  } finally {
    services.connection = previous
  }
})

test('a transport-shaped failure without an error object still reports the localized fallback', async () => {
  // The other branch of the same wrapper: `result` is not `{ ok:false, error }`
  // at all, so there is no code to attach and the message must be localized
  // rather than interpolating `undefined`.
  const previous = services.connection
  services.connection = { rpc: { async call() { return undefined } } }
  try {
    const { container, cleanup } = await renderSection()
    try {
      assert.ok(container.textContent.includes('rpcUnreachable'), 'a shapeless answer is treated as an unreachable host')
    } finally {
      await cleanup()
    }
  } finally {
    services.connection = previous
  }
})

test('the unreachable-host guidance appears when the ping fails', async () => {
  const rpc = (endpoint) => {
    if (endpoint === 'ping') return Promise.reject(new Error('host down'))
    if (endpoint === 'deferred/list') return Promise.resolve({ sessionIds: [], recoverable: [] })
    return new Promise(() => {})
  }
  const { container, cleanup } = await renderSection(rpc)
  try {
    // `!rpcAvailable` could never be true (the inject face always supplies the
    // closure), so this guidance — and the "reload the page" advice in it — was
    // unreachable; the real case showed a raw English error instead.
    assert.ok(container.textContent.includes('rpcUnreachable'), 'the header reports the unreachable host')
    assert.ok(container.textContent.includes('unavailable'), 'and the reload guidance is shown')
  } finally {
    await cleanup()
  }
})

test('the dialog describes itself, and the live regions are wired for announcements', async () => {
  const { sess, ws } = bulkFixture()
  const calls = []
  await withLayout(async () => {
    const { container, cleanup } = await renderSection(idleRpc(calls), sess, ws)
    try {
      // Mounted BEFORE its first child: a live region created in the same commit
      // as its content is the classic missed announcement.
      assert.ok(container.querySelector('[role="status"][aria-live="polite"]'), 'the status region is always mounted')
      assert.equal(container.querySelector('[role="alert"]'), null, 'and no alert is shown yet')

      await act(async () => { rowDeleteButton(container).click(); await settle() })
      const overlay = confirmOverlay()
      const describedBy = overlay.getAttribute('aria-describedby')
      assert.ok(describedBy, 'the dialog is described by an id')
      const body = document.getElementById(describedBy)
      assert.ok(body, 'and that id resolves inside the dialog')
      assert.equal(body.textContent, 'deleteConfirmBody', 'to the consequence text, not the title alone')
      assert.notEqual(describedBy, overlay.getAttribute('aria-labelledby'), 'the two ids are distinct')
      await escapeDialog()
    } finally {
      await cleanup()
    }
  })
})

test('two pending-cancel buttons are distinguishable by name', async () => {
  const rpc = (endpoint) => {
    if (endpoint === 'deferred/list') return Promise.resolve({ sessionIds: [ID2, ID3], recoverable: [ID2, ID3] })
    if (endpoint === 'ping') return Promise.resolve({ version: 'test', menuDeleteAvailable: true })
    return new Promise(() => {})
  }
  const { container, cleanup } = await renderSection(rpc)
  try {
    const cancels = [...container.querySelectorAll('button')]
      .filter((b) => (b.textContent || '').trim() === 'pendingCancel')
    assert.equal(cancels.length, 2, 'both recoverable entries render a cancel button')
    const names = cancels.map((b) => b.getAttribute('aria-label'))
    // The id used to sit in an unassociated sibling <code>, so a screen reader
    // exposed two identical "cancel deletion" buttons.
    assert.deepEqual(names, [`pendingCancel ${ID2}`, `pendingCancel ${ID3}`])
  } finally {
    await cleanup()
  }
})

// ── 0.4.8: keyboard ownership, the cancel-path focus, quiet skips, AA floor ──

test('Escape in the confirm dialog CLAIMS the key, so the page behind it stays put', async () => {
  // The Settings panel is a `useModalLayer` consumer (dsh-client-ui-settings-
  // general) whose document-level Escape handler returns early when
  // `event.defaultPrevented` is set. Our listener runs first — it is installed
  // in the capture phase — and used to prevent nothing, so ONE Escape cancelled
  // the dialog AND closed the whole Settings page behind it, whose own focus
  // restore then overrode ours.
  const { sess, ws } = bulkFixture()
  const calls = []
  await withLayout(async () => {
    const { container, cleanup } = await renderSection(idleRpc(calls), sess, ws)
    try {
      await act(async () => { rowDeleteButton(container).click(); await settle() })
      assert.ok(confirmOverlay(), 'the dialog is up')
      const event = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      await act(async () => { document.dispatchEvent(event); await settle() })
      assert.equal(confirmOverlay(), null, 'the dialog closed')
      assert.equal(event.defaultPrevented, true, 'and claimed the Escape — the exact condition the panel checks')
    } finally {
      await cleanup()
    }
  })
})

test('cancelling the menu delete hands focus back instead of dropping it on <body>', async () => {
  // The menu item IS the opener and it is unmounted the moment the menu closes,
  // so the "restore to the opener" branch cannot work on this path: the caller's
  // landing logic is the only thing standing between the user and `<body>`. The
  // caller's own comment claimed it fell forward on cancel; it did not.
  const menu = await renderMenuItem({ rpc: menuRpc([]), sessionId: ID })
  try {
    await withLayout(async () => {
      const row = document.createElement('div')
      row.setAttribute('data-row-key', `session:${ID}`)
      document.body.appendChild(row)
      let focused = 0
      row.focus = () => { focused += 1 }

      // A real click focuses the row, which is what makes it the dialog's
      // opener; jsdom's `click()` does not, so say it explicitly.
      menu.item().focus()
      await act(async () => { menu.item().click(); await settle() })
      assert.ok(confirmOverlay(), 'the dialog is up')
      await menu.unmount() // the menu closed and took the opener with it
      await act(async () => {
        document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        await settle()
      })
      assert.equal(confirmOverlay(), null, 'the cancel landed')
      assert.equal(focused, 1, 'and the row took focus back, because the opener was gone')
    })
  } finally {
    await menu.cleanup()
  }
})

test('a bulk run reports the running sessions it skipped', async () => {
  // `deleted` counted only successes and the summary mentioned only
  // deleted/failed, so confirming three sessions and deleting two read as
  // "deleted 2" — the skip was invisible in the one line the user reads.
  const { sess, ws } = bulkFixture()
  const calls = []
  await withLayout(async () => {
    const { container, cleanup } = await renderSection(idleRpc(calls), sess, ws)
    try {
      await act(async () => { selectAllBox(container).click() })
      await act(async () => { bulkButton(container).click(); await settle() })
      await confirmBulk(document.querySelector('[data-sm-confirm]'))
      assert.deepEqual(calls.filter(([endpoint]) => endpoint === 'delete').map(([, id]) => id), [ID, ID2], 'the running row is never sent to the host')
      assert.ok(container.textContent.includes('deleteBulkSkipped'), 'the summary says how many were skipped')
    } finally {
      await cleanup()
    }
  })
})

test('the AA floor holds on the surfaces the contrast script cannot see', async () => {
  // scripts/e2e-contrast.mjs samples three buttons on the OPAQUE card, so it
  // cannot see: the error banner (a red wash over the card = 4.44:1 light /
  // 3.94:1 dark, both under the floor), the link-style labels (the aliased
  // accent = 4.24:1), the meta text (the aliased tertiary = 3.70:1), or the
  // dialog's white-on-error-red (4.4976:1). These assertions pin the
  // replacements, so "simplify it back to the token" now fails a test.
  const base = OK_PING_AND_QUEUE()
  const rpc = (endpoint) => {
    if (endpoint === 'restore') return Promise.reject(Object.assign(new Error('session/not-found'), { code: 'session/not-found' }))
    return base(endpoint)
  }
  const { sess, ws } = bulkFixture()
  const { container, cleanup } = await renderSection(rpc, sess, ws)
  try {
    await withLayout(async () => {
      // The banner is the failure channel, so its own text has to clear AA.
      const restore = [...container.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'restore')
    assert.ok(restore, 'the Restore control renders')
    // jsdom's CSSOM normalizes the literals inside `light-dark(...)` to rgb(),
    // so these pin the exact colour rather than the hex spelling.
    assert.ok(restore.style.color.includes('light-dark(rgb(72, 104, 178)'), `link text: #4868b2 = 5.39:1 in light, not the token's 4.24:1 (${restore.style.color})`)
    await act(async () => { restore.click(); await settle() })
    const alert = container.querySelector('[role="alert"]')
    assert.ok(alert, 'the failure is surfaced')
    assert.ok(alert.style.color.includes('light-dark(rgb(220, 38, 38)'), `banner text: #dc2626 = 4.83:1 on the surface below (${alert.style.color})`)
    assert.ok(alert.style.background.includes('--dsw-alias-bg-layer-2'), `banner background: the opaque card (${alert.style.background})`)
    assert.ok(!alert.style.background.includes('hover-danger'), 'never the red wash (4.44:1 light / 3.94:1 dark)')
    assert.ok(alert.style.border.includes('--dsw-alias-state-error-primary'), 'the red moved to the border, where the 3:1 graphic floor applies')

    // The dialog's Delete button: white on the theme's #ec1313 is 4.4976:1 —
    // under the floor by 0.002, and the very number this file cites as the
    // reason that red cannot carry text.
    await act(async () => { rowDeleteButton(container, 0).click(); await settle() })
    const overlay = confirmOverlay()
    assert.ok(overlay, 'the dialog is up')
    const confirm = [...overlay.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'confirm')
    assert.ok(confirm.style.background.includes('light-dark(rgb(220, 38, 38)'), `danger fill: #dc2626 = 4.83:1 in light (${confirm.style.background})`)
    await escapeDialog()
    })
  } finally {
    await cleanup()
  }
})
