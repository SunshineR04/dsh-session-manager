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
// behaviour under test unreachable.
const PRIMITIVE_NAMES = ['IconArchiveOutlineRegular', 'IconCheckOutlineRegular', 'IconLoadingOutlineRegular', 'IconRefreshOutlineRegular', 'IconTrashOutlineRegular', 'IconWarningOutlineRegular']
const requireShim = (name) => {
  if (name === 'react') return React
  if (name === '@deepseek-ai/dsh-client-ui-primitives') {
    const stubs = Object.fromEntries(PRIMITIVE_NAMES.map((icon) => [icon, () => null]))
    stubs.MenuItemButton = ({ children, onSelect }) => React.createElement('button', { type: 'button', role: 'menuitem', onClick: onSelect }, children)
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

function makeCtx() {
  const components = new Map()
  const specs = new Map()
  const ctx = {
    locale: { register() {}, bind: () => (key) => key },
    get: () => undefined,
    effect: (fn) => fn(),
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
    menuItem: () => components.get('sidebar.workspaces.session.menu.item'),
    menuSpec: () => specs.get('sidebar.workspaces.session.menu.item'),
  }
}

const { ctx, section, menuItem, menuSpec } = makeCtx()
mod.apply(ctx)

const makeStore = (snapshot) => ({ subscribe: () => () => {}, getSnapshot: () => snapshot })
const ID = 'session-3012b8a0-1fef-4f34-8d9c-a6c5b7aa84d2'
const TOMBSTONE = 'session-7c9f1d2e-4a5b-4c8d-9e0f-1a2b3c4d5e6f'
const sessions = {
  list: makeStore({ byId: { [ID]: { displayTitle: 'Hello world', cwd: 'C:\\x', updatedAt: 100, running: false } }, ids: [ID], phase: 'ready' }),
  refreshList: async () => {},
}
const workspaces = { list: makeStore({ items: [{ workspaceId: 'w1', title: 'test', path: 'C:/x', sessionIds: [ID] }], archivedSessionIds: [ID, TOMBSTONE] }) }

async function renderSection(rpc, sessionsOverride, workspacesOverride) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(React.createElement(section(), { t: (key) => key, rpc, sessions: sessionsOverride ?? sessions, workspaces: workspacesOverride ?? workspaces })) })
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
  const sessionsRefreshing = {
    list: sessions.list,
    refreshList: () => new Promise((resolve) => { resolveRefresh = resolve }),
  }
  const rpc = (endpoint) => {
    if (endpoint === 'deferred/list') return Promise.resolve({ sessionIds: [], recoverable: [] })
    if (endpoint === 'ping') return Promise.resolve({ version: '0.2.1', menuDeleteAvailable: true })
    return new Promise(() => {})
  }
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
  const sess = {
    list: makeStore({ byId, ids: [ID, ID2, ID3], phase: 'ready' }),
    refreshList: async () => {},
  }
  const ws = { list: makeStore({ items: [{ workspaceId: 'w1', title: 'test', path: 'C:/x', sessionIds: [ID, ID2, ID3] }], archivedSessionIds: [ID, ID2, ID3] }) }
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
  } = options
  clearToasts()
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
  }
  await act(async () => { root.render(React.createElement(menuItem(), props)) })
  await act(async () => { await settle() })
  return {
    container,
    menuOpenCalls,
    item: () => container.querySelector('[role="menuitem"]'),
    cleanup: async () => {
      // Leaving a dialog open would strand the plugin's one-at-a-time guard
      // and silently neuter every later menu test.
      if (confirmOverlay() !== null) {
        await act(async () => {
          document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
          await settle()
        })
      }
      await act(async () => { root.unmount() })
      container.remove()
      clearToasts()
    },
  }
}

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
