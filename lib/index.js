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
//   - `/sessions` slash-command family for interactive users
//   - agent tools `session_list_archived`, `session_restore_archived`,
//     `session_delete_permanently` for the model
//
// The host imports nothing from the dsh core beyond `@deepseek-ai/schemastery`
// for the Config schema; every dsh service is reached through `ctx.get(...)`.

import Schema from '@deepseek-ai/schemastery'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, stat, writeFile, readFile, rename } from 'node:fs/promises'

export const name = 'session-manager'
export const CHANNEL = '/session-manager'
export const SETTINGS_NS = 'dsh-session-manager'

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/

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
  // Refuse to delete a session that is live in the current process.
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
    if (r === undefined) throw new SessionManagerError('workspace-registry-unavailable', 'the workspace registry service is not mounted in this deployment')
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

  /** dsh home directory, derived from the persistence root (`.../.dsh/sessions`). */
  const dshHome = () => {
    if (process.env.DSH_HOME) return process.env.DSH_HOME
    const persistence = tryGet('sessionPersistence')
    const root = persistence?.root
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

  async function readPending() {
    try {
      const parsed = JSON.parse(await readFile(pendingFile(), 'utf8'))
      const ids = Array.isArray(parsed?.sessionIds) ? parsed.sessionIds.filter((id) => typeof id === 'string') : []
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

  const addPending = async (sessionId) => {
    const ids = await readPending()
    if (!ids.includes(sessionId)) ids.push(sessionId)
    await writePending(ids)
    return ids
  }

  const removePending = async (sessionId) => {
    const ids = (await readPending()).filter((id) => id !== sessionId)
    await writePending(ids)
    return ids
  }

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
   * Cancel one queued deletion: drop the marker AND clear any tombstone, so
   * canceling never leaves a stale husk archived forever. Only meaningful
   * for entries whose files are still on disk (crash leftovers); for
   * data-gone entries the UI hides the button.
   */
  async function cancelPending(sessionId) {
    const remaining = await removePending(sessionId)
    const reg = registry()
    const state = registryState(reg)
    if (state.archivedSessionIds.some((id) => String(id) === sessionId)) {
      await reg.setState({ ...state, archivedSessionIds: state.archivedSessionIds.filter((id) => String(id) !== sessionId) })
    }
    return { sessionIds: remaining }
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
      const items = await controller.list()
      for (const item of items) summaries.set(String(item.sessionId), item)
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
    // of every listing here too.
    const pending = new Set(await readPending())
    const ids = reg.archivedSessionIds.map(String).filter((id) => !pending.has(id))
    const limit = effectiveConfig().sessionListLimit
    const capped = ids.slice(0, limit)
    const summaries = await collectSummaries()
    const workspaces = reg.list()
    const workspaceBySession = new Map()
    for (const workspace of workspaces) {
      for (const id of workspace.sessionIds) {
        if (!workspaceBySession.has(String(id))) {
          workspaceBySession.set(String(id), {
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
  async function restoreSession(sessionId) {
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
   * Order: pending queue first (crash safety), then registry bookkeeping
   * (workspace accounting + archive set), then files. A file failure after
   * bookkeeping does not resurrect the session — it is reported as a warning
   * so the caller can retry cleanup.
   */
  async function deleteSession(sessionId) {
    const cfg = effectiveConfig()
    const reg = registry()
    const live = tryGet('sessions')

    const isOpen = live?.get(sessionId) !== undefined && cfg.allowDeleteRunning !== true
    if (isOpen) {
      const agents = tryGet('agents')
      if (agents?.get?.(sessionId)?.status === 'running') {
        throw new SessionManagerError('session/running', `session "${sessionId}" has a running task; wait for it to finish before deleting`, { sessionId })
      }
      // Queue the finish-up before touching anything: a crash mid-delete then
      // always leaves the next boot a marker to sweep.
      await addPending(sessionId)
    }
    if (!(await reg.sessionKnown(sessionId))) {
      throw new SessionManagerError('session/not-found', `session "${sessionId}" does not exist`, { sessionId })
    }

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
    await removePending(sessionId)
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
   */
  async function sweepPending() {
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
      if (typeof sessionId !== 'string' || sessionId.length === 0 || !SESSION_ID_PATTERN.test(sessionId)) {
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
            version: '0.2.3',
            menuDeleteAvailable: manager.effectiveConfig().menuDeleteAvailable !== false,
          })
        case 'list':
          return ok(await manager.listArchived({ includeSize: payload.includeSize === true }))
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
// Slash commands
// ---------------------------------------------------------------------------

export const USAGE = 'Usage: /sessions [archived|restore <#|id>|delete <id>|pending [cancel <id>]]'

function renderEntry(index, entry) {
  const title = entry.title === '' ? '(untitled)' : entry.title
  const date = entry.updatedAt === null ? '?' : new Date(entry.updatedAt).toLocaleString()
  const workspace = entry.workspace === null ? 'ungrouped' : `[${entry.workspace.title}]`
  const running = entry.running ? ' (running)' : ''
  return `  #${index}  ${title}${running}\n       ${workspace}  ${entry.cwd ?? ''}  ${date}`
}

export function registerCommands(ctx, manager) {
  const commands = manager.tryGet('commands')
  if (commands === undefined || typeof commands.register !== 'function') {
    // Expected on the desktop build: its composition does not mount the
    // commands service (no slash-command surface at all), so /sessions
    // silently stays unavailable there. Log it so the gap is diagnosable.
    try { ctx.logger?.info?.('session-manager: slash commands unavailable — host does not mount the commands service') } catch { /* noop */ }
    return
  }
  ctx.effect(() => commands.register({
    name: 'sessions',
    description: 'manage archived sessions: list, restore, permanently delete',
    input: { hint: '[archived|restore <#|id>|delete <id>|pending]' },
    handler: async (invocation) => {
      const input = invocation.rawInput.trim()
      try {
        if (input === '') {
          const list = await manager.listArchived({ includeSize: false })
          return {
            kind: 'success',
            text: [
              'Session manager',
              `Archived sessions: ${list.items.length}${list.truncated ? ' (list capped)' : ''}`,
              `Run /sessions archived to list them.`,
              '',
              USAGE,
            ].join('\n'),
          }
        }
        if (input === 'archived') {
          const list = await manager.listArchived({ includeSize: false })
          if (list.items.length === 0) return { kind: 'success', text: 'No archived sessions.' }
          return {
            kind: 'success',
            text: [
              `Archived sessions (${list.items.length}${list.truncated ? `, showing first ${list.items.length}` : ''}):`,
              ...list.items.map((entry, index) => renderEntry(index + 1, entry)),
              '',
              'Restore with /sessions restore <#> and delete with /sessions delete <id>.',
            ].join('\n'),
          }
        }
        const restoreMatch = /^restore(?:\s+(\S+))?/.exec(input)
        if (restoreMatch !== null) {
          if (restoreMatch[1] === undefined) return { kind: 'error', text: `Restore needs a session: /sessions restore <#|id>.\n${USAGE}` }
          const target = await resolveSessionTarget(manager, restoreMatch[1])
          const result = await manager.restoreSession(target)
          return {
            kind: 'success',
            text: `Restored session ${result.sessionId}.\nArchived sessions remaining: ${result.archivedSessionIds.length}`,
          }
        }
        const deleteMatch = /^delete(?:\s+(\S+))?$/.exec(input)
        if (deleteMatch !== null) {
          if (deleteMatch[1] === undefined) return { kind: 'error', text: `Delete needs a session id: /sessions delete <id>.
${USAGE}` }
          if (deleteMatch[1].startsWith('#') || /^\d+$/.test(deleteMatch[1])) {
            return {
              kind: 'error',
              text: 'Deleting by list index is disabled (indexes shift). Pass the full session id from /sessions archived.',
            }
          }
          const result = await manager.deleteSession(deleteMatch[1])
          if (result.openAtDelete === true) {
            return {
              kind: 'success',
              text: `Permanently deleted session ${result.sessionId}. It is still open in this process, so its in-memory copy lingers until the next dsh restart; it is hidden everywhere until then.`,
            }
          }
          const notes = [...(result.warnings ?? [])]
          return {
            kind: 'success',
            text: [
              `Permanently deleted session ${result.sessionId}.`,
              ...notes,
            ].join('\n'),
          }
        }
        const pendingMatch = /^pending(?:\s+(.*))?$/.exec(input)
        if (pendingMatch !== null) {
          const rest = (pendingMatch[1] ?? '').trim()
          const ids = await manager.readPending()
          if (rest === '') {
            if (ids.length === 0) return { kind: 'success', text: 'No pending deletions.' }
            return {
              kind: 'success',
              text: [
                `Pending deletions (${ids.length}, executed at the next restart):`,
                ...ids.map((id) => `  ${id}`),
                'Cancel with /sessions pending cancel <id>.',
              ].join('\n'),
            }
          }
          const cancel = /^cancel\s+(\S+)$/.exec(rest)
          if (cancel !== null) {
            const remaining = await manager.removePending(cancel[1])
            return { kind: 'success', text: `Cancelled pending deletion of ${cancel[1]}. Pending: ${remaining.length}` }
          }
          return { kind: 'error', text: `Unknown pending option "${rest}".\n${USAGE}` }
        }
        return { kind: 'error', text: `Unknown /sessions command "${input}".\n${USAGE}` }
      } catch (error) {
        if (error instanceof SessionManagerError) return { kind: 'error', text: `${error.code}: ${error.message}` }
        return { kind: 'error', text: `session manager failed: ${errorMessage(error)}` }
      }
    },
  }), 'session-manager: /sessions command')
}

/** Resolve "#3" or a raw id into a session id, against the archive list. */
async function resolveSessionTarget(manager, token) {
  const raw = token.startsWith('#') ? token.slice(1) : token
  if (/^\d+$/.test(raw)) {
    const list = await manager.listArchived({ includeSize: false })
    const index = Number(raw)
    if (index < 1 || index > list.items.length) {
      throw new SessionManagerError('session/not-archived', `archive index #${raw} is out of range (1..${list.items.length})`)
    }
    return list.items[index - 1].sessionId
  }
  if (!SESSION_ID_PATTERN.test(raw)) {
    throw new SessionManagerError('bad-request', `"${token}" is neither an archive index nor a valid session id`)
  }
  return raw
}

// ---------------------------------------------------------------------------
// Agent tools
// ---------------------------------------------------------------------------

function toolResult(kind, payload) {
  return JSON.stringify(kind === 'ok' ? { ok: true, ...payload } : { ok: false, ...payload })
}

export function registerTools(ctx, manager) {
  const tools = manager.tryGet('tools')
  if (tools === undefined || typeof tools.register !== 'function') return

  ctx.effect(() => tools.register({
    name: 'session_list_archived',
    description: 'List archived (hidden) sessions. Each entry includes sessionId, title, project directory, owning workspace and update time. Use with session_restore_archived or session_delete_permanently.',
    parameters: {
      limit: { type: 'number', description: 'Maximum entries to return (default 50).' },
    },
    output: {
      schema: { type: 'string' },
      render: (args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const limit = Math.max(1, Math.min(200, Number(args?.limit) || 50))
      const list = await manager.listArchived({ includeSize: false })
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
    description: 'Restore (unarchive) a session by its exact sessionId. The session returns to its previous position in its workspace. Reversible — no confirmation required.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Exact archived session id from session_list_archived.' },
      confirm: { type: 'boolean', description: 'Optional safety flag; accepted for symmetry with the delete tool.' },
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
    description: 'Permanently delete a session by its exact sessionId: removes the session log, metadata, and its workspace/archive accounting. This is IRREVERSIBLE. Refuses sessions that are currently running. Requires confirm: true.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Exact session id to delete.' },
      confirm: { type: 'boolean', required: true, description: 'Must be true. The tool refuses to delete without it.' },
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

  // Browser RPC channel backing the settings page and menu button. Mounted on
  // the caller-scoped fiber so it unmounts with this plugin (the same pattern
  // the official session-log-export and dsh-vision-router bridges use).
  try {
    ctx.inject(['connection'], (rpcCtx) => {
      const connection = rpcCtx.connection
      if (connection === undefined || typeof connection.rpc?.handle !== 'function') return
      rpcCtx.effect(
        () => connection.rpc.handle(CHANNEL, rpcHandlerFor(manager)),
        `session-manager: ${CHANNEL} rpc channel`,
      )
    })
  } catch (error) {
    ctx.logger?.warn?.(`session-manager: connection RPC unavailable: ${errorMessage(error)}`)
  }

  registerCommands(ctx, manager)
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

export default apply
