// Guard tests: the destructive e2e scripts trust `scripts/e2e-guard.mjs` with
// the user's REAL sessions, and nothing tested it — it was only ever "verified"
// by running a script against a good home. These cases exercise the refusals
// directly, with no browser and no Chrome.
//
// The real home is never written to: the "inside the real home" case is a path
// that does not exist, refused by the prefix rule before any filesystem call.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { E2E_MARKER, assertDisposableHome, assertInstanceServesHome, canonicalPath, homeSessionIds } from '../scripts/e2e-guard.mjs'

const REAL_HOME = join(homedir(), '.dsh')
const ID = 'session-3012b8a0-1fef-4f34-8d9c-a6c5b7aa84d2'
const OTHER = 'session-9987799d-52b1-464a-8db2-5d16bb8a9bd5'

/** A throwaway home with an optional marker + session layout. */
async function seededHome({ marker = true, sessions = [[ 'proj1', ID ]], record } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'sm-guard-'))
  if (marker) {
    await writeFile(join(home, E2E_MARKER), JSON.stringify(record ?? {
      plugin: 'dsh-session-manager',
      home: canonicalPath(home),
      seededAt: new Date().toISOString(),
      seededFrom: REAL_HOME,
    }))
  }
  for (const [project, id] of sessions) {
    await mkdir(join(home, 'sessions', project, id), { recursive: true })
    await writeFile(join(home, 'sessions', project, id, 'session.jsonl.zstd'), 'x')
  }
  return home
}

const refuse = (home, extra = {}) => assert.throws(
  () => assertDisposableHome(home, { script: 'test', ...extra }),
  (error) => error instanceof Error && error.message.includes('test:'),
)

test('the real dsh home is refused by name', () => {
  refuse(REAL_HOME)
  assert.throws(() => assertDisposableHome(REAL_HOME, { script: 'test' }), /REAL dsh home/)
  assert.throws(() => assertDisposableHome(REAL_HOME, { script: 'test', allowUnseeded: true }), /REAL dsh home/)
})

test('anything INSIDE the real home is refused too', () => {
  // A delete anywhere under the real home is too close for comfort, and this
  // path does not exist — the refusal has to come from the path rule, not from
  // a marker check.
  assert.throws(() => assertDisposableHome(join(REAL_HOME, '__sm-never-created__'), { script: 'test' }), /inside it/)
  assert.throws(() => assertDisposableHome(`${REAL_HOME}${process.platform === 'win32' ? '\\' : '/'}e2e`, { script: 'test' }), /inside it/)
})

test('a PARENT of the real home is refused as well', () => {
  // Found by hitting it: `$home` is PowerShell's read-only $HOME, so a script
  // that meant to pass a temp dir passed the user profile instead. The seed's
  // "not empty and unmarked" rule refused it — by luck, and not at all once a
  // marker exists there. `homedir()` contains `.dsh` by definition.
  assert.throws(() => assertDisposableHome(homedir(), { script: 'test' }), /CONTAINS the real dsh home/)
  assert.throws(() => assertDisposableHome(dirname(REAL_HOME), { script: 'test' }), /CONTAINS the real dsh home/)
  // A sibling with a shared prefix is NOT a parent (`…\.dsh2` vs `…\.dsh`).
  refuse(`${REAL_HOME}2`)
})

test('a case variant, a short name and a trailing separator cannot smuggle the real home in', () => {
  // The old check was `resolve(x) === resolve(realHome)`, an exact string
  // comparison: on Windows a case variant (or an 8.3 short name) resolved
  // somewhere else and fell through to the marker check — which only holds while
  // the real home happens to have no marker.
  for (const variant of [REAL_HOME.toUpperCase(), `${REAL_HOME}${process.platform === 'win32' ? '\\' : '/'}`]) {
    if (process.platform === 'win32') {
      // Real-path resolution folds the case, so the refusal is the REAL-home one.
      assert.throws(() => assertDisposableHome(variant, { script: 'test' }), /REAL dsh home/)
    } else {
      refuse(variant)
    }
  }
  refuse(`${REAL_HOME}.`)
})

