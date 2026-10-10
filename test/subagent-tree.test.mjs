// Unit tests for `lib/subagent-tree.js` — the cascade's relationship rule and its
// deletion order. Pure: no host, no filesystem, no temp dirs.
//
// The shape under test is the corpus index `createArtifactResolver().index()`
// returns: `{ snapshots: [{ header, revision, sizeBytes }] }`, where every header
// may be missing (the persistence listing skips an entry it cannot decode).
import test from 'node:test'
import assert from 'node:assert/strict'

import { orphanSubagentClosure, subagentChildrenOf, subagentDescendants } from '../lib/subagent-tree.js'

/** A snapshotted session header as the JSONL backend stores it. */
const header = (id, extra = {}) => ({ type: 'session', version: 4, id, createdAt: 1_700_000_000_000, ...extra })
const subagent = (id, parentSession) => header(id, { parentSession, origin: 'subagent' })
const corpus = (...snapshots) => ({ snapshots: snapshots.map((value) => (value === null ? null : { header: value, revision: 1, sizeBytes: 1 })) })

test('children are found by parentSession AND origin', () => {
  const index = corpus(
    header('root'),
    subagent('child-a', 'root'),
    subagent('child-b', 'root'),
    subagent('other', 'elsewhere'),
    // A session that names the root as its parent but carries no subagent origin
    // must NOT be picked up: upstream allows exactly one origin value, and a
    // forked/independent session is the case this protects.
    header('not-a-child', { parentSession: 'root' }),
    header('no-parent', { origin: 'subagent' }),
  )
  assert.deepEqual(subagentChildrenOf(index, 'root'), ['child-a', 'child-b'])
  assert.deepEqual(subagentChildrenOf(index, 'child-a'), [])
  assert.deepEqual(subagentChildrenOf(index, 'missing'), [])
})

test('the closure is deepest-first, so a crash never strands a child whose parent is gone', () => {
  const index = corpus(
    header('root'),
    subagent('c1', 'root'),
    subagent('c2', 'root'),
    subagent('g1', 'c1'),
    subagent('g2', 'g1'),
    subagent('h1', 'c2'),
  )
  const order = subagentDescendants(index, 'root')
  assert.deepEqual([...order].sort(), ['c1', 'c2', 'g1', 'g2', 'h1'])
  const at = (id) => order.indexOf(id)
  assert.ok(at('g2') < at('g1'), 'grandchild deletes before its parent')
  assert.ok(at('g1') < at('c1'), 'child deletes before its own parent')
  assert.ok(at('h1') < at('c2'), 'a leaf child deletes before its parent')
  assert.ok(at('c1') < at('c2') || at('c2') < at('c1'), 'siblings keep a stable order')
  assert.ok(!order.includes('root'), 'the root is never part of its own cascade')
})

test('a child of a NON-subagent session is still a child (the link is parentSession)', () => {
  // The rule scopes the CANDIDATE by its own origin, not the parent's: an
  // ordinary session can host subagents.
  const index = corpus(header('root'), subagent('c1', 'root'))
  assert.deepEqual(subagentDescendants(index, 'root'), ['c1'])
})

test('a cyclic claim terminates instead of looping forever', () => {
  const index = corpus(subagent('a', 'b'), subagent('b', 'a'))
  const order = subagentDescendants(index, 'a')
  assert.deepEqual(order, ['b'])
})

test('an entry without a header wrapper, or with an unusable id, is skipped not guessed at', () => {
  const index = {
    snapshots: [
      null,
      { revision: 1, sizeBytes: 1 },
      { header: null },
      { header: subagent(undefined, 'root') },
      { header: subagent('good', 'root') },
      { header: subagent('grand', 'good') },
    ],
  }
  assert.deepEqual(subagentChildrenOf(index, 'root'), ['good'])
  assert.deepEqual(subagentDescendants(index, 'root'), ['grand', 'good'])
})

test('a missing or malformed corpus answers "no children" rather than throwing', () => {
  assert.deepEqual(subagentChildrenOf(undefined, 'root'), [])
  assert.deepEqual(subagentChildrenOf({}, 'root'), [])
  assert.deepEqual(subagentChildrenOf({ snapshots: undefined }, 'root'), [])
  assert.deepEqual(subagentDescendants(undefined, 'root'), [])
  assert.deepEqual(subagentDescendants({}, 'root'), [])
})

test('ids are compared as strings, never by identity', () => {
  // A numeric id in a header must still link: `42` as a parentSession and `'42'`
  // as an id are the same session.
  const index = corpus(subagent(42, 'root'), subagent('x', 42))
  assert.deepEqual(subagentChildrenOf(index, 'root'), ['42'])
  assert.deepEqual(subagentChildrenOf(index, 42), ['x'])
  assert.deepEqual(subagentChildrenOf(index, '42'), ['x'])
  // Deepest first: 'x' is the grandchild, '42' the child.
  assert.deepEqual(subagentDescendants(index, 'root'), ['x', '42'])
})

test('the orphan closure reaches grandchildren, which a one-level lookup misses', () => {
  // This is the measured field shape: 43 first-level orphans plus 25 deeper ones
  // whose parent (a doomed child) still existed on disk.
  const index = corpus(
    header('alive'),
    subagent('kid', 'alive'),
    subagent('orphan', 'gone'),
    subagent('orphan-kid', 'orphan'),
    subagent('orphan-grandkid', 'orphan-kid'),
    subagent('also-orphan', 'gone-too'),
  )
  const orphans = orphanSubagentClosure(index, [])
  assert.deepEqual([...orphans].sort(), ['also-orphan', 'orphan', 'orphan-grandkid', 'orphan-kid'])
})

test('a parent known ONLY to an outside source keeps its child alive', () => {
  // The controller lists a live session whose header is not in the corpus yet:
  // its child must not be reported as an orphan.
  const index = corpus(subagent('child', 'live-parent'))
  assert.deepEqual(orphanSubagentClosure(index, []), ['child'])
  assert.deepEqual(orphanSubagentClosure(index, ['live-parent']), [])
})

test('a non-subagent session is never an orphan, whatever its parent field says', () => {
  const index = corpus(header('plain', { parentSession: 'gone' }), subagent('child', 'gone'))
  assert.deepEqual(orphanSubagentClosure(index, []), ['child'])
})

test('orphanSubagentClosure tolerates a missing corpus and a cyclic claim', () => {
  assert.deepEqual(orphanSubagentClosure(undefined, []), [])
  assert.deepEqual(orphanSubagentClosure({}, ['x']), [])
  // Two sessions claiming each other as parent: each parent EXISTS, so neither is
  // an orphan — and the fixpoint iteration terminates instead of looping.
  const cyclic = corpus(subagent('a', 'b'), subagent('b', 'a'))
  assert.deepEqual(orphanSubagentClosure(cyclic, []), [])
})
