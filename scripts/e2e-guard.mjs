// Guard for the DESTRUCTIVE e2e scripts.
//
// `e2e-mutations.mjs` and `e2e-residue.mjs` drive a REAL browser against a REAL
// dsh instance and permanently delete sessions through it. The only safe target
// is a home this repository seeded (a throwaway DSH_HOME), and a URL alone
// cannot prove which home is behind it — pointing these scripts at the user's
// own instance deletes their sessions. So the seed drops a marker file and the
// destructive scripts refuse anything without it (the real `~/.dsh` has none,
// and is named explicitly for a clear message).
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Marker written by `scripts/e2e-seed.mjs` into the seeded home. */
export const E2E_MARKER = '.session-manager-e2e'

/**
 * Refuse anything that is not a seeded, disposable e2e home.
 * @param home - the `DISPOSABLE` home path the caller was given.
 * @param script - the calling script's name, for the error message.
 * @throws when the home is missing, is the real dsh home, or was not seeded.
 */
export function assertDisposableHome(home, { script }) {
  if (typeof home !== 'string' || home.trim() === '') {
    throw new Error(`${script}: an isolated DSH_HOME is required — pass the home scripts/e2e-seed.mjs created (--home <path>)`)
  }
  const target = resolve(home)
  const realHome = resolve(join(homedir(), '.dsh'))
  if (target === realHome) {
    throw new Error(`${script}: refusing to run against the REAL dsh home (${realHome}); seed a disposable one with scripts/e2e-seed.mjs`)
  }
  const marker = join(target, E2E_MARKER)
  if (!existsSync(marker)) {
    throw new Error(`${script}: ${target} is not a seeded e2e home (no ${E2E_MARKER}); run: node scripts/e2e-seed.mjs "${target}"`)
  }
  return { home: target, marker }
}
