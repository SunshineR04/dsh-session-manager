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

const ICON_NAMES = ['IconArchiveOutline20', 'IconCheckOutline16', 'IconLoadingOutline16', 'IconRefreshOutline16', 'IconTrashOutline16', 'IconWarningOutline16']
const requireShim = (name) => {
  if (name === 'react') return React
  if (name === '@deepseek-ai/dsh-client-ui-primitives') {
    return Object.fromEntries(ICON_NAMES.map((icon) => [icon, () => null]))
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
  let section = null
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
      register(_spec, component) {
        section = component
        return { id: 'session-manager' }
      },
    },
  }
  return { ctx, section: () => section }
}

const { ctx, section } = makeCtx()
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

test('settings section renders rows and filters tombstoned (queued) ids', async () => {
  const rpc = (endpoint) => {
    if (endpoint === 'deferred/list') return Promise.resolve({ sessionIds: [TOMBSTONE], recoverable: [] })
    if (endpoint === 'ping') return Promise.resolve({ version: '0.2.0', menuDeleteAvailable: true })
    return new Promise(() => {})
  }
  const { text, cleanup } = await renderSection(rpc)
  try {
    assert.ok(text.includes('Hello world'), 'visible archived row renders')
    assert.ok(!text.includes('unknownSession'), 'tombstoned id without a summary must be filtered out of the rows')
    assert.ok(text.includes('pendingBanner'), 'pending banner renders')
    assert.ok(text.includes('pendingFinalizing'), 'data-gone entry shows the finalizing hint')
    assert.ok(!text.includes('pendingCancel'), 'data-gone entry offers no cancel button')
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
    assert.ok(!text.includes('pendingFinalizing'), 'no finalizing hint for a recoverable entry')
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
