// dsh-session-manager — host half.
//
// Owns archived-session management for the DeepSeek Harness:
//   - list archived sessions (id / title / cwd / dates / owning workspace)
//   - restore (unarchive) a session — the archive set is registry-global and
//     archiving keeps the workspace `sessionIds` slot, so removing the id from
//     `archivedSessionIds` restores its exact previous position
//   - permanently delete a session — registry bookkeeping (archive set +
//     workspace accounting), the `~/.dsh/sessions/<project>/<session>` artifact
//     directory and the `session_projcache` metadata checkpoint. Deletion is
//     always a direct physical delete; there is no backup layer.
//   - pending (open-session) tombstones and their next-boot finish-up
//
// Surfaces (all registered defensively — each one simply does not mount when
// its service is absent from the composition):
//   - Connection RPC channel `/session-manager` for the browser half
//   - agent tools `session_list_archived`, `session_restore_archived`,
//     `session_delete_permanently` for the model
//   (The `/sessions` slash-command family was removed in v0.3.0 — the desktop
//   host has no slash surface; Settings page / context menu / tools are the
//   intended UX.)
//
// The host imports nothing from the dsh core beyond `@deepseek-ai/schemastery`
// for the Config schema; every dsh service is reached through `ctx.get(...)`.

import Schema from '@deepseek-ai/schemastery'
// The pending queue's PURE half — file format, versioning, input sanitization.
// Kept in its own module so those durability semantics are unit-testable without
// standing up a host (see `test/pending-queue.test.mjs`).
import { SESSION_ID_PATTERN, decodePendingQueue, encodePendingQueue } from './pending-queue.js'
// The pure half of the controller-row projection (the `{ items }` envelope and
// the `title` projection) — the seam whose silent failure emptied every summary.
import { decodeControllerList, summaryFromControllerRow } from './session-summaries.js'
// On-disk artifact resolution: the three-seam fallback, the shared corpus index
// and the symlink handling (seams injected — see the module).
import { createArtifactResolver } from './artifact-paths.js'
import { createRegistryWrites } from './registry-writes.js'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile, readFile, rename } from 'node:fs/promises'

export const name = 'session-manager'
/** Endpoint namespace. Wire path is `${CHANNEL}/${endpoint}` and the request
 *  envelope's `method` is `${RPC_NAMESPACE}/${endpoint}` — the browser half's
 *  `rpc.call(CHANNEL, `${NS}/${endpoint}`)` produces exactly that pair. */
export const RPC_NAMESPACE = 'session-manager'
export const CHANNEL = `/api/${RPC_NAMESPACE}`
export const SETTINGS_NS = 'dsh-session-manager'

/** Every endpoint this plugin serves under {@link CHANNEL}, one exact fetch
 *  route each. The list is the single source for both the host registration
 *  loop and the client's method/path agreement. */
export const RPC_ENDPOINTS = Object.freeze([
  'ping',
  'list',
  'restore',
  'delete',
  'deferred/list',
  'deferred/cancel',
])

/** Plugin version, read from the package manifest shipped beside this file
 *  (both live in every installed copy — package.json is in the `files`
 *  whitelist). The literal is only a fallback for unreadable/corrupt manifests
 *  and should roughly track it; single source is the manifest. */
const VERSION_FALLBACK = '0.4.8'
let cachedVersion
export function pluginVersion() {
  if (cachedVersion !== undefined) return cachedVersion
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    cachedVersion = typeof manifest.version === 'string' && manifest.version.length > 0 ? manifest.version : VERSION_FALLBACK
  } catch {
    cachedVersion = VERSION_FALLBACK
  }
  return cachedVersion
}

/** The one place every externally supplied session id must pass before the
 *  manager touches a seam or the filesystem — the RPC channel gate does NOT
 *  cover the agent-tool path, and the raw sessions-root scan is a destructive
 *  `join` sink (a `../..` id escapes it; proven by regression test). */
function assertSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new SessionManagerError('bad-request', 'a valid sessionId is required', { sessionId: String(sessionId) })
  }
}

/** Error whose `code` is stable for callers (RPC envelope, commands, tools). */
export class SessionManagerError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'SessionManagerError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export const Config = Schema.object({
  // Cap on how many archived sessions a single list call returns.
  sessionListLimit: Schema.number().step(1).min(1).default(500),
  // Open-but-idle sessions always delete immediately (tombstoned). This switch
  // only governs a session with a RUNNING task: refused by default, force
  // deleted when true — and a forced delete is tombstoned and queued exactly
  // like any other open-session delete. Dangerous.
  allowDeleteRunning: Schema.boolean().default(false),
  // Agent tool `session_delete_permanently` requires `confirm: true`.
  toolDeleteRequiresConfirm: Schema.boolean().default(true),
  // Mount the red "permanently delete" item into the browser session menu.
  menuDeleteAvailable: Schema.boolean().default(true),
  // Repair pass for the ONE shape a permanent delete cannot make disappear on
  // its own: an OPEN session's in-memory copy keeps being listed by the host
  // (dsh exposes no public "close session" API), so a sidebar that SHOWS
  // archived rows (视图选项 → 全部对话（显示已归档）/仅显示已归档) still renders
  // its archive tombstone in the ungrouped bucket. When true, `deferred/list` —
  // the queue read every client already makes — re-announces
  // `api-session/removed` for each queued id that is still live, which drops it
  // from every connected client's list store again.
  //
  // ON by default since 0.4.1 (field report: the residue showed up for a user
  // whose sidebar displays archived rows). The cost is bounded and documented:
  // the event contradicts the host's own still-live listing, so a client that
  // pulls the list may render the row for a frame before the next announcement;
  // the client repairs at most once per residue episode (never a poll loop). Set
  // false for the tombstone-only behavior, where a page reload re-shows the row
  // to anyone displaying archived sessions.
  reannouncePendingRemovals: Schema.boolean().default(true),
})

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const ok = (value) => ({ ok: true, value })
// `details` is part of the wire contract, not an optional extra: the browser
// half's response parser rejects a failure envelope whose `details` is not an
// object (`invalid server-response failure`), so a domain error without one
// would surface as a transport-shaped TypeError instead of the real code.
const fail = (code, message, details) => ({
  ok: false,
  error: { code, message, details: details ?? {} },
})

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function errorEnvelope(error) {
  if (error instanceof SessionManagerError) return fail(error.code, error.message, error.details)
  return fail('session-manager/internal', errorMessage(error))
}

// ---------------------------------------------------------------------------
// The manager
// ---------------------------------------------------------------------------

