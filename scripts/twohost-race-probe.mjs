// Reproduces the ONE concurrency boundary the operation lock cannot cover: the
// pending-delete queue is a single read-modify-write file, while
// `withOperationLock` is per-manager (per-process) state. Two hosts sharing one
// DSH_HOME can therefore read the same snapshot and write their own on top of
// each other, silently dropping a marker. A dropped marker strands its tombstone
// in the archive set with nothing left to sweep it while the files are already
// gone — the stuck-ghost-row shape ("the deleted session came back").
//
// Run: node scripts/twohost-race-probe.mjs
// Expected output today: "RESULT: LOST 1 marker(s): …"
//
// NOT an e2e script: it drives no browser and never touches a real home (it
// mkdtemps its own). It exists so the boundary stays reproducible instead of
// being folklore — see AGENTS.md, "ONE operation mutex serializes every durable
// mutation", for what a real fix would have to look like (per-id atomic marker
// files with O_EXCL create, i.e. a queue format change, or a cross-process lock).
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionManager } from '../lib/index.js'

const home = await mkdtemp(join(tmpdir(), 'sm-twohost-'))
process.env.DSH_HOME = home
await mkdir(join(home, 'storages'), { recursive: true })

// A minimal ctx: every service is reached through `tryGet`, so an absent one
// simply does not mount — enough for the queue write path, which needs only
// DSH_HOME.
const bare = () => ({ get: () => undefined, effect: (fn) => fn(), logger: undefined })

const A = 'session-aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const B = 'session-bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'

const a = createSessionManager(bare(), {})
const b = createSessionManager(bare(), {})

console.log('host A read:', JSON.stringify(await a.readPendingQueue()))
console.log('host B read:', JSON.stringify(await b.readPendingQueue()))

await Promise.all([a.addPending(A), b.addPending(B)])
const after = await a.readPendingQueue()
console.log('after two concurrent adds:', JSON.stringify(after))

const ids = new Set(after.ids)
const lost = [A, B].filter((id) => !ids.has(id))
console.log(lost.length === 0
  ? 'RESULT: both markers survived'
  : `RESULT: LOST ${lost.length} marker(s): ${lost.join(', ')}`)

await rm(home, { recursive: true, force: true })
