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

/**
 * Resolve a file inside an INSTALLED dsh package. Three roots, in order: this
 * repo's own node_modules, the dsh profile install, and the npm-global dsh.
 * They are not equivalent — `~/.dsh/profiles/node_modules/@deepseek-ai` has no
 * `dsh-client-ui-primitives`, so a guard that only looked there would silently
 * skip forever. Callers skip when nothing resolves.
 */
const installedUnder = (relative, extraCandidates = []) => {
  const roots = [
    join(here, '..', 'node_modules', '@deepseek-ai'),
    join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai'),
    join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'),
  ]
  return [...extraCandidates, ...roots.map((root) => join(root, ...relative.split('/')))]
    .find((candidate) => existsSync(candidate))
}

const installedClientModule = () => installedUnder(
  'dsh-api-session-controller/lib/client.js',
  process.env.DSH_CLIENT_MODULE === undefined ? [] : [process.env.DSH_CLIENT_MODULE],
)

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

// ── the installed persistence snapshot shape (host half) ─────────────────────
//
// `sessionPersistence.list()` hands back `{ header, revision, sizeBytes }`
// WRAPPERS, not bare headers. `lib/index.js` unwraps `.header` in both places it
// reads the listing (the summary fallback and the artifact-resolution seam), and
// reading the wrapper as the header silently keyed every session `'undefined'`
// and reduced that seam to a no-op — while the host test's fake, which returned
// flat headers, kept the suite green the whole time. Same "mock mirrors the
// invention" class as the client surface check above, on the host side of the
// wire: the fake was fixed, and this is the guard that would have caught it.

const installedPersistenceModule = () => installedUnder('dsh-session-persistence-jsonl/lib/index.js')

/**
 * The surface `lib/index.js` depends on: a `list()` that yields snapshot
 * wrappers. Deliberately NOT the wrapper's field-by-field body — an upstream
 * rename of `revision`/`sizeBytes` is harmless to us, a change of the outer
 * shape is not.
 */
