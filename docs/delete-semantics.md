# Delete semantics — the residue and the tombstone (full narrative)

This is the long-form record of the two invariants that AGENTS.md summarises as
"an open-session delete leaves a residue" and "open (live-idle) sessions delete
immediately, via a tombstone". AGENTS.md keeps the rules an agent must not
break; this file keeps the reasoning, the field evidence and the rejected fixes.

Evidence, probes and the chronological record live in
`docs/analysis-deleted-open-session-still-listed.md`.
- **An open-session delete leaves a residue — four rules, all load-bearing**
  (evidence in `docs/analysis-deleted-open-session-still-listed.md` §8):
  1. **The client must never pull the list for a queued id.**
     `pendingDeleteIds` is fed by the `rpc` wrapper (`deferred/list` union;
     `delete` with `openAtDelete === true` adds; `deferred/cancel` removes) and
     NOT by the components: the settings section and the menu item are
     module-scope and cannot see `apply`'s closure, so a helper called from
     there throws (`rememberPendingDelete is not defined` — caught by the
     component and reported as a per-row failure). `scheduleRemovedRefresh`
     checks the set **when scheduling AND when firing**: the delete RESPONSE and
     the event travel on different channels and the event usually arrives first,
     so a schedule-time-only guard still pulls the husk back (e2e-proven).
     Every OTHER pull — the Refresh button, `refreshUntilGone`, a cancel, the
     bulk run — goes through the injected `pullSessions`, which re-checks the
     residue right after pulling: the store subscription already covers an
     observable store, and that explicit `evaluateResidue()` is the only trigger
     when `list.subscribe` is missing or throws. A bulk run containing ANY open
     delete skips its whole-run pull (`deleted > 0 && openDeleted === 0`):
     `api-session/removed` already dropped those ids locally, and the pull would
     re-learn the still-live copies.
  2. **The tombstone hides the residue in the DEFAULT view only.** 视图选项 →
     全部对话（显示已归档）/仅显示已归档 renders archived strays inside the
     ungrouped bucket — that is the reported "deleted session came back".
     `reannouncePendingRemovals` (config, **default `true`** since 0.4.1 — read
     as `!== false`, like `menuDeleteAvailable`, so a raw composition config
     still gets the default) is the repair hook:
     on every `deferred/list` the host re-announces `api-session/removed` for
     queued ids whose session is still LIVE. The client triggers it through
     `evaluateResidue`/`scheduleRepair` one repair per residue episode (never a
     poll loop) — keep that invariant.
  3. **Do NOT "fix" this by detaching the live session**
     (`sessions.liveEntryFor(...).detach()`): the agent stays registered for the
     process lifetime (the controller discards the only `dispose()` handle),
     `sessions.flush()` then throws for that id (goal driver, checkpoint policy,
     message-feedback, subagent continuation and agent-team are all mounted),
     `waitForDrainingConfiguredIdentity` waits on agents AND sessions so a
     config-driven same-id start stalls, and `session/disposed` listeners write
     artifacts back (projection-cache checkpoint; JSONL final drain through a
     `mkdir`-ing path). Full list in the analysis doc §8.1.
  4. **The residue block is armed by a SUCCESSFUL queue read, never by the
     ping.** `pendingDeleteIds` and the store watch are installed only in
     `observePending`, i.e. only by a `deferred/list` that landed; the ping
     proves the host is reachable and nothing more. Marking the seed from the
     ping left the block disarmed for the page's lifetime whenever that first
     read failed — the event-driven pull re-materialised every husk and the host
     repair was never asked, silently: rules 1–2 both inoperative in the exact
     field scenario they exist for (proven by probe: `pulls` 0 with the seed,
     1 without it). So `observePending` sets `pendingSeeded` and
     `seedPendingQueue` retries a failed seed with the ping's own 1s/3s backoff,
     then gives up with one `console.warn` — keep it retried, and keep the
     pending-seed timer in the teardown disposer.
  Regression cover: the residue rules are pinned in `test/host.test.mjs` (queue
  reads, re-announce, sweep) and `test/client.render.test.mjs` (removal events,
  the schedule/fire guard, the seed retry, the banner split, the dialog), with
  `scripts/e2e-residue.mjs` as the real-Chrome acceptance (`grep -n "residue"` in
  both suites lists the cases; the test names are the contract, so do not rename
  one without updating the behaviour it claims).
