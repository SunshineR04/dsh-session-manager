// Subagent relationship rules — pure, host-free.
//
// A permanent delete should take a session's whole subagent subtree with it: the
// official sidebar never renders `origin === 'subagent'` sessions
// (`dsh-client-ui-workspace/lib/client.js`: `if (session.origin === "subagent")
// return false`), so a child left behind is invisible AND unreachable — there is
// no row to click, ours or the official one. That is exactly how 68 orphan
// artifacts (23 MB) accumulated in the field before this module existed.
//
// The link lives in the persisted session header, and the upstream schema makes
// the rule exact rather than heuristic: `parentSession` is a string field and
// `origin` may ONLY be `"subagent"` (verified against the installed
// `dsh-session-persistence-jsonl`: its header validator accepts
// `value.origin === void 0 || value.origin === "subagent"`, and its own internal
// child query is `source.header.origin === "subagent" &&
// source.header.parentSession === id`). A forked or otherwise independent
// session carries no `origin`, so it can never be swept up by a cascade.
//
// The ordering is load-bearing too: DEEPEST FIRST. A crash mid-cascade then
// leaves every remaining child with its parent still on disk — re-running the
// delete finds it again — whereas deleting the parent first would strand its
// children as the very orphans this is meant to prevent.

/** The header inside one `persistence.list()` snapshot, or `undefined`. The
 *  listing yields `{ header, revision, sizeBytes }` WRAPPERS, never bare
 *  headers; an entry without one is skipped, never guessed at. */
const headerOf = (snapshot) => {
  if (snapshot === undefined || snapshot === null) return undefined
  const header = snapshot.header
  if (header === undefined || header === null) return undefined
  return header
}

/**
 * Direct subagent children of `parentId`, from one corpus index
 * (`{ snapshots }` — see `createArtifactResolver().index`).
 * @returns ids as strings, in listing order; empty when nothing matches.
 */
export function subagentChildrenOf(corpus, parentId) {
  const parent = String(parentId)
  const children = []
  for (const snapshot of corpus?.snapshots ?? []) {
    const header = headerOf(snapshot)
    if (header === undefined) continue
    if (header.origin !== 'subagent') continue
    if (header.parentSession === undefined || header.parentSession === null) continue
    if (header.id === undefined || header.id === null) continue
    if (String(header.parentSession) !== parent) continue
    children.push(String(header.id))
  }
  return children
}

/**
 * The orphan closure: subagent sessions whose parent is known to NO source.
 *
 * This is a CLOSURE, not one level, and that is the whole point: a subagent that
 * spawned subagents has children whose parent IS present on disk (the doomed
 * child), so a single `parentSession` lookup reports them as healthy and leaves
 * them behind. The measured field case was 43 first-level orphans plus **25
 * grandchildren**. Starting from every known id and repeatedly dropping a
 * subagent whose parent no longer survives converges on the whole unreachable
 * subtree.
 * @param corpus - the shared corpus index (`{ snapshots }`).
 * @param knownIds - ids known from sources OUTSIDE the corpus (the controller's
 *   list covers live sessions whose header is not written yet). The corpus's own
 *   header ids are added here, never trusted from the caller.
 * @returns the orphan ids, in discovery order (deepest-last); safe to iterate
 *   while deleting, but callers that must delete deepest-first should order each
 *   subtree with `subagentDescendants`.
 */
export function orphanSubagentClosure(corpus, knownIds) {
  const surviving = new Set()
  for (const id of knownIds ?? []) {
    if (id === undefined || id === null) continue
    surviving.add(String(id))
  }
  for (const snapshot of corpus?.snapshots ?? []) {
    const header = headerOf(snapshot)
    if (header === undefined) continue
    if (header.id === undefined || header.id === null) continue
    surviving.add(String(header.id))
  }

  const orphans = []
  for (;;) {
    let grew = false
    for (const snapshot of corpus?.snapshots ?? []) {
      const header = headerOf(snapshot)
      if (header === undefined) continue
      if (header.origin !== 'subagent') continue
      if (header.parentSession === undefined || header.parentSession === null) continue
      if (header.id === undefined || header.id === null) continue
      const id = String(header.id)
      if (!surviving.has(id)) continue
      if (surviving.has(String(header.parentSession))) continue
      surviving.delete(id)
      orphans.push(id)
      grew = true
    }
    if (!grew) break
  }
  return orphans
}

/**
 * Every descendant of `rootId`, DEEPEST FIRST (children before their own
 * children's parents — i.e. a valid deletion order). Cycles and duplicate ids
 * are collapsed; a header without a usable id is skipped rather than guessed at.
 * `rootId` itself is never part of the result.
 * @param corpus - the shared corpus index (`{ snapshots }`).
 * @param rootId - the session being deleted.
 */
export function subagentDescendants(corpus, rootId) {
  const root = String(rootId)
  const childrenByParent = new Map()
  for (const snapshot of corpus?.snapshots ?? []) {
    const header = headerOf(snapshot)
    if (header === undefined) continue
    if (header.origin !== 'subagent') continue
    if (header.parentSession === undefined || header.parentSession === null) continue
    const id = header.id
    if (id === undefined || id === null) continue
    const parent = String(header.parentSession)
    const siblings = childrenByParent.get(parent)
    if (siblings === undefined) childrenByParent.set(parent, [String(id)])
    else siblings.push(String(id))
  }

  const ordered = []
  const visited = new Set()
  // Iterative post-order: recursion depth is bounded by the delegation depth,
  // but a corrupt header could claim an arbitrarily deep chain, and a stack
  // overflow inside a delete would be a needless failure mode. `visited` is
  // marked on POP, so a header that claims a cycle terminates instead of
  // looping forever.
  const stack = [{ id: root, expanded: false }]
  while (stack.length > 0) {
    const frame = stack.pop()
    if (frame.expanded) {
      if (frame.id !== root) ordered.push(frame.id)
      continue
    }
    if (visited.has(frame.id)) continue
    visited.add(frame.id)
    stack.push({ id: frame.id, expanded: true })
    const children = childrenByParent.get(frame.id) ?? []
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]
      if (visited.has(child)) continue
      stack.push({ id: child, expanded: false })
    }
  }
  return ordered
}