export function createSessionManager(ctx, config = {}) {
  /** Current effective config: composition config + settings-document overrides. */
  const effectiveConfig = () => {
    let overrides = {}
    try {
      const settings = ctx.get('settings')
      const value = settings?.get?.(SETTINGS_NS)
      if (value && typeof value === 'object' && !Array.isArray(value)) overrides = value
    } catch {
      // Settings absence or a read failure keeps composition config authoritative.
    }
    return { ...config, ...overrides }
  }

  const tryGet = (service) => {
    try {
      return ctx.get(service)
    } catch {
      return undefined
    }
  }

  const registry = () => {
    const r = tryGet('workspaceRegistry')
    if (r === undefined) throw new SessionManagerError('registry/unavailable', 'the workspace registry service is not mounted in this deployment')
    return r
  }

  // Registry read/write rules live in `lib/registry-writes.js` (host-free, so
  // they are unit-tested directly rather than only through a mounted host). The
  // error class is injected because it is this module's export surface.
  const { registryState, unarchiveThrough, archiveThrough, assertRegistryWritable } = createRegistryWrites({ SessionManagerError })

  /** dsh home directory, derived from the persistence root (`.../.dsh/sessions`).
   *  `DSH_HOME` wins over the seam (that is the official override, e2e depends
   *  on it), but the pending queue and the projcache sweep follow this home
   *  while artifacts resolve through the persistence seam — when the two
   *  diverge, that cleanup silently lands in the wrong directory, so warn once
   *  (lazily, at first filesystem use, when persistence is certainly mounted). */
  let homeDivergenceWarned = false
  const dshHome = () => {
    const persistence = tryGet('sessionPersistence')
    const root = persistence?.root
    const envHome = process.env.DSH_HOME
    if (envHome) {
      if (!homeDivergenceWarned && typeof root === 'string' && root.length > 0) {
        homeDivergenceWarned = true
        const derived = dirname(root)
        if (derived !== envHome) {
          try {
            ctx.logger?.warn?.(`session-manager: DSH_HOME (${envHome}) differs from the session persistence root's home (${derived}); the pending-delete queue and projcache cleanup follow DSH_HOME while artifacts resolve through the persistence seam`)
          } catch { /* noop */ }
        }
      }
      return envHome
    }
    if (typeof root === 'string' && root.length > 0) return dirname(root)
    return join(homedir(), '.dsh')
  }

  // -------- deferred (open-session) deletion ---------------------------------
  // dsh has no public "close session" API: a session opened in the UI stays
  // live in the process until the owning scope dies. Deleting one still
  // removes its registry accounting and files right away — later appends open
  // the log by path and never recreate a deleted directory — but the
  // in-memory summary outlives the files and would resurface as an ungrouped
  // sidebar entry. So the id stays in the archive set as a TOMBSTONE (every
  // official view hides archived ids) and goes into a persistent
  // pending-delete queue; the next-boot sweep clears the tombstone once the
  // session is cold.

  const pendingFile = () => join(dshHome(), 'storages', 'session-manager.pending.json')

  // ONE in-process mutex serializes every durable mutation — both the
  // read-modify-write queue file and the archive-set registryState→setState
  // windows. Unserialized, the sweep's full-list queue write-back can clobber
  // a marker queued mid-sweep (stranding its tombstone forever), and two
  // concurrent deletes/restores/cancels read the same archive-set snapshot and
  // last-write-wins drops the other's change (ghost archived rows or a lost
  // tombstone — both resurrection shapes). Single lock, single order: nothing
  // nested takes it twice; regions already holding it must use the _ internals.
  let mutationQueue = Promise.resolve()
  function withOperationLock(fn) {
    const run = mutationQueue.then(fn, fn)
    mutationQueue = run.then(() => {}, () => {})
    return run
  }

  let pendingSanitized = false

  /** Why an unreadable queue must never be reported as an empty one: EVERY
   *  writer persists the snapshot it just read, so a transient read failure
   *  (Windows EBUSY, a torn in-place fallback write, a hand edit) returned as
   *  `[]` publishes that empty view on the next write-back and drops every live
   *  marker in the file. Their tombstones then stay in the archive set with no
   *  queue entry left to sweep them, while their files are already gone — so
   *  `listArchived` un-hides them as rows that `restoreSession` can never
   *  restore (`sessionKnown` is false): permanently stuck ghost rows, exactly
   *  the "the deleted session came back" shape this queue exists to prevent.
   *  Logged where it is created, so no caller can swallow it silently (the ping
   *  sweep is fire-and-forget). */
  const pendingQueueUnreadable = (snapshot) => {
    const message = `the pending-delete queue could not be read (${snapshot.reason}); refusing to rewrite it from an empty view`
    try { ctx.logger?.warn?.(`session-manager: ${message}`) } catch { /* noop */ }
    return new SessionManagerError('session-manager/internal', message, { reason: snapshot.reason })
  }

  /**
   * The pending-delete queue as a snapshot.
   *
   * ENOENT is the normal empty queue; ANY other failure is `degraded` (see
   * {@link pendingQueueUnreadable}). Only an unreadable file or unparseable
   * JSON qualifies: a parseable file cannot lose ids to a write-back, because
   * whatever it holds is representable and gets returned.
   * @returns `{ ids, degraded, reason }`
   */
  async function readPendingSnapshot() {
    let text
    try {
      text = await readFile(pendingFile(), 'utf8')
    } catch (error) {
      // A missing file IS an empty queue (first run / nothing ever deleted).
      if (error?.code === 'ENOENT') return { ids: [], entries: [], degraded: false, reason: undefined }
      return { ids: [], entries: [], degraded: true, reason: `read failed: ${errorMessage(error)}` }
    }
    // Format, versioning and id sanitization live in `lib/pending-queue.js`
    // (pure, unit-tested): a malformed id must never reach
    // resolveSessionDirs/disposePath, or the raw sessions-root scan turns into a
    // path-traversal delete — and a torn file must come back `degraded` rather
    // than as an empty queue.
    const decoded = decodePendingQueue(text)
    if (decoded.degraded) return { ids: [], entries: [], degraded: true, reason: decoded.reason }
    if (decoded.malformed > 0 && !pendingSanitized) {
      pendingSanitized = true
      try { ctx.logger?.warn?.(`session-manager: dropped ${decoded.malformed} malformed id(s) from the pending-delete queue`) } catch { /* noop */ }
    }
    return { ids: decoded.entries.map((entry) => entry.id), entries: decoded.entries, degraded: false, reason: undefined }
  }

  /** Tolerant id view for readers that only need to peek: a degraded read is
   *  `[]` here. Callers that must not act on a guess use the snapshot, or
   *  refuse outright — every writer does. */
  async function readPending() {
    return (await readPendingSnapshot()).ids
  }

  /**
   * Persist the queue.
   *
   * Accepts bare ids (callers that have nothing to record) or `{ id, workspaces }`
   * entries, and always writes the v2 shape; a v1 file is still accepted on
   * read (see `readPendingSnapshot`). `workspaces` is the accounting a CANCELLED
   * deletion has to restore — `deleteLocked` detaches the id from every
   * workspace that owns it, so without this the cancel would return the session
   * as an ungrouped row.
   */
  async function writePending(entries) {
    // The FORMAT lives in `lib/pending-queue.js` (pure, unit-tested): it accepts
    // bare ids or `{ id, workspaces }`, always writes the v2 shape, and
    // re-validates every id on the way out — this is the other end of the same
    // input channel the read side guards.
    const body = encodePendingQueue(entries)
    const target = pendingFile()
    await mkdir(dirname(target), { recursive: true })
    const tmp = `${target}.${process.pid}.tmp`
    await writeFile(tmp, body, 'utf8')
    try {
      await rename(tmp, target)
    } catch {
      // Cross-device rename fallback for exotic storage layouts. NOTE: this write
      // is NOT atomic — which is exactly why a torn read must be `degraded` rather
      // than an empty queue.
      await writeFile(target, body, 'utf8')
      await rm(tmp, { force: true })
    }
    return JSON.parse(body).sessionIds
  }

  // Unlocked internals — ONLY callable from code already holding the
  // operation lock (delete/sweep/cancel bodies). Lock re-entry would deadlock.
  // Both refuse a degraded read: a write-back built from a read that failed is
  // what silently drops live markers (see `pendingQueueUnreadable`).
  const _addPending = async (sessionId, workspaces = []) => {
    const snapshot = await readPendingSnapshot()
    if (snapshot.degraded) throw pendingQueueUnreadable(snapshot)
    const others = snapshot.entries.filter((entry) => entry.id !== sessionId)
    // Re-adding an id REPLACES its entry (and therefore its workspace list)
    // rather than merging: the caller just detached from the workspaces it
    // computed, so its list is the current truth.
    const ids = await writePending([...others, { id: sessionId, workspaces }])
    return ids
  }

  const _removePending = async (sessionId) => {
    const snapshot = await readPendingSnapshot()
    if (snapshot.degraded) throw pendingQueueUnreadable(snapshot)
    const ids = await writePending(snapshot.entries.filter((entry) => entry.id !== sessionId))
    return ids
  }

  // Public, lock-taking queue entry points for callers outside the wrapped
  // operations (tests first). (Pure readPending is lock-free: a torn read
  // cannot happen thanks to the atomic rename, and callers only ever want a
  // snapshot.)
  const addPending = (sessionId) => withOperationLock(() => _addPending(sessionId))
  const removePending = (sessionId) => withOperationLock(() => _removePending(sessionId))

  /**
   * Cancel one queued deletion: read the queue, DROP THE MARKER, then clear any
   * tombstone — a registry failure rewrites the marker (rolling the cancel
   * back), while an unreadable queue fails before anything is touched. Both
   * halves are durable writes and the pair is not atomic, so the order is
   * chosen by which state a crash may strand: see the COMMIT POINT note in the
   * body for why marker-first is the only order that cannot lose data.
   *
   * Refused when the id is NOT queued (`session/not-pending`): cancelling is the
   * one operation that puts a session BACK — it clears a tombstone — and an id
   * that was merely archived must not be restored by it. Without that guard a
   * cancel of a non-queued id un-archived the session and reported success, i.e.
   * an unarchive nobody asked for, reachable from a stale client, a second
   * window, or a hand-made request. `restoreSession`'s `session/pending` refusal
   * is this guard's mirror image.
   * Refused when the queued id's files are already gone (normal open-session
   * deletes): un-tombstoning one would expose the artifact-less lingering
   * summary as an ungrouped row. The UI only offers cancel for `recoverable`
   * entries; this enforces that for RPC/tool callers.
   */
  async function cancelPending(sessionId) {
    assertSessionId(sessionId)
    return withOperationLock(async () => {
      // Read the queue BEFORE mutating anything: an unreadable queue fails
      // before the tombstone is touched, and the entries are needed both for
      // the marker drop below and for the rollback that follows a registry
      // failure.
      const snapshot = await readPendingSnapshot()
      if (snapshot.degraded) throw pendingQueueUnreadable(snapshot)
      // "Is it queued?" comes before "are its files still there?": for an id
      // nobody queued, `data-gone` would be a misleading answer — the request
      // itself is wrong, not the state of its files.
      const entry = snapshot.entries.find((candidate) => candidate.id === sessionId)
      if (entry === undefined) {
        throw new SessionManagerError('session/not-pending', `session "${sessionId}" has no pending deletion to cancel`, { sessionId })
      }
      if (!(await hasArtifact(sessionId))) {
        throw new SessionManagerError('session/data-gone', `the queued deletion of "${sessionId}" already disposed its files; nothing left to cancel`, { sessionId })
      }
      const reg = registry()
      assertRegistryWritable(reg)
      // Put back the workspace accounting the delete removed, BEFORE anything is
      // committed. This is the difference between "cancel" handing the session
      // back to its old workspace slot and handing it back as an UNGROUPED row —
      // the exact residue shape the tombstone exists to prevent. It also mirrors
      // the delete's own invariant: re-attach while the session is still
      // archived (hidden), so it never flashes as an ungrouped row in between.
      //
      // Best-effort on purpose: refusing the cancel because a POSITION could not
      // be restored would be a worse outcome than restoring the session without
      // its slot, so every failure is collected as a warning for the caller to
      // surface. The entry stays fully queued until the writes below commit, so
      // a retry is always possible.
      const reattached = []
      const warnings = []
      for (const workspaceId of entry.workspaces) {
        const workspace = reg.list().find((candidate) => String(candidate.id) === workspaceId)
        if (workspace === undefined) {
          warnings.push(`workspace "${workspaceId}" no longer exists; the session was restored but not re-grouped`)
          continue
        }
        if (typeof workspace.attachSession !== 'function') {
          warnings.push('this dsh build exposes no Workspace.attachSession; the session was restored but not re-grouped')
          continue
        }
        try {
          await workspace.attachSession(sessionId)
          reattached.push(workspaceId)
        } catch (error) {
          warnings.push(`could not restore the session to workspace "${workspaceId}": ${errorMessage(error)}`)
        }
      }
      // ── COMMIT POINT ────────────────────────────────────────────────────
      // The marker drop and the tombstone clear are two separate durable
      // writes, so the PAIR is not atomic. Whichever order they run in, a
      // crash (or a failed write) between them leaves one of two states, and
      // only one of them is safe for a user who just clicked Cancel:
      //   · marker dropped, tombstone still set → the session stays hidden and
      //     nothing finishes a deletion without a queued marker; a retry or a
      //     restore resolves it. Harmless.
      //   · tombstone cleared, marker still set → the boot sweep reads that
      //     marker and deletes the very session the user cancelled. Data loss
      //     (proven by probe: the cancel reports an error, the session
      //     reappears in the list, and the next start deletes its files).
      // So: drop the marker FIRST, then clear the tombstone, and ROLL THE
      // MARKER BACK when the registry write fails. The rollback restores the
      // exact pre-cancel state (queued + tombstoned), which keeps the cancel
      // retryable — the property the previous ordering was defending for the
      // REGISTRY-failure case while leaving the QUEUE-write-failure case with
      // the one state that loses data.
      //
      // Unlocked internals throughout: we already hold the operation lock.
      const markerRollback = entry.workspaces
      // `_removePending` answers with the surviving ids (not a wrapper).
      const remainingIds = await _removePending(sessionId)
      try {
        await unarchiveThrough(reg, sessionId)
      } catch (error) {
        // The registry refused the un-archive AFTER the marker was dropped.
        // Put the marker back so the next boot cannot finish this deletion.
        let rolledBack = false
        try {
          await _addPending(sessionId, markerRollback)
          rolledBack = true
        } catch { /* reported in `details` below */ }
        throw new SessionManagerError(
          'session-manager/internal',
          `the session "${sessionId}" was NOT restored: un-archiving it failed (${errorMessage(error)}).`
            + (rolledBack
              ? ' it stays queued for deletion, so you can retry the cancel'
              : ' the pending marker could not be rewritten, so the next dsh start may still complete this deletion'),
          { sessionId, rolledBack },
        )
      }
      return { sessionIds: remainingIds, reattached, warnings }
    })
  }

  /** Directory + filename prefix covering one session's projection checkpoints
   *  (`<id>.json` and every `<id>.json.bak-*` sibling). */
  const projcacheSweep = (sessionId) => ({
    dir: join(dshHome(), 'storages', 'session_projcache', 'sessions'),
    prefix: `${sessionId}.json`,
  })

  // -------- summaries -------------------------------------------------------

  /** One-shot guard for the header-wrapper shape warning (see collectSummaries). */
  let summariesShapeWarned = false
  /** One-shot guard for the controller-row shape warning (see collectSummaries). */
  let controllerShapeWarned = false

  /**
   * Session summaries keyed by id. Primary path is the session controller
   * (`list()` covers live and cold sessions); fallback is the persistence
   * header listing (no titles, no updatedAt beyond createdAt).
   *
   * The envelope and the row projection live in `lib/session-summaries.js`
   * (pure, unit-tested) — the shape that silently emptied every summary in the
   * field is worth pinning without standing up a host.
   */
  const collectSummaries = async () => {
    const summaries = new Map()
    let controllerAnswered = false
    const controller = tryGet('sessionController')
    if (controller !== undefined && typeof controller.list === 'function') {
      try {
        // A fresh deployment's controller may answer undefined/null until its
        // own state initializes — treat that as "no summaries".
        const raw = await controller.list()
        const items = decodeControllerList(raw)
        if (items === null) {
          // An unrecognized shape must be LOUD: silently reporting an empty
          // corpus is exactly how the `{ header }` wrapper breakage hid.
          if (raw !== undefined && raw !== null && !controllerShapeWarned) {
            controllerShapeWarned = true
            try { ctx.logger?.warn?.('session-manager: sessionController.list() answered an unrecognized shape (expected an array or { items: [...] }); falling back to the persistence header listing') } catch { /* noop */ }
          }
        } else {
          controllerAnswered = true
          for (const item of items) {
            const summary = summaryFromControllerRow(item)
            if (summary !== null) summaries.set(summary.sessionId, summary)
          }
        }
      } catch {
        // Controller read failed: fall through to the persistence listing
        // rather than reporting an empty corpus.
      }
    }
    // The corpus listing is the expensive fallback — take it only when the
    // controller could not answer at all, so a successful read stays one call.
    if (controllerAnswered) return summaries
    const persistence = tryGet('sessionPersistence')
    if (persistence !== undefined && typeof persistence.list === 'function') {
      for (const snapshot of await persistence.list()) {
        // `list()` yields `{ header, revision, sizeBytes }` WRAPPERS, not bare
        // headers — verified against the shipped backend
        // (`dsh-session-persistence-jsonl` pushes `header: artifact.header`) and
        // against both official consumers (`dsh-workspace`, `dsh-session-query`,
        // which both do `.map((snapshot) => snapshot.header)`). Reading the
        // wrapper as if it were the header keyed every session `'undefined'` and
        // blanked every field. An entry without a header is skipped and reported
        // rather than guessed at — guessing is what hid that breakage.
        const header = snapshot?.header
        if (header === undefined || header === null) {
          if (!summariesShapeWarned) {
            summariesShapeWarned = true
            try { ctx.logger?.warn?.('session-manager: sessionPersistence.list() returned an entry without a header wrapper; the header-listing fallback may be incomplete') } catch { /* noop */ }
          }
          continue
        }
        const id = String(header.id)
        summaries.set(id, {
          sessionId: id,
          createdAt: Number.isFinite(header.createdAt) ? new Date(header.createdAt).getTime() : null,
          updatedAt: Number.isFinite(header.createdAt) ? new Date(header.createdAt).getTime() : null,
          running: false,
          blank: false,
          ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
          ...(header.parentSession === undefined ? {} : { parentSessionId: String(header.parentSession) }),
          ...(header.origin === undefined ? {} : { origin: header.origin }),
        })
      }
    }
    return summaries
  }

  // ── artifact resolution ─────────────────────────────────────────────────────
  // The three-seam fallback, the wrapper unwrapping, the shared corpus index and
  // the symlink handling live in `lib/artifact-paths.js`, with the seams
  // injected so they are unit-testable against fake backends. The returned
  // functions are destructured to the names this closure already used, so every
  // call site below is unchanged.
  const { index: artifactIndex, resolveSessionDirs, hasArtifact } = createArtifactResolver({
    getPersistence: () => tryGet('sessionPersistence'),
    fallbackSessionsRoot: () => join(dshHome(), 'sessions'),
  })

  // -------- list / restore / delete ----------------------------------------

  /**
   * Complete archived-session projection: archive order + session summary +
   * owning workspace.
   */
  async function listArchived() {
    const reg = registry()
    // Ids queued for deletion are already tombstoned in the archive set until
    // their next-boot finish-up; they are gone for the user, so keep them out
    // of every listing here too. A fresh home may hand back an uninitialized
    // state whose archive set is not an array yet — treat it as empty. An
    // unreadable queue is refused rather than guessed at: this listing decides
    // whether the tombstones are exposed, and a failed read reported as "no
    // pending ids" would render them as ordinary archived rows.
    const snapshot = await readPendingSnapshot()
    if (snapshot.degraded) throw pendingQueueUnreadable(snapshot)
    const pending = new Set(snapshot.ids)
    const ids = (Array.isArray(reg.archivedSessionIds) ? reg.archivedSessionIds : [])
      .map(String)
      .filter((id) => !pending.has(id))
    // Settings-document overrides bypass the Config schema, so clamp at the
    // consumption point — a NaN or negative limit must not silently empty
    // the list.
    let limit = Number(effectiveConfig().sessionListLimit)
    if (!Number.isFinite(limit) || limit < 1) limit = 500
    limit = Math.floor(limit)
    const capped = ids.slice(0, limit)
    const summaries = await collectSummaries()
    const workspaces = reg.list()
    // Owner resolution only matters for the capped ids; keying the whole
    // membership of every workspace would scale with total sessions instead.
    const wanted = new Set(capped)
    const workspaceBySession = new Map()
    for (const workspace of workspaces) {
      for (const id of workspace.sessionIds) {
        const key = String(id)
        if (wanted.has(key) && !workspaceBySession.has(key)) {
          workspaceBySession.set(key, {
            workspaceId: String(workspace.id),
            title: workspace.title,
            path: workspace.path,
          })
        }
      }
    }
    const entries = []
    for (const id of capped) {
      const summary = summaries.get(id)
      const workspace = workspaceBySession.get(id)
      // `running` means "a model step is executing", and only the controller can
      // answer that (`item.running` is its agent's status). Liveness is a
      // DIFFERENT fact — a session that is merely open is idle — and OR-ing
      // `live.get(id) !== undefined` into this made every open session report
      // `running: true`, so the settings page drew a 运行中 badge and the agent
      // tool reported running work that did not exist. A summary that came from
      // the persistence fallback carries no running information at all, and then
      // this honestly reports false.
      const running = summary?.running === true
      entries.push({
        sessionId: id,
        title: summary?.title ?? '',
        cwd: summary?.cwd,
        createdAt: summary?.createdAt ?? null,
        updatedAt: summary?.updatedAt ?? null,
        running,
        blank: summary?.blank === true,
        origin: summary?.origin,
        parentSessionId: summary?.parentSessionId,
        workspace,
      })
    }
    return {
      archivedSessionIds: ids,
      truncated: ids.length > capped.length,
      items: entries,
    }
  }

  /**
   * Unarchive one session. The archive set is the only thing that changes —
   * the workspace keeps its `sessionIds` slot, so the session returns to its
   * previous position in the workspace browser.
   */
  // Public entry points are async on purpose: the input guard's rejection is
  // a rejected promise (never a synchronous throw), so every caller layer
  // (RPC envelope, tool try/catch, tests) sees one uniform failure channel.
  async function restoreSession(sessionId) {
    assertSessionId(sessionId)
    return withOperationLock(() => restoreLocked(sessionId))
  }

  async function restoreLocked(sessionId) {
    // A queued id carries a deletion in flight (or awaiting its finish-up):
    // un-tombstoning it would expose an artifact-less husk — the listings
    // deliberately hide it, so only the agent tools can reach this path. An
    // unreadable queue cannot prove the id is NOT queued, so it refuses too
    // (tolerantly reading "no pending ids" here is how a queued id gets
    // un-tombstoned and then deleted by the next boot sweep).
    const snapshot = await readPendingSnapshot()
    if (snapshot.degraded) throw pendingQueueUnreadable(snapshot)
    if (snapshot.ids.includes(sessionId)) {
      throw new SessionManagerError('session/pending', `session "${sessionId}" is queued for permanent deletion; cancel the pending deletion first`, { sessionId })
    }
    const reg = registry()
    assertRegistryWritable(reg)
    if (!reg.archivedSessionIds.some((id) => String(id) === sessionId)) {
      throw new SessionManagerError('session/not-archived', `session "${sessionId}" is not archived`, { sessionId })
    }
    if (!(await reg.sessionKnown(sessionId))) {
      throw new SessionManagerError('session/not-found', `session "${sessionId}" no longer exists in session persistence`, { sessionId })
    }
    const state = registryState(reg)
    const archivedSessionIds = state.archivedSessionIds.filter((id) => String(id) !== sessionId)
    if (archivedSessionIds.length === state.archivedSessionIds.length) {
      throw new SessionManagerError('session/not-archived', `session "${sessionId}" is not archived`, { sessionId })
    }
    await unarchiveThrough(reg, sessionId)
    // Re-read: the official entry point writes the set it read itself, so the
    // caller's view comes from the registry rather than from our pre-write copy.
    return { sessionId, restored: true, archivedSessionIds: registryState(reg).archivedSessionIds.map(String) }
  }

  /**
   * Broadcast the official session removal so every connected client drops the
   * id from its list store. The host itself only emits this when a LIVE session
   * is disposed, which a cold delete never is, and which an open-session delete
   * cannot trigger either (no public close API) — without the broadcast the
   * deleted session would linger in every open UI. Cosmetic by nature: a missed
   * broadcast only costs a delayed list refresh, so it never fails an operation.
   * @param sessionId - the removed session identity.
   */
  function announceRemoval(sessionId) {
    try {
      if (typeof ctx.emit === 'function') ctx.emit('api-session/removed', sessionId)
    } catch {
      // Cosmetic: a missed broadcast only costs a delayed list refresh.
    }
  }

  /**
   * Read one live session entry through a seam that may fail.
   *
   * Three outcomes, and callers MUST tell them apart — conflating the last two
   * is a real defect, not a style choice:
   *   · `entry`     — the session is live (open in this process).
   *   · `undefined` — the seam answered, and the session is NOT live.
   *   · `unavailable: true` — the seam itself failed, so liveness is UNKNOWN.
   *
   * A user-initiated `deleteSession` may treat "unknown" as "cold": the caller
   * explicitly asked for that session to be deleted, and files are addressed by
   * id, so refusing would break a confirmed delete over a diagnostic read.
   *
   * The autonomous BOOT SWEEP may not. There, "unknown" must stay QUEUED for a
   * colder boot: a liveness seam that is down is exactly when a session may
   * still be open (its in-memory summary would outlive the delete and resurface
   * as an ungrouped row), and the sweep is the one path that runs with no human
   * watching. This is the project's existing rule — the test named "a failed
   * liveness check leaves the entry queued" is its contract.
   */
  const readLiveEntry = (sessionId) => {
    const live = tryGet('sessions')
    try {
      return { entry: live?.get(sessionId), unavailable: false }
    } catch {
      return { entry: undefined, unavailable: true }
    }
  }

  /**
   * Permanently delete one session — always a direct physical delete, there
   * is no backup layer.
   *
   * A session opened in this process cannot be closed through any public API
   * (its in-memory summary outlives everything), but its data can go right
   * now: appends open the log by path and never recreate a deleted directory,
   * so a post-delete flush cannot resurrect anything. Policy:
   *   - agent running → refuse (`session/running`)
   *   - open but idle → delete immediately; the id stays in the archive set
   *     as a tombstone (hiding the lingering summary from every official
   *     view) and enters the pending queue for the next-boot finish-up;
   *     reports `openAtDelete: true`
   *   - cold          → same marker + tombstone, but the delete FINISHES in this
   *     call (files are disposed, then the tombstone and marker are cleared):
   *     a cold session has no in-memory copy that could outlive it. A file-phase
   *     failure keeps it queued and hidden for the next boot to retry, so a
   *     failed cold delete can no longer resurface as an ungrouped row
   *   - `allowDeleteRunning` → skip the RUNNING refusal (the delete is still
   *     tombstoned and queued, like any other open-session delete)
   *
   * Order: input guard (path-traversal choke point shared with every other
   * entry), existence check (read-only), pending-queue marker (crash safety),
   * workspace detach, tombstone, files, and — for a cold delete — the inline
   * finish. The whole sequence holds the operation lock so two concurrent
   * deletes cannot lose an archive-set update. A file failure after
   * bookkeeping does not resurrect the session: it is reported as a warning and
   * the entry stays queued for the boot sweep.
   */
  async function deleteSession(sessionId) {
    assertSessionId(sessionId)
    return withOperationLock(() => deleteLocked(sessionId))
  }

  async function deleteLocked(sessionId) {
    const cfg = effectiveConfig()
    const reg = registry()
    assertRegistryWritable(reg)

    // Liveness alone decides the treatment below (tombstone, pending marker,
    // `openAtDelete`); the switch only decides whether a RUNNING session is
    // refused. Folding the switch into `isOpen` used to strip the tombstone from
    // open-idle sessions too, which is how a deleted session could resurrect as
    // an ungrouped row.
    const isOpen = readLiveEntry(sessionId).entry !== undefined
    if (isOpen && cfg.allowDeleteRunning !== true) {
      const agents = tryGet('agents')
      if (agents?.get?.(sessionId)?.status === 'running') {
        throw new SessionManagerError('session/running', `session "${sessionId}" has a running task; wait for it to finish before deleting`, { sessionId })
      }
    }
    if (!(await reg.sessionKnown(sessionId))) {
      throw new SessionManagerError('session/not-found', `session "${sessionId}" does not exist`, { sessionId })
    }
    // Which workspaces account for this session — ONE predicate, one read,
    // evaluated before any mutation, and used by both the marker below and the
    // detach loop. The list is recorded IN the marker so a cancelled deletion
    // can re-attach through it; without that record the session would come back
    // as an ungrouped row.
    const allWorkspaces = reg.list()
    const accountsForSession = (workspace) => workspace.sessionIds.some((id) => String(id) === sessionId)
      || (Array.isArray(workspace.record?.sessionIds) && workspace.record.sessionIds.some((id) => String(id) === sessionId))
    const accountedWorkspaces = allWorkspaces.filter(accountsForSession)

    const warnings = []

    // Queue the finish-up before touching anything — for a COLD session too.
    //
    // The marker is what makes the file phase crash-safe: written before any
    // mutation, it guarantees a crash after this point leaves the next boot a
    // queued id to sweep. It used to be written for OPEN sessions only, which
    // left the ordinary cold delete with a real window: a crash between the
    // archive-set write and the `rm` left the session un-archived, detached and
    // unqueued, its files still on disk and nothing left to finish the job — so
    // the next start listed it again as an ungrouped row while this plugin could
    // no longer list, restore or retry it. The corpus read inside the file phase
    // makes that window wide, not instantaneous.
    //
    // The ONE deliberate exception is an unreadable queue, and it is cold-only:
    // refusing there would remove the documented escape hatch (the
    // "unreadable queue is refused" rule is scoped to queue-DEPENDENT work, and
    // a cold delete never used to read the queue). That path warns about exactly
    // what it gives up.
    // (Unlocked variant: we already hold the operation lock.)
    let markerDurable = false
    try {
      await _addPending(sessionId, accountedWorkspaces.map((workspace) => String(workspace.id)))
      markerDurable = true
    } catch (error) {
      if (isOpen) throw error
      warnings.push(`the pending-delete queue could not be read, so this deletion is NOT crash-safe (${errorMessage(error)}); a crash before the files are removed would leave the session listed again`)
    }

    let header
    try {
      header = await reg.readSessionHeader(sessionId)
    } catch {
      header = undefined
    }

    // Warnings are collected from here on, not from the file phase: registry
    // bookkeeping below is best-effort for the DETACH half (see the loop).
    // 1) Registry bookkeeping — durable and published to every follower.
    //    Detach from the workspace FIRST: the session is still archived (hidden)
    //    while we detach, so it never flashes back into the workspace browser
    //    between the unarchive and detach frames. The real Workspace.sessionIds
    //    getter filters members through the registry's canonical-cwd header
    //    index, so a stale index hides the id from the getter; the raw record
    //    is checked as a fallback, or the detach would be skipped and the
    //    session would stay accounted (and resurface as ungrouped) forever.
    for (const workspace of accountedWorkspaces) {
      try {
        await workspace.detachSession(sessionId)
      } catch (error) {
        // A failing detach must not abort a delete the user already confirmed:
        // throwing here (the old behavior) left the session half-bookkept —
        // already detached from some workspaces, still archived, files intact —
        // which is the "ungrouped resurrection" shape this plugin exists to
        // prevent. A registry that is unusable in a deeper way still fails the
        // delete where it must, at the archive-set write below.
        warnings.push(`the session could not be detached from workspace "${String(workspace.id)}": ${errorMessage(error)}`)
      }
    }
    // 2) The tombstone: keep the id archived so its files can go while the
    //    session stays hidden from every official view. Written ONLY together
    //    with a durable marker — a tombstone with no marker left to clear it is
    //    the one strand nothing can recover from (a hidden row whose files are
    //    still on disk, with no queue entry to finish the job), so the two go in
    //    as a pair or not at all. `archiveThrough` is a no-op when the id is
    //    already archived.
    if (markerDurable) {
      try {
        await archiveThrough(reg, sessionId)
      } catch (error) {
        // The marker is already durable, so the next start WILL finish this
        // deletion. Reporting only "it failed" showed the user a session that
        // looks alive while it is queued for removal, so the failure carries
        // both facts for the caller to surface.
        throw new SessionManagerError(
          'session-manager/internal',
          `the deletion of "${sessionId}" is queued and will be completed on the next dsh start, but the archive-set update failed (${errorMessage(error)})`,
          { sessionId, queued: true },
        )
      }
    } else if (registryState(reg).archivedSessionIds.some((id) => String(id) === sessionId)) {
      // The marker-less fallback keeps the pre-0.4.8 behavior — the id leaves
      // the archive set before its files do — because with no marker to clear it,
      // hiding the row could strand it forever. The warning above says so.
      await unarchiveThrough(reg, sessionId)
    }

    // 3) Files: the session artifact directory and the projection checkpoint.
    const corpus = await artifactIndex()
    const sessionDirs = await resolveSessionDirs(sessionId, header, corpus)
    if (sessionDirs.length === 0) {
      warnings.push('session artifact directory could not be located under the sessions root; only registry bookkeeping and metadata cleanup ran')
    }
    for (const sessionDir of sessionDirs) {
      const outcome = await disposePath(sessionDir)
      if (outcome.error !== undefined) warnings.push(`the session artifact directory could not be removed: ${sessionDir} (${outcome.error})`)
      else if (!outcome.removed) warnings.push(`session artifact directory was not found: ${sessionDir}`)
    }

    const projcache = projcacheSweep(sessionId)
    warnings.push(...await disposePrefix(projcache.dir, projcache.prefix))

    // 4) A COLD delete finishes here, in the same operation: nothing of this
    //    session can outlive it (no in-memory copy, unlike the open case), so
    //    the tombstone and the marker are cleared as soon as the files are
    //    verifiably gone — leaving them behind would keep the row hidden from
    //    every listing while the deletion was already complete.
    //
    //    A file-phase failure does NOT finish: the entry stays queued and
    //    tombstoned so the next start's sweep retries it (the shape
    //    `finishDeferredDeletion` exists for), instead of reporting a delete
    //    whose residue the sidebar would render as a live session again. The
    //    warning below is what tells the user which of the two happened.
    if (markerDurable && !isOpen) {
      if (warnings.length === 0) {
        try {
          await unarchiveThrough(reg, sessionId)
          await _removePending(sessionId)
        } catch (error) {
          warnings.push(`the session's files are gone but the bookkeeping could not be finalised (${errorMessage(error)}); it stays queued and the next dsh start will finish it`)
        }
      } else {
        warnings.push('the deletion stays queued: the next dsh start will finish removing what is left')
      }
    }

    // Broadcast the official removal so every connected client drops the
    // session from its list store at once (see `announceRemoval`).
    announceRemoval(sessionId)

    return {
      sessionId,
      deleted: true,
      ...(isOpen ? { openAtDelete: true } : {}),
      warnings: warnings.length > 0 ? warnings : undefined,
    }
  }

  /**
   * Finish one queued deletion (open-session tombstone or an older queued
   * id): dispose whatever files are left and clear the archive-set tombstone
   * unconditionally — the session may already be unlistable (files gone)
   * while still archived. Skips sessions that are live again, keeping them
   * queued for a colder boot.
   */
  async function finishDeferredDeletion(sessionId, index) {
    const liveness = readLiveEntry(sessionId)
    // An UNREADABLE liveness seam keeps the entry queued (see `readLiveEntry`):
    // this is the autonomous path, and a session may still be open precisely
    // when that seam is failing.
    if (liveness.unavailable || liveness.entry !== undefined) return false
    const reg = registry()
    assertRegistryWritable(reg)
    // A failed disposal is a warning here too, and it must be LOGGED: the sweep
    // clears the tombstone and drops the marker unconditionally afterwards, so
    // a silent failure would leave the caller believing the cleanup finished
    // when the files are still on disk and nothing is queued to retry it.
    const warnings = []
    let removedSomething = false
    for (const sessionDir of await resolveSessionDirs(sessionId, undefined, index)) {
      const outcome = await disposePath(sessionDir)
      removedSomething = removedSomething || outcome.removed
      if (outcome.error !== undefined) warnings.push(`the session artifact directory could not be removed: ${sessionDir} (${outcome.error})`)
    }
    const projcache = projcacheSweep(sessionId)
    warnings.push(...await disposePrefix(projcache.dir, projcache.prefix))
    for (const workspace of reg.list()) {
      const accounted = workspace.sessionIds.some((id) => String(id) === sessionId)
        || (Array.isArray(workspace.record?.sessionIds) && workspace.record.sessionIds.some((id) => String(id) === sessionId))
      if (!accounted) continue
      try {
        await workspace.detachSession(sessionId)
      } catch (error) {
        // Best-effort like the file phase: the sweep is the last chance to
        // finish this deletion, and a throwing detach used to abort it before
        // the marker was dropped — leaving the entry queued forever (each boot
        // retrying the same doomed detach) while its files were already gone.
        warnings.push(`the session could not be detached from workspace "${String(workspace.id)}": ${errorMessage(error)}`)
      }
    }
    // ── Commit order here is the OPPOSITE of `cancelPending`'s, on purpose ──
    // Both halves are durable and the pair is not atomic, so each site picks
    // the state a crash may strand:
    //   · here BOTH writes are attempts to finish the same deletion, so
    //     "tombstone cleared, marker still set" is harmless — it is just an
    //     unfinished delete that the next boot completes (the intended
    //     outcome). "Marker dropped, tombstone still set" is worse: the
    //     session is deleted *and* still hidden, with nothing left to clear
    //     the tombstone, so it keeps consuming a row that can never be
    //     restored. And the marker is what reports "work left to do", so it
    //     goes LAST.
    //   · in `cancelPending` the two writes pull in opposite directions (one
    //     deletes, one preserves), so a stranded marker there means a deletion
    //     the user cancelled still happens — which is why THAT site drops the
    //     marker first and rolls it back on failure.
    try {
      // Clears the tombstone (no-op when the id is not archived): the session
      // may be unlistable already (files gone) while still archived.
      await unarchiveThrough(reg, sessionId)
    } catch (error) {
      // Leave the entry QUEUED and let the next sweep retry it. The marker was
      // never dropped, so the retry is real; keeping it also preserves the
      // workspace record the entry carries.
      warnings.push(`the archive-set tombstone could not be cleared (${errorMessage(error)}); the deletion stays queued for the next sweep`)
      for (const warning of warnings) {
        try { ctx.logger?.warn?.(`session-manager: ${warning}`) } catch { /* noop */ }
      }
      return false
    }
    announceRemoval(sessionId)
    // Unlocked variant: only ever called from sweepPending while the operation
    // lock is held (the lock is not reentrant). It is the FINAL step because it
    // is the queue's own record that this entry is finished — and because the
    // caller (and the boot-sweep test) uses "the queue no longer holds the id"
    // as the signal that the whole finish-up landed.
    await _removePending(sessionId)
    for (const warning of warnings) {
      try { ctx.logger?.warn?.(`session-manager: ${warning}`) } catch { /* noop */ }
    }
    if (warnings.length === 0 && !removedSomething) {
      // The normal open-session delete lands here: its files went at delete
      // time, so the sweep has nothing left to dispose and only clears the
      // tombstone. Logged (not warned) so a sweep that "finished" nothing is
      // still traceable rather than indistinguishable from a real cleanup.
      try { ctx.logger?.info?.(`session-manager: queued deletion of "${sessionId}" had nothing left to dispose; tombstone and marker cleared`) } catch { /* noop */ }
    }
    return true
  }

  /**
   * Physically remove one exact path.
   *
   * **NEVER THROWS**, and that is the point. Every caller runs AFTER the
   * deletion committed its registry bookkeeping, so a rejection here (Windows
   * EPERM/EBUSY from an antivirus scanner, a search indexer, or a foreign
   * handle) used to abort the delete at the worst possible moment: the id was
   * already detached and un-archived, so `listArchived` could no longer see it
   * and the UI could neither list, retry nor cancel it — while its files were
   * still on disk. The documented contract is "a file failure after bookkeeping
   * is a warning, not a resurrection"; this function is where it is kept.
   * @returns `{ removed, error }` — `removed:false` with no `error` means the
   *   path was simply not there.
   */
  async function disposePath(source) {
    if (!existsSync(source)) return { removed: false, error: undefined }
    try {
      await rm(source, { recursive: true, force: true })
      return { removed: true, error: undefined }
    } catch (error) {
      return { removed: false, error: errorMessage(error) }
    }
  }

  /**
   * Best-effort disposal of every `<prefix>*` entry in one directory. Inherits
   * `disposePath`'s no-throw contract and hands the failures back as messages.
   * @returns the warnings, one per entry that could not be removed.
   */
  async function disposePrefix(dir, prefix) {
    let names
    try {
      names = await readdir(dir)
    } catch {
      return []
    }
    const failures = []
    for (const entryName of names) {
      if (!entryName.startsWith(prefix)) continue
      const outcome = await disposePath(join(dir, entryName))
      if (outcome.error !== undefined) failures.push(`could not remove "${join(dir, entryName)}": ${outcome.error}`)
    }
    return failures
  }

  /**
   * Boot-time sweep of the pending-delete queue. Runs once shortly after the
   * tree boots (sessions are cold then); ids that are live again — e.g. the
   * UI auto-resumed them before the sweep — stay queued for the next boot.
   * The whole sweep holds the operation lock so its final full-list queue
   * write-back cannot clobber a marker queued mid-sweep, its archive-set
   * updates cannot interleave with other mutations, and concurrent sweeps
   * (boot timer + opportunistic ping sweeps) serialize instead of racing.
   * @param index - optional shared corpus read (see `artifactIndex`); the sweep
   *   builds one when the caller has none, so N queued ids cost ONE listing.
   */
  function sweepPending(index) {
    return withOperationLock(async () => {
      // Refuse a degraded read: this sweep ENDS by publishing a full-list
      // write-back, so running it on a read that failed would clear the file
      // and lose every marker in it.
      const snapshot = await readPendingSnapshot()
      if (snapshot.degraded) throw pendingQueueUnreadable(snapshot)
      const queued = snapshot.ids
      if (queued.length === 0) return { deleted: [], remaining: [] }
      const corpus = index ?? await artifactIndex()
      const remaining = []
      const remainingEntries = []
      const deleted = []
      for (const entry of snapshot.entries) {
        try {
          if (await finishDeferredDeletion(entry.id, corpus)) deleted.push(entry.id)
          else { remaining.push(entry.id); remainingEntries.push(entry) }
        } catch (error) {
          remaining.push(entry.id)
          remainingEntries.push(entry)
          try { ctx.logger?.warn?.(`session-manager: pending delete of "${entry.id}" failed: ${errorMessage(error)}`) } catch { /* noop */ }
        }
      }
      // Write back the ENTRIES, not just the ids: the entries that stay queued
      // keep their recorded workspaces, so a later cancel can still re-attach.
      await writePending(remainingEntries)
      return { deleted, remaining }
    })
  }

  /**
   * The opportunistic sweep a client `ping` triggers.
   *
   * A ping happens on every page load and on the residue repair path, so this
   * ran a full corpus walk (inside the operation lock) far too often — and a
   * queued id whose session is still LIVE survives every sweep by design until
   * the next boot, so repeated sweeps were pure waste. Two guards:
   *   - an EMPTY queue costs one file read and no corpus walk at all (the
   *     common case, and `sweepPending` already returns early on it);
   *   - an UNCHANGED queue that a previous sweep could not finish is not walked
   *     again until `SWEEP_MIN_INTERVAL_MS` has passed, so a client poll loop
   *     cannot serialize the deletes/cancels behind a corpus walk.
   * A queue whose contents changed re-arms immediately — a NEW marker must be
   * swept, which is the crash-safety promise this hook exists for.
   */
  const SWEEP_MIN_INTERVAL_MS = 30_000
  let lastSweepAt = 0
  let lastSweepSignature = null
  const opportunisticSweep = async () => {
    // Refusing (not tolerant) read: an unreadable queue must still fail loudly
    // here rather than look empty and silently skip the sweep.
    const snapshot = await readPendingSnapshot()
    if (snapshot.degraded) throw pendingQueueUnreadable(snapshot)
    const signature = snapshot.ids.join(',')
    if (signature === '') {
      lastSweepAt = Date.now()
      lastSweepSignature = ''
      return { deleted: [], remaining: [] }
    }
    const now = Date.now()
    if (signature === lastSweepSignature && now - lastSweepAt < SWEEP_MIN_INTERVAL_MS) {
      return { deleted: [], remaining: snapshot.ids }
    }
    const result = await sweepPending()
    lastSweepAt = Date.now()
    lastSweepSignature = result.remaining.join(',')
    return result
  }

  return {
    listArchived,
    restoreSession,
    deleteSession,
    effectiveConfig,
    tryGet,
    pendingFile,
    readPending,
    writePending,
    addPending,
    removePending,
    cancelPending,
    hasArtifact,
    artifactIndex,
    sweepPending,
    opportunisticSweep,
    announceRemoval,
    /**
     * The queue as `{ ids, entries }`, REFUSING a degraded read. The RPC handler
     * needs the refusing semantics — not `readPending`'s tolerant view — to
     * decide whether the corpus walk is needed at all: a tolerant read would
     * report an unreadable queue as empty and skip the very sweep that refuses
     * it.
     */
    readPendingQueue: async () => {
      const snapshot = await readPendingSnapshot()
      if (snapshot.degraded) throw pendingQueueUnreadable(snapshot)
      return { ids: snapshot.ids, entries: snapshot.entries }
    },
    /**
     * Cheap gate reads for the agent tools — registry state and existence only,
     * no corpus walk. `false` on a registry failure: the delete that follows
     * re-checks everything itself, so a gate failure can only refuse, never
     * widen access.
     */
    isArchived: (sessionId) => {
      try {
        return registryState(registry()).archivedSessionIds.some((id) => String(id) === sessionId)
      } catch {
        return false
      }
    },
    sessionKnown: async (sessionId) => {
      try {
        return await registry().sessionKnown(sessionId)
      } catch {
        return false
      }
    },
    /**
     * The same choke-point guard the manager entries use, re-exported so a
     * model-facing gate can validate BEFORE it reads any other seam: a malformed
     * id must always answer `bad-request`, never be masked into
     * `session/not-found` or `session/not-archived` by a permissive registry.
     */
    assertSessionId,
  }
}

