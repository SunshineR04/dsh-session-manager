// Direct tests for the registry read/write rules, which used to be reachable
// only through a mounted host (`test/host.test.mjs`). These are the rules that
// decide whether a durable archive-set write may happen at all, so they get
// their own suite rather than living as a side effect of some other test.
//
// ⚠ The contract these tests pin, and the reason they are written this way:
// the `setState` fallback is only legal when `requireState()` exists. Without it
// the state can only be RECONSTRUCTED, and `refuseReconstructedWrite` throws —
// a reconstructed snapshot would erase the fields this plugin cannot see (pins,
// the default workspace, a pending mutation). So every fallback case below hands
// the registry a `requireState`; a fallback with no `requireState` is the
// refusal case, tested separately.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRegistryWrites } from '../lib/registry-writes.js'
import { SessionManagerError } from '../lib/index.js'

const { registryState, unarchiveThrough, archiveThrough, assertRegistryWritable } = createRegistryWrites({ SessionManagerError })
const ID = 'session-aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'

/** The OFFICIAL shape: `list()` + `archivedSessionIds`, and whatever else the
 *  caller adds. `setState` records instead of writing, so an official call and a
 *  fallback write can be told apart. */
const makeRegistry = (overrides = {}) => {
  const writes = []
  return {
    writes,
    list: () => [{ id: 'ws-1' }],
    archivedSessionIds: [],
    setState: (state) => { writes.push(state) },
    ...overrides,
  }
}

/** A registry that can serve a FAITHFUL state but has no official entry point —
 *  the only situation in which the fallback may write. */
const fallbackRegistry = (archivedSessionIds, extra = {}) => makeRegistry({
  requireState: () => ({ initialized: true, workspaceIds: ['ws-1'], archivedSessionIds, ...extra }),
})

test('registryState prefers requireState over any reconstruction', () => {
  const official = { initialized: true, workspaceIds: ['ws-1'], archivedSessionIds: [ID], pinnedSessionIds: ['p-1'] }
  const reg = makeRegistry({ requireState: () => official })
  assert.equal(registryState(reg), official, 'the registry own state object is returned as-is')
})

test('registryState reconstructs and MARKS it reconstructed, coercing ids', () => {
  const reg = makeRegistry({ archivedSessionIds: [ID], pinnedSessionIds: [42], defaultWorkspaceId: 'ws-9' })
  const state = registryState(reg)
  assert.equal(state.reconstructed, true, 'a reconstruction must announce itself: it cannot be written back')
  assert.deepEqual(state.workspaceIds, ['ws-1'])
  assert.deepEqual(state.archivedSessionIds, [ID])
  assert.deepEqual(state.pinnedSessionIds, ['42'], 'ids are stringified')
  assert.equal(state.defaultWorkspaceId, 'ws-9')
  assert.deepEqual(reg.writes, [], 'reading never writes')
})

test('registryState omits the optional fields a registry does not carry', () => {
  const state = registryState(makeRegistry())
  assert.equal('pinnedSessionIds' in state, false, 'absent pins must not become an empty array')
  assert.equal('defaultWorkspaceId' in state, false, 'absent default workspace must not become undefined')
})

test('unarchiveThrough uses the registry OWN entry point and never touches setState', async () => {
  const calls = []
  const reg = makeRegistry({ requireState: () => ({ archivedSessionIds: [ID] }), unarchiveSession: async (id) => { calls.push(id) } })
  await unarchiveThrough(reg, ID)
  assert.deepEqual(calls, [ID])
  assert.deepEqual(reg.writes, [], 'the official call already ran on the registry internal queue')
})

test('unarchiveThrough falls back to setState and REMOVES the id, spreading the rest', async () => {
  const reg = fallbackRegistry([ID, 'session-bbbb'], { pinnedSessionIds: ['pin-1'] })
  await unarchiveThrough(reg, ID)
  assert.equal(reg.writes.length, 1)
  assert.deepEqual(reg.writes[0].archivedSessionIds, ['session-bbbb'])
  assert.deepEqual(reg.writes[0].pinnedSessionIds, ['pin-1'], 'fields we do not own survive the spread')
})

test('unarchiveThrough is a no-op when the id is not archived', async () => {
  const reg = fallbackRegistry(['session-bbbb'])
  await unarchiveThrough(reg, ID)
  assert.deepEqual(reg.writes, [], 'the official method is no-op-safe; the fallback must be too')
})

test('archiveThrough passes stopActivity: true — without it a RUNNING session throws', async () => {
  const calls = []
  const reg = makeRegistry({ archiveSession: async (id, options) => { calls.push([id, options]) } })
  await archiveThrough(reg, ID)
  assert.deepEqual(calls, [[ID, { stopActivity: true }]])
  assert.deepEqual(reg.writes, [])
})

test('archiveThrough falls back to setState and APPENDS the id', async () => {
  const reg = fallbackRegistry(['session-bbbb'])
  await archiveThrough(reg, ID)
  assert.deepEqual(reg.writes[0].archivedSessionIds, ['session-bbbb', ID])
})

test('archiveThrough does not duplicate an id that is already archived', async () => {
  const reg = fallbackRegistry([ID])
  await archiveThrough(reg, ID)
  assert.deepEqual(reg.writes, [])
})

test('a RECONSTRUCTED state is refused for a write, with registry/unavailable', async () => {
  // No `requireState`: the state can only be reconstructed, so BOTH write paths
  // must refuse — including the fallback one that would otherwise just write.
  for (const run of [() => unarchiveThrough(makeRegistry({ archivedSessionIds: [ID] }), ID), () => archiveThrough(makeRegistry(), ID)]) {
    await assert.rejects(run, (error) => {
      assert.equal(error.code, 'registry/unavailable')
      assert.match(error.message, /reconstructed snapshot would erase fields/)
      return true
    })
  }
})

test('assertRegistryWritable: requireState alone is enough', () => {
  assert.doesNotThrow(() => assertRegistryWritable(makeRegistry({ requireState: () => ({}) })))
})

test('assertRegistryWritable: the official PAIR is enough even without requireState', () => {
  assert.doesNotThrow(() => assertRegistryWritable(makeRegistry({ archiveSession: async () => {}, unarchiveSession: async () => {} })))
})

test('assertRegistryWritable: one half of the pair is NOT enough', () => {
  assert.throws(() => assertRegistryWritable(makeRegistry({ archiveSession: async () => {} })), (error) => {
    assert.equal(error.code, 'registry/unavailable')
    assert.match(error.message, /neither requireState nor the official/)
    return true
  })
})

test('with the official pair but no requireState, the official branch wins (no refusal)', async () => {
  const calls = []
  const reg = makeRegistry({ archiveSession: async (id) => { calls.push(id) }, unarchiveSession: async () => {} })
  // The refusal exists for the FALLBACK path: a registry that can serve the
  // official call is writable even though it cannot hand out a faithful state.
  assert.doesNotThrow(() => assertRegistryWritable(reg))
  await archiveThrough(reg, ID)
  assert.deepEqual(calls, [ID])
  assert.deepEqual(reg.writes, [])
})