test('a junction or symlink pointing at the real home is refused AS the real home', async (t) => {
  // The reason matters, not just the refusal: the marker check would also refuse
  // this link today (the real home carries no marker), so an assertion that only
  // said "throws" would stay green with `resolve()` — which is exactly how the
  // link-shaped bypass survived.
  const link = join(await mkdtemp(join(tmpdir(), 'sm-guard-')), 'link')
  try {
    await symlink(REAL_HOME, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    t.skip('this platform will not let the test create a link without elevation')
    return
  }
  assert.throws(() => assertDisposableHome(link, { script: 'test' }), /REAL dsh home/)
})

test('an unmarked home is refused, and only the seed may pass allowUnseeded', async () => {
  const bare = await mkdtemp(join(tmpdir(), 'sm-guard-'))
  refuse(bare)
  assert.deepEqual(
    assertDisposableHome(bare, { script: 'test', allowUnseeded: true }).home,
    canonicalPath(bare),
    'the seed itself gets the canonical home back',
  )
  refuse(join(tmpdir(), '__sm-definitely-missing__', 'home'))
})

test('a marker that is not a file, not JSON, or not ours is refused', async () => {
  const asDirectory = await mkdtemp(join(tmpdir(), 'sm-guard-'))
  await mkdir(join(asDirectory, E2E_MARKER))
  assert.throws(() => assertDisposableHome(asDirectory, { script: 'test' }), /not a regular file/)

  const notJson = await mkdtemp(join(tmpdir(), 'sm-guard-'))
  await writeFile(join(notJson, E2E_MARKER), 'not json at all')
  assert.throws(() => assertDisposableHome(notJson, { script: 'test' }), /not valid JSON/)

  const foreign = await seededHome({ record: { plugin: 'some-other-plugin', home: 'C:/elsewhere' } })
  assert.throws(() => assertDisposableHome(foreign, { script: 'test' }), /not written by this repository/)
})

test('a marker that records a different home (or predates the binding) is refused', async () => {
  // A legitimate-looking marker restored from a home snapshot used to license
  // deleting that snapshot's sessions; now it has to name THIS path.
  const elsewhere = await seededHome({ record: { plugin: 'dsh-session-manager', home: 'C:/some/other/home' } })
  assert.throws(() => assertDisposableHome(elsewhere, { script: 'test' }), /records a different home/)

  const legacy = await seededHome({ record: { plugin: 'dsh-session-manager', seededAt: 'then' } })
  assert.throws(() => assertDisposableHome(legacy, { script: 'test' }), /predates the home binding/)
})

test('a properly seeded home is accepted, and its id set is read off the filesystem', async () => {
  const home = await seededHome({ sessions: [['proj1', ID], ['proj2', OTHER]] })
  const approved = assertDisposableHome(home, { script: 'test' })
  assert.equal(approved.home, canonicalPath(home))
  const ids = await homeSessionIds(approved.home)
  assert.deepEqual([...ids].sort(), [ID, OTHER].sort(), 'exactly the session directories the seed copied')
})

test('the instance binding passes only when every id the page reports exists in the home', async () => {
  const home = await seededHome({ sessions: [['proj1', ID]] })
  const page = (seen) => ({ evaluate: async () => seen })

  const ok = await assertInstanceServesHome(page({ archived: [ID], rows: [] }), home, { script: 'test' })
  assert.equal(ok.checked, 1)
  await assertInstanceServesHome(page({ archived: [], rows: [ID] }), home, { script: 'test' })

  // The real-instance case: one id this home does not contain is enough.
  await assert.rejects(
    assertInstanceServesHome(page({ archived: [ID, OTHER], rows: [] }), home, { script: 'test' }),
    /NOT serving/,
  )
  await assert.rejects(
    assertInstanceServesHome(page({ archived: null, rows: [OTHER] }), home, { script: 'test' }),
    /NOT serving/,
  )
})

test('the instance binding fails CLOSED when the page reports nothing', async () => {
  // "Probably fine" is not good enough for an irreversible delete, and a page
  // whose plugin RPC is down is exactly when the seat-of-the-pants answer is
  // most likely wrong.
  const home = await seededHome({ sessions: [['proj1', ID]] })
  await assert.rejects(
    assertInstanceServesHome({ evaluate: async () => ({ archived: null, rows: [] }) }, home, { script: 'test' }),
    /could not read a single session id/,
  )
  // A home with no sessions at all cannot contradict anything, so it passes.
  const empty = await seededHome({ sessions: [] })
  const result = await assertInstanceServesHome({ evaluate: async () => ({ archived: null, rows: [] }) }, empty, { script: 'test' })
  assert.equal(result.homeIds, 0)
})
