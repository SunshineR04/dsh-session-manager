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

async function renderSection(rpc, sessionsOverride) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(React.createElement(section(), { t: (key) => key, rpc, sessions: sessionsOverride ?? sessions, workspaces })) })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  return { text: container.textContent, container, cleanup: () => { root.unmount(); container.remove() } }
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
    cleanup()
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
    cleanup()
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
    cleanup()
  }
})
