// E2E seed script: builds an isolated DSH_HOME for browser tests of
// dsh-session-manager. It copies a few small session directories from
// $DSH_HOME (default ~/.dsh) into the test home and crafts a minimal
// workspace registry (2 workspaces, active + archived sessions).
//
// The machine-specific data lives in `scripts/e2e-seed.local.json`
// (gitignored; see `e2e-seed.local.example.json` for the shape) so no real
// paths or session ids end up in the repository.
// Run: node scripts/e2e-seed.mjs <e2e-home> [<source-dsh-home>]
//
// ORDER IS THE CONTRACT: every refusal (real home, a non-empty unmarked target,
// a malformed or stale spec, source == target) happens before the first `rm`,
// and the marker is written before the first `rm` too — so whatever this script
// destroys is always inside a directory it has already claimed as disposable,
// and a failure half-way through cannot leave a home holding a copy of the real
// `.credentials.yaml` that no script will ever accept again.
import { mkdir, cp, rm, writeFile, readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { E2E_MARKER, assertDisposableHome, canonicalPath } from './e2e-guard.mjs'

const requestedHome = process.argv[2]
const sourceHome = canonicalPath(process.argv[3] ?? join(homedir(), '.dsh'))
if (!requestedHome) {
  console.error('usage: node scripts/e2e-seed.mjs <e2e-home> [<source-dsh-home>]')
  process.exit(2)
}

// THIS SCRIPT IS DESTRUCTIVE: it recursively removes `sessions/` and
// `storages/` in the target. The real home is refused by name, and anything
// else must be either already seeded (marker) or EMPTY — so a typo cannot wipe
// an unrelated tree either. Both checks run BEFORE the first `rm`, because a
// guard that runs after the delete is not a guard.
let e2eHome
try {
  ({ home: e2eHome } = assertDisposableHome(requestedHome, { script: 'e2e-seed', allowUnseeded: true }))
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

// `node scripts/e2e-seed.mjs <home> <home>` used to pass the staleness check,
// then destroy the fixture with the `rm` below, fail every copy with ENOENT
// (warned, not thrown) and still print "e2e home seeded" with exit 0. Nothing
// has been touched at this point, so refusing costs nothing.
if (canonicalPath(e2eHome) === canonicalPath(sourceHome)) {
  console.error(`e2e-seed: the source and the target are the same home (${e2eHome}); seeding would empty the fixture it copies from.`)
  process.exit(2)
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

// The SHAPE is validated before the `rm` too. A spec with a valid `sessions`
// array but no `workspaces` used to crash at `WORKSPACES.map` AFTER the delete
// and after the credential copy, leaving a mutilated home holding a copy of the
// real `.credentials.yaml` — which the "no marker and not empty" rule above then
// refuses forever.
const shapeErrors = []
const specSessions = Array.isArray(spec.sessions) ? spec.sessions : []
const specWorkspaces = Array.isArray(spec.workspaces) ? spec.workspaces : []
if (specSessions.length === 0) shapeErrors.push('`sessions` must be a non-empty array')
if (specWorkspaces.length === 0) shapeErrors.push('`workspaces` must be a non-empty array')
for (const [index, entry] of specSessions.entries()) {
  if (typeof entry?.project !== 'string' || entry.project === '' || typeof entry?.id !== 'string' || entry.id === '') {
    shapeErrors.push(`sessions[${index}] needs a non-empty string \`project\` and \`id\``)
  }
}
for (const [index, workspace] of specWorkspaces.entries()) {
  if (typeof workspace?.id !== 'string' || typeof workspace?.path !== 'string' || !Array.isArray(workspace?.sessionIds)) {
    shapeErrors.push(`workspaces[${index}] needs a string \`id\`, a string \`path\` and an array \`sessionIds\``)
  }
}
if (shapeErrors.length > 0) {
  console.error(`e2e-seed: ${specPath} is not a usable seed spec (nothing was created):`)
  for (const problem of shapeErrors) console.error(`  - ${problem}`)
  process.exit(2)
}

const SESSIONS = specSessions.map((entry) => [entry.project, entry.id, entry.archived === true])
const WORKSPACES = specWorkspaces

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

// Claim the directory as a disposable e2e home BEFORE mutating it. Everything
// above this line only reads; from here on, a failure leaves a home that is
// already marked (so it can be re-seeded or deleted) instead of a half-written
// directory holding a copy of the real credentials and refused by every script.
await mkdir(e2eHome, { recursive: true })
await writeFile(
  join(e2eHome, E2E_MARKER),
  JSON.stringify({ plugin: 'dsh-session-manager', home: e2eHome, seededAt: new Date().toISOString(), seededFrom: sourceHome }, null, 2),
)

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
    // Fatal, not a warning: the staleness pre-check above proved this session
    // existed a moment ago, so a copy failure means something changed underneath
    // us — and a "seeded" home missing a session the spec names is the spent
    // fixture that surfaces later looking like a plugin bug.
    console.error(`e2e-seed: cannot copy ${source}: ${error.message}`)
    console.error(`e2e-seed: ${e2eHome} is marked disposable but incomplete — delete it and re-run.`)
    process.exit(1)
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
console.log(`e2e home seeded: ${e2eHome}`)
console.log(`e2e-seed: the marker was written first, so a failure above leaves ${e2eHome} recognisable and disposable — delete it and re-run.`)
