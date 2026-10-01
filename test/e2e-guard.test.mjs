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
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

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

test('a link is resolved to its target, so it cannot launder a real-home path', async (t) => {
  // The REASON matters, not just the refusal: the marker check refuses most
  // paths anyway, so an assertion that only said "throws" stayed green with
  // `resolve()` in place of a real-path resolution — which is how the
  // link-shaped bypass survived. This test asserted a link AT the real home and
  // passed locally, then failed on CI, where no dsh is installed: `~/.dsh` does
  // not exist there, so the link is DANGLING, `realpath` throws and falls back
  // to the link path — a different refusal.
  //
  // So the two assertions are split, and neither needs `~/.dsh` to exist:
  //   1. `canonicalPath` really follows a link, and is not just `resolve()`;
  //   2. a link to the real home's PARENT is refused as something that CONTAINS
  //      the real home — unreachable without that resolution.
  const root = await mkdtemp(join(tmpdir(), 'sm-guard-'))
  const target = join(root, 'target')
  const link = join(root, 'link')
  const kind = process.platform === 'win32' ? 'junction' : 'dir'
  await mkdir(target, { recursive: true })
  try {
    await symlink(target, link, kind)
    await symlink(dirname(REAL_HOME), join(root, 'parent-link'), kind)
  } catch {
    t.skip('this platform will not let the test create a link without elevation')
    return
  }

  assert.equal(canonicalPath(link), canonicalPath(target), 'the canonical form follows the link')
  assert.notEqual(canonicalPath(link), resolve(link), 'and it is NOT the link path itself')
  assert.throws(() => assertDisposableHome(join(root, 'parent-link'), { script: 'test' }), /CONTAINS the real dsh home/)

  // Where dsh IS installed, cover the original case as well: a link at the real
  // home, refused as the real home and not merely as an unseeded directory.
  if (existsSync(REAL_HOME)) {
    await symlink(REAL_HOME, join(root, 'real-link'), kind)
    assert.throws(() => assertDisposableHome(join(root, 'real-link'), { script: 'test' }), /REAL dsh home/)
  }
})

test('the real home is refused even where it does NOT exist, and whatever its spelling', async () => {
  // CI has no dsh install, so `~/.dsh` is absent there — and `realpathSync` does
  // not run on a missing path, so the real home kept the caller's spelling while
  // the target got resolved (8.3 short names, case). The equality and prefix
  // rules then MISSED and only the marker check stood between a target inside the
  // real home and a delete. Found by running this suite with a fake home, i.e.
  // the CI shape, instead of only on a developer box.
  const fake = await mkdtemp(join(tmpdir(), 'sm-guard-'))
  const key = process.platform === 'win32' ? 'USERPROFILE' : 'HOME'
  const previous = process.env[key]
  process.env[key] = fake
  try {
    assert.equal(existsSync(join(fake, '.dsh')), false, 'this case is about a machine with no dsh install')
    assert.throws(() => assertDisposableHome(fake, { script: 'test' }), /CONTAINS the real dsh home/)
    assert.throws(() => assertDisposableHome(join(fake, '.dsh', 'sub'), { script: 'test' }), /inside it/)
    // …and a properly marked home elsewhere is still accepted.
    const seeded = await seededHome({ sessions: [['proj1', ID]] })
    assertDisposableHome(seeded, { script: 'test' })
  } finally {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
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
