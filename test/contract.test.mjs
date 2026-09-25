// Contract tests: bind the two halves of the wire to each other, and bind this
// plugin's client-half assumptions to the installed dsh.
//
// Why this file exists: the browser half called `sessions.refreshList()` for three
// releases. No published client service ever carried that name (0.1.5-rc.1,
// 0.1.7-alpha.1, 0.1.7-rc.1 and 0.1.7-rc.2 all expose only `refresh()`), so all
// eight guards skipped silently — and every render test stayed green because its
// fakes carried the same invented name. A typo or a one-sided rename should fail
// HERE instead of in the user's UI.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CHANNEL, RPC_ENDPOINTS, RPC_NAMESPACE } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const clientSource = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/** Endpoints the browser half calls, read out of the source. */
const clientEndpoints = () => new Set([...clientSource.matchAll(/\brpc\(\s*'([^']+)'/g)].map((match) => match[1]))

/** Reached only from the host side: `list` has no browser caller (the settings
 *  page renders from the client stores; the agent tools go through the manager).
 *  Listed deliberately — a NEW endpoint must either be called by the client or
 *  be added here, so nobody has to guess whether a route is dead. */
const HOST_ONLY_ENDPOINTS = ['list']

test('every rpc() call site passes a literal endpoint, so the scan sees all of them', () => {
  const calls = [...clientSource.matchAll(/\brpc\(/g)].length
  const literals = [...clientSource.matchAll(/\brpc\(\s*'([^']+)'/g)].length
  assert.ok(calls > 0, 'the scan must find the helper calls')
  assert.equal(literals, calls, 'a computed endpoint name would make this contract test blind — keep them literal')
})

test('every endpoint the browser half calls is a registered host endpoint', () => {
  const called = clientEndpoints()
  assert.ok(called.size > 0, 'the scan must find the call sites')
  for (const endpoint of called) {
    assert.ok(RPC_ENDPOINTS.includes(endpoint), `lib/client.js calls rpc('${endpoint}'), which the host does not register`)
  }
})

test('the client/host endpoint sets agree, with host-only endpoints declared', () => {
  const declared = [...new Set([...clientEndpoints(), ...HOST_ONLY_ENDPOINTS])].sort()
  assert.deepEqual(declared, [...RPC_ENDPOINTS].sort(), 'RPC_ENDPOINTS and the browser half drifted apart')
})

test('the halves agree on the namespace and the channel prefix', () => {
  const clientNs = clientSource.match(/const NS = '([^']+)'/)?.[1]
  const clientChannel = clientSource.match(/const CHANNEL = '([^']+)'/)?.[1]
  assert.equal(clientNs, RPC_NAMESPACE, 'the method namespace must match the host export')
  // The host exports the FULL route prefix (`/api/session-manager`); the browser
  // half rides the connection client's shared `/api` prefix and passes the
  // `${NS}/${endpoint}` method, so the two compose the host's route path.
  assert.equal(`${clientChannel}/${clientNs}`, CHANNEL, 'client CHANNEL + NS must compose the host route prefix')
  assert.ok(CHANNEL.startsWith('/api'), 'the exact fetch routes live under the host\'s shared /api prefix')
})

test('the endpoints no behaviour test exercises are still called by the client', () => {
  // `restore` and `deferred/cancel` have no coverage in test/client.render.test.mjs
  // (no test clicks their buttons), so their literals would drift unseen.
  for (const endpoint of ['restore', 'deferred/cancel']) {
    assert.ok(clientSource.includes(`rpc('${endpoint}'`), `rpc('${endpoint}') must exist in lib/client.js`)
  }
})

// ── the installed dsh surface (skipped where dsh is not installed, e.g. CI) ───
//
// This half cannot run in CI, and it is not pretended otherwise: it is the LOCAL
// upgrade guard. When dsh is upgraded on a dev machine, a renamed export or a
// moved method fails here before it reaches a user.

const installedClientModule = () => {
  const override = process.env.DSH_CLIENT_MODULE
  const candidates = [
    ...(override === undefined ? [] : [override]),
    join(here, '..', 'node_modules', '@deepseek-ai', 'dsh-api-session-controller', 'lib', 'client.js'),
    join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-api-session-controller', 'lib', 'client.js'),
    join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-api-session-controller', 'lib', 'client.js'),
  ]
  return candidates.find((candidate) => existsSync(candidate))
}

/**
 * The contract this plugin has with the OFFICIAL module, as a pure predicate so
 * the guard itself can be tested (see the fixtures below).
 *
 * It asserts the SURFACE — the service is provided, it carries a zero-argument
 * `refresh()` (the entry `lib/client.js` calls), and the snapshot keys we read —
 * and deliberately NOT the delegation body. `refresh() { return
 * this.manager.refreshList(); }` is an implementation detail: pinning it turns a
 * harmless upstream refactor into a red CI while the entry we call is still
 * there, and the failure direction we care about is a MISSING entry.
 */
function assertServiceSurface(source, label) {
  assert.ok(source.includes('provide("sessions"'), `${label}: no longer provides the sessions service`)
  assert.match(source, /refresh\(\)\s*\{/, `${label}: no longer exposes a service-level refresh() — lib/client.js calls it`)
  for (const key of ['byId', 'phase']) {
    assert.ok(source.includes(key), `${label}: no longer carries the list snapshot key "${key}"`)
  }
}

const SURFACE_FIXTURES = {
  // The shape shipped today (0.1.5-rc.1 … 0.1.7-rc.2 all match it).
  current: 'reflect.provide("sessions", this, void 0);\n\t\t\trefresh() { return this.manager.refreshList(); }\nbyId phase',
  // A harmless upstream refactor: the service entry stays, delegation moves.
  refactored: 'reflect.provide("sessions", this, void 0);\n\t\t\trefresh() { return this.manager.reload(); }\nbyId phase',
  // The entry this plugin calls, gone.
  missingRefresh: 'reflect.provide("sessions", this, void 0);\n\t\t\trefreshProjections() {}\nbyId phase',
}

test('the surface predicate keeps the entry this plugin calls, and nothing more', () => {
  // Both shapes that KEEP `refresh()` must pass: relaxing the assertion must not
  // blind the guard.
  assertServiceSurface(SURFACE_FIXTURES.current, 'current')
  assertServiceSurface(SURFACE_FIXTURES.refactored, 'refactored')
  // Losing the entry, or the service itself, must still fail loudly.
  assert.throws(() => assertServiceSurface(SURFACE_FIXTURES.missingRefresh, 'fixture'), /refresh\(\)/)
  assert.throws(() => assertServiceSurface('nothing here', 'fixture'), /sessions service/)
})

test('the installed dsh client service still carries the surface this plugin uses', (t) => {
  const modulePath = installedClientModule()
  if (modulePath === undefined) {
    t.skip('no installed dsh client module found — set DSH_CLIENT_MODULE to point at one (this guard is local-only)')
    return
  }
  assertServiceSurface(readFileSync(modulePath, 'utf8'), modulePath)
  const workspaceModule = join(dirname(modulePath), '..', '..', 'dsh-api-workspace-controller', 'lib', 'client.js')
  if (existsSync(workspaceModule)) {
    const workspaceSource = readFileSync(workspaceModule, 'utf8')
    for (const key of ['items', 'archivedSessionIds']) {
      assert.ok(workspaceSource.includes(key), `${workspaceModule} no longer carries the workspaces snapshot key "${key}"`)
    }
  }
})