// ---------------------------------------------------------------------------
// RPC channel
// ---------------------------------------------------------------------------

export function rpcHandlerFor(manager) {
  return async (endpoint, payload = {}, signal) => {
    signal?.throwIfAborted?.()
    const sessionId = payload.sessionId
    if (endpoint !== 'ping' && endpoint !== 'list' && endpoint !== 'deferred/list') {
      try {
        assertSessionId(sessionId)
      } catch {
        return fail('bad-request', 'a valid sessionId is required')
      }
    }
    try {
      switch (endpoint) {
        case 'ping':
          // A connected client means the UI is up: opportunistically clear
          // any queued deletion whose session is cold again. Throttled — see
          // `opportunisticSweep`; an empty queue now costs one file read.
          Promise.resolve(manager.opportunisticSweep()).catch(() => {})
          return ok({
            channel: CHANNEL,
            plugin: name,
            version: pluginVersion(),
            menuDeleteAvailable: manager.effectiveConfig().menuDeleteAvailable !== false,
          })
        case 'list':
          return ok(await manager.listArchived())
        case 'restore':
          return ok(await manager.restoreSession(sessionId))
        case 'delete':
          return ok(await manager.deleteSession(sessionId))
        case 'deferred/list': {
          // Read the queue BEFORE the corpus index. `artifactIndex()` is a full
          // `persistence.list()` — every generation, every stored header
          // decompressed — plus a sessions-root `readdir`, and the common case
          // is an empty queue whose sweep can do nothing. The read is the
          // REFUSING one on purpose: see `readPendingQueue`.
          const queue = await manager.readPendingQueue()
          // ONE corpus read for the whole request when it IS needed: the sweep
          // and the `recoverable` split each used to resolve every queued id
          // from scratch, which is O(queued × corpus) header decodes per call.
          const corpus = queue.ids.length > 0 ? await manager.artifactIndex() : undefined
          if (corpus !== undefined) await manager.sweepPending(corpus)
          // Never re-read the queue through the TOLERANT reader: a file that
          // turns torn between this read and the sweep would come back as an
          // empty queue with `ok: true`, and the client would then render a
          // queued session as an ordinary archived row — the silent shape the
          // residue rules exist to prevent. The sweep above drops every id it
          // finished, so its denying read is the answer in both cases.
          const ids = corpus === undefined ? queue.ids : (await manager.readPendingQueue()).ids
          const recoverable = []
          for (const id of ids) {
            if (corpus !== undefined && await manager.hasArtifact(id, corpus)) recoverable.push(id)
          }
          // Optional repair for the one shape a delete cannot hide everywhere:
          // a queued id whose session is still live keeps showing up in the
          // host's own session list (the in-memory copy), so a client that
          // renders archived rows draws its tombstone again. Re-announcing the
          // official removal here — on the queue read every client already
          // makes — drops it out of every connected list store again. The
          // emission is scoped to the ids whose session is LIVE: a swept or
          // cold entry has nothing left to hide.
          // `!== false` mirrors `menuDeleteAvailable`: the default is ON, and a
          // composition config that bypasses the schema (raw `{}` in tests, or an
          // older caller) must still get the default rather than silently off.
          if (manager.effectiveConfig().reannouncePendingRemovals !== false) {
            const live = manager.tryGet('sessions')
            for (const id of ids) {
              let present = false
              try {
                present = live?.get?.(id) !== undefined
              } catch {
                present = false
              }
              if (present) manager.announceRemoval(id)
            }
          }
          return ok({ sessionIds: ids, recoverable })
        }
        case 'deferred/cancel':
          return ok(await manager.cancelPending(sessionId))
        default:
          return fail('bad-request', `unknown endpoint "${String(endpoint)}"`)
      }
    } catch (error) {
      return errorEnvelope(error)
    }
  }
}

