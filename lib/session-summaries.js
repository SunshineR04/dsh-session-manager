// The pure half of `collectSummaries()`: the session controller's list ENVELOPE
// and one row's projection into the summary shape the manager consumes.
//
// This is the seam that broke in the field. `sessionController.list()` answers
// `{ items: [...] }` — never a bare array — and its rows carry NO `title` and NO
// `createdAt`: `listFields()` adds only `cwd`/`origin`/`parentSessionId`. The
// display title is the `title` PROJECTION (`item.projections.values.title`),
// which is also where the official browser client reads it
// (`projectionValues?.title`). Requiring `Array.isArray(items)` therefore made
// every summary empty on a real host — `title: ''`/`(untitled)`, `cwd: null`,
// `updatedAt: null` for EVERY archived session — silently, while the host test's
// fake (which returned exactly that invented flat array) kept the suite green.
//
// Kept pure and separate so both facts are unit-testable without a host, and so
// `test/contract.test.mjs` can pin them against the installed module.

/**
 * Unwrap the controller's list answer.
 * @returns the rows, or `null` when the shape is UNRECOGNIZED — which callers
 *   must treat as "controller could not answer" (warn once, fall back to the
 *   persistence listing), never as an empty corpus. Silently reporting an empty
 *   corpus is precisely how the old breakage hid.
 */
export function decodeControllerList(raw) {
  if (Array.isArray(raw)) return raw
  if (Array.isArray(raw?.items)) return raw.items
  return null
}

/**
 * The display title of one controller row: the `title` projection when the
 * registry is mounted, with a flat `title` field accepted only as a fallback so
 * a composition that does expose one still works.
 */
export function titleOfRow(item) {
  const projected = item.projections?.values?.title
  if (typeof projected === 'string') return projected
  return typeof item.title === 'string' ? item.title : ''
}

/**
 * Project one controller row into the summary the manager reads. `createdAt` is
 * always `null`: the controller computes `updatedAt` (max(createdAt,
 * lastPromptAt)) and exposes no creation time, so inventing one would be a lie.
 * @returns the summary, or `null` for a row that cannot be addressed.
 */
export function summaryFromControllerRow(item) {
  if (item === null || typeof item !== 'object') return null
  const id = item.sessionId ?? item.id
  if (id === undefined || id === null) return null
  const updatedAt = Number.isFinite(item.updatedAt) ? item.updatedAt : null
  return {
    sessionId: String(id),
    title: titleOfRow(item),
    createdAt: null,
    updatedAt,
    running: item.running === true,
    blank: item.blank === true,
    ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
    ...(item.parentSessionId === undefined ? {} : { parentSessionId: String(item.parentSessionId) }),
    ...(item.origin === undefined ? {} : { origin: item.origin }),
  }
}
