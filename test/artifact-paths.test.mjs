// Unit tests for the artifact resolver.
//
// This is the seam where a MISS resurrects a deleted session: if the artifact
// directory is not found the caller only does registry bookkeeping, the files
// stay on disk, and the UI no longer lists the session. So the three-way
// fallback and the wrapper unwrapping are pinned here against FAKE backends,
// with real temp directories only where existence is the question.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createArtifactResolver } from '../lib/artifact-paths.js'

const ID = 'session-3012b8a0-1fef-4f34-8d9c-a6c5b7aa84d2'
const CWD = 'C:\\Users\\test\\project'

async function makeRoot() {
  return mkdtemp(join(tmpdir(), 'dsm-artifacts-'))
}

/** A resolver over an explicit sessions root, with the persistence seam faked. */
function makeResolver(root, persistence) {
  return createArtifactResolver({
    getPersistence: () => persistence,
    fallbackSessionsRoot: () => root,
  })
}

const locateAt = (root) => ({
  locate: (meta) => ({ kind: 'jsonl', path: join(root, '--project--', meta.id, 'session.jsonl.zstd') }),
})

test('seam 1: the header cwd plus locate resolves the artifact directory', async () => {
  const root = await makeRoot()
  const resolver = makeResolver(root, locateAt(root))
  const dirs = await resolver.resolveSessionDirs(ID, { cwd: CWD }, { snapshots: [], root, projects: [] })
  assert.deepEqual(dirs, [join(root, '--project--', ID)])
})

test('seam 2: the header LISTING resolves it, and only through the wrapper', async () => {
  // The listing yields `{ header, revision, sizeBytes }` wrappers. Reading
  // `.id`/`.cwd` off the wrapper matched nothing and silently reduced this seam
  // to a no-op — the historical bug.
  const root = await makeRoot()
  const resolver = makeResolver(root, locateAt(root))
  const wrapped = { snapshots: [{ header: { id: ID, cwd: CWD }, revision: 'r', sizeBytes: 0 }], root, projects: [] }
  assert.deepEqual(await resolver.resolveSessionDirs(ID, undefined, wrapped), [join(root, '--project--', ID)])

  // A BARE header (no wrapper) must NOT resolve: the shape the old fake used.
  const bare = { snapshots: [{ id: ID, cwd: CWD }], root, projects: [] }
  assert.deepEqual(await resolver.resolveSessionDirs(ID, undefined, bare), [], 'a bare header is skipped, not guessed at')
  // …and neither does an entry with no header at all.
  assert.deepEqual(await resolver.resolveSessionDirs(ID, undefined, { snapshots: [{ revision: 'r' }], root, projects: [] }), [])
})

test('seam 3: the raw scan finds a directory named exactly the id', async () => {
  const root = await makeRoot()
  await mkdir(join(root, '--project--', ID), { recursive: true })
  // A decoy project whose NAME contains the id must not match.
  await mkdir(join(root, `--${ID}--`, 'other'), { recursive: true })
  const resolver = makeResolver(root, undefined) // no persistence at all
  const index = await resolver.index()
  assert.deepEqual(await resolver.resolveSessionDirs(ID, undefined, index), [join(root, '--project--', ID)])
})

test('a SYMLINKED project directory is scanned, not skipped', async () => {
  // A dirent for a link reports `isDirectory() === false` (true for Windows
  // junctions too), so filtering on `isDirectory()` alone would hide the
  // artifact, clear the tombstone and resurrect the session at the next boot.
  const root = await makeRoot()
  const real = await makeRoot()
  await mkdir(join(real, ID), { recursive: true })
  try {
    await symlink(real, join(root, 'linked-project'), 'junction')
  } catch {
    return // no symlink privilege on this machine — covered by the host suite
  }
  const resolver = makeResolver(root, undefined)
  const resolved = await resolver.resolveSessionDirs(ID, undefined, await resolver.index())
  assert.deepEqual(resolved, [join(root, 'linked-project', ID)])
})

test('the same directory found by two seams is reported once', async () => {
  const root = await makeRoot()
  await mkdir(join(root, '--project--', ID), { recursive: true })
  const resolver = makeResolver(root, locateAt(root))
  const index = { snapshots: [{ header: { id: ID, cwd: CWD } }], root, projects: ['--project--'] }
  const dirs = await resolver.resolveSessionDirs(ID, { cwd: CWD }, index)
  assert.deepEqual(dirs, [join(root, '--project--', ID)], 'deduplicated')
})

test('index() reads the listing ONCE, and tolerates a throwing or absent backend', async () => {
  const root = await makeRoot()
  let listings = 0
  const counting = { root, async list() { listings += 1; return [] } }
  const resolver = makeResolver(root, counting)
  await resolver.index()
  assert.equal(listings, 1)

  // A throwing listing falls through to the raw scan instead of failing.
  const throwing = makeResolver(root, { root, async list() { throw new Error('nope') } })
  assert.deepEqual((await throwing.index()).snapshots, [])

  // No backend at all: the sessions root is still listed.
  const none = makeResolver(root, undefined)
  assert.deepEqual((await none.index()).projects, [])
  assert.equal((await none.index()).root, root)
})

test('index() prefers the backend root over the fallback', async () => {
  const fallback = await makeRoot()
  const backendRoot = await makeRoot()
  await mkdir(join(backendRoot, '--project--'), { recursive: true })
  const resolver = makeResolver(fallback, { root: backendRoot, async list() { return [] } })
  const index = await resolver.index()
  assert.equal(index.root, backendRoot)
  assert.deepEqual(index.projects, ['--project--'])
})

test('hasArtifact requires EXISTENCE, not just resolvability', async () => {
  // The header seams keep resolving a path after the files are gone, so
  // "resolvable" is not the question — the cancel button depends on this.
  const root = await makeRoot()
  const resolver = makeResolver(root, locateAt(root))
  assert.equal(await resolver.hasArtifact(ID), false, 'nothing on disk yet')
  await mkdir(join(root, '--project--', ID), { recursive: true })
  assert.equal(await resolver.hasArtifact(ID), true, 'now there is')
})

test('a session with no cwd anywhere and no matching directory resolves to nothing', async () => {
  const root = await makeRoot()
  await mkdir(join(root, '--other--', 'session-someone-else-0001'), { recursive: true })
  const resolver = makeResolver(root, { root, async list() { return [{ header: { id: 'session-someone-else-0001', cwd: CWD } }] } })
  assert.deepEqual(await resolver.resolveSessionDirs(ID, {}, await resolver.index()), [])
})

test('writing a file into the resolved directory is what makes it an artifact', async () => {
  // Guards against a resolver that returns the project dir instead of the
  // session dir: deleting the former would remove every session in it.
  const root = await makeRoot()
  await mkdir(join(root, '--project--', ID), { recursive: true })
  await writeFile(join(root, '--project--', ID, 'session.jsonl.zstd'), 'bytes')
  const resolver = makeResolver(root, undefined)
  const dirs = await resolver.resolveSessionDirs(ID, undefined, await resolver.index())
  assert.deepEqual(dirs, [join(root, '--project--', ID)])
})