/**
 * Adapt one endpoint to an exact fetch route (the `connection.fetch.register`
 * contract). The envelope is produced here — the connection plugin's own RPC
 * handler is not involved — so this mirrors its wire shape exactly:
 * `{ type: "server-response", rpcId, result: { ok, value } | { ok, error } }`.
 * @param manager - the session manager instance.
 * @param endpoint - the single endpoint this route serves.
 * @returns an async fetch handler for that endpoint.
 */
export function rpcRouteHandler(manager, endpoint) {
  const handler = rpcHandlerFor(manager)
  return async (request) => {
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
    const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (contentType !== 'application/json') return new Response('content type must be application/json', { status: 415 })
    let body
    try {
      body = await request.json()
    } catch {
      return new Response('body is not JSON', { status: 400 })
    }
    const rpcId = typeof body?.rpcId === 'string' ? body.rpcId : 'invalid-request'
    if (body?.type !== 'client-request' || typeof body?.method !== 'string') {
      return Response.json({
        type: 'server-response',
        rpcId,
        result: fail('bad-request', 'invalid client-request message'),
      })
    }
    if (body.method !== `${RPC_NAMESPACE}/${endpoint}`) {
      return Response.json({
        type: 'server-response',
        rpcId,
        result: fail('bad-request', `method ${JSON.stringify(body.method)} does not match endpoint ${JSON.stringify(endpoint)}`),
      })
    }
    try {
      const result = await handler(endpoint, body.payload ?? {}, request.signal)
      return Response.json({ type: 'server-response', rpcId, result })
    } catch (error) {
      return Response.json({ type: 'server-response', rpcId, result: errorEnvelope(error) })
    }
  }
}

