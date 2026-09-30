// Unit tests for the pending-delete queue's PURE half.
//
// These semantics used to be reachable only through a whole host: the queue is
// the single record a queued deletion can be finished from, so its format, its
// v1/v2 compatibility and its input sanitization are worth pinning directly. The
// file I/O (atomic rename, the non-atomic cross-device fallback) stays in
// `lib/index.js` and is covered by `test/host.test.mjs`.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PENDING_QUEUE_VERSION, SESSION_ID_PATTERN, decodePendingQueue, encodePendingQueue } from '../lib/pending-queue.js'

const A = 'session-3012b8a0-1fef-4f34-8d9c-a6c5b7aa84d2'
const B = 'session-9987799d-52b1-464a-8db2-5d16bb8a9bd5'

test('a v2 body round-trips, workspace records included', () => {
  const body = encodePendingQueue([{ id: A, workspaces: ['ws-1', 'ws-2'] }, B])
  const decoded = decodePendingQueue(body)
  assert.equal(decoded.degraded, false)
  assert.equal(decoded.malformed, 0)
  assert.deepEqual(decoded.entries, [
    { id: A, workspaces: ['ws-1', 'ws-2'] },
    // A bare id carries no record — the cancel then simply cannot re-group.
    { id: B, workspaces: [] },
  ])
  assert.equal(JSON.parse(body).version, PENDING_QUEUE_VERSION)
})

test('a v1 body still reads, with nothing recorded', () => {
  // v1 is the shape every release before this one wrote: bare `sessionIds`.
  // It must keep reading — a plugin that refused it would strand its own
  // previous markers (and the boot sweep with them).
  const decoded = decodePendingQueue(JSON.stringify({ version: 1, sessionIds: [A, B] }))
  assert.equal(decoded.degraded, false)
  assert.deepEqual(decoded.entries.map((entry) => entry.id), [A, B])
  assert.deepEqual(decoded.entries.map((entry) => entry.workspaces), [[], []])
})

test('a torn or unparseable body is DEGRADED, never an empty queue', () => {
  // Every writer persists the snapshot it just read, so treating a failed read as
  // "empty" would publish that empty view on the next write-back and erase every
  // live marker — leaving their tombstones in the archive set with no queue entry
  // left to sweep them.
  for (const text of ['', '{"version":2,"sessionIds":[', 'not json at all']) {
    const decoded = decodePendingQueue(text)
    assert.equal(decoded.degraded, true, `"${text}" must be degraded`)
    assert.equal(typeof decoded.reason, 'string')
    assert.deepEqual(decoded.entries, [])
  }
})

test('ids failing the pattern are dropped and COUNTED, never returned', () => {
  // The file is an input channel (crash leftovers, hand edits, corruption). An id
  // that reaches `resolveSessionDirs`/`disposePath` turns the raw sessions-root
  // scan into a path-traversal delete, so this is the guard that must hold.
  const decoded = decodePendingQueue(JSON.stringify({
    version: 2,
    // '../../etc/passwd' (traversal), 'abc' (below the 4-char floor) and
    // 'has space' (outside the class) are the three that must go.
    sessionIds: [A, '../../etc/passwd', 'abc', 'has space', 'ok_id_1234'],
  }))
  assert.deepEqual(decoded.entries.map((entry) => entry.id), [A, 'ok_id_1234'])
  assert.equal(decoded.malformed, 3, 'the caller warns once with this count')
})

test('the same id twice is one entry, first occurrence first', () => {
  const decoded = decodePendingQueue(JSON.stringify({ version: 2, sessionIds: [A, B, A] }))
  assert.deepEqual(decoded.entries.map((entry) => entry.id), [A, B])
})

test('a malformed `detached` is ignored rather than trusted', () => {
  for (const detached of [null, 'ws-1', 42, [['ws-1']]]) {
    const decoded = decodePendingQueue(JSON.stringify({ version: 2, sessionIds: [A], detached }))
    assert.deepEqual(decoded.entries, [{ id: A, workspaces: [] }], `detached=${JSON.stringify(detached)}`)
  }
  // …and a non-string / empty member inside a valid map is filtered out.
  const decoded = decodePendingQueue(JSON.stringify({ version: 2, sessionIds: [A], detached: { [A]: ['ws-1', '', 7, null] } }))
  assert.deepEqual(decoded.entries[0].workspaces, ['ws-1'])
})

test('encoding refuses a malformed id instead of writing it', () => {
  // The other end of the same input channel: a write must not be able to
  // introduce what the read would have to drop.
  const body = encodePendingQueue([A, '../../escape', { id: 'x' }, null, undefined])
  assert.deepEqual(JSON.parse(body).sessionIds, [A])
})

test('encoding deduplicates ids and workspace records', () => {
  const body = encodePendingQueue([{ id: A, workspaces: ['ws-1', 'ws-1'] }, { id: A, workspaces: ['ws-2'] }])
  const parsed = JSON.parse(body)
  assert.deepEqual(parsed.sessionIds, [A], 'the id appears once')
  // Last write wins for the record (the caller just recomputed the owners).
  assert.deepEqual(parsed.detached[A], ['ws-2'])
})

test('a re-encode of a decoded body is stable', () => {
  const body = encodePendingQueue([{ id: A, workspaces: ['ws-1'] }, B])
  const once = encodePendingQueue(decodePendingQueue(body).entries)
  assert.equal(once, body, 'decode -> encode is a fixed point, so a sweep write-back cannot churn the file')
})

test('the exported pattern is the one the manager uses', () => {
  // Single-sourced: `assertSessionId` in lib/index.js imports THIS regex, so a
  // relaxation here would widen the manager choke point too.
  assert.equal(SESSION_ID_PATTERN.test(A), true)
  assert.equal(SESSION_ID_PATTERN.test('../../etc/passwd'), false)
  assert.equal(SESSION_ID_PATTERN.test('a'.repeat(129)), false, 'the length cap holds')
  assert.equal(SESSION_ID_PATTERN.test('a'.repeat(128)), true)
})
