// Unit tests for the pure half of `collectSummaries()`.
//
// The manager's summary mapping is the seam whose failure was INVISIBLE: the
// installed controller answers `{ items }` with rows that carry no `title` and
// no `createdAt`, so a flat-array-only reader reported every archived session as
// untitled/null while the host suite stayed green (its fake encoded the invented
// shape). These cases pin the real shape directly.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { decodeControllerList, summaryFromControllerRow, titleOfRow } from '../lib/session-summaries.js'

const ID = 'session-3012b8a0-1fef-4f34-8d9c-a6c5b7aa84d2'

test('decodeControllerList unwraps the real envelope and accepts a bare array', () => {
  // The REAL shape (dsh 0.2.0-rc.2): an object envelope.
  assert.deepEqual(decodeControllerList({ items: [1, 2] }), [1, 2])
  // An alternative composition may hand the rows over directly.
  assert.deepEqual(decodeControllerList([1, 2]), [1, 2])
  // Anything else is UNRECOGNIZED — the caller warns once and falls back, rather
  // than reporting an empty corpus.
  for (const raw of [undefined, null, {}, { rows: [] }, 'items', 42]) {
    assert.equal(decodeControllerList(raw), null, `${JSON.stringify(raw)} must be unrecognized`)
  }
})

test('the display title comes from the projection, not from the row', () => {
  // The installed row has no top-level `title` at all.
  assert.equal(titleOfRow({ sessionId: ID, projections: { values: { title: 'Greeting' } } }), 'Greeting')
  // A flat field is a fallback for compositions that do expose one…
  assert.equal(titleOfRow({ sessionId: ID, title: 'Flat' }), 'Flat')
  // …and an ABSENT title is an empty string, never the string "undefined".
  assert.equal(titleOfRow({ sessionId: ID }), '')
  assert.equal(titleOfRow({ sessionId: ID, projections: { values: { title: 7 } } }), '', 'a non-string projection value is not a title')
})

test('a real row projects to the fields the manager reads', () => {
  const summary = summaryFromControllerRow({
    sessionId: ID,
    updatedAt: 1700000000000,
    running: true,
    blank: false,
    cwd: 'C:\\Users\\test\\project',
    origin: 'operator',
    parentSessionId: 'session-parent-0001',
    projections: { values: { title: 'Greeting' } },
  })
  assert.deepEqual(summary, {
    sessionId: ID,
    // The controller exposes no creation time; `updatedAt` is the one timestamp
    // it computes, and inventing a `createdAt` would be a lie.
    createdAt: null,
    updatedAt: 1700000000000,
    running: true,
    blank: false,
    cwd: 'C:\\Users\\test\\project',
    origin: 'operator',
    parentSessionId: 'session-parent-0001',
    title: 'Greeting',
  })
})

test('a row that cannot be addressed is skipped, not guessed at', () => {
  for (const item of [null, undefined, 'row', 42, {}, { title: 'orphan' }]) {
    assert.equal(summaryFromControllerRow(item), null, `${JSON.stringify(item)} must be skipped`)
  }
  // The id is accepted under either name, and always comes out a string.
  assert.equal(summaryFromControllerRow({ id: ID }).sessionId, ID)
  assert.equal(summaryFromControllerRow({ sessionId: 1234 }).sessionId, '1234')
})

test('absent optional fields are OMITTED, not nulled', () => {
  // The manager spreads these into its entries and the client distinguishes
  // "absent" from "explicitly null" when it falls back to its own defaults.
  const summary = summaryFromControllerRow({ sessionId: ID })
  assert.equal('cwd' in summary, false)
  assert.equal('origin' in summary, false)
  assert.equal('parentSessionId' in summary, false)
  assert.equal(summary.updatedAt, null)
  assert.equal(summary.running, false, 'a missing flag is not a running task')
  assert.equal(summary.blank, false)
})

test('a bogus timestamp becomes null rather than an Invalid Date', () => {
  for (const updatedAt of [undefined, null, 'yesterday', Number.NaN, Infinity]) {
    assert.equal(summaryFromControllerRow({ sessionId: ID, updatedAt }).updatedAt, null)
  }
})
