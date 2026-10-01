# Changelog

Keyed to the repository's tags. The dsh plugin API is versioned with the plugin,
so a change that requires a newer dsh host says so explicitly.

> **Note on 0.4.0.** There is no `v0.4.0` tag and `package.json` never contained
> that version: the release went `0.3.9` → `0.4.1`. `docs/analysis-deleted-open-session-still-listed.md`
> records field evidence dated to a build reporting `0.4.0` (the pre-release of
> the same work); read those references as 0.4.1.

## [Unreleased]

- **The destructive-e2e guard resolves the real home through its existing
  PARENT.** CI run #19 failed one case on BOTH legs
  (`a junction or symlink pointing at the real home is refused AS the real home`)
  purely because a runner has no dsh install: `~/.dsh` does not exist there, so
  the link is dangling, `realpathSync` throws and falls back to `resolve()`. That
  was not only a test defect — `realpathSync` does not run on a missing path, so
  the real home kept the caller's spelling while the target got resolved (8.3
  short names, case), and the equality/prefix rules could MISS, leaving the
  marker check as the only thing between a path inside the real home and a
  delete. `canonical()` now resolves the nearest existing ancestor and re-appends
  the missing tail, the real home is compared in both forms (its path and its
  resolved target, so a symlinked home is refused either way), and a new case
  runs the guard against a FAKE home — the CI shape — asserting both the ancestor
  and the inside-the-home refusals there. Tooling only: `scripts/` is not shipped
  in the package, so the 0.4.8 tag stays where it is.

## [0.4.8] - 2026-10-02

A second review-driven release. Every fix below is regression-guarded by a test
that was mutation-checked against the OLD code (the new cases were run with the
fix reverted, and each failed).

### Fixed — a cold delete could be lost in its own crash window

- **A cold delete now writes the pending marker and takes the archive-set
  tombstone, and finishes both inside the same call.** It used to write no marker
  at all, so a crash between the archive-set write and the `rm` left a session
  that was un-archived, detached and unqueued while its files stayed on disk: the
  next start listed it again as an **ungrouped row**, and this plugin could no
  longer list, restore or retry it. The corpus read inside the file phase made
  that window wide, not instantaneous. A cold session has no in-memory copy that
  can outlive it, so the deletion now completes synchronously — tombstone and
  marker cleared once the files are gone.
- **A file-phase failure on a cold delete no longer reports a finished delete.**
  The entry stays tombstoned AND queued, which is exactly the state the boot
  sweep exists to finish; reporting success while the row could come back was the
  "resurrection" shape in slow motion. The result says so in its warnings.
- **The marker and the tombstone are now written as a pair or not at all.** A
  tombstone with no marker to clear it is the one strand nothing recovers from,
  so the one remaining escape hatch — a cold delete on an unreadable queue, kept
  because it is the only delete left when the file is corrupt — proceeds WITHOUT
  either and reports that it is not crash-safe.
- **`deferred/cancel` refuses an id that is not queued, with the new stable code
  `session/not-pending`.** Cancelling is the one operation that puts a session
  back: it clears a tombstone. Without the guard, cancelling a merely archived id
  cleared its archive membership and returned success — a restore nobody asked
  for, reachable from a stale client, a second window, a hand-made request, or
  two hosts on one `DSH_HOME`. `restoreSession`'s `session/pending` refusal is
  its mirror image; the check comes before the `session/data-gone` probe, because
  for an id nobody queued the request itself is wrong.

### Fixed — the client: focus, keyboard ownership, and silent skips

- **A confirmed row delete no longer drops focus on `<body>`.** `focusAfterDelete`
  asked `[data-sm-row-delete], [data-sm-bulk-delete]` — and the bulk button is
  FIRST in document order while being `disabled` with an empty selection, and
  focusing a disabled control is a spec'd no-op. So every confirmed delete asked
  a control that could not take focus and the section fallback below it was
  unreachable. The selector now carries `:not([disabled])`, and the render test
  asserts WHICH target was asked (the old assertion only counted requests, which
  is how this shipped).
