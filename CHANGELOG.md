# Changelog

Keyed to the repository's tags. The dsh plugin API is versioned with the plugin,
so a change that requires a newer dsh host says so explicitly.

> **Note on 0.4.0.** There is no `v0.4.0` tag and `package.json` never contained
> that version: the release went `0.3.9` → `0.4.1`. `docs/analysis-deleted-open-session-still-listed.md`
> records field evidence dated to a build reporting `0.4.0` (the pre-release of
> the same work); read those references as 0.4.1.

## [Unreleased]

Nothing yet.

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
