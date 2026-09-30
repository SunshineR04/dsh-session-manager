// On-disk artifact resolution for one session id.
//
// This is the seam where a MISS silently resurrects a deleted session: if the
// artifact directory is not found, the caller reports "only registry bookkeeping
// ran" and the session's files stay on disk while the UI no longer lists it. So
// it over-resolves rather than under-resolves, through three seams in turn:
//
//   1. the registry header's `cwd` + the persistence backend's `locate`;
//   2. the persistence HEADER LISTING (which is why the listing must be read
//      once per operation — see `index()`);
//   3. a raw scan of the sessions root for a directory named exactly the id,
//      which is already pattern-validated by the manager's choke point.
//
// The seams are injected (`getPersistence`, `fallbackSessionsRoot`) so the
// three-way fallback, the wrapper unwrapping and the symlink handling are
// unit-testable with fake backends instead of a whole host — the same reason
// `pending-queue.js` and `session-summaries.js` exist.
import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * @param getPersistence - returns the session-persistence seam, or `undefined`
 *   when that service is not mounted. Called per use, so a late-mounted service
 *   is seen.
 * @param fallbackSessionsRoot - the sessions root to use when the backend
 *   exposes none; a FUNCTION, because the dsh home is read from the environment
 *   lazily (tests point `DSH_HOME` at a fresh fixture per case).
 */
export function createArtifactResolver({ getPersistence, fallbackSessionsRoot }) {
  /** Artifact path of one session via the persistence backend `locate` seam. */
  const artifactPathOf = (cwd, sessionId) => {
    const persistence = getPersistence()
    if (persistence === undefined || typeof persistence.locate !== 'function' || cwd === undefined) return undefined
    try {
      return persistence.locate({ cwd, id: sessionId })?.path
    } catch {
      return undefined
    }
  }

  /**
   * One corpus read, shared by a whole operation: `persistence.list()` (which
   * walks every generation and reads+decompresses every stored header) and the
   * sessions-root listing are the two expensive halves of `resolveSessionDirs`.
   * Resolving ONE queued id at a time made `deferred/list` `O(queued × corpus)`
   * — five queued ids against a 500-session corpus meant ~2500 header decodes
   * for one request, twice over (the sweep and the `hasArtifact` split), while
   * holding the operation lock. Build this once per operation and pass it down;
   * a caller that omits it gets the single-id behavior.
   * @returns `{ snapshots, root, projects }`
   */
  async function index() {
    const persistence = getPersistence()
    let snapshots = []
    if (persistence !== undefined && typeof persistence.list === 'function') {
      try {
        snapshots = await persistence.list()
      } catch {
        // Header listing unavailable — the raw scan below still applies.
        snapshots = []
      }
    }
    const root = typeof persistence?.root === 'string' && persistence.root.length > 0
      ? persistence.root
      : fallbackSessionsRoot()
    let projects = []
    try {
      // Symlinked project directories are accepted: the leaf check below uses
      // `stat` (which follows the link), so skipping them here was the only
      // reason a link-shaped sessions root could hide an artifact. A dirent for
      // a link reports `isDirectory() === false` — true for Windows junctions
      // too — so filtering on `isDirectory()` alone would clear the tombstone
      // and resurrect the session at the next boot.
      projects = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => entry.name)
    } catch {
      // Sessions root unreadable — report whatever the seams resolved.
      projects = []
    }
    return { snapshots, root, projects }
  }

  /**
   * Every on-disk artifact directory that plausibly holds `sessionId`'s log,
   * through the three seams above. A silently missed artifact is what resurrects
   * deleted sessions as ungrouped entries in the workspace browser, so this
   * over-resolves rather than under-resolves. Pass the operation's index to
   * avoid re-reading the corpus per id.
   */
  async function resolveSessionDirs(sessionId, header, corpusIndex) {
    const dirs = []
    const seen = new Set()
    const consider = (path) => {
      if (path === undefined || seen.has(path)) return
      seen.add(path)
      dirs.push(path)
    }
    const located = artifactPathOf(header?.cwd, sessionId)
    if (located !== undefined) consider(dirname(located))
    const corpus = corpusIndex ?? await index()
    for (const snapshot of corpus.snapshots) {
      // The listing yields `{ header, revision, sizeBytes }` wrappers, never bare
      // headers: reading `.id`/`.cwd` off the wrapper never matched, which
      // silently reduced this middle seam to a no-op. An entry without a header
      // is skipped, not guessed at.
      const candidate = snapshot?.header
      if (candidate === undefined || candidate === null) continue
      if (String(candidate.id) !== sessionId) continue
      const path = artifactPathOf(candidate.cwd, sessionId)
      if (path !== undefined) consider(dirname(path))
    }
    for (const project of corpus.projects) {
      const candidate = join(corpus.root, project, sessionId)
      const info = await stat(candidate).catch(() => undefined)
      if (info?.isDirectory() === true) consider(candidate)
    }
    return dirs
  }

  /**
   * Whether the session's on-disk artifact directory still exists (i.e. the
   * queued deletion has something left to cancel meaningfully). EXISTENCE, not
   * just resolvability: the header seams keep resolving paths after the files
   * are gone, so a resolvable-but-absent answer must not count.
   */
  const hasArtifact = async (sessionId, corpusIndex) => {
    for (const dir of await resolveSessionDirs(sessionId, undefined, corpusIndex)) {
      if (existsSync(dir)) return true
    }
    return false
  }

  return { artifactPathOf, index, resolveSessionDirs, hasArtifact }
}
