// Host unit tests: mock the dsh seams (workspaceRegistry / sessionController /
// sessionPersistence / live session store) and exercise the real manager code
// against real temporary directories.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readdir, symlink } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSessionManager, rpcHandlerFor, rpcRouteHandler, SessionManagerError, apply, registerTools, RPC_ENDPOINTS, RPC_NAMESPACE, CHANNEL } from '../lib/index.js'

// ---------------------------------------------------------------------------

const SESSION_ID = 'session-3012b8a0-1fef-4f34-8d9c-a6c5b7aa84d2'
const OTHER_ID = 'session-9987799d-52b1-464a-8db2-5d16bb8a9bd5'
const CWD = 'C:\\Users\\test\\project'

function makeWorkspace(id, title, path, sessionIds) {
  return {
    id,
    title,
    path,
    get sessionIds() {
      return sessionIds
    },
    async detachSession(sessionId) {
      const index = sessionIds.indexOf(sessionId)
      if (index !== -1) sessionIds.splice(index, 1)
    },
    /**
     * Re-attach. `deferred/cancel` restores the slot the delete removed, so the
     * fixture needs the official `Workspace.attachSession` surface — without it
     * the re-attach code path could only ever be exercised by its "this dsh
     * build has no attachSession" warning.
     */
    async attachSession(sessionId) {
      if (!sessionIds.includes(sessionId)) sessionIds.push(sessionId)
    },
    async setTitle() {},
  }
}

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsm-test-'))
  const home = join(root, '.dsh')
  const sessionsRoot = join(home, 'sessions')
  const storagesRoot = join(home, 'storages')
  // Isolate dshHome()'s env seam: without this, a machine that has DSH_HOME
  // set (e.g. an e2e-capable dev box) would silently send the pending queue
  // and the projcache sweep into the REAL user home. Each host test file runs
  // in its own `node --test` child process, so this mutation never escapes.
  process.env.DSH_HOME = home
  return { root, home, sessionsRoot, storagesRoot }
}

