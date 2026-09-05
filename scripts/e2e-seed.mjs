// E2E seed script: builds an isolated DSH_HOME for browser tests of
// dsh-session-manager. It copies a few small session directories from
// $DSH_HOME (default ~/.dsh) into the test home and crafts a minimal
// workspace registry (2 workspaces, active + archived sessions).
//
// The machine-specific data lives in `scripts/e2e-seed.local.json`
// (gitignored; see `e2e-seed.local.example.json` for the shape) so no real
// paths or session ids end up in the repository.
// Run: node scripts/e2e-seed.mjs <e2e-home> [<source-dsh-home>]
import { mkdir, cp, rm, writeFile, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const e2eHome = process.argv[2]
const sourceHome = process.argv[3] ?? join(homedir(), '.dsh')
if (!e2eHome) {
  console.error('usage: node scripts/e2e-seed.mjs <e2e-home> [<source-dsh-home>]')
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

const SESSIONS = spec.sessions.map((entry) => [entry.project, entry.id, entry.archived === true])
const WORKSPACES = spec.workspaces

await rm(join(e2eHome, 'sessions'), { recursive: true, force: true })
await rm(join(e2eHome, 'storages'), { recursive: true, force: true })
await mkdir(join(e2eHome, 'sessions'), { recursive: true })
await mkdir(join(e2eHome, 'storages', 'session_projcache', 'sessions'), { recursive: true })
await mkdir(join(e2eHome, 'profiles'), { recursive: true })

// Settings + credentials copies give the test app the user's providers/theme.
for (const name of ['settings.yaml', '.credentials.yaml']) {
  try {
    await cp(join(sourceHome, name), join(e2eHome, name))
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
console.log(`e2e home seeded: ${e2eHome}`)