- **Cancelling the context-menu delete hands focus back.** The menu item IS the
  opener and is unmounted when the menu closes, so the "restore to the opener"
  branch could not work there — the code's own comment claimed it fell forward
  and it did not. Focus now falls through to the caller's landing logic, which
  focuses the session row.
- **Escape in the confirm dialog claims the key.** Our capture-phase handler ran
  first and prevented nothing, while the Settings panel behind the dialog is a
  `useModalLayer` consumer whose document-level Escape handler bails out on
  `event.defaultPrevented` — so one Escape cancelled the dialog AND closed the
  whole Settings page (whose own focus restore then overrode ours).
- **A bulk run reports the running sessions it skipped.** `deleted` counted only
  successes and the summary mentioned only deleted/failed, so confirming five
  sessions and deleting two read as "deleted 2"; if every target turned running
  the run finished in total silence. The skips are counted, added to the summary
  and to the success line, the progress counter advances for them, and the
  all-running case always says something.
- **The plain-DOM toast takes a `kind` and is named `plainToast`.** It painted
  every message in the error colour, so the menu path's ONLY feedback channel
  drew a successful permanent delete exactly like a failure — and sharing the
  name `toast` with the component-local `toast(kind, text)` made a one-argument
  call inside the component a warning toast with `undefined` text.

### Fixed — accessibility: AA on the surfaces the acceptance script cannot see

Measured against the installed theme tokens (WCAG 2.x relative luminance).
`e2e-contrast.mjs` samples three buttons on the OPAQUE card, so none of these
were covered by its 4/4 pass:

- **The `role="alert"` failure banner was the failure channel and missed AA in
  both themes** — `dangerText` on
  `--dsw-alias-interactive-bg-hover-danger` (`#ec13130d` light / `#f25a5a26`
  dark) measured **4.44:1 light and 3.94:1 dark**. It now sits on the opaque
  `panelSurface` with a 1px danger border, where the same text measures
  4.83/4.73 — the same rule the cards, rows and toasts already followed.
- **Link/action text** (`Restore`, `Refresh`, `Cancel deletion`, the running
  pill) was `--dsw-alias-state-business-primary` = **4.24:1** on the light card —
  under AA, while the file's own hardcoded fallback (`#4a5cf0`) would have passed
  5.15:1. New `TOKENS.primaryText` = `light-dark(#4868b2, #7aaaff)` = 5.39/5.99:1.
- **Small meta text** was `--dsw-alias-label-tertiary` = **3.70:1** on the light
  card. New `TOKENS.metaText` = `light-dark(#61666b, #adb2b8)` = 5.80/6.53:1, and
  there is deliberately no `textTertiary` token left to use by accident.
- **The dialog's danger button** left its white label at **4.4976:1** on the
  theme's `#ec1313` — the very number this repository cites as the reason that
  red cannot carry text, and it is just as short under a white label. New
  `TOKENS.dangerFill` = `light-dark(#dc2626, #f25a5a)` = 4.83:1 in light.

### Fixed — the e2e tooling that can delete a real user's sessions

- **The URL is now bound to the validated home.** `assertDisposableHome` proved
  the home was throwaway but nothing proved the instance behind the page used it,
  so `node scripts/e2e-residue.mjs <your real instance URL> --home <seeded>`
  passed every check and permanently deleted real sessions. Every destructive
  script now calls `assertInstanceServesHome` first: it asks the page for the
  session ids it can see (the plugin's own `list` endpoint plus the
  `[data-row-key^="session:"]` rows) and requires all of them to exist in the
  seeded home, failing CLOSED when the page reports nothing.
- **The marker is validated instead of trusted by name.** A directory called
  `.session-manager-e2e` used to satisfy it, and so did a stale marker restored
  from a home snapshot. It must now be a regular JSON file written by this
  repository's seed, recording THIS home (the seed writes `home`; a pre-0.4.8
  marker is refused, so an old home must be re-seeded).
