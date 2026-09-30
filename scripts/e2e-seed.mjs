// E2E seed script: builds an isolated DSH_HOME for browser tests of
// dsh-session-manager. It copies a few small session directories from
// $DSH_HOME (default ~/.dsh) into the test home and crafts a minimal
// workspace registry (2 workspaces, active + archived sessions).
//
// The machine-specific data lives in `scripts/e2e-seed.local.json`
// (gitignored; see `e2e-seed.local.example.json` for the shape) so no real
// paths or session ids end up in the repository.
// Run: node scripts/e2e-seed.mjs <e2e-home> [<source-dsh-home>]
import { mkdir, cp, rm, writeFile, readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { E2E_MARKER, assertDisposableHome } from './e2e-guard.mjs'

const e2eHome = process.argv[2]
const sourceHome = process.argv[3] ?? join(homedir(), '.dsh')
if (!e2eHome) {
  console.error('usage: node scripts/e2e-seed.mjs <e2e-home> [<source-dsh-home>]')
  process.exit(2)
}

// THIS SCRIPT IS DESTRUCTIVE: it recursively removes `sessions/` and
// `storages/` in the target. The real home is refused by name, and anything
// else must be either already seeded (marker) or EMPTY — so a typo cannot wipe
// an unrelated tree either. Both checks run BEFORE the first `rm`, because a
// guard that runs after the delete is not a guard.
try {
  assertDisposableHome(e2eHome, { script: 'e2e-seed', allowUnseeded: true })
} catch (error) {
  console.error(error.message)
  process.exit(2)
}
if (!existsSync(join(e2eHome, E2E_MARKER))) {
  const existing = existsSync(e2eHome) ? await readdir(e2eHome) : []
  if (existing.length > 0) {
    console.error(`e2e-seed: refusing to seed into ${e2eHome}: it exists, carries no ${E2E_MARKER} and is not empty (${existing.length} entries).`)
    console.error('e2e-seed: point it at a NEW or emptied directory — never a home you care about.')
    process.exit(2)
  }
}

const specPath = join(dirname(fileURLToPath(import.meta.url)), 'e2e-seed.local.json')
let spec
try {
  spec = JSON.parse(await readFile(specPath, 'utf8'))
} catch {
  console.error(`e2e-seed: missing ${specPath}`)
  console.error('copy scripts/e2e-seed.local.example.json to scripts/e2e-seed.local.json and fill in your own values')
  process.exit(2)
}

const SESSIONS = spec.sessions.map((entry) => [entry.project, entry.id, entry.archived === true])
const WORKSPACES = spec.workspaces

// Every spec'd session must EXIST before anything is created.
//
// A stale spec (ids get deleted from the source home over time) used to warn
// once per missing copy and then write the marker ANYWAY, producing a home that
// looks correctly seeded but has no openable session: the acceptance scripts
// then cannot run, and the failure surfaces much later looking like a plugin
// bug. Verified in the field 2026-09-30 — all six ids had been deleted, every
// copy failed with ENOENT, and the seed still exited 0. Nothing has been
// created at this point, so refusing outright costs nothing.
const missing = SESSIONS.filter(([project, id]) => !existsSync(join(sourceHome, 'sessions', project, id)))
if (missing.length > 0) {
  for (const [project, id] of missing) {
    console.error(`e2e-seed: session not found: ${join(sourceHome, 'sessions', project, id)}`)
  }
  console.error(`e2e-seed: ${missing.length} of ${SESSIONS.length} session(s) in the spec no longer exist in ${sourceHome}.`)
  console.error('e2e-seed: update scripts/e2e-seed.local.json to sessions that exist TODAY, and keep at least one NON-archived')
  console.error('e2e-seed: (the sidebar hides archived rows by default, so an all-archived spec leaves nothing to open).')
  process.exit(2)
}

await rm(join(e2eHome, 'sessions'), { recursive: true, force: true })
await rm(join(e2eHome, 'storages'), { recursive: true, force: true })
await mkdir(join(e2eHome, 'sessions'), { recursive: true })
await mkdir(join(e2eHome, 'storages', 'session_projcache', 'sessions'), { recursive: true })
await mkdir(join(e2eHome, 'profiles'), { recursive: true })

// Settings + credentials copies give the test app the user's providers/theme.
// ⚠ `.credentials.yaml` is a REAL secret copy: it must land in the disposable
// home for the test app to reach the model provider, so delete that home when
// you are done with it (the marker file makes it obvious which tree that is).
for (const name of ['settings.yaml', '.credentials.yaml']) {
  try {
    await cp(join(sourceHome, name), join(e2eHome, name))
    if (name === '.credentials.yaml') {
      console.warn(`e2e-seed: copied your real .credentials.yaml into ${join(e2eHome, name)} — delete this home when finished`)
    }
  } catch {
    console.warn(`e2e-seed: no ${name} in ${sourceHome}`)
  }
}

for (const [project, id] of SESSIONS) {
  const source = join(sourceHome, 'sessions', project, id)
  const target = join(e2eHome, 'sessions', project, id)
  await mkdir(dirname(target), { recursive: true })
  try {
    await cp(source, target, { recursive: true })
  } catch (error) {
    console.warn(`e2e-seed: cannot copy ${source}: ${error.message}`)
  }
  try {
    await cp(join(sourceHome, 'storages', 'session_projcache', 'sessions', `${id}.json`), join(e2eHome, 'storages', 'session_projcache', 'sessions', `${id}.json`))
  } catch {
    console.warn(`e2e-seed: no projcache for ${id}`)
  }
}

const archived = SESSIONS.filter(([, , archived]) => archived).map(([, id]) => id)
const registry = {
  unit: { name: 'workspace', version: 2 },
  global: {
    initialized: true,
    workspaceIds: WORKSPACES.map((workspace) => workspace.id),
    archivedSessionIds: archived,
  },
  tables: {
    workspaces: Object.fromEntries(WORKSPACES.map((workspace) => [workspace.id, {
      path: workspace.path,
      title: workspace.title,
      sessionIds: workspace.sessionIds,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }])),
  },
}
await writeFile(join(e2eHome, 'storages', 'workspace.json'), JSON.stringify(registry, null, 2))
// Marker for the DESTRUCTIVE e2e scripts: they refuse to run against a home
// this seed did not create (see scripts/e2e-guard.mjs) — otherwise pointing
// one at the user's own instance deletes their sessions.
await writeFile(
  join(e2eHome, E2E_MARKER),
  JSON.stringify({ plugin: 'dsh-session-manager', seededAt: new Date().toISOString(), seededFrom: sourceHome }, null, 2),
)
console.log(`e2e home seeded: ${e2eHome}`)