function assertSnapshotShape(source, label) {
  assert.match(source, /async\s+list\s*\(/, `${label}: the backend no longer exposes async list()`)
  assert.match(source, /\.push\(\{\s*header\s*:/, `${label}: list() no longer yields { header, revision, sizeBytes } wrappers — lib/index.js unwraps .header`)
}

const SNAPSHOT_FIXTURES = {
  // The shape shipped today (both installed copies match it).
  current: 'async list(options) {\n\t\t\tconst snapshots = [];\n\t\t\tsnapshots.push({\n\t\t\t\theader: artifact.header,\n\t\t\t\trevision: fileRevision(identity),\n\t\t\t\tsizeBytes: Number(identity.size)\n\t\t\t});\n\t\t\treturn snapshots;\n\t\t}',
  // A harmless upstream refactor: the wrapper stays, the locals are renamed.
  renamed: 'async list() {\n\t\t\tconst emitted = [];\n\t\t\temitted.push({ header: entry.header, revision: entry.revision });\n\t\t\treturn emitted;\n\t\t}',
  // The shape this plugin used to assume, and must fail loudly on.
  bareHeader: 'async list() {\n\t\t\tconst snapshots = [];\n\t\t\tsnapshots.push(artifact.header);\n\t\t\treturn snapshots;\n\t\t}',
}

test('the snapshot-shape predicate keeps the wrapper this plugin unwraps, and nothing more', () => {
  assertSnapshotShape(SNAPSHOT_FIXTURES.current, 'current')
  assertSnapshotShape(SNAPSHOT_FIXTURES.renamed, 'renamed')
  assert.throws(() => assertSnapshotShape(SNAPSHOT_FIXTURES.bareHeader, 'fixture'), /wrappers/)
  assert.throws(() => assertSnapshotShape('nothing here', 'fixture'), /async list\(\)/)
})

test('the installed persistence backend still yields the snapshot wrapper this plugin unwraps', (t) => {
  const modulePath = installedPersistenceModule()
  if (modulePath === undefined) {
    t.skip('no installed dsh persistence backend found — this guard is local-only')
    return
  }
  assertSnapshotShape(readFileSync(modulePath, 'utf8'), modulePath)
})

// ── the installed primitives exports + the official slots (client half) ──────
//
// Every symbol `lib/client.js` destructures out of `dsh-client-ui-primitives` is
// a HARD upgrade dependency, and a renamed export arrives as `undefined` — NOT
// as an error: dsh 0.1.7's size-neutral icon rename
// (`IconArchiveOutline20` → `IconArchiveOutlineRegular`) made
// `React.createElement(undefined, …)` throw React error #130 and blank the
// settings section. A renamed SLOT is worse still: the surface simply never
// mounts and nothing is logged anywhere.
//
// `test/client.render.test.mjs` stubs that module with a HAND-MAINTAINED name
// list (`PRIMITIVE_NAMES`), so it can only catch a name client.js ADDS — and
// that suite imports no `node:fs` at all, so it can never compare against the
// installed package. These two guards cover the OTHER direction, the one that
// has actually broken in the field: they open the installed module and assert
// the names are still there.

const PRIMITIVES_USED = [
  'IconArchiveOutlineRegular',
  'IconCheckOutlineRegular',
  'IconLoadingOutlineRegular',
  'IconRefreshOutlineRegular',
  'IconTrashOutlineRegular',
  'IconWarningOutlineRegular',
  'MenuItemButton',
]

/**
 * A name counts as present when it still appears as an identifier in the
 * package. Deliberately NOT a parse of the export list, and deliberately
 * over-permissive in that direction: a harmless upstream refactor (a
 * re-export, a renamed local alias, a different bundle layout) must keep
 * passing, while a name that is GONE must fail. Same failure-direction choice
 * as `assertServiceSurface` above.
 */
function assertPrimitivesExports(source, label) {
  const missing = PRIMITIVES_USED.filter((name) => !new RegExp(`\\b${name}\\b`).test(source))
  assert.deepEqual(
    missing,
    [],
    `${label}: no longer exports ${missing.join(', ')} — lib/client.js destructures these, and a renamed export arrives as undefined (React error #130), not as an error`,
  )
}

const PRIMITIVES_FIXTURES = {
  // The shipped shape: the names are exported from the bundle.
  current: 'const IconTrashOutlineRegular = trashArtwork;\nconst MenuItemButton = menuRow;\nexport { IconArchiveOutlineRegular, IconCheckOutlineRegular, IconLoadingOutlineRegular, IconRefreshOutlineRegular, IconTrashOutlineRegular, IconWarningOutlineRegular, MenuItemButton };',
  // A harmless upstream refactor: destructured re-export, same names.
  refactored: 'import * as artwork from "./icons-bundle.js";\nexport const { IconArchiveOutlineRegular, IconCheckOutlineRegular, IconLoadingOutlineRegular, IconRefreshOutlineRegular, IconTrashOutlineRegular, IconWarningOutlineRegular, MenuItemButton } = artwork;',
  // The rename that broke the field: one icon's name is gone.
  renamed: 'export { IconArchiveOutlineRegular, IconCheckOutlineRegular, IconLoadingOutlineRegular, IconRefreshOutlineRegular, IconTrashRegular, IconWarningOutlineRegular, MenuItemButton };',
}

test('the primitives predicate keeps the symbols this plugin destructures, and nothing more', () => {
  assertPrimitivesExports(PRIMITIVES_FIXTURES.current, 'current')
  assertPrimitivesExports(PRIMITIVES_FIXTURES.refactored, 'refactored')
  assert.throws(() => assertPrimitivesExports(PRIMITIVES_FIXTURES.renamed, 'fixture'), /IconTrashOutlineRegular/)
  assert.throws(() => assertPrimitivesExports('', 'fixture'), /MenuItemButton/)
})

test('the installed primitives still export the symbols the client half destructures', (t) => {
  const modulePath = installedUnder('dsh-client-ui-primitives/lib/index.js')
  if (modulePath === undefined) {
    t.skip('no installed dsh-client-ui-primitives found — this guard is local-only')
    return
  }
  assertPrimitivesExports(readFileSync(modulePath, 'utf8'), modulePath)
})

const SLOT_LITERALS = ['sidebar.workspaces.session.menu.item', 'settings.section']

/** Both surfaces this plugin registers into must still be declared. */
function assertSlotsDeclared(source, label) {
  for (const slot of SLOT_LITERALS) {
    assert.ok(
      source.includes(slot),
      `${label}: the official slot "${slot}" is gone — a renamed slot is COMPLETELY silent (the surface simply never mounts, and nothing is logged)`,
    )
  }
}

test('the slot predicate keeps both slots this plugin registers into, and nothing more', () => {
  assertSlotsDeclared("register({ name: 'sidebar.workspaces.session.menu.item' }); register({ name: 'settings.section' })", 'current')
  assert.throws(() => assertSlotsDeclared("'settings.section'", 'fixture'), /menu\.item/)
  assert.throws(() => assertSlotsDeclared("'sidebar.workspaces.session.menu.item'", 'fixture'), /settings\.section/)
  assert.throws(() => assertSlotsDeclared('', 'fixture'), /sidebar/)
})

test('the installed client kernel still declares both slots this plugin registers into', (t) => {
  // The kernel enumerates the slot registry, so both literals live in one file.
  const modulePath = installedUnder('dsh-cordis-client-runner/lib/client.js')
  if (modulePath === undefined) {
    t.skip('no installed dsh-cordis-client-runner found — this guard is local-only')
    return
  }
  assertSlotsDeclared(readFileSync(modulePath, 'utf8'), modulePath)
})

// ── the installed session-controller LIST shape (host half) ──────────────────
//
// `collectSummaries()` reads `sessionController.list()`. The installed
// controller answers `{ items: [...] }` — NEVER a bare array — its rows carry no
// top-level `title`, and the display title is the `title` PROJECTION
// (`item.projections.values.title`), which is also where the official browser
// client reads it (`projectionValues?.title`). Requiring an array made every
// summary empty on a real host — title `''`/`(untitled)`, `cwd: null`,
// `updatedAt: null` for EVERY archived session, silently — while the host test's
// fake, which returned exactly that invented flat array, kept the suite green.
// The three facts below are the ones the fix depends on; AGENTS.md recorded the
// fix as "NOT yet covered by the contract guard", and this closes that.

function assertControllerListShape(source, label) {
  assert.match(source, /\{\s*items\s*:/, `${label}: the controller no longer answers an { items } envelope — lib/index.js unwraps it`)
  assert.match(source, /listState\.list\(/, `${label}: list() no longer delegates to listState.list()`)
  assert.match(source, /\{\s*projections\s*\}/, `${label}: rows no longer carry the projections bag — the display title lives at item.projections.values.title`)
}

const CONTROLLER_FIXTURES = {
  current: '\t\tasync list(_request, signal) {\n\t\t\treturn { items: await this.listState.list(signal) };\n\t\t}\n\t\tconst row = { sessionId: session.id, ...(projections === void 0 ? {} : { projections }) };',
  // A harmless upstream refactor: same envelope, an extra field.
  refactored: '\t\tasync list(_request, signal) {\n\t\t\tconst rows = await this.listState.list(signal);\n\t\t\treturn { items: rows, total: rows.length };\n\t\t}\n\t\tconst row = { sessionId: session.id, ...(projections === void 0 ? {} : { projections }) };',
  // The shape this plugin used to require: a bare array.
  bareArray: '\t\tasync list(_request, signal) {\n\t\t\treturn this.listState.list(signal);\n\t\t}\n\t\tconst row = { sessionId: session.id, ...(projections === void 0 ? {} : { projections }) };',
  // The envelope survives but the projections bag is dropped: titles go blank.
  withoutProjections: '\t\tasync list(_request, signal) {\n\t\t\treturn { items: await this.listState.list(signal) };\n\t\t}\n\t\tconst row = { sessionId: session.id };',
}

test('the controller-list predicate keeps the envelope, the delegation and the projections', () => {
  assertControllerListShape(CONTROLLER_FIXTURES.current, 'current')
  assertControllerListShape(CONTROLLER_FIXTURES.refactored, 'refactored')
  assert.throws(() => assertControllerListShape(CONTROLLER_FIXTURES.bareArray, 'fixture'), /\{ items \} envelope/)
  assert.throws(() => assertControllerListShape(CONTROLLER_FIXTURES.withoutProjections, 'fixture'), /projections bag/)
})

test('the installed session controller still answers the list shape this plugin unwraps', (t) => {
  const modulePath = installedUnder('dsh-api-session-controller/lib/index.js')
  if (modulePath === undefined) {
    t.skip('no installed dsh-api-session-controller host module found — this guard is local-only')
    return
  }
  assertControllerListShape(readFileSync(modulePath, 'utf8'), modulePath)
})

/** The display title is the `title` PROJECTION, keyed by name. */
function assertTitleProjection(source, label) {
  assert.match(source, /key:\s*["']title["']/, `${label}: the "title" session projection is gone — lib/index.js reads the display title from item.projections.values.title`)
}

const TITLE_FIXTURES = {
  current: 'ctx.sessionProjections.register({ key: "title", stateSchema: titleSchema, wire: { view: (state) => state } })',
  renamed: 'ctx.sessionProjections.register({ key: "displayTitle", stateSchema: titleSchema })',
}

test('the title-projection predicate keeps the key the plugin reads, and nothing more', () => {
  assertTitleProjection(TITLE_FIXTURES.current, 'current')
  assert.throws(() => assertTitleProjection(TITLE_FIXTURES.renamed, 'fixture'), /"title" session projection/)
})

test('the installed session-title package still registers the title projection', (t) => {
  const modulePath = installedUnder('dsh-session-title/lib/index.js')
  if (modulePath === undefined) {
    t.skip('no installed dsh-session-title found — this guard is local-only')
    return
  }
  assertTitleProjection(readFileSync(modulePath, 'utf8'), modulePath)
})
