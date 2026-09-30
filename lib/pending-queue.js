// The pending-delete queue's PURE half: its file format, its versioning, and the
// sanitization of everything read back out of it.
//
// No filesystem and no `ctx` — that is the point. This queue is the ONLY record a
// queued deletion can be finished from, and its semantics carry several
// field-learned invariants that used to be reachable only by standing up a whole
// host through `createSessionManager`:
//
//   - the file is an INPUT channel (crash leftovers, hand edits, corruption), so
//     every id is pattern-validated before it can reach a filesystem call;
//   - **v2 records the workspaces a delete detached from**, because a cancelled
//     deletion has to be able to put the session back into its workspace slot —
//     without the record the cancel returns an UNGROUPED row, which is the exact
//     residue shape the tombstone exists to prevent;
//   - a v1 file (bare `sessionIds`, no `detached`) must still read, as "nothing
//     recorded";
//   - a torn or unparseable file must come back `degraded`, never as an empty
//     queue: every writer persists the snapshot it just read, so a tolerant `[]`
//     would erase every live marker on the next write-back and strand their
//     tombstones in the archive set forever.

/** Session ids are addressed by exact full id; this is the one pattern. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/

/** v2 adds the `detached` map. v1 files are still accepted on read. */
export const PENDING_QUEUE_VERSION = 2

/**
 * Decode one queue file body.
 * @param text - the file's contents.
 * @returns `{ entries, malformed, degraded, reason }`. `entries` is
 *   `{ id, workspaces }[]`, deduplicated in file order. `degraded` means the text
 *   exists but could not be understood — callers must REFUSE, never treat it as
 *   an empty queue. `malformed` counts the ids dropped by pattern validation, so
 *   the caller can warn once without this module needing a logger.
 */
export function decodePendingQueue(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    // A half-written file lands here too: the cross-device fallback writes in
    // place, so a crash or a concurrent reader can observe it torn.
    return { entries: [], malformed: 0, degraded: true, reason: `the queue file is not valid JSON: ${error.message}` }
  }
  const raw = Array.isArray(parsed?.sessionIds) ? parsed.sessionIds.filter((id) => typeof id === 'string') : []
  const ids = raw.filter((id) => SESSION_ID_PATTERN.test(id))
  // A v1 file has no `detached`: nothing was recorded, and the cancel still
  // works — it just cannot restore the grouping.
  const detached = parsed?.detached !== null && typeof parsed?.detached === 'object' && !Array.isArray(parsed?.detached)
    ? parsed.detached
    : {}
  const entries = [...new Set(ids)].map((id) => ({
    id,
    workspaces: Array.isArray(detached[id])
      ? detached[id].filter((workspaceId) => typeof workspaceId === 'string' && workspaceId.length > 0)
      : [],
  }))
  return { entries, malformed: raw.length - ids.length, degraded: false, reason: undefined }
}

/**
 * Encode queue entries as the v2 body.
 *
 * Accepts bare ids (callers with nothing to record) or `{ id, workspaces }`.
 * Ids are re-validated here as well as on read: this is the other end of the
 * same input channel, and a malformed id must never reach the file that the raw
 * sessions-root scan later consumes.
 */
export function encodePendingQueue(entries) {
  const normalized = []
  for (const entry of entries) {
    const id = typeof entry === 'string' ? entry : entry?.id
    if (typeof id !== 'string' || !SESSION_ID_PATTERN.test(id)) continue
    const workspaces = typeof entry === 'string' || !Array.isArray(entry?.workspaces)
      ? []
      : [...new Set(entry.workspaces.filter((workspaceId) => typeof workspaceId === 'string' && workspaceId.length > 0))]
    normalized.push({ id, workspaces })
  }
  const ids = [...new Set(normalized.map((entry) => entry.id))]
  const detached = {}
  for (const entry of normalized) {
    if (entry.workspaces.length > 0) detached[entry.id] = entry.workspaces
  }
  return JSON.stringify({ version: PENDING_QUEUE_VERSION, sessionIds: ids, detached }, null, 2)
}
