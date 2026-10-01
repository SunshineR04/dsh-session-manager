// Guard for the DESTRUCTIVE e2e scripts.
//
// `e2e-mutations.mjs`, `e2e-residue.mjs`, `e2e-bug2.mjs`, `e2e-live.mjs` and
// `e2e-dialog-style.mjs` drive a REAL browser against a REAL dsh instance and
// permanently delete sessions through it. Two independent facts have to hold
// before any of them may click Delete, and neither is provable from the other:
//
//   1. the HOME is disposable — it carries a marker this repository's seed
//      wrote, for THIS path (see `assertDisposableHome`); and
//   2. the INSTANCE behind the page is serving that home — a URL cannot prove
//      it, so the instance is asked for the session ids it can see and every one
//      of them must exist in the home (see `assertInstanceServesHome`).
//
// Without (2), pointing a script at your own running dsh with a valid
// `--home` passed every check and deleted your real sessions.
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/** Marker written by `scripts/e2e-seed.mjs` into the seeded home. */
export const E2E_MARKER = '.session-manager-e2e'

const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)

/**
 * The path as the FILESYSTEM sees it. `resolve()` only normalizes text: it does
 * not follow a symlink or a junction, does not expand an 8.3 short name
 * (`ADMINI~1`) and does not strip a `\\?\` prefix — each of which was a way past
 * the old exact-string comparison with the real home. A path that does not exist
 * yet (the seed's own target) falls back to `resolve()`.
 */
const canonical = (target) => {
  try {
    return realpathSync.native(target)
  } catch {
    return resolve(target)
  }
}

const realHome = () => canonical(join(homedir(), '.dsh'))

/** The filesystem-canonical form of a path (see {@link canonical}). */
export const canonicalPath = (target) => canonical(target)

/**
 * Refuse anything that is not a seeded, disposable e2e home.
 *
 * EVERY script that deletes or mutates sessions must call this, and must call it
 * BEFORE its first filesystem write — `scripts/e2e-seed.mjs` included, which
 * recursively removes `sessions/` and `storages/` before it writes the marker.
 * @param home - the DISPOSABLE home path the caller was given.
 * @param script - the calling script's name, for the error message.
 * @param allowUnseeded - accept a home that has no marker yet (the SEED itself
 *   must, since it is what writes the marker). The real-home refusal still
 *   applies; callers that pass this must add their own "is it safe to write
 *   here" rule on top (see `e2e-seed.mjs`).
 * @throws when the home is missing, is the real dsh home (or inside it), or is
 *   not a home this repository seeded.
 */
export function assertDisposableHome(home, { script, allowUnseeded = false } = {}) {
  if (typeof home !== 'string' || home.trim() === '') {
    throw new Error(`${script}: an isolated DSH_HOME is required — pass the home scripts/e2e-seed.mjs created (--home <path>)`)
  }
  const target = canonical(home)
  const real = realHome()
  // Case-insensitive on Windows, and a PREFIX check, not just equality: the real
  // home can be reached by a case variant, a short name, an UNC path, a
  // junction, or `\\?\…`, and a delete inside `~/.dsh/anything` is too close for
  // comfort.
  if (fold(target) === fold(real) || fold(target).startsWith(fold(real) + sep)) {
    throw new Error(`${script}: refusing to run against the REAL dsh home (${real}) or anything inside it; seed a disposable home with scripts/e2e-seed.mjs`)
  }
  // An ANCESTOR of the real home is refused as well. `assertDisposableHome(home)`
  // is a plausible slip — `HOMEDIR` reads like a fine scratch path — and the
  // seed would then `rm -rf` `<you>/sessions` and `<you>/storages`, delete the
  // real home's siblings, and copy `.credentials.yaml` beside them. The "not
  // empty and unmarked" rule catches that only by luck (and not at all once a
  // marker exists there).
  if (fold(real).startsWith(fold(target) + sep)) {
    throw new Error(`${script}: ${target} CONTAINS the real dsh home (${real}) — refusing to treat a parent of your real home as disposable`)
  }
  const marker = join(target, E2E_MARKER)
  if (!existsSync(marker)) {
    if (allowUnseeded) return { home: target, marker }
    throw new Error(`${script}: ${target} is not a seeded e2e home (no ${E2E_MARKER}); run: node scripts/e2e-seed.mjs "${target}"`)
  }
  // The marker IS an authorization, so it is validated rather than trusted by
  // name. A DIRECTORY called like one satisfied the old check; so did a stale
  // copy restored from a home snapshot, which then licensed deleting that home's
  // sessions.
  if (!lstatSync(marker).isFile()) {
    throw new Error(`${script}: ${marker} is not a regular file — refusing to treat ${target} as a disposable home`)
  }
  let recorded
  try {
    recorded = JSON.parse(readFileSync(marker, 'utf8'))
  } catch {
    throw new Error(`${script}: ${marker} is not valid JSON — re-seed ${target} with scripts/e2e-seed.mjs`)
  }
  if (recorded?.plugin !== 'dsh-session-manager') {
    throw new Error(`${script}: ${marker} was not written by this repository's seed — re-seed ${target}`)
  }
  if (typeof recorded.home !== 'string' || recorded.home === '') {
    throw new Error(`${script}: ${marker} predates the home binding and cannot prove which home it belongs to — re-seed ${target} with scripts/e2e-seed.mjs`)
  }
  if (fold(canonical(recorded.home)) !== fold(target)) {
    throw new Error(`${script}: ${marker} records a different home (${recorded.home}) — refusing to run`)
  }
  return { home: target, marker }
}

