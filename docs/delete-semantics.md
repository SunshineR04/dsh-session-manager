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
  (`cancelPending`) READS the queue, then DROPS THE MARKER, then clears the
  tombstone — and rewrites the marker if the registry write fails.
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