- **Open (live-idle) sessions delete immediately, via a tombstone**: dsh has no
  public "close session" API — the in-memory summary outlives the delete (its
  owner scope is the session-controller service scope, not the UI view), but
  appends open the log by path and never recreate a deleted directory, so
  files can go right away. `deleteSession` runs the read-only existence check,
  then queues the id BEFORE any mutation (crash safety), detaches it, keeps it
  in the archive set as a **tombstone** (the official archive filter hides the
  lingering summary in the DEFAULT view — a sidebar set to show archived rows
  renders it; see the residue rules above), disposes
  files + projcache, emits `api-session/removed`, and reports
  `openAtDelete: true`. The next-boot sweep calls `finishDeferredDeletion`,
  which must clear the tombstone even when `sessionKnown` is false (files
  already gone). The settings page additionally filters queued ids out of its
  rows (client-side, via `pendingIds`). `deferred/list` reports which queued
  ids are still `recoverable` (artifact dir on disk); `deferred/cancel`
  (`cancelPending`) REFUSES an id that is not queued at all
  (`session/not-pending` — cancelling is the one operation that puts a session
  BACK, so a stale or hand-made request must not restore something nobody
  queued; `restoreSession`'s `session/pending` refusal is its mirror image),
  then READS the queue, then DROPS THE MARKER, then clears the tombstone — and
  rewrites the marker if the registry write fails.
- **A cold delete takes the SAME route and finishes inside the same call.** The
  marker and the tombstone are not an open-session speciality any more: the
  marker is what makes the file phase crash-safe, and a cold delete used to write
  none, so a crash between the archive-set write and the `rm` left a session that
  was un-archived, detached and unqueued while its files stayed on disk — the
  next start listed it as an ungrouped row and this plugin could no longer list,
  restore or retry it (the corpus read inside the file phase makes that window
  wide, not instantaneous). Because nothing of a cold session outlives the
  delete, `deleteLocked` clears the tombstone and drops the marker itself once
  the files are gone; a file-phase failure (or a throwing detach) leaves the
  entry tombstoned AND queued, which is exactly the state `finishDeferredDeletion`
  already knows how to complete. The one exception: an unreadable queue, where a
  cold delete still proceeds (the escape hatch) without a marker and REPORTS that
  it is not crash-safe, while an open delete refuses.
  ⚠ **The order is marker-first for a data-safety reason, and the earlier
  "clear the tombstone, then drop the marker" rationale was incomplete.** Both
  halves are durable writes and the pair is not atomic, so a failure between
  them strands exactly one of two states. "Marker dropped, tombstone still set"
  is harmless: the session stays hidden, and nothing finishes a deletion without
  a queued marker, so a retry or a restore resolves it. "Tombstone cleared,
  marker still set" is DATA LOSS — the boot sweep reads the surviving marker and
  deletes the session the user just cancelled, after the failed cancel told them
  nothing had happened (proven by probe: the cancel throws, the session
  reappears in the list, and the next start removes its files). The old order
  was chosen for the REGISTRY-failure case and is right for it; marker-first
  plus a compensating `_addPending` also keeps that case retryable, so nothing
  is given up. It also REFUSES entries whose files are already gone
  (`session/data-gone`) —
  un-tombstoning one would expose the artifact-less lingering summary as an
  ungrouped row, so the UI's hidden cancel button is a protocol rule, not a
  convention. The pending banner splits on that same flag: only `recoverable`
  ids get a row with a **Cancel deletion** button, while cleaned-up ids (the
  normal open-session delete — the host exposes NO public way to dispose a
  live session, so the tombstone must stand until the next boot) collapse into
  one summary line with an optional id expander. `restoreSession` REFUSES queued ids
  (`session/pending`) — un-tombstoning one would expose an artifact-less husk.
  A session with a RUNNING task is refused; `allowDeleteRunning: true` skips only
  that refusal — the delete is still tombstoned and queued. `isOpen` alone decides
  the treatment (tombstone, pending marker, `openAtDelete`); folding the flag into
  it used to strip the tombstone from open-idle deletes too, which is exactly the
  resurrection shape the tombstone exists to prevent.

## The subagent subtree (`cascadeSubagents`, default ON, 0.5.0)

A permanent delete removes the session's whole subagent subtree as well: its
subagent children, their children, and so on, **deepest first, with the session
the user clicked deleted last**.

**Why the cascade exists — the orphan is unreachable, not merely invisible.**
dsh's sidebar returns `false` for a session whose `origin === 'subagent'`
(`dsh-client-ui-workspace/lib/client.js`), the settings page of this plugin filters
the same origin (its rows are the user's conversations, not the model's), and the
agent tool refuses any id that is not archived. So a subagent artifact left behind
by a parent's delete has **no surface that could ever remove it again**: no row to
click in either UI, no listing that carries it (`listArchived` only lists the
archive set; subagent sessions are never archived), no tool that accepts it. It is
pure disk. Measured on the field home that motivated this: **68 orphan artifacts,
23.1 MB** — 43 first-level children plus **25 grandchildren**, which is why the
discovery is a closure and not one `parentSession` lookup (a one-level sweep found
the 43 and left the 25).

**The link is exact, and upstream says so.** The persisted session header carries
`parentSession` (string) and `origin`, and the installed backend's header
validator accepts `origin` as **exactly** `undefined` or `"subagent"`
(`dsh-session-persistence-jsonl`: `value.origin === void 0 || value.origin ===
"subagent"`; its own internal child query is `source.header.origin === "subagent"
&& source.header.parentSession === id`). A forked session, an agent-team session
that is not a subagent, or any other independent session therefore carries no
`origin` and can NEVER be swept up by a cascade — the `origin` check is not
belt-and-braces, it is the whole separation between "my subagent's transcript" and
"my other conversation".

**Deepest first is a crash-safety property, not a detail.** `deleteOneLocked` per
id keeps the same marker-then-bookkeeping-then-files order for a child as for the
target. Ordering the subtree deepest-first means a crash part-way through leaves
every remaining child with its parent **still on disk**, so the user's next attempt
(a re-run, or the boot sweep via the markers already written) still finds it.
Deleting the parent first would strand its children as exactly the orphan shape
this cascade exists to eliminate — including the grandchildren, whose link to the
tree would be gone with their parent.

**Refusals are decided once, before anything is touched.** If any descendant has a
RUNNING task, the whole delete is refused with `session/running` and
`details.runningSubagents` unless `allowDeleteRunning` is on: half a subtree is
worse than a refusal, and a refusal that arrives after three children are gone
would be a nasty surprise. `deleteOneLocked` keeps its own per-id running check as
a second layer.

**Only the ROOT is gated like a user-facing session.** A descendant skips
`session/not-found` (its header is why it is in the plan) and DEGRADES on a
registry-write failure: the failure becomes a labelled warning
(`subagent <id>: …`) and the deletion continues, because the child's marker is
durable either way and the boot sweep can finish it. One odd child must not strand
its siblings. The target keeps the strict behavior documented above (a failed
tombstone write on the target still throws, with `queued: true`).

**Reported, never silent.** The `delete` result carries
`subagents: { total, sessionIds }`; the menu toast, the settings-page row toast and
the bulk summary all append "including N subagent session(s)" (the bulk run SUMS
over its targets), and the agent tool's reply carries the same field. That line is
the only place a user can learn those sessions existed. `api-session/removed` is
emitted for every cascaded id as well — the sidebar filters subagent rows at
RENDER time, but the client list store holds their summaries, and a stale entry
there is what the residue rules exist to prevent.

**Setting it off.** `cascadeSubagents: false` restores "delete exactly the id you
asked for" — for a deployment that treats subagent transcripts as auditable
records. Nothing else changes; the discovery read is skipped entirely, so the
corpus index is only built for the file phase.

## The orphan cleanup (`orphans/list` / `orphans/delete`, settings page)

The cascade can only start from a parent that still EXISTS, so it can never reach
the orphans that already accumulated — hence a second, explicit path. The settings
page grows a block whenever the host reports orphans: how many, how many MB, and
one confirmed cleanup button.

**Definition.** An orphan is a subagent session (`origin === 'subagent'`) whose
`parentSession` id is known to NO source — neither the corpus listing nor the
controller. `orphanSubagentClosure` computes it in `lib/subagent-tree.js` as the
same CLOSURE the cascade uses (starting from every known id and repeatedly
dropping a subagent whose parent no longer survives), because a one-level lookup
reports a doomed child's OWN children as healthy: the measured field case was 43
first-level orphans plus 25 grandchildren.

**Two guards, both load-bearing.**

1. **A grace period** (`orphanGraceHours`, default 24 h) measured from the
   artifact directory's mtime. A session that is still being written must never
   look like residue, and an orphan whose artifact directory is gone entirely is
   held back too (there is nothing to reclaim and no age to establish). ⚠ Read it
   through the `orphanGraceHours()` helper, never the raw field: a raw composition
   config carries no schema defaults, so `Number(undefined)` → `NaN` → `Date.now()
   - mtime < NaN` is false for EVERY entry, i.e. a NaN grace silently means no
   grace at all.
2. **The list is recomputed inside `deleteOrphans`.** The client's view is a
   snapshot; an id that became reachable again (a restored home, a re-indexed
   header, the cascade having run) must not be deleted by a stale click. Ineligible
   ids are skipped and REPORTED in `warnings`, and a request whose ids are all
   ineligible is refused with `bad-request` rather than answering "nothing to do".

Deletion goes through `deleteOneLocked(..., { isRoot: false })` — the same per-id
body a normal delete uses (marker, bookkeeping, files, projcache, removal
broadcast) — ordered deepest-first per subtree, so a crash mid-cleanup never
strands a child whose own parent has already been removed.

The block is cosmetically silent when there is nothing to clean, and a failed
`orphans/list` keeps it hidden with a `console.warn` rather than painting the
failure banner: unlike a failed `deferred/list` (which would render a queued
session as an ordinary row), a failed orphan read cannot mislead about anything
the user is about to destroy — the destructive call re-derives the list itself.