/**
 * Every session id the seeded home can serve, from the filesystem that will be
 * deleted from: `<home>/sessions/<project>/<id>` is exactly what `e2e-seed.mjs`
 * copies and the only thing such an instance can list.
 * @returns a `Set` of ids (empty when the home has no sessions at all).
 */
export async function homeSessionIds(home) {
  const ids = new Set()
  let projects
  try {
    projects = await readdir(join(home, 'sessions'), { withFileTypes: true })
  } catch {
    return ids
  }
  for (const project of projects) {
    if (!project.isDirectory() && !project.isSymbolicLink()) continue
    let entries
    try {
      entries = await readdir(join(home, 'sessions', project.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) ids.add(entry.name)
    }
  }
  return ids
}

/**
 * Refuse to mutate unless the INSTANCE BEHIND THE PAGE is serving `home`.
 *
 * The guard above proves the home is disposable; it cannot prove that the URL
 * points at an instance using it, and `assertDisposableHome` says so itself. So
 * ask the page for the session ids it can see — the plugin's own `list` endpoint
 * (every archived id the host serving this page knows) plus the sidebar rows —
 * and require all of them to exist in the home. A real instance reports the
 * user's real ids, which a seeded home does not contain.
 *
 * Fails CLOSED: an instance that answers nothing is not treated as "probably
 * fine", because the whole point is to rule the wrong instance out.
 * @param page - a puppeteer page already navigated to the app, and authenticated.
 * @param home - the home `assertDisposableHome` approved.
 * @param script - the calling script's name, for the error message.
 */
export async function assertInstanceServesHome(page, home, { script }) {
  const local = await homeSessionIds(home)
  const seen = await page.evaluate(async () => {
    const out = { archived: null, rows: [] }
    try {
      out.rows = [...document.querySelectorAll('[data-row-key^="session:"]')]
        .map((element) => String(element.getAttribute('data-row-key')).slice('session:'.length))
    } catch { /* the row scan is best effort; the RPC below is the load-bearing half */ }
    try {
      const response = await fetch('/api/session-manager/list', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'e2e-guard', method: 'session-manager/list', payload: {} }),
      })
      const body = await response.json()
      const value = body?.result?.ok === true ? body.result.value : null
      if (value !== null && Array.isArray(value.archivedSessionIds)) out.archived = value.archivedSessionIds.map(String)
    } catch { /* reported below as "could not read" */ }
    return out
  })
  const reported = [...new Set([...(seen.archived ?? []), ...seen.rows])]
  const foreign = reported.filter((id) => !local.has(id))
  if (foreign.length > 0) {
    throw new Error(
      `${script}: refusing to continue — the instance behind this page is NOT serving ${home}: it reports ${foreign.length} session(s) that home does not contain (${foreign.slice(0, 3).join(', ')}${foreign.length > 3 ? ', …' : ''})`,
    )
  }
  if (local.size > 0 && reported.length === 0) {
    throw new Error(
      `${script}: could not read a single session id from the page (plugin RPC down, or not logged in?) — refusing to delete anything without proof of which home this instance serves`,
    )
  }
  return { checked: reported.length, homeIds: local.size }
}