// ---------------------------------------------------------------------------
// Agent tools
// ---------------------------------------------------------------------------

function toolResult(kind, payload) {
  return JSON.stringify(kind === 'ok' ? { ok: true, ...payload } : { ok: false, ...payload })
}

export function registerTools(ctx, manager) {
  // The tools service may start after this plugin: wait for it instead of
  // reading it once at apply time.
  try {
    ctx.inject(['tools'], (toolsCtx) => {
        const tools = toolsCtx.tools
        if (tools === undefined || typeof tools.register !== 'function') return

    ctx.effect(() => tools.register({
      name: 'session_list_archived',
      description: 'List archived (hidden) sessions. Each entry includes sessionId, title, project directory, owning workspace and update time. Use with session_restore_archived or session_delete_permanently.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Maximum entries to return (default 50).' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render: (args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        const limit = Math.max(1, Math.min(200, Number(args?.limit) || 50))
        let list
        try {
          list = await manager.listArchived()
        } catch (error) {
          return toolResult('error', { code: error.code ?? 'list-failed', message: errorMessage(error) })
        }
        const items = list.items.slice(0, limit).map((entry) => ({
          sessionId: entry.sessionId,
          title: entry.title || '(untitled)',
          cwd: entry.cwd ?? null,
          workspace: entry.workspace?.title ?? null,
          updatedAt: entry.updatedAt,
          running: entry.running,
        }))
        return toolResult('ok', {
          count: items.length,
          totalArchived: list.archivedSessionIds.length,
          truncated: list.truncated || list.items.length > limit,
          items,
        })
      },
    }), 'session-manager: tool session_list_archived')

    ctx.effect(() => tools.register({
      name: 'session_restore_archived',
      description: 'Restore (unarchive) a session by its exact sessionId. The session returns to its previous position in its workspace. Reversible — no confirmation required. A session queued for permanent deletion is refused with session/pending: cancel the pending deletion first (deferred/list shows the queue; entries whose files are still on disk can be canceled).',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', pattern: '^[A-Za-z0-9_-]{4,128}$', description: 'Exact archived session id from session_list_archived.' },
          confirm: { type: 'boolean', description: 'Optional safety flag; accepted for symmetry with the delete tool.' },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render: (args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        try {
          const result = await manager.restoreSession(args.sessionId)
          return toolResult('ok', { sessionId: result.sessionId, restored: true, remainingArchived: result.archivedSessionIds.length })
        } catch (error) {
          return toolResult('error', { code: error.code ?? 'restore-failed', message: errorMessage(error) })
        }
      },
    }), 'session-manager: tool session_restore_archived')

    ctx.effect(() => tools.register({
      name: 'session_delete_permanently',
      description: 'Permanently delete an ARCHIVED session by its exact sessionId: removes the session log, metadata, and its workspace/archive accounting. This is IRREVERSIBLE. Refuses unknown ids, ids that are not archived (archive the session first) and sessions with a running task; deleting an open idle session succeeds and reports openAtDelete. Requires confirm: true.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', pattern: '^[A-Za-z0-9_-]{4,128}$', description: 'Exact session id to delete.' },
          confirm: { type: 'boolean', description: 'Must be true. The tool refuses to delete without it.' },
        },
        required: ['sessionId', 'confirm'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render: (args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        try {
          if (manager.effectiveConfig().toolDeleteRequiresConfirm !== false && args.confirm !== true) {
            return toolResult('error', { code: 'confirmation-required', message: 'permanent deletion requires confirm: true' })
          }
          // The id is validated FIRST, through the manager's own choke-point
          // guard: a malformed id must always answer `bad-request` and never be
          // masked into not-found/not-archived by the gates below.
          try {
            manager.assertSessionId(args.sessionId)
          } catch (error) {
            return toolResult('error', { code: error.code ?? 'bad-request', message: errorMessage(error) })
          }
          // This tool is part of the ARCHIVED-session family and is
          // model-facing: without these two gates a model that merely KNOWS an
          // id could permanently delete a live session it was never asked
          // about. The HUMAN surfaces are deliberately not gated this way — the
          // context-menu row is offered on every session row (that is a
          // documented feature), and the settings page lists archived rows.
          if (!(await manager.sessionKnown(args.sessionId))) {
            return toolResult('error', { code: 'session/not-found', message: `session "${args.sessionId}" does not exist` })
          }
          if (!manager.isArchived(args.sessionId)) {
            return toolResult('error', {
              code: 'session/not-archived',
              message: 'session_delete_permanently manages ARCHIVED sessions. Archive this session first (session menu → archive) and delete it from the archived list, or use the Session Manager settings page.',
            })
          }
          const result = await manager.deleteSession(args.sessionId)
          if (result.openAtDelete === true) {
            return toolResult('ok', {
              sessionId: result.sessionId,
              deleted: true,
              openAtDelete: true,
              note: 'the session was open; its files are deleted, but the in-memory copy lingers (hidden) until the next dsh restart',
            })
          }
          return toolResult('ok', {
            sessionId: result.sessionId,
            deleted: true,
            warnings: result.warnings,
          })
        } catch (error) {
          return toolResult('error', { code: error.code ?? 'delete-failed', message: errorMessage(error) })
        }
      },
  }), 'session-manager: tool session_delete_permanently')
    })
  } catch (error) {
    ctx.logger?.warn?.(`session-manager: tools service unavailable: ${errorMessage(error)}`)
  }
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

