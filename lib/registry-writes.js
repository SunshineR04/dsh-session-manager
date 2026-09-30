// Registry-write seam — the rules for reading and writing the workspace
// registry's durable state, extracted from `lib/index.js` so they can be tested
// directly instead of only through a mounted host.
//
// Nothing here touches `ctx`: every function takes the registry as an argument,
// and the host's error class arrives through the factory (the same seam-injection
// shape `lib/artifact-paths.js` uses). The rules are load-bearing — see the
// comments on `archiveThrough` and `assertRegistryWritable` — so keep them here
// verbatim rather than re-inlining one "just for now".

export function createRegistryWrites({ SessionManagerError }) {
  /** Durable domain state, read through the registry's own seam when present. */
  const registryState = (reg) => {
    if (typeof reg.requireState === 'function') return reg.requireState()
    // Defensive reconstruction for registries that stop exposing requireState.
    // ⚠ READS ONLY, and marked as such: a reconstruction cannot be complete (a
    // registry that hides `requireState` may still carry fields we cannot see —
    // `defaultWorkspaceId`, `pendingMutation`, future ones), so writing it back
    // through `setState` would ERASE them. Every archive-set write below refuses
    // a reconstructed state instead of guessing.
    return {
      initialized: true,
      workspaceIds: reg.list().map((workspace) => workspace.id),
      archivedSessionIds: reg.archivedSessionIds.map(String),
      ...(Array.isArray(reg.pinnedSessionIds) ? { pinnedSessionIds: reg.pinnedSessionIds.map(String) } : {}),
      ...(reg.defaultWorkspaceId === undefined ? {} : { defaultWorkspaceId: reg.defaultWorkspaceId }),
      reconstructed: true,
    }
  }

  const refuseReconstructedWrite = (state) => {
    if (state.reconstructed === true) {
      throw new SessionManagerError(
        'registry/unavailable',
        'the workspace registry no longer exposes requireState, so its durable state cannot be updated safely — a reconstructed snapshot would erase fields this plugin cannot see (pins, the default workspace, a pending mutation)',
      )
    }
  }

  /**
   * Archive-set writes go through the registry's OWN entry points when they
   * exist.
   *
   * `setState` is a bare `global.set` in `dsh-workspace`, while every official
   * mutation (archive, unarchive, pin, workspace create) runs on the registry's
   * internal `enqueueOperation` queue — so hand-rolling the read-modify-write
   * lets our stale snapshot undo a concurrent official write: we would write
   * back the `pinnedSessionIds` / `defaultWorkspaceId` / `workspaceIds` we read a
   * moment earlier. Our own operation lock cannot prevent that; it only
   * serializes THIS plugin's callers.
   *
   * Both official methods are no-op-safe (they resolve without writing when the
   * id is already archived / not archived), and `archiveSession` additionally
   * drops the id from the PIN set — which a hand-rolled add leaves dangling.
   */
  const unarchiveThrough = async (reg, sessionId) => {
    if (typeof reg.unarchiveSession === 'function') {
      await reg.unarchiveSession(sessionId)
      return
    }
    const state = registryState(reg)
    refuseReconstructedWrite(state)
    if (state.archivedSessionIds.some((id) => String(id) === sessionId)) {
      await reg.setState({ ...state, archivedSessionIds: state.archivedSessionIds.filter((id) => String(id) !== sessionId) })
    }
  }

  /**
   * Add the tombstone through the official entry point when available.
   *
   * `stopActivity: true` is required, not cosmetic: without it `archiveSession`
   * first runs the `workspace/session-activity` waterfall and THROWS for a
   * session with running work — which would break the documented
   * `allowDeleteRunning` path after it had already decided to proceed. The
   * delete is the decision point; the tombstone must follow it unconditionally.
   */
  const archiveThrough = async (reg, sessionId) => {
    if (typeof reg.archiveSession === 'function') {
      await reg.archiveSession(sessionId, { stopActivity: true })
      return
    }
    const state = registryState(reg)
    refuseReconstructedWrite(state)
    if (!state.archivedSessionIds.some((id) => String(id) === sessionId)) {
      await reg.setState({ ...state, archivedSessionIds: [...state.archivedSessionIds, sessionId] })
    }
  }

  /**
   * Refuse a durable mutation on a registry whose state cannot be written
   * safely. Called at the TOP of every mutating entry point, before anything is
   * touched: a refusal raised after the detach would strand the session
   * (detached, still archived, no queue marker) — worse than refusing outright.
   *
   * Writable means: it exposes `requireState` (so a faithful spread is possible)
   * or the official `archiveSession`/`unarchiveSession` pair (which read their
   * own state internally).
   */
  const assertRegistryWritable = (reg) => {
    if (typeof reg.requireState === 'function') return
    if (typeof reg.archiveSession === 'function' && typeof reg.unarchiveSession === 'function') return
    throw new SessionManagerError(
      'registry/unavailable',
      'the workspace registry exposes neither requireState nor the official archiveSession/unarchiveSession entry points, so its durable state cannot be updated safely',
    )
  }

  return { registryState, unarchiveThrough, archiveThrough, assertRegistryWritable }
}
