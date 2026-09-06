// Host unit tests: mock the dsh seams (workspaceRegistry / sessionController /
// sessionPersistence / live session store) and exercise the real manager code
// against real temporary directories.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSessionManager, rpcHandlerFor, SessionManagerError, apply, registerTools } from '../lib/index.js'

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
    async setTitle() {},
  }
}

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsm-test-'))
  const home = join(root, '.dsh')
  const sessionsRoot = join(home, 'sessions')
  const storagesRoot = join(home, 'storages')
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
    async list() {
      return [...headers.values()]
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

  const summaries = [
    { sessionId: SESSION_ID, title: 'Greeting', cwd: CWD, updatedAt: 1700000000000, running: false, blank: false },
    { sessionId: OTHER_ID, title: 'Other', cwd: CWD, updatedAt: 1600000000000, running: false, blank: false },
  ]

  const sessionController = {
    async list() {
      return summaries.filter((summary) => headers.has(summary.sessionId))
    },
  }

  const services = {
    workspaceRegistry: registry,
    sessionPersistence: persistence,
    sessionController,
    sessions: { get: (id) => live.get(id) },
    settings: overrides.settings ?? { get: () => undefined },
    logger: { warn: () => {}, info: () => {} },
  }

  const events = []
  const ctx = {
    services,
    events,
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

  // live + running agent -> still refused
  ctx.services.agents = { get: (id) => (id === SESSION_ID ? { status: 'running' } : undefined) }
  const strict = createSessionManager(ctx, {})
  await assert.rejects(strict.deleteSession(SESSION_ID), (error) => error instanceof SessionManagerError && error.code === 'session/running')

  // allowDeleteRunning force-deletes with cold semantics (no tombstone)
  ctx.services.agents = { get: () => undefined }
  const permissive = createSessionManager(ctx, { allowDeleteRunning: true })
  const forced = await permissive.deleteSession(SESSION_ID)
  assert.equal(forced.deleted, true)
  assert.equal(forced.openAtDelete, undefined)
  assert.deepEqual(state.archivedSessionIds, [], 'force delete unarchives like a cold delete')
})

test('deleteSession broadcasts api-session/removed for every real deletion', async () => {
  const fixture = await makeFixture()
  const { ctx, headers, events } = makeCtx({ fixture })
  headers.set(SESSION_ID, { id: SESSION_ID, cwd: CWD })
  await writeSessionFiles(fixture, SESSION_ID)
  const manager = createSessionManager(ctx, {})

  await manager.deleteSession(SESSION_ID)
  assert.deepEqual(events, [['api-session/removed', SESSION_ID]])
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

test('deleteSession broadcasts api-session/removed for every real deletion', async () => {
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

test('deferred/list separates recoverable ids and cancel clears the tombstone', async () => {
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

  // Cancel clears the tombstone instead of leaving a husk archived forever.
  const cancelled = await handler('deferred/cancel', { sessionId: SESSION_ID })
  assert.deepEqual(cancelled.value.sessionIds, [])
  assert.deepEqual(state.archivedSessionIds, [])
  assert.deepEqual(await manager.readPending(), [])

  // Crash-leftover style entry (queued, files intact, cold) -> recoverable.
  await writeSessionFiles(fixture, SESSION_ID)
  await manager.addPending(SESSION_ID)
  const crashList = await handler('deferred/list', {})
  assert.deepEqual(crashList.value.recoverable, [SESSION_ID])
  services.sessions = { get: () => undefined }
  const sweep = await manager.sweepPending()
  assert.deepEqual(sweep.deleted, [SESSION_ID])
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

test('apply mounts the rpc channel and surfaces defensively', () => {
  const fixturePromise = makeFixture()
  return fixturePromise.then((fixture) => {
    const { ctx } = makeCtx({ fixture })
    let handled = null
    ctx.services.connection = { rpc: { handle: (channel, handler) => { handled = { channel, handler } } } }
    apply(ctx, {})
    assert.equal(handled.channel, '/session-manager')
    assert.equal(typeof handled.handler, 'function')
  })
})