/**
 * Host plugin body. Everything registers defensively: a surface whose
 * backing service is absent from the composition simply does not mount.
 * @param ctx - Host context.
 * @param config - resolved composition config (schema defaults applied).
 */
export function apply(ctx, config = {}) {
  const manager = createSessionManager(ctx, config)

  // Browser RPC surface backing the settings page and menu button. The 0.1.5
  // host routes every HTTP surface under the shared `/api` prefix, and plugins
  // attach through `connection.fetch.register` EXACT routes — the shape the
  // official dsh-session-log-export uses. Never `rpc.intercept('/api', …)`:
  // that channel holds exactly ONE interceptor and the official dsh-api-gateway
  // already owns it, so a second registration throws; whoever wins the race
  // takes every other plugin's API down with it (when this plugin stole the
  // slot, the gateway died silently and EVERY host RPC — session/list,
  // workspace/list — answered 404 while this plugin's own endpoints kept
  // working, blanking the sidebar). Exact routes are keyed per path, coexist
  // with the gateway, and match before the interceptor.
  try {
    ctx.inject(['connection'], (rpcCtx) => {
      const connection = rpcCtx.connection
      if (connection === undefined || typeof connection.fetch?.register !== 'function') {
        ctx.logger?.warn?.('session-manager: connection service has no fetch.register; settings page and menu delete stay offline')
        return
      }
      for (const endpoint of RPC_ENDPOINTS) {
        rpcCtx.effect(
          () => connection.fetch.register({
            path: `${CHANNEL}/${endpoint}`,
            methods: ['POST'],
            requestBody: 'buffered',
            fetch: rpcRouteHandler(manager, endpoint),
          }),
          `session-manager: ${CHANNEL}/${endpoint} fetch route`,
        )
      }
    })
  } catch (error) {
    ctx.logger?.warn?.(`session-manager: connection RPC unavailable: ${errorMessage(error)}`)
  }

  registerTools(ctx, manager)

  // Boot-time sweep of the pending-delete queue. Sessions are still cold at
  // this point; the sweep runs after the tree settles so the workspace
  // registry and session store are mounted. A plain timer plus an effect
  // cleanup is used because `ctx.setTimeout` is not available on plugin
  // contexts in every composition.
  const sweepTimer = setTimeout(() => {
    manager.sweepPending().then((result) => {
      if (result.deleted.length > 0) {
        ctx.logger?.info?.(`session-manager: swept ${result.deleted.length} pending deletion(s): ${result.deleted.join(', ')}`)
      }
      if (result.remaining.length > 0) {
        ctx.logger?.info?.(`session-manager: ${result.remaining.length} pending deletion(s) still live, kept for the next boot`)
      }
    }).catch((error) => {
      ctx.logger?.warn?.(`session-manager: pending-delete sweep failed: ${errorMessage(error)}`)
    })
  }, 2500)
  ctx.effect(() => () => clearTimeout(sweepTimer), 'session-manager: pending-delete sweep timer')
}