/** Build a mock host ctx around the fixture dirs. */
function makeCtx(overrides = {}) {
  const home = overrides.fixture.home
  const sessionsRoot = overrides.fixture.sessionsRoot

  const headers = new Map()
  const state = {
    initialized: true,
    workspaceIds: ['ws-1'],
    archivedSessionIds: [SESSION_ID],
  }
  const workspaces = [makeWorkspace('ws-1', 'project', CWD, [SESSION_ID])]
  const persistedStates = []
  const live = new Map(overrides.liveSessions ?? [])

  const persistence = {
    root: sessionsRoot,
    locate(meta) {
      return { kind: 'jsonl', path: join(sessionsRoot, `--${String(meta.cwd).replace(/[\\/:]/g, '-')}--`, meta.id, 'session.jsonl.zstd') }
    },
    // The REAL shape: `list()` yields snapshot WRAPPERS (`{ header, revision,
    // sizeBytes }`), not bare headers — verified against the shipped
    // `dsh-session-persistence-jsonl` and against both official consumers
    // (`dsh-workspace`, `dsh-session-query`), which all unwrap `.header`. A flat
    // fake here is what kept a dead artifact-resolution seam invisible.
    async list() {
      return [...headers.values()].map((header) => ({ header, revision: 'test', sizeBytes: 0 }))
    },
  }

  const registry = {
    archivedSessionIds: state.archivedSessionIds,
    list: () => workspaces,
    get: (id) => workspaces.find((workspace) => workspace.id === id),
    async sessionKnown(id) {
      return headers.has(id)
    },
    async readSessionHeader(id) {
      const header = headers.get(id)
      if (header === undefined) throw new Error(`no header for ${id}`)
      return header
    },
    requireState: () => state,
    async setState(next) {
      persistedStates.push(next)
      state.archivedSessionIds = [...next.archivedSessionIds]
      state.workspaceIds = [...next.workspaceIds]
    },
  }

  // The REAL controller row shape, verified against the shipped
  // `dsh-api-session-controller` 0.2.0-rc.2: no top-level `title`, no
  // `createdAt`, and the display title inside the `title` PROJECTION
  // (`listFields()` adds only cwd/origin/parentSessionId). A fake that returns
  // a flat array of `{ title }` rows — which this used to be — is exactly what
  // kept the silent empty-summary defect green, so keep this shape even though
  // it is more verbose.
  const summaries = [
    { sessionId: SESSION_ID, cwd: CWD, updatedAt: 1700000000000, running: false, blank: false, projections: { values: { title: 'Greeting' } } },
    { sessionId: OTHER_ID, cwd: CWD, updatedAt: 1600000000000, running: false, blank: false, projections: { values: { title: 'Other' } } },
  ]

  const sessionController = {
    // The REAL envelope: `list()` answers `{ items: [...] }`, never a bare array
    // (`dsh-api-session-controller/lib/index.js`: `return { items: await
    // this.listState.list(signal) }`).
    async list() {
      return { items: summaries.filter((summary) => headers.has(summary.sessionId)) }
    },
  }

  const services = {
    workspaceRegistry: registry,
    sessionPersistence: persistence,
    sessionController: overrides.sessionController ?? sessionController,
    sessions: { get: (id) => live.get(id) },
    settings: overrides.settings ?? { get: () => undefined },
    logger: overrides.logger ?? { warn: () => {}, info: () => {} },
  }

  const events = []
  const ctx = {
    services,
    events,
    // The real Cordis context carries its own `logger` (the host code warns
    // through `ctx.logger?.warn?.`, not through the services map), so the
    // fixture must expose it or a warning path can never be asserted.
    logger: services.logger,
    get(name) {
      return services[name]
    },
    emit(event, ...args) {
      events.push([event, ...args])
    },
    effect(fn) {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    inject(deps, callback) {
      const child = {
        ...ctx,
        get: (name) => (deps.includes(name) ? services[name] : ctx.get(name)),
        effect: ctx.effect,
      }
      for (const dep of deps) child[dep] = services[dep]
      callback(child)
      return () => {}
    },
  }

  return { ctx, fixture: overrides.fixture, registry, persistence, state, persistedStates, headers, live, services, events }
}

/** Materialize fake on-disk session artifacts for one session. */
async function writeSessionFiles(fixture, sessionId, { cwd = CWD, projcache = true, bak = false } = {}) {
  const projectDir = join(fixture.sessionsRoot, `--${cwd.replace(/[\\/:]/g, '-')}--`)
  const sessionDir = join(projectDir, sessionId)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.jsonl.zstd'), 'fake-zstd-bytes')
  if (projcache) {
    const dir = join(fixture.storagesRoot, 'session_projcache', 'sessions')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${sessionId}.json`), '{"version":5}')
    if (bak) await writeFile(join(dir, `${sessionId}.json.bak-20260901`), '{}')
  }
}

// ---------------------------------------------------------------------------

test('listArchived joins archive set with summaries and workspaces', async () => {
  const fixture = await makeFixture()
  const { ctx, headers } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD, createdAt: 1690000000000 })
  const manager = createSessionManager(ctx, {})
  const result = await manager.listArchived()
  assert.equal(result.items.length, 1)
  const entry = result.items[0]
  assert.equal(entry.sessionId, SESSION_ID)
  assert.equal(entry.title, 'Greeting')
  assert.equal(entry.workspace.title, 'project')
  assert.equal(entry.running, false)
})

test('listArchived reads the title from the controller projection, not the row', async () => {
  // Guards the blocker: the installed controller's rows carry NO top-level
  // `title` and no `createdAt` (`listFields()` adds only cwd/origin/
  // parentSessionId) and `list()` answers `{ items }`, never a bare array.
  // A reader that required `Array.isArray(items)` reported every archived
  // session as title '' / cwd undefined / updatedAt null on a real host while
  // this suite stayed green, because the fixture used to encode exactly that
  // invented shape.
  const fixture = await makeFixture()
  const { ctx, headers } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD, createdAt: 1690000000000 })
  const manager = createSessionManager(ctx, {})
  const entry = (await manager.listArchived()).items[0]
  assert.equal(entry.title, 'Greeting') // from `projections.values.title`
  assert.equal(entry.cwd, CWD) // from the row
  assert.equal(entry.updatedAt, 1700000000000) // the row's own updatedAt
  assert.equal(entry.createdAt, null) // the row exposes no creation time
})

test('listArchived still accepts a controller that answers a bare array', async () => {
  // An alternative composition may hand the rows over directly; both shapes
  // must keep working, so the unwrap cannot be "real shape only".
  const fixture = await makeFixture()
  const { ctx, headers } = makeCtx({
    fixture,
    sessionController: {
      async list() {
        return [{ sessionId: SESSION_ID, title: 'Flat', cwd: CWD, updatedAt: 1700000000000, running: false, blank: false }]
      },
    },
  })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  const manager = createSessionManager(ctx, {})
  assert.equal((await manager.listArchived()).items[0].title, 'Flat')
})

test('an unrecognized controller shape warns once and falls back to the persistence listing', async () => {
  // An unreadable shape must be LOUD and must not be reported as an empty
  // corpus — silently doing so is how the `{ header }` wrapper breakage hid.
  const warnings = []
  const fixture = await makeFixture()
  const { ctx, headers } = makeCtx({
    fixture,
    sessionController: { async list() { return { rows: [] } } },
    logger: { warn: (message) => warnings.push(String(message)), info: () => {} },
  })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD, createdAt: 1690000000000 })
  const manager = createSessionManager(ctx, {})
  const result = await manager.listArchived()
  assert.equal(result.items.length, 1) // the header listing still resolves it
  assert.equal(result.items[0].cwd, CWD)
  assert.equal(warnings.filter((m) => m.includes('unrecognized shape')).length, 1)
  await manager.listArchived()
  assert.equal(warnings.filter((m) => m.includes('unrecognized shape')).length, 1)
})

test('deleteSession detaches the workspace BEFORE the archive set changes', async () => {
  // The documented load-bearing order: the session is still archived (hidden)
  // while it is detached, so a row never flashes back into the workspace
  // browser between the two frames. Asserting the end state alone (as the
  // other delete tests do) cannot see this — only the call order can.
  const fixture = await makeFixture()
  const { ctx, headers, registry } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  await writeSessionFiles(fixture, SESSION_ID)
  const workspace = registry.list()[0]
  const detach = workspace.detachSession.bind(workspace)
  const setState = registry.setState.bind(registry)
  const order = []
  workspace.detachSession = async (id) => { order.push('detach'); return detach(id) }
  registry.setState = async (next) => { order.push('setState'); return setState(next) }
  const manager = createSessionManager(ctx, {})
  await manager.deleteSession(SESSION_ID)
  assert.deepEqual(order, ['detach', 'setState'])
})

test('restoreSession unarchives and keeps the workspace slot', async () => {
  const fixture = await makeFixture()
  const { ctx, headers, state } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  const manager = createSessionManager(ctx, {})
  const result = await manager.restoreSession(SESSION_ID)
  assert.equal(result.restored, true)
  assert.deepEqual(result.archivedSessionIds, [])
  assert.deepEqual(state.archivedSessionIds, [])
})

test('restoreSession rejects a non-archived session', async () => {
  const fixture = await makeFixture()
  const { ctx, headers } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  const manager = createSessionManager(ctx, {})
  await assert.rejects(manager.restoreSession(OTHER_ID), (error) => error instanceof SessionManagerError && error.code === 'session/not-archived')
})

test('deleteSession removes files, archive entry and workspace accounting', async () => {
  const fixture = await makeFixture()
  const { ctx, headers, state } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  await writeSessionFiles(fixture, SESSION_ID, { bak: true })
  const manager = createSessionManager(ctx, {})
  const result = await manager.deleteSession(SESSION_ID)
  assert.equal(result.deleted, true)
  assert.deepEqual(state.archivedSessionIds, [])
  assert.deepEqual(ctx.get('workspaceRegistry').list()[0].sessionIds, [])
  const sessionDir = join(fixture.sessionsRoot, `--${CWD.replace(/[\\/:]/g, '-')}--`, SESSION_ID)
  assert.equal(existsSync(sessionDir), false)
  const projcacheDir = join(fixture.storagesRoot, 'session_projcache', 'sessions')
  const leftovers = (await readdir(projcacheDir)).filter((name) => name.startsWith(SESSION_ID))
  assert.deepEqual(leftovers, [])
})

test('deleteSession removes an open idle session at once, tombstoned until the boot sweep', async () => {
  const fixture = await makeFixture()
  const { ctx, headers, state, events } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  await writeSessionFiles(fixture, SESSION_ID)
  const manager = createSessionManager(ctx, {})

  // live + idle -> deleted right away; archive set keeps a tombstone
  ctx.services.sessions = { get: (id) => (id === SESSION_ID ? {} : undefined) }
  const result = await manager.deleteSession(SESSION_ID)
  assert.equal(result.deleted, true)
  assert.equal(result.openAtDelete, true)
  const sessionDir = join(fixture.sessionsRoot, `--${CWD.replace(/[\\/:]/g, '-')}--`, SESSION_ID)
  assert.equal(existsSync(sessionDir), false, 'files of an open idle session are removed immediately')
  assert.deepEqual(state.archivedSessionIds, [SESSION_ID], 'tombstone keeps the lingering summary hidden')
  assert.deepEqual(await manager.readPending(), [SESSION_ID])
  assert.ok(events.some(([event, id]) => event === 'api-session/removed' && id === SESSION_ID))

  // live + running agent + switch OFF -> refused
  ctx.services.agents = { get: (id) => (id === SESSION_ID ? { status: 'running' } : undefined) }
  const strict = createSessionManager(ctx, {})
  await assert.rejects(strict.deleteSession(SESSION_ID), (error) => error instanceof SessionManagerError && error.code === 'session/running')

  // live + running agent + switch ON -> forced, and STILL an open-session
  // delete: tombstoned and queued, never a cold delete. The switch only skips
  // the refusal.
  const permissive = createSessionManager(ctx, { allowDeleteRunning: true })
  const forced = await permissive.deleteSession(SESSION_ID)
  assert.equal(forced.deleted, true)
  assert.equal(forced.openAtDelete, true, 'a forced delete is still an open-session delete')
  assert.deepEqual(state.archivedSessionIds, [SESSION_ID], 'and it still tombstones, so the lingering summary stays hidden')
  assert.deepEqual(await permissive.readPending(), [SESSION_ID], 'and it stays queued for the boot sweep')
})

test('a file failure after bookkeeping is a warning, not an aborted delete', async () => {
  // Windows refuses to remove a directory that is a live process's CWD (EBUSY)
  // — the same class of failure as an antivirus scanner, a search indexer or a
  // foreign handle, which is what this contract exists for. Previously that
  // rejection propagated AFTER the id had been detached and un-archived, so the
  // session was no longer listable, retryable or cancellable while its files
  // stayed on disk. POSIX permits removing a live CWD, so the failure assertion
  // is platform-aware; what must hold EVERYWHERE is that the delete commits.
  const fixture = await makeFixture()
  const { ctx, headers, state } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  await writeSessionFiles(fixture, SESSION_ID)
  const manager = createSessionManager(ctx, {})
  const sessionDir = join(fixture.sessionsRoot, `--${CWD.replace(/[\\/:]/g, '-')}--`, SESSION_ID)
  const previousCwd = process.cwd()
  let result
  try {
    process.chdir(sessionDir)
    result = await manager.deleteSession(SESSION_ID)
  } finally {
    process.chdir(previousCwd)
  }
  assert.equal(result.deleted, true, 'the delete still commits')
  assert.deepEqual(state.archivedSessionIds, [], 'and the archive entry is still released')
  if (process.platform === 'win32') {
    assert.ok(
      (result.warnings ?? []).some((line) => line.includes('could not be removed')),
      `the file failure is REPORTED rather than thrown (warnings: ${JSON.stringify(result.warnings)})`,
    )
  }
})

test('an open-session delete records the workspaces it detached from', async () => {
  // The record is what makes a later cancel able to restore the slot. (The
  // normal open delete disposes the files at once, so IT can no longer be
  // cancelled — `session/data-gone`; the record only comes into play for a
  // mid-delete crash leftover, which is exactly the state the UI offers Cancel
  // for. See the next test.)
  const fixture = await makeFixture()
  const { ctx, headers, registry } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  await writeSessionFiles(fixture, SESSION_ID)
  const manager = createSessionManager(ctx, {})
  ctx.services.sessions = { get: (id) => (id === SESSION_ID ? {} : undefined) }

  await manager.deleteSession(SESSION_ID)
  assert.deepEqual(registry.list()[0].sessionIds, [], 'the slot is detached')
  const queued = JSON.parse(readFileSync(manager.pendingFile(), 'utf8'))
  assert.equal(queued.version, 2)
  assert.deepEqual(queued.detached[SESSION_ID], ['ws-1'], 'and the marker records it for a cancel')
})

test('deferred/cancel restores the workspace slot the delete removed', async () => {
  // Without this the user cancels a deletion and gets the session back as an
  // UNGROUPED row — the exact residue shape the tombstone exists to prevent.
  const fixture = await makeFixture()
  const { ctx, headers, state, registry } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  await writeSessionFiles(fixture, SESSION_ID)
  const manager = createSessionManager(ctx, {})
  // A mid-delete CRASH LEFTOVER: detached, tombstoned and queued, but the files
  // are still on disk — the only state a cancel is offered for.
  const workspace = registry.list()[0]
  workspace.sessionIds.splice(0, workspace.sessionIds.length)
  state.archivedSessionIds = [SESSION_ID]
  await mkdir(join(fixture.home, 'storages'), { recursive: true })
  await writeFile(manager.pendingFile(), JSON.stringify({ version: 2, sessionIds: [SESSION_ID], detached: { [SESSION_ID]: ['ws-1'] } }), 'utf8')

  const cancelled = await manager.cancelPending(SESSION_ID)
  assert.deepEqual(cancelled.reattached, ['ws-1'])
  assert.deepEqual(cancelled.warnings, [])
  assert.deepEqual(cancelled.sessionIds, [], 'the marker is dropped')
  assert.deepEqual(workspace.sessionIds, [SESSION_ID], 'and the session is back in its workspace slot')
  assert.deepEqual(state.archivedSessionIds, [], 'the tombstone is cleared')
})

test('deferred/cancel reports a vanished workspace instead of failing', async () => {
  // A lost slot must degrade to a warning: refusing the cancel because a
  // POSITION could not be restored would be the worse outcome.
  const fixture = await makeFixture()
  const { ctx, headers, state, registry } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  await writeSessionFiles(fixture, SESSION_ID)
  const manager = createSessionManager(ctx, {})
  const workspace = registry.list()[0]
  workspace.sessionIds.splice(0, workspace.sessionIds.length)
  state.archivedSessionIds = [SESSION_ID]
  await mkdir(join(fixture.home, 'storages'), { recursive: true })
  await writeFile(manager.pendingFile(), JSON.stringify({ version: 2, sessionIds: [SESSION_ID], detached: { [SESSION_ID]: ['ws-1'] } }), 'utf8')

  registry.list = () => [] // the workspace disappeared while it was queued
  const cancelled = await manager.cancelPending(SESSION_ID)
  assert.deepEqual(cancelled.reattached, [])
  assert.equal(cancelled.warnings.length, 1)
  assert.match(cancelled.warnings[0], /no longer exists/)
  assert.deepEqual(cancelled.sessionIds, [])
  assert.deepEqual(state.archivedSessionIds, [], 'the cancel still succeeds')
})

test('a v1 pending queue still reads, with no workspace record to restore', async () => {
  const fixture = await makeFixture()
  const { ctx, headers } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  await writeSessionFiles(fixture, SESSION_ID)
  const manager = createSessionManager(ctx, {})
  await mkdir(join(fixture.home, 'storages'), { recursive: true })
  await writeFile(manager.pendingFile(), JSON.stringify({ version: 1, sessionIds: [SESSION_ID] }), 'utf8')

  assert.deepEqual(await manager.readPending(), [SESSION_ID])
  const cancelled = await manager.cancelPending(SESSION_ID)
  assert.deepEqual(cancelled.reattached, [], 'nothing was recorded, so nothing can be restored')
  assert.deepEqual(cancelled.warnings, [], 'and that is not an error')
  assert.deepEqual(cancelled.sessionIds, [])
})

test('the boot sweep keeps the workspace record of an entry it cannot finish', async () => {
  const fixture = await makeFixture()
  const { ctx, headers } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  await writeSessionFiles(fixture, SESSION_ID)
  const manager = createSessionManager(ctx, {})
  await mkdir(join(fixture.home, 'storages'), { recursive: true })
  await writeFile(
    manager.pendingFile(),
    JSON.stringify({ version: 2, sessionIds: [SESSION_ID], detached: { [SESSION_ID]: ['ws-1'] } }),
    'utf8',
  )
  // Still live -> the sweep must KEEP it, and its full-list write-back must not
  // silently drop the record a later cancel depends on.
  ctx.services.sessions = { get: (id) => (id === SESSION_ID ? {} : undefined) }

  const swept = await manager.sweepPending()
  assert.deepEqual(swept.remaining, [SESSION_ID])
  const after = JSON.parse(readFileSync(manager.pendingFile(), 'utf8'))
  assert.deepEqual(after.detached[SESSION_ID], ['ws-1'], 'the write-back must preserve the record')
})

/**
 * A registry exposing the OFFICIAL serialized entry points (`dsh-workspace`).
 * The manager must PREFER these over a hand-rolled `setState` spread: `setState`
 * is a bare `global.set` while every official mutation runs on the registry's
 * own queue, so our stale snapshot could undo a concurrent official write.
 */
function officialRegistry(state, headers, workspaces) {
  const calls = { archive: [], unarchive: [], setState: 0 }
  const registry = {
    list: () => workspaces,
    get: (id) => workspaces.find((workspace) => workspace.id === id),
    async sessionKnown(id) { return headers.has(id) },
    async readSessionHeader(id) { return headers.get(id) },
    requireState: () => state,
    async setState(next) { calls.setState += 1; state.archivedSessionIds = [...next.archivedSessionIds] },
    async archiveSession(id, options = {}) {
      calls.archive.push({ id, options })
      if (state.archivedSessionIds.some((value) => String(value) === id)) return
      state.archivedSessionIds = [...state.archivedSessionIds, id]
    },
    async unarchiveSession(id) {
      calls.unarchive.push(id)
      state.archivedSessionIds = state.archivedSessionIds.filter((value) => String(value) !== id)
    },
  }
  // The real registry exposes the set as a GETTER; model that so a stale
  // property copy cannot mask a bug.
  Object.defineProperty(registry, 'archivedSessionIds', { get: () => state.archivedSessionIds })
  return { registry, calls }
}

/** A workspace the manager can detach from and re-attach to. */
function workspaceFor(id, sessionIds) {
  const members = [...sessionIds]
  return {
    id,
    title: id,
    path: CWD,
    record: { sessionIds: [...sessionIds] },
    get sessionIds() { return members },
    async detachSession(sessionId) { const index = members.indexOf(sessionId); if (index !== -1) members.splice(index, 1) },
    async attachSession(sessionId) { if (!members.includes(sessionId)) members.push(sessionId) },
  }
}

test("archive-set writes go through the registry's own serialized entry points", async () => {
  const fixture = await makeFixture()
  const { ctx, headers, state } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  headers.set(OTHER_ID, { id: OTHER_ID, cwd: CWD })
  await writeSessionFiles(fixture, SESSION_ID)
  const workspace = workspaceFor('ws-1', [SESSION_ID, OTHER_ID])
  const { registry, calls } = officialRegistry(state, headers, [workspace])
  ctx.services.workspaceRegistry = registry
  const manager = createSessionManager(ctx, {})

  // An OPEN session: the tombstone goes through archiveSession WITH
  // `stopActivity` — without it the official call throws for running work,
  // which would break allowDeleteRunning after it had decided to proceed.
  ctx.services.sessions = { get: (id) => (id === SESSION_ID ? {} : undefined) }
  state.archivedSessionIds = []
  const opened = await manager.deleteSession(SESSION_ID)
  assert.equal(opened.openAtDelete, true)
  assert.deepEqual(calls.archive.map((call) => call.id), [SESSION_ID])
  assert.deepEqual(calls.archive[0].options, { stopActivity: true })
  assert.deepEqual(state.archivedSessionIds, [SESSION_ID], 'the tombstone landed')

  // A COLD session: unarchiveSession.
  ctx.services.sessions = { get: () => undefined }
  state.archivedSessionIds = [OTHER_ID]
  const cold = await manager.deleteSession(OTHER_ID)
  assert.equal(cold.deleted, true)
  assert.deepEqual(calls.unarchive, [OTHER_ID])
  assert.deepEqual(state.archivedSessionIds, [])

  // restoreSession goes through it too. The open delete above left a queue
  // marker, and restore REFUSES a queued id on purpose — drop it first.
  await manager.removePending(SESSION_ID)
  state.archivedSessionIds = [SESSION_ID]
  const restored = await manager.restoreSession(SESSION_ID)
  assert.deepEqual(calls.unarchive, [OTHER_ID, SESSION_ID])
  assert.deepEqual(restored.archivedSessionIds, [], 'the reported set is re-read from the registry, not from a pre-write copy')

  assert.equal(calls.setState, 0, 'a hand-rolled setState spread is never used when the official entry point exists')
})

test('an unwritable registry is refused BEFORE anything is touched', async () => {
  // No requireState and no official entry points: the only way to write would be
  // a reconstructed spread, which erases fields this plugin cannot see (pins,
  // the default workspace, a pending mutation). Refusing after the detach would
  // strand the session (detached, still archived, no marker) — so the refusal
  // has to come first.
  const fixture = await makeFixture()
  const { ctx, headers, state } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  await writeSessionFiles(fixture, SESSION_ID)
  const workspace = workspaceFor('ws-1', [SESSION_ID])
  const calls = { setState: 0 }
  const unwritable = {
    list: () => [workspace],
    get: (id) => (id === 'ws-1' ? workspace : undefined),
    async sessionKnown() { return true },
    async readSessionHeader() { return { id: SESSION_ID, cwd: CWD } },
    async setState(next) { calls.setState += 1; state.archivedSessionIds = [...next.archivedSessionIds] },
  }
  Object.defineProperty(unwritable, 'archivedSessionIds', { get: () => state.archivedSessionIds })
  ctx.services.workspaceRegistry = unwritable
  const manager = createSessionManager(ctx, {})

  await assert.rejects(
    manager.deleteSession(SESSION_ID),
    (error) => error instanceof SessionManagerError && error.code === 'registry/unavailable',
  )
  assert.deepEqual(workspace.sessionIds, [SESSION_ID], 'refused BEFORE the detach')
  assert.deepEqual(state.archivedSessionIds, [SESSION_ID], 'the archive set is untouched')
  assert.deepEqual(await manager.readPending(), [], 'and no queue marker was written')
  assert.equal(calls.setState, 0)

  await assert.rejects(manager.restoreSession(SESSION_ID), (error) => error.code === 'registry/unavailable')
  await assert.rejects(manager.cancelPending(SESSION_ID), (error) => error.code === 'registry/unavailable')
})

test('apply schedules the boot sweep, which finishes a crash-left tombstone', async (t) => {
  // The boot sweep is the ONLY autonomous crash-recovery path — the whole
  // tombstone design depends on it — yet replacing its body with a no-op used to
  // keep the suite green, because every other test calls `sweepPending` directly
  // and never goes through `apply`.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const fixture = await makeFixture()
  const { ctx, headers, state } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  await writeSessionFiles(fixture, SESSION_ID)
  // A crash leftover: tombstoned + queued, files still on disk, session cold.
  state.archivedSessionIds = [SESSION_ID]
  await mkdir(fixture.storagesRoot, { recursive: true })
  const queueFile = join(fixture.storagesRoot, 'session-manager.pending.json')
  await writeFile(queueFile, JSON.stringify({ version: 2, sessionIds: [SESSION_ID], detached: {} }), 'utf8')

  apply(ctx, {})
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(state.archivedSessionIds, [SESSION_ID], 'nothing happens before the timer fires')

  t.mock.timers.tick(2500)
  // The sweep lands in STAGES (unarchive, then the queue write-back), and it does
  // real filesystem I/O whose completions arrive on the threadpool — so drain the
  // event loop until the LAST of those stages is observable rather than guessing
  // a turn count.
  const queueIds = () => {
    try { return JSON.parse(readFileSync(queueFile, 'utf8')).sessionIds } catch { return null }
  }
  // Exit only on a VALID empty read: `null` means "unreadable right now" (the
  // cross-device fallback write is not atomic), not "drained".
  //
  // The bound is WALL CLOCK, not a turn count. The sweep's stages complete on
  // threadpool filesystem I/O, and a turn count drains the event loop far faster
  // than that I/O lands on a fast machine: 500 `setImmediate` turns finish in
  // ~13 ms on Ubuntu CI, long before the queue write-back is observable, so the
  // assertion below failed there while passing on Windows (where the same 500
  // turns take hundreds of ms and the I/O wins the race). `setTimeout` cannot be
  // used to pace the wait — this test mocks it.
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const ids = queueIds()
    if (Array.isArray(ids) && ids.length === 0) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.deepEqual(queueIds(), [], 'the marker is dropped')

  assert.deepEqual(state.archivedSessionIds, [], 'the boot sweep cleared the tombstone')
  const sessionDir = join(fixture.sessionsRoot, `--${CWD.replace(/[\\/:]/g, '-')}--`, SESSION_ID)
  assert.equal(existsSync(sessionDir), false, 'and disposed the artifact')
})

test('deferred/list does not walk the corpus when nothing is queued', async () => {
  // `artifactIndex()` is a full persistence listing plus a sessions-root
  // readdir, and the common case is an empty queue whose sweep can do nothing.
  const fixture = await makeFixture()
  const { ctx, headers, persistence } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  let listings = 0
  const realList = persistence.list.bind(persistence)
  persistence.list = async () => { listings += 1; return realList() }
  const manager = createSessionManager(ctx, {})
  const handler = rpcHandlerFor(manager)

  const envelope = await handler('deferred/list', {})
  assert.equal(envelope.ok, true)
  assert.deepEqual(envelope.value.sessionIds, [])
  assert.equal(listings, 0, 'an empty queue must not pay for a full persistence listing')

  // With something queued it must still take exactly ONE corpus read. The id
  // has to STAY queued for that, which means a live session (a cold one would
  // be swept away inside the same request).
  await writeSessionFiles(fixture, SESSION_ID)
  ctx.services.sessions = { get: (id) => (id === SESSION_ID ? {} : undefined) }
  await manager.addPending(SESSION_ID)
  const queued = await handler('deferred/list', {})
  assert.deepEqual(queued.value.sessionIds, [SESSION_ID])
  assert.equal(listings, 1, 'one corpus read for the whole request')
})

test('the opportunistic ping sweep does not re-walk the corpus for an unchanged queue', async () => {
  // A residue entry (a queued id whose session is still live) survives every
  // sweep by design, so repeated sweeps on a client poll would serialize the
  // deletes behind a corpus walk for nothing.
  const fixture = await makeFixture()
  const { ctx, headers, persistence } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  await writeSessionFiles(fixture, SESSION_ID)
  let listings = 0
  const realList = persistence.list.bind(persistence)
  persistence.list = async () => { listings += 1; return realList() }
  const manager = createSessionManager(ctx, {})
  await manager.addPending(SESSION_ID)
  // Stays live -> the sweep cannot finish it, so it stays queued.
  ctx.services.sessions = { get: (id) => (id === SESSION_ID ? {} : undefined) }

  const first = await manager.opportunisticSweep()
  assert.deepEqual(first.remaining, [SESSION_ID])
  assert.ok(listings > 0, 'the first sweep does walk the corpus')
  const afterFirst = listings

  const second = await manager.opportunisticSweep()
  assert.deepEqual(second.remaining, [SESSION_ID])
  assert.equal(listings, afterFirst, 'an unchanged queue must not be walked again')

  // A CHANGED queue re-arms it immediately: a new marker must be swept, which
  // is the crash-safety promise the hook exists for.
  await manager.addPending(OTHER_ID)
  await manager.opportunisticSweep()
  assert.ok(listings > afterFirst, 'a new marker re-arms the sweep')
})

test('allowDeleteRunning never strips the tombstone from an open idle session either', async () => {
  const fixture = await makeFixture()
  const { ctx, headers, state } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  await writeSessionFiles(fixture, SESSION_ID)
  const manager = createSessionManager(ctx, { allowDeleteRunning: true })
  ctx.services.sessions = { get: (id) => (id === SESSION_ID ? {} : undefined) }

  const result = await manager.deleteSession(SESSION_ID)
  assert.equal(result.openAtDelete, true, 'the switch must not turn an open delete into a cold one')
  assert.deepEqual(state.archivedSessionIds, [SESSION_ID], 'the tombstone is kept, so the summary cannot resurface as ungrouped')
  assert.ok((await manager.readPending()).includes(SESSION_ID), 'and the next-boot finish-up is queued')
  const sessionDir = join(fixture.sessionsRoot, `--${CWD.replace(/[\\/:]/g, '-')}--`, SESSION_ID)
  assert.equal(existsSync(sessionDir), false, 'the files still go immediately')
})

test('listArchived hides ids queued for deletion', async () => {
  const fixture = await makeFixture()
  const { ctx, headers, state } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  await writeSessionFiles(fixture, SESSION_ID)
  const manager = createSessionManager(ctx, {})

  ctx.services.sessions = { get: (id) => (id === SESSION_ID ? {} : undefined) }
  await manager.deleteSession(SESSION_ID)
  const listed = await manager.listArchived()
  assert.deepEqual(listed.archivedSessionIds, [], 'tombstoned ids stay out of the user-facing list')
})

test('sweepPending finishes queued deletions: disposes leftovers and clears tombstones', async () => {
  const fixture = await makeFixture()
  const { ctx, headers, state } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  await writeSessionFiles(fixture, SESSION_ID)
  const manager = createSessionManager(ctx, {})

  // Cold queued id with intact files -> files disposed.
  // Unknown id -> nothing to dispose, marker still dropped.
  await manager.addPending(SESSION_ID)
  await manager.addPending(OTHER_ID)
  const result = await manager.sweepPending()
  assert.deepEqual(result.deleted.sort(), [SESSION_ID, OTHER_ID])
  assert.deepEqual(await manager.readPending(), [])
  assert.equal(existsSync(join(fixture.sessionsRoot, `--${CWD.replace(/[\\/:]/g, '-')}--`, SESSION_ID)), false)

  // Tombstoned open-session delete (files already gone, header unresolvable)
  // -> the boot sweep must clear the archive-set tombstone.
  state.archivedSessionIds.push(SESSION_ID)
  ctx.services.sessions = { get: () => undefined }
  await manager.addPending(SESSION_ID)
  const finish = await manager.sweepPending()
  assert.deepEqual(finish.deleted, [SESSION_ID])
  assert.deepEqual(state.archivedSessionIds, [], 'tombstone cleared even though the session no longer lists')
  assert.deepEqual(await manager.readPending(), [])
})

test('sweepPending keeps ids that are live again', async () => {
  const fixture = await makeFixture()
  const { ctx, headers } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  const manager = createSessionManager(ctx, {})
  ctx.services.sessions = { get: (id) => (id === SESSION_ID ? {} : undefined) }

  await manager.addPending(SESSION_ID)
  const result = await manager.sweepPending()
  assert.deepEqual(result.deleted, [])
  assert.deepEqual(result.remaining, [SESSION_ID])
  assert.deepEqual(await manager.readPending(), [SESSION_ID])
})

test('deleteSession detaches through a stale membership index via the raw record', async () => {
  const fixture = await makeFixture()
  const { ctx, headers, state } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  await writeSessionFiles(fixture, SESSION_ID)
  // Mimic the real Workspace entity: the `sessionIds` getter filters members
  // through the registry's canonical-cwd header index, so a stale index hides
  // the id from the getter even though the durable record still accounts it.
  const record = { sessionIds: [SESSION_ID] }
  const staleWorkspace = {
    id: 'ws-stale',
    title: 'stale',
    path: CWD,
    get sessionIds() {
      return []
    },
    record,
    async detachSession(sessionId) {
      record.sessionIds = record.sessionIds.filter((id) => id !== sessionId)
    },
    async setTitle() {},
  }
  ctx.services.workspaceRegistry.list = () => [staleWorkspace]
  const manager = createSessionManager(ctx, {})

  const result = await manager.deleteSession(SESSION_ID)
  assert.equal(result.deleted, true)
  assert.deepEqual(record.sessionIds, [], 'raw record must be detached despite the stale getter')
  assert.deepEqual(state.archivedSessionIds, [])
})

test('deleteSession still removes the artifact when the registry and persistence header seams fail', async () => {
  const fixture = await makeFixture()
  const { ctx, headers, registry } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  await writeSessionFiles(fixture, SESSION_ID, { bak: true })
  // Both header seams lie — the shape seen in the field where the old code
  // silently skipped the artifact and left a resurrectable log behind.
  registry.readSessionHeader = async () => {
    throw new Error('header seam down')
  }
  ctx.services.sessionPersistence.list = async () => {
    throw new Error('listing seam down')
  }
  const manager = createSessionManager(ctx, {})

  const result = await manager.deleteSession(SESSION_ID)
  assert.equal(result.deleted, true)
  assert.equal(result.warnings, undefined)
  const sessionDir = join(fixture.sessionsRoot, `--${CWD.replace(/[\\/:]/g, '-')}--`, SESSION_ID)
  assert.equal(existsSync(sessionDir), false, 'raw scan must still find and delete the artifact')
  const projcacheDir = join(fixture.storagesRoot, 'session_projcache', 'sessions')
  assert.deepEqual((await readdir(projcacheDir)).filter((name) => name.startsWith(SESSION_ID)), [])
})

test('the persistence header listing alone can resolve and dispose the artifact', async () => {
  const fixture = await makeFixture()
  const { ctx, headers, registry } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  // The artifact lives OUTSIDE the sessions root, so the raw scan cannot find
  // it, and the registry header seam is down: only the persistence LISTING can
  // name the directory. `list()` yields `{ header, ... }` wrappers, so reading
  // `.id`/`.cwd` off the wrapper left this advertised middle seam a permanent
  // no-op — with a flat test fake hiding it.
  const outside = await mkdtemp(join(tmpdir(), 'dsm-outside-'))
  const artifactDir = join(outside, SESSION_ID)
  await mkdir(artifactDir, { recursive: true })
  await writeFile(join(artifactDir, 'session.jsonl.zstd'), 'bytes')
  registry.readSessionHeader = async () => {
    throw new Error('header seam down')
  }
  ctx.services.sessionPersistence.locate = () => ({ kind: 'jsonl', path: join(artifactDir, 'session.jsonl.zstd') })
  const manager = createSessionManager(ctx, {})

  const result = await manager.deleteSession(SESSION_ID)
  assert.equal(result.deleted, true)
  assert.equal(result.warnings, undefined, 'the listing seam resolved the artifact; nothing may be reported missing')
  assert.equal(existsSync(artifactDir), false, 'the artifact the listing named must be disposed')
})

test('the persistence header listing is a real fallback when the controller is absent', async () => {
  const fixture = await makeFixture()
  const { ctx, headers, services } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD, createdAt: 1690000000000 })
  // The documented fallback path for a composition without a session
  // controller: `listArchived` must project the persistence headers. Reading the
  // snapshot wrapper as if it were the header keyed every session 'undefined',
  // so the archived row silently lost its cwd and timestamp — and the agent
  // tool its metadata.
  services.sessionController = undefined
  const manager = createSessionManager(ctx, {})

  const listed = await manager.listArchived()
  assert.equal(listed.items.length, 1)
  assert.equal(listed.items[0].sessionId, SESSION_ID)
  assert.equal(listed.items[0].cwd, CWD)
  assert.equal(listed.items[0].updatedAt, 1690000000000)
})

test('a symlinked project directory is scanned for the artifact', async () => {
  const fixture = await makeFixture()
  const { ctx, headers, registry } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  // The artifact is reachable only through a LINK under the sessions root, and
  // both header seams are down: the raw scan is the only seam left. A dirent
  // for a link reports `isDirectory() === false` (verified on Windows junctions
  // too), so filtering on `isDirectory()` alone skipped the project and the
  // tombstone was cleared while the artifact survived — the deleted session
  // would be listed again on the next boot.
  const realProject = join(fixture.root, 'real-project')
  const realSession = join(realProject, SESSION_ID)
  await mkdir(realSession, { recursive: true })
  await writeFile(join(realSession, 'session.jsonl.zstd'), 'bytes')
  await mkdir(fixture.sessionsRoot, { recursive: true })
  await symlink(realProject, join(fixture.sessionsRoot, '--linked--'), 'junction')
  registry.readSessionHeader = async () => {
    throw new Error('header seam down')
  }
  ctx.services.sessionPersistence.list = async () => {
    throw new Error('listing seam down')
  }
  const manager = createSessionManager(ctx, {})

  const result = await manager.deleteSession(SESSION_ID)
  assert.equal(result.deleted, true)
  assert.equal(result.warnings, undefined, 'the raw scan must follow the project link')
  assert.equal(existsSync(realSession), false, 'and dispose what it found there')
})

test('deferred/list reads the persistence listing once for the whole queue', async () => {
  const fixture = await makeFixture()
  const { ctx, headers, services } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  headers.set(OTHER_ID, { id: OTHER_ID, cwd: CWD })
  await writeSessionFiles(fixture, SESSION_ID)
  await writeSessionFiles(fixture, OTHER_ID)
  // The real `list()` walks every generation and reads+decompresses every
  // stored header, so resolving ONE queued id at a time made this endpoint
  // O(queued × corpus) — for the sweep AND for the `recoverable` split.
  let listings = 0
  const originalList = services.sessionPersistence.list
  services.sessionPersistence.list = async () => {
    listings += 1
    return originalList()
  }
  // Both ids are LIVE, so the sweep keeps them queued and `hasArtifact` runs
  // for each — the shape that used to re-read the corpus per id.
  ctx.services.sessions = { get: (id) => (id === SESSION_ID || id === OTHER_ID ? {} : undefined) }
  const manager = createSessionManager(ctx, {})
  await manager.addPending(SESSION_ID)
  await manager.addPending(OTHER_ID)
  const handler = rpcHandlerFor(manager)

  listings = 0
  const listed = await handler('deferred/list', {})
  assert.equal(listed.ok, true)
  assert.deepEqual(listed.value.sessionIds.slice().sort(), [SESSION_ID, OTHER_ID].slice().sort())
  assert.deepEqual(listed.value.recoverable.slice().sort(), [SESSION_ID, OTHER_ID].slice().sort())
  assert.equal(listings, 1, 'one corpus read for the whole request, not one per queued id')
})

test('deleteSession broadcasts api-session/removed for cold and open deletions', async () => {
  const fixture = await makeFixture()
  const { ctx, headers, events } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  await writeSessionFiles(fixture, SESSION_ID)
  const manager = createSessionManager(ctx, {})

  await manager.deleteSession(SESSION_ID)
  assert.deepEqual(events, [['api-session/removed', SESSION_ID]])

  ctx.services.sessions = { get: (id) => (id === SESSION_ID ? {} : undefined) }
  await manager.deleteSession(SESSION_ID)
  assert.equal(events.length, 2, 'open-session deletes broadcast too')
})

test('deferred/list re-announces live queued removals by default, and can be switched off', async () => {
  const fixture = await makeFixture()
  const { ctx, headers, events } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  await writeSessionFiles(fixture, SESSION_ID)
  // Composition config with no override: the DEFAULT must repair (0.4.1+).
  const manager = createSessionManager(ctx, {})
  const handler = rpcHandlerFor(manager)

  // Open-session delete: queued + tombstoned, and still live in the host.
  ctx.services.sessions = { get: (id) => (id === SESSION_ID ? {} : undefined) }
  await manager.deleteSession(SESSION_ID)
  events.length = 0

  // Default ON: the still-live queued id is re-announced, so every client drops
  // it again (this is what keeps a "show archived" sidebar clean).
  const listed = await handler('deferred/list', {})
  assert.deepEqual(listed.value.sessionIds, [SESSION_ID])
  assert.deepEqual(events, [['api-session/removed', SESSION_ID]], 'the default repairs a live queued id')

  // Opt-out: the queue read is a plain read — no re-announcement.
  const quiet = createSessionManager(ctx, { reannouncePendingRemovals: false })
  const quietHandler = rpcHandlerFor(quiet)
  events.length = 0
  await quietHandler('deferred/list', {})
  assert.deepEqual(events, [], 'the repair can still be switched off')

  // An unusable liveness seam is treated as "not live", never as "live": the
  // queue stays intact (the sweep keeps an id whose liveness check fails) and
  // nothing is re-announced on a guess.
  events.length = 0
  ctx.services.sessions = { get: () => { throw new Error('liveness seam down') } }
  const guarded = await handler('deferred/list', {})
  assert.deepEqual(guarded.value.sessionIds, [SESSION_ID], 'a failed liveness check leaves the entry queued')
  assert.deepEqual(events, [], 'a failed liveness check is not re-announced')
})

test('deferred/list separates recoverable ids; cancel works only for files on disk', async () => {
  const fixture = await makeFixture()
  const { ctx, headers, state, services } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  await writeSessionFiles(fixture, SESSION_ID)
  const manager = createSessionManager(ctx, {})
  const handler = rpcHandlerFor(manager)

  // Open-session delete: data gone, tombstone kept -> queued but NOT recoverable.
  ctx.services.sessions = { get: (id) => (id === SESSION_ID ? {} : undefined) }
  await manager.deleteSession(SESSION_ID)
  const openList = await handler('deferred/list', {})
  assert.deepEqual(openList.value.sessionIds, [SESSION_ID])
  assert.deepEqual(openList.value.recoverable, [])
  // Canceling a data-gone entry is refused: dropping its tombstone would
  // expose the artifact-less lingering summary as an ungrouped row.
  const refused = await handler('deferred/cancel', { sessionId: SESSION_ID })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'session/data-gone')
  assert.deepEqual(await manager.readPending(), [SESSION_ID], 'a refused cancel leaves the entry queued')
  assert.deepEqual(state.archivedSessionIds, [SESSION_ID], 'and tombstoned')

  // Crash-leftover shape (files back on disk while still queued) ->
  // recoverable, and cancel clears marker + tombstone with files intact.
  await writeSessionFiles(fixture, SESSION_ID)
  const crashList = await handler('deferred/list', {})
  assert.deepEqual(crashList.value.recoverable, [SESSION_ID])
  const cancelled = await handler('deferred/cancel', { sessionId: SESSION_ID })
  assert.deepEqual(cancelled.value.sessionIds, [])
  assert.deepEqual(state.archivedSessionIds, [])
  assert.deepEqual(await manager.readPending(), [])
  services.sessions = { get: () => undefined }
  const sweep = await manager.sweepPending()
  assert.deepEqual(sweep.deleted, [], 'the canceled entry is gone from the queue')
  assert.ok(
    existsSync(join(fixture.sessionsRoot, `--${CWD.replace(/[\\/:]/g, '-')}--`, SESSION_ID)),
    'canceling must leave the recoverable files untouched',
  )
})

test('pending queue drops malformed ids before they can reach the filesystem', async () => {
  const fixture = await makeFixture()
  const { ctx } = makeCtx({ fixture })
  const manager = createSessionManager(ctx, {})
  // Corrupted / hand-edited queue file: a path-traversal id plus a short
  // junk id alongside the valid one. Without the guard, the raw sessions-root
  // scan resolves "../../sm-canary" to <home>/sm-canary and rm -rf's it.
  await mkdir(join(fixture.sessionsRoot, '--any--'), { recursive: true })
  await mkdir(fixture.storagesRoot, { recursive: true })
  const canary = join(fixture.home, 'sm-canary')
  await mkdir(canary, { recursive: true })
  await writeFile(manager.pendingFile(), JSON.stringify({ version: 1, sessionIds: ['../../sm-canary', 'x', SESSION_ID] }), 'utf8')
  const result = await manager.sweepPending()
  assert.ok(existsSync(canary), 'malformed ids must never reach the filesystem')
  assert.deepEqual(result.deleted, [SESSION_ID])
  assert.deepEqual(await manager.readPending(), [], 'the sanitized write-back purges malformed entries')
})

test('an unreadable pending queue is refused, never rewritten from an empty view', async () => {
  const fixture = await makeFixture()
  const { ctx, headers, state, events } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  headers.set(OTHER_ID, { id: OTHER_ID, cwd: CWD })
  await writeSessionFiles(fixture, SESSION_ID)
  await writeSessionFiles(fixture, OTHER_ID)
  // SESSION_ID is OPEN in this process: its delete is the path that must write a
  // pending marker (and therefore must read the queue first).
  ctx.services.sessions = { get: (id) => (id === SESSION_ID ? {} : undefined) }
  const warnings = []
  ctx.logger = { warn: (message) => warnings.push(String(message)), info: () => {} }
  const manager = createSessionManager(ctx, {})
  const handler = rpcHandlerFor(manager)
  const sessionDir = (id) => join(fixture.sessionsRoot, `--${CWD.replace(/[\\/:]/g, '-')}--`, id)

  // A half-written queue file: the cross-device fallback writes in place, so a
  // crash (or a concurrent reader) can catch it torn. Whatever it holds, it must
  // read as UNREADABLE — not as "the queue is empty". Every writer ends by
  // persisting the snapshot it just read, so a tolerant `[]` here would drop the
  // live markers on the next write-back and leave their tombstones in the
  // archive set with no queue entry to sweep them, while their files are already
  // gone: permanently stuck, un-restorable ghost rows — the exact "the deleted
  // session came back" shape this queue exists to prevent.
  const torn = '{"version":1,"sessionIds":["session-3012b8a0'
  await writeFile(manager.pendingFile(), torn, 'utf8')

  // Every queue-dependent operation refuses, and each reports the same stable
  // code with the underlying reason. A tolerant read would instead delete the
  // session, un-tombstone it, or publish an empty queue.
  for (const [endpoint, payload] of [
    ['list', {}],
    ['deferred/list', {}],
    ['delete', { sessionId: SESSION_ID }],
    ['restore', { sessionId: SESSION_ID }],
    ['deferred/cancel', { sessionId: SESSION_ID }],
  ]) {
    const answer = await handler(endpoint, payload)
    assert.equal(answer.ok, false, `${endpoint} must refuse an unreadable queue`)
    assert.equal(answer.error.code, 'session-manager/internal', `${endpoint} must report the queue failure`)
    assert.equal(typeof answer.error.details.reason, 'string', `${endpoint} must carry the reason`)
  }
  await assert.rejects(manager.sweepPending(), (error) => error.code === 'session-manager/internal')

  // Nothing was mutated on the way: no artifact removed, no archive change, no
  // broadcast, and the torn file is left byte-for-byte as it was found.
  assert.equal(existsSync(sessionDir(SESSION_ID)), true, 'a refused delete must not dispose the artifact')
  assert.deepEqual(state.archivedSessionIds, [SESSION_ID], 'nor touch the archive set')
  assert.deepEqual(events, [], 'nor broadcast a removal')
  assert.equal(readFileSync(manager.pendingFile(), 'utf8'), torn, 'the queue file is left exactly as found')
  assert.ok(warnings.some((line) => line.includes('pending-delete queue could not be read')), 'the refusal is logged where it is created, so no caller can swallow it silently')

  // The refusal is scoped to the queue: a COLD delete writes no marker and reads
  // no queue, so it still works — the guard must not become a plugin-wide outage.
  const cold = await handler('delete', { sessionId: OTHER_ID })
  assert.equal(cold.ok, true, 'a cold delete does not depend on the pending queue')
  assert.equal(existsSync(sessionDir(OTHER_ID)), false)

  // And it is not a one-way door: repairing the file restores every path.
  await manager.writePending([SESSION_ID])
  const listed = await handler('deferred/list', {})
  assert.equal(listed.ok, true)
  assert.deepEqual(listed.value.sessionIds, [SESSION_ID])
  const removed = await handler('delete', { sessionId: SESSION_ID })
  assert.equal(removed.ok, true)
  assert.equal(existsSync(sessionDir(SESSION_ID)), false)
})

test('a queue add racing the sweep survives the sweep write-back (operation lock)', async () => {
  const fixture = await makeFixture()
  const { ctx, headers } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  const manager = createSessionManager(ctx, {})
  // SESSION_ID stays queued (live); OTHER_ID is queued while the sweep runs.
  ctx.services.sessions = { get: (id) => (id === SESSION_ID ? {} : undefined) }
  await manager.addPending(SESSION_ID)
  const sweep = manager.sweepPending()
  const queued = manager.addPending(OTHER_ID)
  await Promise.all([sweep, queued])
  const ids = await manager.readPending()
  assert.ok(ids.includes(SESSION_ID), 'live id stays queued')
  assert.ok(ids.includes(OTHER_ID), 'id queued mid-sweep must not be clobbered by the sweep full-list write-back')
})

test('manager entry guards reject malformed ids even through permissive seams', async () => {
  const fixture = await makeFixture()
  const { ctx } = makeCtx({ fixture })
  // Worst-case host seam: sessionKnown answers true to anything — the
  // plugin's own doctrine says seams must never be trusted destructively,
  // so the id guard must not rely on it.
  ctx.services.workspaceRegistry.sessionKnown = async () => true
  const manager = createSessionManager(ctx, {})
  // A sibling project directory under the sessions root: an ungarded
  // raw-scan join (`<sessionsRoot>/<project>/../--victim--`) would rm -rf
  // this entire tree — every other workspace's sessions.
  const victim = join(fixture.sessionsRoot, '--victim--')
  await mkdir(join(victim, OTHER_ID), { recursive: true })
  for (const evil of ['../--victim--', '../../evil', 'a'.repeat(200), '', 'has space']) {
    await assert.rejects(manager.deleteSession(evil), (error) => error instanceof SessionManagerError && error.code === 'bad-request')
    await assert.rejects(manager.restoreSession(evil), (error) => error instanceof SessionManagerError && error.code === 'bad-request')
    await assert.rejects(manager.cancelPending(evil), (error) => error instanceof SessionManagerError && error.code === 'bad-request')
  }
  assert.ok(existsSync(victim), 'no seam or filesystem sink may be reached with a malformed id')

  // The agent-tool path (model-controlled args, no RPC gate) hits the same
  // choke point through manager.deleteSession.
  const registered = []
  ctx.services.tools = { register: (def) => { registered.push(def) } }
  registerTools(ctx, manager)
  const deleteTool = registered.find((def) => def.name === 'session_delete_permanently')
  const result = JSON.parse(await deleteTool.execute({ sessionId: '../--victim--', confirm: true }))
  assert.equal(result.ok, false)
  assert.equal(result.code, 'bad-request')
  assert.ok(existsSync(victim), 'the tool path must not delete outside the sessions root')
})

test('concurrent deletes serialize instead of losing an archive-set update', async () => {
  const fixture = await makeFixture()
  const { ctx, headers, state } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  headers.set(OTHER_ID, { id: OTHER_ID, cwd: CWD })
  state.archivedSessionIds.push(OTHER_ID)
  // A host shape where setState applies asynchronously (last write wins):
  // without the operation lock both deletes read the same archived-set
  // snapshot and one id survives as a ghost row (proven by review probe).
  ctx.services.workspaceRegistry.setState = async (next) => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    state.archivedSessionIds = [...next.archivedSessionIds]
  }
  const manager = createSessionManager(ctx, {})
  await Promise.all([manager.deleteSession(SESSION_ID), manager.deleteSession(OTHER_ID)])
  assert.deepEqual(state.archivedSessionIds, [], 'archive-set read-modify-write must serialize')
})

test('restoreSession rejects a queued (tombstoned) id', async () => {
  const fixture = await makeFixture()
  const { ctx, headers, state } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  const manager = createSessionManager(ctx, {})
  await manager.addPending(SESSION_ID)
  await assert.rejects(
    manager.restoreSession(SESSION_ID),
    (error) => error instanceof SessionManagerError && error.code === 'session/pending',
  )
  assert.deepEqual(state.archivedSessionIds, [SESSION_ID], 'the tombstone survives a rejected restore')
})

test('deleteSession refuses an unpersisted live session and leaves no queue marker', async () => {
  const fixture = await makeFixture()
  const { ctx } = makeCtx({ fixture })
  ctx.services.sessions = { get: (id) => (id === SESSION_ID ? {} : undefined) }
  const manager = createSessionManager(ctx, {})
  await assert.rejects(
    manager.deleteSession(SESSION_ID),
    (error) => error instanceof SessionManagerError && error.code === 'session/not-found',
  )
  assert.deepEqual(await manager.readPending(), [])
})

test('listArchived clamps a corrupt sessionListLimit override', async () => {
  const fixture = await makeFixture()
  const { ctx, headers } = makeCtx({ fixture, settings: { get: () => ({ sessionListLimit: 'not-a-number' }) } })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD, createdAt: 1690000000000 })
  const manager = createSessionManager(ctx, {})
  const result = await manager.listArchived()
  assert.equal(result.items.length, 1, 'a NaN override must fall back to the default cap, not empty the list')
})

test('rpc handler enforces the sessionId guard and maps domain errors', async () => {
  const fixture = await makeFixture()
  const { ctx, headers, state } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  const manager = createSessionManager(ctx, {})
  const handler = rpcHandlerFor(manager)

  const bad = await handler('restore', { sessionId: '../evil' })
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'bad-request')

  // A session id that IS in the archive set but has no persisted files:
  // existence check must fail with session/not-found.
  const GHOST_ID = 'session-00000000-0000-0000-0000-000000000000'
  state.archivedSessionIds.push(GHOST_ID)
  const missing = await handler('restore', { sessionId: GHOST_ID })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'session/not-found')

  const unknown = await handler('explode', {})
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'bad-request')

  const ping = await handler('ping', {})
  assert.equal(ping.ok, true)
  assert.equal(ping.value.menuDeleteAvailable, true)
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(ping.value.version, manifest.version, 'ping must report the package manifest version (single source)')

  const restored = await handler('restore', { sessionId: SESSION_ID })
  assert.equal(restored.ok, true)
  assert.equal(restored.value.restored, true)
})

test('agent tools register and the delete tool requires confirm', async () => {
  const fixture = await makeFixture()
  const { ctx, headers, state } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  const registered = []
  ctx.services.tools = { register: (def) => { registered.push(def) } }
  const manager = createSessionManager(ctx, {})
  registerTools(ctx, manager)

  assert.equal(registered.length, 3)
  assert.deepEqual(registered.map((def) => def.name), ['session_list_archived', 'session_restore_archived', 'session_delete_permanently'])

  const deleteTool = registered[2]
  const refused = await deleteTool.execute({ sessionId: SESSION_ID, confirm: false })
  assert.match(refused, /confirmation-required/)
  const executed = JSON.parse(await deleteTool.execute({ sessionId: SESSION_ID, confirm: true }))
  assert.equal(executed.ok, true)
  assert.deepEqual(state.archivedSessionIds, [])
})

test('an open-but-idle session is not reported as running', async () => {
  // `running` must mean "a model step is executing". Liveness is a DIFFERENT
  // fact, and OR-ing it in made every open session report running work that did
  // not exist — a 运行中 badge in the settings page, and a lie to the agent tool.
  const fixture = await makeFixture()
  const { ctx, headers } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD, createdAt: 1690000000000 })
  const manager = createSessionManager(ctx, {})
  // Open but idle: present in the live store, controller says running: false.
  ctx.services.sessions = { get: (id) => (id === SESSION_ID ? {} : undefined) }
  assert.equal((await manager.listArchived()).items[0].running, false, 'an open idle session is not running')

  // A genuinely running task is still reported.
  const busyFixture = await makeFixture()
  const busy = makeCtx({
    fixture: busyFixture,
    sessionController: {
      async list() {
        return {
          items: [{
            sessionId: SESSION_ID, cwd: CWD, updatedAt: 1700000000000, running: true, blank: false,
            projections: { values: { title: 'Busy' } },
          }],
        }
      },
    },
  })
  busy.headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  const busyManager = createSessionManager(busy.ctx, {})
  const entry = (await busyManager.listArchived()).items[0]
  assert.equal(entry.running, true, 'a running task is still reported as running')
  assert.equal(entry.title, 'Busy')
})

test('the delete tool refuses sessions that are not archived', async () => {
  // Model-facing: without this gate a model that merely KNOWS an id could
  // permanently delete a session it was never asked about. The HUMAN surfaces
  // deliberately stay ungated — the context-menu row is offered on every
  // session row, which is a documented feature.
  const fixture = await makeFixture()
  const { ctx, headers, state } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  headers.set(OTHER_ID, { id: OTHER_ID, cwd: CWD })
  const registered = []
  ctx.services.tools = { register: (def) => { registered.push(def) } }
  const manager = createSessionManager(ctx, {})
  registerTools(ctx, manager)
  const deleteTool = registered.find((def) => def.name === 'session_delete_permanently')

  // OTHER_ID exists but is not archived (the fixture archives SESSION_ID only).
  const refused = JSON.parse(await deleteTool.execute({ sessionId: OTHER_ID, confirm: true }))
  assert.equal(refused.ok, false)
  assert.match(refused.message, /ARCHIVED/, 'the refusal explains what to do instead')

  // An unknown id is reported as not-found, not as not-archived.
  const unknown = JSON.parse(await deleteTool.execute({ sessionId: 'session-00000000-0000-4000-8000-000000000000', confirm: true }))
  assert.equal(unknown.ok, false)
  assert.match(unknown.message, /does not exist/)

  // The archived one still goes through.
  const archived = JSON.parse(await deleteTool.execute({ sessionId: SESSION_ID, confirm: true }))
  assert.equal(archived.ok, true, 'an archived session is still deletable through the tool')
  assert.deepEqual(state.archivedSessionIds, [])
})

test('apply mounts one exact fetch route per endpoint and never takes the /api interceptor', () => {
  const fixturePromise = makeFixture()
  return fixturePromise.then((fixture) => {
    const { ctx } = makeCtx({ fixture })
    const routes = new Map()
    let interceptorTaken = false
    // Host composition: the RPC surface mounts through `connection.fetch`
    // EXACT routes. `rpc.intercept('/api')` is a single-slot channel owned by
    // the official dsh-api-gateway — taking it would kill every host RPC.
    ctx.services.connection = {
      fetch: {
        register: (route) => { routes.set(route.path, route) },
      },
      rpc: {
        intercept: () => { interceptorTaken = true },
      },
    }
    apply(ctx, {})
    assert.equal(interceptorTaken, false, 'the shared /api interceptor must stay untouched')
    assert.deepEqual([...routes.keys()].sort(), RPC_ENDPOINTS.map((endpoint) => `${CHANNEL}/${endpoint}`).sort())
    for (const route of routes.values()) {
      assert.deepEqual(route.methods, ['POST'])
      assert.equal(route.requestBody, 'buffered')
      assert.equal(typeof route.fetch, 'function')
    }
  })
})

test('apply stays offline without the connection service but still mounts tools', () => {
  const fixturePromise = makeFixture()
  return fixturePromise.then((fixture) => {
    const warnings = []
    const { ctx } = makeCtx({ fixture })
    // No connection service at all: the channel must not mount, the tools must.
    ctx.logger = { warn: (message) => warnings.push(String(message)), info: () => {} }
    apply(ctx, {})
    assert.ok(warnings.some((message) => message.includes('connection')), 'missing connection is reported as a warning')
  })
})

test('the fetch route envelope round-trips ping and rejects a mismatched method', async () => {
  const fixture = await makeFixture()
  const { ctx } = makeCtx({ fixture })
  const manager = createSessionManager(ctx, {})
  const fetch = rpcRouteHandler(manager, 'ping')

  const call = (body, { contentType = 'application/json', method = 'POST' } = {}) => fetch(new Request(`http://dsh.internal${CHANNEL}/ping`, {
    method,
    headers: contentType === null ? {} : { 'content-type': contentType },
    ...(method === 'POST' && contentType !== null ? { body: JSON.stringify(body) } : {}),
  }))

  const good = await call({ type: 'client-request', rpcId: 'r-1', method: `${RPC_NAMESPACE}/ping`, payload: {} })
  assert.equal(good.status, 200)
  const envelope = await good.json()
  assert.equal(envelope.type, 'server-response')
  assert.equal(envelope.rpcId, 'r-1')
  assert.equal(envelope.result.ok, true)
  assert.equal(envelope.result.value.plugin, 'session-manager')

  const mismatched = await call({ type: 'client-request', rpcId: 'r-2', method: `${RPC_NAMESPACE}/list`, payload: {} })
  const mismatchEnvelope = await mismatched.json()
  assert.equal(mismatchEnvelope.rpcId, 'r-2')
  assert.equal(mismatchEnvelope.result.ok, false)
  assert.equal(mismatchEnvelope.result.error.code, 'bad-request')
  // The client's parser requires an object here, not a missing field.
  assert.deepEqual(mismatchEnvelope.result.error.details, {})

  assert.equal((await call({}, { method: 'GET' })).status, 405)
  assert.equal((await call({}, { contentType: 'text/plain' })).status, 415)
})
