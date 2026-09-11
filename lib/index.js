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
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, rm, stat, writeFile, readFile, rename } from 'node:fs/promises'

export const name = 'session-manager'
export const CHANNEL = '/api/session-manager'
/** Endpoint namespace claimed inside the shared `/api` RPC prefix: a request
 *  to `/api/session-manager/<endpoint>` reaches the RPC handler as
 *  `<endpoint>` with this prefix stripped. */
export const RPC_NAMESPACE = 'session-manager'
export const SETTINGS_NS = 'dsh-session-manager'

/** Plugin version, read from the package manifest shipped beside this file
 *  (both live in every installed copy — package.json is in the `files`
 *  whitelist). The literal is only a fallback for unreadable/corrupt manifests
 *  and should roughly track it; single source is the manifest. */
const VERSION_FALLBACK = '0.3.1'
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

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/

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
  // Open-but-idle sessions always delete immediately (tombstoned); this switch
  // only governs sessions with a RUNNING task: refused by default, force
  // deleted with cold semantics (no tombstone) when true. Dangerous.
  allowDeleteRunning: Schema.boolean().default(false),
  // Agent tool `session_delete_permanently` requires `confirm: true`.
  toolDeleteRequiresConfirm: Schema.boolean().default(true),
  // Mount the red "permanently delete" item into the browser session menu.
  menuDeleteAvailable: Schema.boolean().default(true),
})

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const ok = (value) => ({ ok: true, value })
const fail = (code, message, details) => ({
  ok: false,
  error: { code, message, ...(details === undefined ? {} : { details }) },
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

  /** Durable domain state, read through the registry's own seam when present. */
  const registryState = (reg) => {
    if (typeof reg.requireState === 'function') return reg.requireState()
    // Defensive reconstruction for registries that stop exposing requireState.
    return {
      initialized: true,
      workspaceIds: reg.list().map((workspace) => workspace.id),
      archivedSessionIds: reg.archivedSessionIds.map(String),
    }
  }

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
  async function readPending() {
    try {
      const parsed = JSON.parse(await readFile(pendingFile(), 'utf8'))
      const raw = Array.isArray(parsed?.sessionIds) ? parsed.sessionIds.filter((id) => typeof id === 'string') : []
      // The queue file is an INPUT channel (crash leftovers, hand edits,
      // corruption), not just our own output: never let a malformed id reach
      // resolveSessionDirs/disposePath, or the raw sessions-root scan turns
      // into a path-traversal delete. Malformed entries also vanish from the
      // file on the next locked write-back (which always writes what this
      // filtered view returned).
      const ids = raw.filter((id) => SESSION_ID_PATTERN.test(id))
      if (ids.length !== raw.length && !pendingSanitized) {
        pendingSanitized = true
        try { ctx.logger?.warn?.(`session-manager: dropped ${raw.length - ids.length} malformed id(s) from the pending-delete queue`) } catch { /* noop */ }
      }
      return [...new Set(ids)]
    } catch {
      return []
    }
  }

  async function writePending(sessionIds) {
    const ids = [...new Set(sessionIds)]
    const target = pendingFile()
    await mkdir(dirname(target), { recursive: true })
    const tmp = `${target}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify({ version: 1, sessionIds: ids }, null, 2), 'utf8')
    try {
      await rename(tmp, target)
    } catch {
      // Cross-device rename fallback for exotic storage layouts.
      await writeFile(target, JSON.stringify({ version: 1, sessionIds: ids }, null, 2), 'utf8')
      await rm(tmp, { force: true })
    }
  }

  // Unlocked internals — ONLY callable from code already holding the
  // operation lock (delete/sweep/cancel bodies). Lock re-entry would deadlock.
  const _addPending = async (sessionId) => {
    const ids = await readPending()
    if (!ids.includes(sessionId)) ids.push(sessionId)
    await writePending(ids)
    return ids
  }

  const _removePending = async (sessionId) => {
    const ids = (await readPending()).filter((id) => id !== sessionId)
    await writePending(ids)
    return ids
  }

  // Public, lock-taking queue entry points for callers outside the wrapped
  // operations (tests first). (Pure readPending is lock-free: a torn read
  // cannot happen thanks to the atomic rename, and callers only ever want a
  // snapshot.)
  const addPending = (sessionId) => withOperationLock(() => _addPending(sessionId))
  const removePending = (sessionId) => withOperationLock(() => _removePending(sessionId))

  /** Whether the session's on-disk artifact directory still exists (i.e. the
   *  queued deletion has something left to cancel meaningfully). Existence,
   *  not just resolvability: the header seams keep resolving paths after the
   *  files are gone. */
  const hasArtifact = async (sessionId) => {
    for (const dir of await resolveSessionDirs(sessionId, undefined)) {
      if (existsSync(dir)) return true
    }
    return false
  }

  /**
   * Cancel one queued deletion: clear any tombstone first, THEN drop the
   * marker — a registry failure leaves the entry fully queued (still
   * offered, retryable), while the reverse order could strand a marker-less
   * tombstone. Refused outright when the queued id's files are already gone
   * (normal open-session deletes): un-tombstoning one would expose the
   * artifact-less lingering summary as an ungrouped row. The UI only offers
   * cancel for `recoverable` entries; this enforces that for RPC/tool callers.
   */
  async function cancelPending(sessionId) {
    assertSessionId(sessionId)
    return withOperationLock(async () => {
      if (!(await hasArtifact(sessionId))) {
        throw new SessionManagerError('session/data-gone', `the queued deletion of "${sessionId}" already disposed its files; nothing left to cancel`, { sessionId })
      }
      const reg = registry()
      const state = registryState(reg)
      if (state.archivedSessionIds.some((id) => String(id) === sessionId)) {
        await reg.setState({ ...state, archivedSessionIds: state.archivedSessionIds.filter((id) => String(id) !== sessionId) })
      }
      const remaining = await _removePending(sessionId)
      return { sessionIds: remaining }
    })
  }

  /** Directory + filename prefix covering one session's projection checkpoints
   *  (`<id>.json` and every `<id>.json.bak-*` sibling). */
  const projcacheSweep = (sessionId) => ({
    dir: join(dshHome(), 'storages', 'session_projcache', 'sessions'),
    prefix: `${sessionId}.json`,
  })

  // -------- summaries -------------------------------------------------------

  /**
   * Session summaries keyed by id. Primary path is the session controller
   * (`list()` covers live and cold sessions); fallback is the persistence
   * header listing (no titles, no updatedAt beyond createdAt).
   */
  const collectSummaries = async () => {
    const controller = tryGet('sessionController')
    if (controller !== undefined && typeof controller.list === 'function') {
      const summaries = new Map()
      // A fresh deployment's controller may answer undefined/null until its
      // own state initializes — treat that as "no summaries".
      const items = (await controller.list()) ?? []
      if (Array.isArray(items)) for (const item of items) summaries.set(String(item.sessionId), item)
      return summaries
    }
    const persistence = tryGet('sessionPersistence')
    const summaries = new Map()
    if (persistence !== undefined && typeof persistence.list === 'function') {
      for (const header of await persistence.list()) {
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

  /** Artifact path of one session via the persistence backend `locate` seam. */
  const artifactPathOf = (cwd, sessionId) => {
    const persistence = tryGet('sessionPersistence')
    if (persistence === undefined || typeof persistence.locate !== 'function' || cwd === undefined) return undefined
    try {
      return persistence.locate({ cwd, id: sessionId })?.path
    } catch {
      return undefined
    }
  }

  /**
   * Every on-disk artifact directory that plausibly holds `sessionId`'s log,
   * resolved through three seams in turn: registry header + `locate`, the
   * persistence header listing + `locate`, and a raw scan of the sessions
   * root for a directory named exactly the (already pattern-validated) id.
   * A silently missed artifact is what resurrects deleted sessions as
   * ungrouped entries in the workspace browser, so this over-resolves rather
   * than under-resolves.
   */
  async function resolveSessionDirs(sessionId, header) {
    const dirs = []
    const seen = new Set()
    const consider = (path) => {
      if (path === undefined || seen.has(path)) return
      seen.add(path)
      dirs.push(path)
    }
    const located = artifactPathOf(header?.cwd, sessionId)
    if (located !== undefined) consider(dirname(located))
    const persistence = tryGet('sessionPersistence')
    if (persistence !== undefined && typeof persistence.list === 'function') {
      try {
        for (const candidate of await persistence.list()) {
          if (String(candidate.id) !== sessionId) continue
          const path = artifactPathOf(candidate.cwd, sessionId)
          if (path !== undefined) consider(dirname(path))
        }
      } catch {
        // Header listing unavailable — the raw scan below still applies.
      }
    }
    const root = typeof persistence?.root === 'string' && persistence.root.length > 0
      ? persistence.root
      : join(dshHome(), 'sessions')
    try {
      for (const project of await readdir(root, { withFileTypes: true })) {
        if (!project.isDirectory()) continue
        const candidate = join(root, project.name, sessionId)
        const info = await stat(candidate).catch(() => undefined)
        if (info?.isDirectory() === true) consider(candidate)
      }
    } catch {
      // Sessions root unreadable — report whatever the seams resolved.
    }
    return dirs
  }

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
    // state whose archive set is not an array yet — treat it as empty.
    const pending = new Set(await readPending())
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
    const live = tryGet('sessions')
    const entries = []
    for (const id of capped) {
      const summary = summaries.get(id)
      const workspace = workspaceBySession.get(id)
      const isLive = live?.get(id) !== undefined
      const running = summary?.running === true || isLive === true
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
    // deliberately hide it, so only the agent tools can reach this path.
    if ((await readPending()).includes(sessionId)) {
      throw new SessionManagerError('session/pending', `session "${sessionId}" is queued for permanent deletion; cancel the pending deletion first`, { sessionId })
    }
    const reg = registry()
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
    await reg.setState({ ...state, archivedSessionIds })
    return { sessionId, restored: true, archivedSessionIds: archivedSessionIds.map(String) }
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
   *   - cold          → plain full delete
   *   - `allowDeleteRunning` → treat an open session as cold (dangerous)
   *
   * Order: input guard (path-traversal choke point shared with every other
   * entry), then existence check (read-only), then the pending-queue marker
   * (crash safety), then registry bookkeeping (workspace accounting + archive
   * set), then files. The whole sequence holds the operation lock so two
   * concurrent deletes cannot lose an archive-set update. A file failure after
   * bookkeeping does not resurrect the session — it is reported as a warning
   * so the caller can retry cleanup.
   */
  async function deleteSession(sessionId) {
    assertSessionId(sessionId)
    return withOperationLock(() => deleteLocked(sessionId))
  }

  async function deleteLocked(sessionId) {
    const cfg = effectiveConfig()
    const reg = registry()
    const live = tryGet('sessions')

    const isOpen = live?.get(sessionId) !== undefined && cfg.allowDeleteRunning !== true
    if (isOpen) {
      const agents = tryGet('agents')
      if (agents?.get?.(sessionId)?.status === 'running') {
        throw new SessionManagerError('session/running', `session "${sessionId}" has a running task; wait for it to finish before deleting`, { sessionId })
      }
    }
    if (!(await reg.sessionKnown(sessionId))) {
      throw new SessionManagerError('session/not-found', `session "${sessionId}" does not exist`, { sessionId })
    }
    // Queue the finish-up before touching anything, but only once the session
    // is known to exist: sessionKnown is read-only, so a crash mid-delete
    // still always leaves the next boot a marker to sweep — while an
    // unpersisted (blank) live session can no longer leave a phantom marker.
    // (Unlocked variant: we already hold the operation lock.)
    if (isOpen) await _addPending(sessionId)

    let header
    try {
      header = await reg.readSessionHeader(sessionId)
    } catch {
      header = undefined
    }

    // 1) Registry bookkeeping — durable and published to every follower.
    //    Detach from the workspace FIRST: the session is still archived (hidden)
    //    while we detach, so it never flashes back into the workspace browser
    //    between the unarchive and detach frames. The real Workspace.sessionIds
    //    getter filters members through the registry's canonical-cwd header
    //    index, so a stale index hides the id from the getter; the raw record
    //    is checked as a fallback, or the detach would be skipped and the
    //    session would stay accounted (and resurface as ungrouped) forever.
    for (const workspace of reg.list()) {
      const accounted = workspace.sessionIds.some((id) => String(id) === sessionId)
        || (Array.isArray(workspace.record?.sessionIds) && workspace.record.sessionIds.some((id) => String(id) === sessionId))
      if (accounted) await workspace.detachSession(sessionId)
    }
    const state = registryState(reg)
    const isArchived = state.archivedSessionIds.some((id) => String(id) === sessionId)
    if (isOpen) {
      // Tombstone: keep the id archived so the still-listed in-memory summary
      // stays hidden from every official view until the boot sweep clears it.
      if (!isArchived) {
        await reg.setState({ ...state, archivedSessionIds: [...state.archivedSessionIds, sessionId] })
      }
    } else if (isArchived) {
      await reg.setState({ ...state, archivedSessionIds: state.archivedSessionIds.filter((id) => String(id) !== sessionId) })
    }

    // 2) Files: the session artifact directory and the projection checkpoint.
    const warnings = []
    const sessionDirs = await resolveSessionDirs(sessionId, header)
    if (sessionDirs.length === 0) {
      warnings.push('session artifact directory could not be located under the sessions root; only registry bookkeeping and metadata cleanup ran')
    }
    for (const sessionDir of sessionDirs) {
      if (!(await disposePath(sessionDir))) warnings.push(`session artifact directory was not found: ${sessionDir}`)
    }

    const projcache = projcacheSweep(sessionId)
    await disposePrefix(projcache.dir, projcache.prefix)

    // Broadcast the official removal so every connected client drops the
    // session from its list store at once. The host itself only emits this
    // event when a live session is disposed, which a cold delete never is;
    // without it the deleted session lingers in every open UI (and, no longer
    // archived or workspace-accounted, resurfaces as ungrouped).
    try {
      if (typeof ctx.emit === 'function') ctx.emit('api-session/removed', sessionId)
    } catch {
      // Cosmetic: a missed broadcast only costs a delayed list refresh.
    }

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
  async function finishDeferredDeletion(sessionId) {
    const live = tryGet('sessions')
    if (live?.get(sessionId) !== undefined) return false
    const reg = registry()
    for (const sessionDir of await resolveSessionDirs(sessionId, undefined)) {
      await disposePath(sessionDir)
    }
    const projcache = projcacheSweep(sessionId)
    await disposePrefix(projcache.dir, projcache.prefix)
    for (const workspace of reg.list()) {
      const accounted = workspace.sessionIds.some((id) => String(id) === sessionId)
        || (Array.isArray(workspace.record?.sessionIds) && workspace.record.sessionIds.some((id) => String(id) === sessionId))
      if (accounted) await workspace.detachSession(sessionId)
    }
    const state = registryState(reg)
    if (state.archivedSessionIds.some((id) => String(id) === sessionId)) {
      await reg.setState({ ...state, archivedSessionIds: state.archivedSessionIds.filter((id) => String(id) !== sessionId) })
    }
    try {
      if (typeof ctx.emit === 'function') ctx.emit('api-session/removed', sessionId)
    } catch {
      // Cosmetic only.
    }
    // Unlocked variant: only ever called from sweepPending while the
    // operation lock is held (the lock is not reentrant).
    await _removePending(sessionId)
    return true
  }

  /** Physically remove one exact path. Returns false when it was not there. */
  async function disposePath(source) {
    if (!existsSync(source)) return false
    await rm(source, { recursive: true, force: true })
    return true
  }

  /** Best-effort disposal of every `<prefix>*` entry in one directory. */
  async function disposePrefix(dir, prefix) {
    let names
    try {
      names = await readdir(dir)
    } catch {
      return
    }
    for (const entryName of names) {
      if (!entryName.startsWith(prefix)) continue
      await disposePath(join(dir, entryName))
    }
  }

  /**
   * Boot-time sweep of the pending-delete queue. Runs once shortly after the
   * tree boots (sessions are cold then); ids that are live again — e.g. the
   * UI auto-resumed them before the sweep — stay queued for the next boot.
   * The whole sweep holds the operation lock so its final full-list queue
   * write-back cannot clobber a marker queued mid-sweep, its archive-set
   * updates cannot interleave with other mutations, and concurrent sweeps
   * (boot timer + opportunistic ping sweeps) serialize instead of racing.
   */
  function sweepPending() {
    return withOperationLock(async () => {
      const queued = await readPending()
      if (queued.length === 0) return { deleted: [], remaining: [] }
      const remaining = []
      const deleted = []
      for (const id of queued) {
        try {
          if (await finishDeferredDeletion(id)) deleted.push(id)
          else remaining.push(id)
        } catch (error) {
          remaining.push(id)
          try { ctx.logger?.warn?.(`session-manager: pending delete of "${id}" failed: ${errorMessage(error)}`) } catch { /* noop */ }
        }
      }
      await writePending(remaining)
      return { deleted, remaining }
    })
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
    sweepPending,
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
          // any queued deletion whose session is cold again.
          Promise.resolve(manager.sweepPending()).catch(() => {})
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
          await manager.sweepPending()
          const ids = await manager.readPending()
          const recoverable = []
          for (const id of ids) {
            if (await manager.hasArtifact(id)) recoverable.push(id)
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
      description: 'Permanently delete a session by its exact sessionId: removes the session log, metadata, and its workspace/archive accounting. This is IRREVERSIBLE. Refuses unknown ids and sessions with a running task; deleting an open idle session succeeds and reports openAtDelete. Requires confirm: true.',
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

  // Browser RPC channel backing the settings page and menu button. The 0.1.5
  // host composes every HTTP surface under the shared `/api` prefix: plugin
  // channels register a namespaced interceptor with `rpc.intercept('/api')`
  // (the exact pattern the official dsh-api-gateway uses). The older
  // `rpc.handle('/session-manager')` prefix-route shape is gone — its route
  // registration reads `webServer` through the CALLER's context, where a
  // sibling plugin never sees it, so the channel silently never mounted.
  // Keep this module free of `export default`: the Loader's unwrapExports
  // prefers `module.default`, and a bare function carries no plugin metadata.
  try {
    ctx.inject(['connection'], (rpcCtx) => {
      const connection = rpcCtx.connection
      if (connection === undefined || typeof connection.rpc?.intercept !== 'function') {
        ctx.logger?.warn?.('session-manager: connection service has no rpc.intercept; settings page and menu delete stay offline')
        return
      }
      rpcCtx.effect(
        () => connection.rpc.intercept(
          '/api',
          (endpoint) => endpoint.startsWith(`${RPC_NAMESPACE}/`),
          (endpoint, payload, signal) => rpcHandlerFor(manager)(endpoint.slice(RPC_NAMESPACE.length + 1), payload, signal),
        ),
        `session-manager: ${RPC_NAMESPACE} rpc interceptor`,
      )
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