- **The real-home refusal survives case variants, short names, junctions and
  `\\?\` paths** — it canonicalizes with `realpathSync.native` and compares
  case-insensitively on Windows, and refuses anything INSIDE the real home too.
- **`e2e-seed.mjs` cannot half-destroy a home any more**: the full spec shape and
  a `source != target` refusal now run before the first `rm`, and the marker is
  written BEFORE it — a spec with a valid `sessions` array but no `workspaces`
  used to crash after the delete and after copying the real `.credentials.yaml`,
  leaving a mutilated, unmarked home holding a secret that no script would accept
  again. A session-copy failure is fatal instead of a warning.
- **`e2e-contrast.mjs` still exits 2 when the archived ROW was not measured.**
  The header's bulk-delete and Refresh buttons render on an empty archive set
  too, so "something was measured" silently degraded into a one-button check.
- **`e2e-probe.mjs`'s module-roster line can be true now** — it scanned
  `Object.keys(window.__DSH_BOOT__)` for a module name, which is always false
  (the wire object's keys are `rev`/`entries`/`batches`).
- **The analysis doc's session ids are truncated**, per this repository's own
  "no real ids in the repo" rule.

### Added — guards for the classes above

- **`test/e2e-guard.test.mjs` (new, 11 cases)**: the destructive-e2e guard had
  only ever been "verified" by running a script against a good home. It now has
  unit coverage that needs no dsh and no Chrome — the real-home refusal (name,
  prefix, an ANCESTOR of it, case variant, junction), the marker validation
  (directory, non-JSON, foreign plugin, different home, missing `home`), the id
  set, and the instance↔home binding including its fail-closed rule. It never
  writes inside the real home.
- **`apply` is asserted to mount the agent tools.** Deleting
  `registerTools(ctx, manager)` used to keep the suite green while all three
  tools silently never mounted (the test whose name says "…but still mounts
  tools" asserted only a warning), and the list tool's `execute` body — limit
  clamp, item projection, error branch — had never run at all.
- **The `settings` fake now has the REAL surface** (`configure`/`describe`/
  `update`/`documentPath`, no `get`). It used to hand the manager a `get()` the
  installed service does not have, and drove the only test of the
  `sessionListLimit` clamp through it — the invented-shape class that has hidden
  three field bugs in this project. The clamp is now driven through the
  composition config, and `truncated` (previously unasserted) is pinned.
- New client cases: the disabled-control focus rule, the cancel-path focus, the
  Escape claim, the bulk skip report, and all four AA replacements above.

**Test count: 178 → 199 (0 fail, 0 skip).**

## [0.4.7] - 2026-10-01

A review-driven release. Every fix here is regression-guarded by a test that was
mutation-checked against the OLD code (the new cases were run with the fix
reverted, and each failed).

### Fixed — data loss: a failed cancel could still be completed by the next boot

- **`cancelPending` now drops the pending marker BEFORE clearing the tombstone,
  and rewrites it if the registry write fails.** The two writes are durable and
  the pair is not atomic, so a failure between them stranded "tombstone cleared,
  marker still set" — the boot sweep then read that surviving marker and deleted
  the session the user had just cancelled, after the failed cancel told them
  nothing had happened. Proven by probe before the fix (cancel throws → the
  session reappears in the list → the next start deletes its files). The
  marker-first order keeps the registry-failure case retryable, which is what the
  old order was defending. `finishDeferredDeletion` deliberately keeps the
  opposite order: there both writes finish the same deletion, and a stranded
  marker is merely an unfinished delete.
- **Registry bookkeeping is no longer able to half-book a delete.**
  `workspace.detachSession` failures are collected as warnings instead of
  aborting the loop — aborting left the session detached from some workspaces,
  still archived and with its files intact, i.e. the "ungrouped resurrection"
  shape. The archive-set write is still allowed to fail the operation, and when
  an OPEN delete's marker is already durable it now reports
  `details.queued === true` plus a message saying a restart will finish it.
- **A throwing liveness seam no longer aborts a confirmed delete.** `readLiveEntry`
  separates "the seam answered: not live" from "the seam failed: unknown".
  `deleteSession` treats unknown as cold (files are addressed by id, and refusing
  would break a delete the user confirmed); the autonomous boot sweep keeps the
  entry queued, because a seam that is down is exactly when a session may still
  be open.

### Fixed — a silently empty pending queue

- **`decodePendingQueue` now refuses a body that parses but is not this format**
  (`{}`, `null`, `[]`, a future v3 shape, `sessionIds: null`). It used to answer
  `degraded: false` with zero entries — indistinguishable from a legitimately
  empty queue — and since every writer persists the snapshot it just read, the
  next write-back would publish `[]` and erase every live marker. A v1 body and a
  real `{ version, sessionIds: [] }` still read normally.
- **`deferred/list` no longer re-reads the queue through the TOLERANT reader.**
  A file that turned torn between the two reads came back as an empty queue with
  `ok: true`, so a queued session rendered as an ordinary archived row with no
  feedback.

### Fixed — the menu path failed silently, and focus was lost

- **A second delete while the first is still running now reports itself.** It
  used to return with no dialog, no toast and no error — on the flagship entry
  point, which reads as "the plugin is broken" and contradicts this file's own
  "the menu path must never fail silently" rule. The guard also had a TDZ trap:
  it read `t` from a destructuring that sits after it.
- **A confirmed delete no longer drops focus on `<body>`.** The dialog restores
  focus to its opener, but a confirmed delete unmounts the row that opened it
  (the list refreshes), so keyboard users were thrown to the top of the document
  (WCAG 2.4.3, Level A). Focus now lands on a stable neighbour — the next row's
  delete control, else the section root (`data-sm-section`, made focusable for
  exactly this) — and the menu path falls back to the session row.

### Fixed — accessibility: danger text did not meet WCAG AA

- **Measured in the live GUI, the row's 12.5px 彻底删除 was 4.24:1** against the
  dark card surface, below the 4.5:1 floor (the light theme was also marginal at
  the aliased red-600, 4.50:1). The theme ships no red that clears AA as TEXT on
  both surfaces, so a `dangerText` token now uses `light-dark(#dc2626, #f36b6b)`
  — the primitive the host's own `color-scheme: light|dark` makes resolvable in
  inline styles, where a var() fallback inside `light-dark()` would have pinned
  BOTH branches to one value. (An earlier candidate derived the colour with
  `color-mix()` and made the dark theme WORSE: 4.24 → 2.96. Do not go back to
  it — measure, see AGENTS.md.) `danger` keeps the FILL role (the confirm
  button's background, toast borders); the fill itself was deepened separately in
  0.4.8.

### Fixed — the e2e scripts could not see what they claimed to test

- **Row discovery goes through `data-row-key="session:<id>"`.** The old
  `button[aria-label*="的操作"]` plus "climb to a wide element" heuristic matched
  the **WORKSPACE** row (its label is `工作区“…”的操作`), so `e2e-check`,
  `e2e-realclick`, `e2e-mutations` and `e2e-live` silently exercised the wrong
  element and reported `[row] null` — which reads as a fixture problem.
- **Menu items are matched by substring.** dsh appends shortcut hints
  (`归档会话` renders as `归档会话Ctrl+Alt+A`), so the `=== '彻底删除'` lookups
  had already stopped matching.
- **`e2e-realclick.mjs`'s bug-1 checks are real assertions.** They were
  `console.log` calls inside a script that the docs listed as one that "can
  FAIL", so a true regression (a real click opens no dialog) exited 0.
- README.md, README.zh.md and AGENTS.md now carry an accurate table of which
  scripts can actually fail, and AGENTS.md records that the e2e fixtures are
  consumable (`e2e-residue.mjs` deletes the one openable session the seed
  creates, so a later script's `no restorable session to open` is a spent
  fixture, not a plugin bug).

### Added — guards for the classes above

- `test/client.render.test.mjs` drives the REAL `rpc` wrapper through
  `ctx.get('connection')` (`renderSection()` with no `rpc` override) and asserts
  the structured `error.code`; deleting that assignment used to keep all 165
  tests green.
- New host cases: a refused cancel rolls the marker back; a failed queue write
  during cancel touches neither half; a throwing liveness seam does not abort a
  delete; a failing detach is a warning; an archive-set failure reports
  `queued`; a sweep whose tombstone write fails keeps the entry queued.
- New client cases: the busy guard reports itself; a confirmed delete asks a
  stable element for focus; the section declares its focus targets.
- `test/pending-queue.test.mjs` pins the degraded/not-degraded boundary in both
  directions.

**Test count: 165 → 178 (0 fail, 0 skip).**

## [0.4.6] - 2026-09-30

### Added — packaging guards (the "register a new file" rule is now machine-enforced)

- **`test/packaging.test.mjs` (new, 6 cases).** AGENTS.md has always stated that a
  new runtime file must be added to BOTH `package.json → files` and
  `scripts.test`, and that rule has been the failure mode more than once: a file
  missing from `files` ships a broken package while every local run stays green,
  and a suite missing from `scripts.test` never runs at all. The suite now asserts
  it mechanically — every `lib/*.js` is in `files` and in `scripts.check`, every
  `test/*.test.mjs` on disk is named in `scripts.test`, every suite named there
  exists and appears once, the package entry points resolve, and the bundle patch
  is both what `dsh.bundle.patch` declares and what `files` ships.
  Mutation-checked: dropping a lib file from `files`, and unregistering a suite
  from `scripts.test`, each fail exactly one case (both reverted).
- AGENTS.md's `pnpm test` comment said "both libs" while the repo has six lib
  files and eight suites; it now describes what actually runs.

### Changed — the registry write rules are a tested unit of their own

- **`lib/registry-writes.js` (new).** The archive-set read/write rules —
  `registryState`, `unarchiveThrough`, `archiveThrough`, `assertRegistryWritable`
  — moved out of `lib/index.js` (1465 → 1375 lines) into a host-free module that
  takes the error class as an injected seam, the same shape
  `lib/artifact-paths.js` uses. They decide whether a durable write may happen at
  all, and until now they were reachable only through a mounted host.
- **`test/registry-writes.test.mjs` (new, 14 cases)** pins them directly:
  `requireState` wins over a reconstruction; a reconstruction is marked and
  refuses every write (`registry/unavailable`); the official
  `archiveSession(id, { stopActivity: true })` is preferred and the option is
  load-bearing for `allowDeleteRunning`; the `setState` fallback is only legal
  with a faithful `requireState`, spreads the fields it does not own, and is
  no-op-safe; one half of the official pair is not enough.
  ⚠ Two of the fourteen initially failed, and the tests were wrong, not the code:
  the `setState` fallback cannot run when only a reconstructed state is available.
  That contract is now written down in the suite's header.
- Mutation-checked: dropping `stopActivity: true` and removing the
  reconstructed-state refusal each fail exactly one case; both mutations were
  reverted and the file re-verified (`pnpm test` 159/159, 7 suites).
- Registered in BOTH `package.json → files` and `scripts.test` (plus
  `scripts.check`) — the rule AGENTS.md calls out for a new runtime file.

### Verified — the cross-process queue boundary, and a CI-only test race

- **Two hosts on one `DSH_HOME` can lose a pending marker — confirmed.** The
  operation lock is per-manager while the pending queue is one read-modify-write
  file, so two hosts read the same snapshot and the last write wins.
  `scripts/twohost-race-probe.mjs` (new, checked in) reproduces it against the
  real manager: `RESULT: LOST 1 marker(s): …`. A lost marker strands its tombstone
  with nothing left to sweep it while its files are gone — the stuck-ghost-row
  shape. No fix is included on purpose: the faithful ones are per-id atomic marker
  files (a queue-format change) or a real cross-process lock, and an optimistic
  verify-then-retry is not one, because the winner can verify before the loser
  clobbers it. Supported configuration: one host per `DSH_HOME`; AGENTS.md carries
  the full record.
- **A test race that only Ubuntu could lose is fixed.**
  `apply schedules the boot sweep…` bounded its drain loop by event-loop TURNS
  (500 `setImmediate`s) while the sweep's stages land on threadpool filesystem
  I/O: Ubuntu drains 500 turns in ~13 ms, long before the queue write-back is
  observable, so the assertion failed there and passed on Windows (where those
  same turns take hundreds of ms). The bound is now 5 s of wall clock. The product
  was never at fault — the boot timer already calls the unthrottled
  `sweepPending()`.

## [0.4.5] - 2026-09-30

### Fixed — the e2e isolation recipe, and the seed's stale-data trap

- **The isolation recipe was wrong.** Both READMEs and AGENTS.md recommended
  `ELECTRON_RUN_AS_NODE=1 ... --expose-internals "<app.asar>/lib/desktop-cli.js"`;
  on the installed desktop build that asar path does not resolve and the CLI
  exits with `MODULE_NOT_FOUND` (verified 2026-09-30 while running the
  real-browser acceptance). They now use the disk-based CLI shipped in the dsh
  npm package — `node "$(npm root -g)/@deepseek-ai/dsh/lib/bin.js"` — with the
  three commands that were actually used end to end: `--from-default-profile web
  --dump-config` to create the profile without booting, `plugin … add` to install
  this plugin, and `--no-open --port <port>` to boot and print the token URL.
- **`e2e-seed.mjs` refuses a stale spec instead of producing a misleading home.**
  It used to warn once per session it could not copy and then write the marker
  ANYWAY, so a spec whose ids had since been deleted yielded a home that looked
  correctly seeded but had no openable session: the acceptance scripts then could
  not run, and the failure surfaced much later looking like a plugin bug (hit in
  the field on 2026-09-30 — all six ids were gone, every copy failed with ENOENT,
  and the seed still exited 0). It now checks every named session BEFORE creating
  anything and exits 2 with the missing paths, so nothing is left behind to clean
  up.

## [0.4.4] - 2026-09-30

### Changed — the three failure-prone seams are now pure modules

- `lib/pending-queue.js` (the queue's format, v1/v2 compatibility and input
  sanitization) and `lib/session-summaries.js` (the controller-list envelope and
  the row → summary projection) hold the pure half of the two seams whose SILENT
  failure actually reached users. Both now have direct unit suites — the queue's
  "a torn file is degraded, never empty" and the row's "the title is a
  projection, not a field" are pinned without standing up a host. No behaviour
  change intended; the host and contract suites are unchanged and green.

### Fixed — the archived-session listing was empty on a real host

- **`sessionController.list()` was read with the wrong shape, so every archived
  session lost its metadata.** The host answers `{ items: [...] }` — never a bare
  array — and its rows carry no `title` and no `createdAt` (`listFields()` adds
  only `cwd`/`origin`/`parentSessionId`); the display title is the `title`
  *projection* (`item.projections.values.title`), which is where the official
  browser client reads it too. `collectSummaries()` required an array and
  returned early, so the `list` endpoint and the `session_list_archived` tool
  reported `title: ''`/`(untitled)`, `cwd: null`, `updatedAt: null` for every
  archived session — silently: the host test's fake encoded the invented
  flat-array shape, so the suite stayed green. It now accepts both shapes, reads
  the title from the projection, falls back to the persistence header listing
  when the controller answers nothing usable, and **warns once** on an
  unrecognized shape instead of reporting an empty corpus.
- The host test fixture now encodes the REAL controller row shape, and
  `test/contract.test.mjs` gained `assertPrimitivesExports()` /
  `assertSlotsDeclared()` (installed-module guards, local-only) so the next
  upstream rename of an icon or a slot fails loudly instead of blanking a
  surface quietly.

### Fixed — a cancelled deletion returned the session as an ungrouped row

- The pending-delete queue is now **v2**: it records which workspaces the delete
  detached the id from, and `deferred/cancel` re-attaches through that record —
  before the tombstone is cleared, mirroring the delete's own
  detach-while-still-archived invariant. Cancelling used to hand the session back
  with no workspace accounting, i.e. straight into 未分组/ungrouped, which is the
  residue shape the tombstone exists to prevent. A v1 queue file still reads
  (nothing recorded, so nothing to restore), a vanished workspace degrades to a
  warning rather than blocking the cancel, and the warnings reach the settings
  page's alert region.

### Fixed — a file failure after bookkeeping aborted the delete

- `disposePath()` no longer lets a `rm` rejection propagate. Callers run *after*
  the registry bookkeeping has committed, so a Windows `EPERM`/`EBUSY` (antivirus,
  indexer, foreign handle) used to abort the delete once the id was already
  detached and un-archived — the plugin's own UI could then neither list, retry
  nor cancel it while its files stayed on disk. A failure is now a warning, which
  is what the documented contract always claimed, and the boot sweep logs the
  same way (including the "nothing left to dispose" case).

### Fixed — the menu row could vanish for a whole page

- The ping answer is read through a **live getter** instead of the frozen
  injected value: the renderer caches `inject()` per entry for the entry's
  lifetime, so an open that happened while the ping was still in flight froze
  `null` and hid the red delete row for the rest of the page. A ping that
  *failed* is now retried once when the menu is next opened (a host that
  answered "no" is never re-pinged), and the settings section resolves its
  session/workspace handles the same way, so a store that mounts late no longer
  renders "No archived sessions" forever.
- `refreshUntilGone()` re-checks the pending-delete residue in a `finally`, so
  the repair the comment describes now also happens on the early-return success
  path (it was unreachable there).

### Fixed — smaller correctness and honesty items

- **Archive-set writes go through the registry's own serialized entry points.**
  `setState` is a bare `global.set` while every official mutation (archive,
  unarchive, pin, workspace create) runs on the registry's internal queue, so the
  hand-rolled read-modify-write could undo a concurrent official write —
  restoring the pins, default workspace and workspace list it had read a moment
  earlier. `unarchiveSession` / `archiveSession(id, { stopActivity: true })` are
  now preferred (our own lock only ever serialized *this* plugin), and a registry
  that exposes neither `requireState` nor the official pair is **refused before
  anything is touched**, instead of writing back a reconstructed snapshot that
  would erase the fields it cannot see.
- `onDeleted` was an undeclared identifier in `lib/client.js` (its destructure
  was dropped in 0.4.3 while the call stayed) — removed; it was dead code and a
  latent `ReferenceError`.
- Accumulated host warnings/errors render legibly: the `role="alert"` region
  preserves newlines and wraps instead of collapsing several failures into one
  run-on line. The accumulation is now uniform too — `restore`, `refreshRows` and
  the settings Cancel-deletion used last-write-wins `setError`, so a failure could
  silently erase another one that was already on screen (and a cancel's post-cancel
  refresh failure was swallowed outright).
- A session whose title is an EMPTY string renders the placeholder instead of a
  blank row (`??` only rejects null/undefined), and a fired toast timer is pruned
  instead of accumulating one dead handle per toast for the page's lifetime.
- Every card, row and floating toast uses the **opaque** layer-2 surface. The
  translucent menu token it used before resolves to 58% opaque (light) / 45%
  (dark) on Windows, not the ~94% only darwin gets.
- `deferred/list` no longer walks the whole persistence corpus when the pending
  queue is empty, and the opportunistic `ping` sweep is throttled (it no longer
  re-walks the corpus for an unchanged queue, or inside the operation lock on
  every client poll).
- **The `session_delete_permanently` agent tool now only deletes ARCHIVED
  sessions** and reports `session/not-archived` otherwise; the human surfaces are
  unchanged (the context-menu row is still offered on every session row). The id
  guard still runs first, so a malformed id always answers `bad-request`.

### Security / tooling

- **Every** e2e script that deletes or mutates sessions now requires a seeded
  disposable home: `e2e-bug2.mjs`, `e2e-live.mjs` (both really delete) and
  `e2e-dialog-style.mjs` (unarchives) previously took only a URL.
- `e2e-seed.mjs` **validates before it deletes**: the real `~/.dsh` is refused,
  and any other target must be already marked or empty — it used to `rm -rf` the
  target's `sessions/` and `storages/` before writing the marker. It also warns
  that it copies your real `.credentials.yaml` into the seeded home.
- Every puppeteer script resolves Chrome as
  `process.env.CHROME_PATH ?? <the Windows default>`, so the suite is runnable on
  a machine whose Chrome lives elsewhere (and on macOS/Linux).

### Packaging / docs

- A `v*` tag now publishes a GitHub release with generated notes
  (`.github/workflows/release.yml`, `gh` CLI — no third-party release action, and
  it cannot affect the test workflow). The repository's CHANGELOG remains the
  human-written record; note there is still no `v0.4.0` tag (see the note above).

- `engines.dsh` is declared (the requirement was prose-only), and the shipped
  `cordis.patch.yml` no longer tells readers to install by the bare npm name
  `dsh-session-manager` — that name belongs to an unrelated published project
  which also registers a session menu row, so the mistake looks like success.
- The READMEs document the development Node floor (jsdom 30 needs ≥ 22.22.2
  while the plugin itself runs on ≥ 20), quote the real UI strings, qualify the
  delete's archive-set step as cold-only, and drop a zh-only `--help` claim that
  started nothing.
- `AGENTS.md` corrections: the menu hook-order note (the installed
  `menuOpenStateFactory` is a plain closure that calls no React hook, so
  reordering does not throw the claimed error today), the token-alpha figure, the
  reference-docs pointer, and the destructive-script inventory.

## [0.4.3]

- Fix dialog lifecycle: a reload with a dialog open no longer orphans the overlay
  or wedges the one-at-a-time guard; a dialog that cannot be attached resolves as
  cancelled.
- Failures are always visible: `pushError` accumulates instead of last-write-wins,
  and a failed refresh can no longer swallow a partial delete's host warnings.
- One corpus read per request (`artifactIndex`) — `deferred/list` is no longer
  `O(queued × corpus)`.

## [0.4.2]

- Never lose the pending queue (an unreadable queue is refused, never rewritten
  from an empty view) and route every list pull through the residue guard.

## [0.4.1]

- Keep deleted open sessions out of view in every sidebar mode:
  `reannouncePendingRemovals` defaults to **on** (the host re-announces
  `api-session/removed` for queued ids that are still live).
- The confirm dialog uses the opaque modal surface.

## [0.3.9]

- One confirmation dialog at a time; focus returns to the element that opened it.

## [0.3.8]

- Contract-test the wire protocol and the installed dsh surface.

## [0.3.7]

- `fix!` — register the menu delete row into the official
  `sidebar.workspaces.session.menu.item` slot and drop the DOM/fiber
  augmentation (which dsh 0.1.7-rc.2 had already broken silently).

## [0.3.6]

- `fix!` — restore the settings pane on dsh 0.1.7 (size-neutral icon names) and
  narrow the plugin to deletion.

## [0.3.5]

- Deleted rows disappear immediately; cleaned-up queue entries collapse into one
  summary line with an optional id expander.

## [0.3.4]

- Select-all and bulk delete in the settings page.

## [0.3.3]

- `fix!` — never take the shared `/api` interceptor; use exact fetch routes per
  endpoint instead. (Taking it had blanked every host RPC while this plugin's own
  endpoints kept working.)

## [0.3.2]

- Mount the RPC surface through the shared `/api` interceptor (reverted in 0.3.3).

## [0.3.1]

- `fix!` — guard session ids at the manager boundary and serialize every durable
  mutation behind one operation lock.

## [0.3.0]

- `feat!` — remove the `/sessions` slash-command family: the desktop host has no
  slash surface. The Settings page, the context menu and the agent tools are the
  intended UX.

## [0.2.4]

- Wait for host services before registering commands and tools.

## [0.2.2]

- Archived session management for DeepSeek Harness: list, restore, permanently
  delete, with a Settings page and a red context-menu item.
