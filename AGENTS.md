# AGENTS.md — dsh-session-manager

DeepSeek Harness (dsh) plugin that manages **archived sessions**: list, restore,
permanently delete, a Settings page, a red context-menu item,
agent tools. Plain JavaScript ESM, no
TypeScript, no linter, no bundler. Package manager is **pnpm**; Node >= 20
(e2e scripts need >= 22.12 via puppeteer-core).

## Commands

```bash
pnpm install
pnpm test   # node --check on both libs + host + client render + contract tests
```

- `node --test test/` (as written in some docs) **fails on Windows** — Node
  resolves it as a module path. Pass files explicitly. The file list in
  `package.json → scripts.test` is therefore the whole truth: a new suite that is
  not named there never runs, locally or in CI.
- **`test/client.render.test.mjs` is load-bearing**: it mounts the real
  settings section with React 18 inside jsdom (`test/client-test-env.mjs`
  must be imported before React — the act() flag is captured at import time).
  Client-side render crashes (hook order, TDZ) blank the whole settings pane
  and are invisible to host tests; always run the render tests after touching
  `lib/client.js`. It takes the section's props from the production `inject:`
  face (only `rpc` is overridden), so the real `refreshUntilGone` closure is
  under test, and its service fakes expose the OFFICIAL surface only (`list` +
  `refresh()`) behind a Proxy that throws on any other name — a method the real
  service does not carry must fail there, never silently skip in production.
  Its `ctx.effect` stub captures cleanups **by label** (`runDisposer(label)`),
  which is what makes the teardown paths testable at all: the previous
  `effect: (fn) => fn()` dropped every disposer.
- **`test/contract.test.mjs`** pins the client's endpoint literals against
  `RPC_ENDPOINTS` (plus `HOST_ONLY_ENDPOINTS` for routes with no browser caller)
  and the shared `/api` + `${NS}` → host-prefix composition. Its installed-module
  check goes through a pure `assertServiceSurface()` predicate carrying three
  inline fixtures: two shapes that KEEP `refresh()` (including an upstream
  refactor of its delegation body) must pass, a missing entry must fail — so
  relaxing that assertion can never silently blind it. It **skips where dsh is
  absent** (CI), so do not read a green CI run as "the surface was verified".
  Its `makeCtx()` fake keys captured components **by slot name** — `apply()`
  registers into two slots, and the single shared variable this used to be
  would let the last registration win, silently mounting the menu row into
  every settings test. Its primitives stub is a Proxy that throws on any name
  outside `PRIMITIVE_NAMES`, and stubs `MenuItemButton` as a real clickable
  `role="menuitem"` button (the icons' bare `() => null` would make the menu
  row's behaviour unreachable).
  A second local-only guard pins the HOST side: `assertSnapshotShape()` checks
  that the installed persistence backend's `list()` still yields
  `{ header, … }` wrappers (three inline fixtures: the current shape and a
  renamed wrapper must pass, a bare header must fail) — the shape `lib/index.js`
  unwraps, and the one whose absence had a seam silently dead.
- **dsh 0.1.7 line required.** Both hard dependencies arrived in it: the
  size-neutral product icons, and the `sidebar.workspaces.session.menu.item`
  slot (present from 0.1.7-alpha.1 — 0.1.5-rc.1, 0.1.5-rc.3 and 0.1.6-alpha.1
  do not declare it, so on those the menu row simply does not mount and the
  settings page is the only delete path).
- Host tests mock the dsh seams (`workspaceRegistry`, `sessionController`,
  `sessionPersistence`, live `sessions` store) and use real temp dirs — read
  `test/host.test.mjs` before changing manager semantics. `makeFixture()`
  points `process.env.DSH_HOME` at the temp home: `dshHome()` honors that env
  seam first, so without the isolation the pending queue and projcache sweep
  silently target the REAL `~/.dsh` (and the tests fail on any machine where
  `DSH_HOME` happens to be set). Keep every fs-touching test behind
  `makeFixture()`.
- E2E (`scripts/e2e-*.mjs`) drives a real web instance through puppeteer-core
  with Chrome hard-coded at `C:/Program Files/Google/Chrome/Application/chrome.exe`.
  It must run against an isolated home seeded by `scripts/e2e-seed.mjs`, never
  against the real `~/.dsh`. The two **destructive** scripts
  (`e2e-mutations.mjs`, `e2e-residue.mjs`) enforce that instead of trusting the
  operator: they require the seeded home (positional for mutations, `--home
  <path>` for residue) and refuse without the `.session-manager-e2e` marker the
  seed writes — including an explicit refusal for the real home, because a URL
  alone cannot prove which home an instance serves (`scripts/e2e-guard.mjs`).
  Keep that guard on any new destructive script.
  ⚠ **The desktop `dsh.cmd` shim hardcodes
  `set "DSH_HOME=<real home>"`**, so `DSH_HOME=<e2e-home> dsh ...` does NOT
  isolate — verified: `dsh plugin add` under that env created the profile in
  the real home (delete such a profile if it happens; nothing else is touched).
  Verified isolation recipe — call the CLI entry directly with the env set:
  `ELECTRON_RUN_AS_NODE=1 DSH_HOME=<e2e-home> "<DSH Desktop.exe>" --expose-internals "<app.asar>\lib\desktop-cli.js" plugin --profile <name> add <pkg>`
  (installs into `<e2e-home>/profiles/<name>`, real home untouched). The seed reads
  machine-specific data from `scripts/e2e-seed.local.json` (gitignored; copy
  `e2e-seed.local.example.json`) — keep real paths/session ids out of the repo.

## Architecture

Two runtime halves plus a bundle patch (`cordis.patch.yml` merely inserts the
plugin row; `dsh plugin add` applies it):

- **`lib/index.js` — host (Node, Cordis plugin)**. `apply(ctx, config)` mounts:
  one **exact fetch route per endpoint** on the connection service
  (`connection.fetch.register({ path: `${CHANNEL}/${endpoint}`, methods:
  ['POST'], requestBody: 'buffered', fetch })` — the shape the official
  dsh-session-log-export uses) and agent tools (`tools.register`).
  ⚠ 0.1.5-rc host compatibility, three traps in one place — keep all three
  invariants or the whole surface silently dies:
  1. **Never call `connection.rpc.intercept('/api', …)`.** That channel holds
     exactly ONE interceptor and the official dsh-api-gateway already owns it
     (`registerInterceptor` throws on a second registration). 0.3.2 took the
     slot and the gateway's registration was refused in the same pass: EVERY
     host RPC (`session/list`, `workspace/list`, the whole sidebar) answered
     404 while this plugin's own endpoints kept working — a silent, total
     host-wide outage. Exact routes are keyed per path, coexist with the
     gateway, and are matched before the interceptor.
  2. The older `rpc.handle('/session-manager')` prefix route silently never
     mounted either: its route registration resolves `webServer` through the
     CALLING plugin's fiber chain, where a sibling service is invisible.
  3. Keep this module free of `export default`: the Loader's `unwrapExports`
     prefers `module.default`, so a bare function export carries no plugin
     metadata (this is why `apply` is a named export).
  The route handler builds the full `{ type: 'server-response', rpcId,
  result }` envelope itself (`rpcRouteHandler`), mirroring the connection
  plugin's own wire shape — including an object `error.details`, which the
  browser half's parser rejects as a transport-shaped TypeError when missing.
  `RPC_ENDPOINTS` is the single source for the registration loop, and the
  client's `CHANNEL = '/api'` + `${NS}/${endpoint}` method/path pair must stay
  in lockstep with it.
  The `/sessions` slash-command family was REMOVED in v0.3.0: the desktop host
  has no slash surface, and the Settings page / context menu / agent tools
  are the intended UX. Do not re-add command registrations unless the host
  ecosystem gains a real desktop slash surface.
  Desktop compatibility audit (2026-09-06, verified against the installed
  desktop build's composition): `tools` service IS mounted (built-in tools
  run through it) and `register(definition)` matches our tool shape exactly
  (per-property `parameters` descriptors like the built-in `todo_write`,
  `output { schema, render }` required) — the three agent tools are live on
  desktop. `workspaceRegistry`/`sessionPersistence`/`sessionController`/
  `sessions`/`agents` are all present (session-controller injects them).
  `settings` is optional: absent -> composition config only, graceful.
  Every dsh service is reached through `ctx.get(...)` wrapped in `tryGet` —
  surfaces register **defensively** and silently don't mount if the service is
  absent. Registrations go through `ctx.effect(fn, label)` for cleanup.
- **`lib/client.js` — browser half**. Hand-written, **no bundler, no JSX**:
  wrapped in `window.__ModuleLoader__.load({ id, factory })`, CJS-style
  `require` of React and the `@deepseek-ai/dsh-client-*` modules listed in
  `package.json → dsh.client.inject`. UI is `React.createElement` only.
  Two surfaces: the settings section (`ctx.slots.inject('settings.section')`,
  data from the sessions/workspaces client stores) and the session context-menu
  row (`ctx.slots.inject('sidebar.workspaces.session.menu.item')`, order 500,
  rendered with the official `MenuItemButton`).
  ⚠ **Never identify an official surface by its text or DOM shape.** The menu
  row used to be injected by observing the DOM and resolving the session
  through the React fiber tree, with `Set(['归档会话','Archive session'])`
  matching each menu item's `textContent`. dsh 0.1.7-rc.2 appended the
  keyboard-shortcut hint to every row's text (`归档会话` became
  `归档会话Ctrl+Alt+A`), the match stopped matching, and the red delete row
  vanished from the menu — with **no error at all**: the client module loaded,
  the roster listed it, the settings page was healthy, and the augmentation
  even logged that it was active. The official slot has existed since
  0.1.7-alpha.1 and hands the row identity over as props; use it.
  ⚠ **`DeleteSessionMenuItem` must call `props.useMenuOpenState()`
  unconditionally, before its `menuEnabled` early return.** Reordering those
  two lines crashes the slot entry with a hook-order error.
  ⚠ **Every symbol this half pulls out of an official client module is a hard
  upgrade dependency, and a renamed one arrives as `undefined`, not an error.**
  dsh 0.1.7 dropped the artboard-suffixed product icons (`IconArchiveOutline20`,
  `IconTrashOutline16`, …) for size-neutral names: `Regular` keeps the one-pixel
  artwork at the glyph's own default size, `Medium` is the same geometry at a
  1.3px stroke, and the `size` prop picks rendered dimensions. The destructure
  went on yielding `undefined`, so `React.createElement(undefined, …)` threw
  React error #130 (`slot entry crashed in 'settings.section'`) and the WHOLE
  settings pane rendered blank while the nav entry, the host RPC and the
  context menu all stayed healthy — the client module still loaded, so the
  module roster looked fine. `test/client.render.test.mjs` stubs this module,
  which is why its green tests could not see it; the stub is now a Proxy
  that throws on any name outside `PRIMITIVE_NAMES` (which includes
  `MenuItemButton`), turning the next rename into a loud failure. When dsh is
  upgraded, re-check these names against the installed
  `@deepseek-ai/dsh-client-ui-primitives`.
  The same class of blind spot hid the rc.2 menu break: the DOM augmentation
  had **zero** tests. The slot registration is a plain component, so it is
  covered — keep it that way.
  The third instance was the refresh seam: `lib/client.js` called
  `sessions.refreshList()` for three releases, a name no published client service
  carries (0.1.5-rc.1, 0.1.7-alpha.1, 0.1.7-rc.1 and 0.1.7-rc.2 all expose only
  `refresh()`), so every guard skipped and a SUCCESSFUL cold delete reported a
  failed refresh. `ctx.get('sessions')` hands out the SERVICE, never its internal
  manager: pull through the module-level `refreshSessionList(sessions)` helper and
  read the store via `sessions.list`. Never invent a method name on an official
  service — the fakes and `test/contract.test.mjs` now fail loudly instead.
- **A slot registrant's `inject()` runs ONCE per entry and its result is cached
  for that entry's lifetime** (`dsh-client-ui-renderer`: `cachedRootInject` is a
  WeakMap keyed by the entry, with no invalidation; session-scoped entries cache
  per binding). Re-rendering — including reopening the "…" menu — returns the
  same object. So anything a component must react to later has to arrive through
  an injected HOOK (the slot injects `menuOpenState` and `shortcuts`), and any
  value read from a closure must be settled before the entry's first render. That
  is why `menuEnabled` retries its ping in the first seconds rather than waiting
  for a "later update".
- Client↔host RPC envelope: `{ ok: true, value }` / `{ ok: false, error: { code, message } }`;
  domain errors are `SessionManagerError` with **stable codes**
  (`session/running`, `session/not-found`, `session/not-archived`,
  `session/pending`, `session/data-gone`, `registry/unavailable`,
  `bad-request`, `session-manager/internal`) matched structurally: the RPC
  client attaches `error.code` to thrown errors (`isRunningError`), tool layer
  matches on code.

## Invariants and gotchas

- **Delete order is deliberate — per path**: `deleteLocked` does registry
  bookkeeping first (detach from its workspace, then remove from the archive set),
  files second, then a `ctx.emit('api-session/removed', sessionId)` broadcast.
  `finishDeferredDeletion` (the boot sweep) disposes files FIRST and does the same
  accounting afterwards, which is fine because the session is cold there. The
  load-bearing half in both — detach BEFORE unarchive, so a row never flashes back
  into the workspace browser — must not be reordered in either. A file failure
  after bookkeeping is a warning, not a resurrection.
- **Never trust a single host seam during a destructive op** — this caused the
  0.1.4 field bug where deleted sessions resurfaced as *ungrouped* sidebar
  entries: the real `Workspace.sessionIds` getter filters members through the
  registry's canonical-cwd header index, so a stale index hides the id and the
  detach was skipped; the header seam failing also silently skipped the log
  deletion. Hence: the detach also checks `workspace.record.sessionIds` (raw
  record), and the artifact directory is resolved through three seams (header
  `locate` → persistence header listing → raw scan of the sessions root).
  ⚠ The middle seam reads `sessionPersistence.list()`, which yields
  `{ header, revision, sizeBytes }` **wrappers**, never bare headers (verified
  against the shipped `dsh-session-persistence-jsonl`, which pushes
  `header: artifact.header`, and against both official consumers —
  `dsh-workspace`, `dsh-session-query` — which both do
  `.map((snapshot) => snapshot.header)`). Reading the wrapper as the header
  matched nothing (`String(undefined) !== sessionId`) and silently reduced that
  seam to a no-op; the host test's fake returned flat headers, which is why the
  suite stayed green. Both read sites (`resolveSessionDirs` and the
  `collectSummaries` fallback) unwrap `.header`, skip — and warn once about — an
  entry without one, and `test/contract.test.mjs` pins the wrapper against the
  installed backend with three inline fixtures.
- **One corpus read per operation** (`artifactIndex`): `sessionPersistence.list()`
  walks every generation and reads+decompresses every stored header, so resolving
  ONE queued id at a time made `deferred/list` `O(queued × corpus)` — twice over
  (the sweep and the `recoverable` split), while holding the operation lock.
  `deleteLocked`, `finishDeferredDeletion`, `sweepPending` and the
  `deferred/list` handler build the index ONCE and pass it down
  (`resolveSessionDirs(id, header, index)`, `hasArtifact(id, index)`); omitting
  it keeps the single-id behavior. The index also accepts SYMLINKED project
  directories: a dirent for a link reports `isDirectory() === false` (true for
  Windows junctions too) while the leaf check uses `stat`, so filtering on
  `isDirectory()` alone could hide an artifact, clear its tombstone and
  resurrect the session at the next boot.
- **`api-session/removed` must be emitted after a real delete**: the host only
  emits it itself when a *live* session is disposed, so a cold delete would
  otherwise linger in every connected client's list store forever (the client
  handles the event by dropping the id — verified in
  `dsh-api-session-controller/lib/client.js`). The sidebar's 未分组/ungrouped
  bucket is "every session in the client list store not accounted by any
  workspace and not archived" — any stale summary there *is* a resurrection.
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
  Regression cover: `test/host.test.mjs` ("deferred/list can re-announce…",
  "the persistence header listing alone…", "the persistence header listing is a
  real fallback…", "a symlinked project directory…", "deferred/list reads the
  persistence listing once…"), `test/client.render.test.mjs` ("a removal event
  for a queued id…", "a removal event that outruns its own delete response…",
  "a failed first queue read does not disarm the residue repair", "a bulk run
  made only of open deletes…", "a mixed bulk run does not re-pull…", "an
  explicit list pull re-checks the residue even when the store cannot be
  watched", "teardown closes an open dialog…", "a dialog that cannot be
  attached resolves as cancelled…", "a failed pending-queue read is reported…",
  "host warnings and a failed refresh both reach the user", "the unreachable-host
  guidance appears when the ping fails", "the dialog describes itself…", "two
  pending-cancel buttons are distinguishable by name") and
  `scripts/e2e-residue.mjs` (real Chrome: after a menu delete of an open session
  the id renders in NEITHER view).
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
  (`cancelPending`) READS the queue first, then clears the tombstone, then drops
  the marker — a registry failure leaves the entry fully queued and retryable,
  and an unreadable queue fails before anything is touched (reading AFTER the
  tombstone was cleared would leave "no tombstone + still queued", and the next
  boot would finish the deletion the user just cancelled). It also
  REFUSES entries whose files are already gone (`session/data-gone`) —
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
- **ONE operation mutex serializes every durable mutation** (`withOperationLock`):
  both the read-modify-write pending-queue file (five entry points: boot
  timer sweep, ping sweep, `deferred/list` sweep, deletes, cancels) and the
  archive-set `registryState → setState` windows. Unserialized, a sweep's
  full-list queue write-back clobbers a marker queued mid-sweep (stranding its
  tombstone forever), and two concurrent deletes/cancels/restore+sweep pairs
  read the same archived snapshot and last-write-wins ghost one of them (both
  shapes proven by probes; both have regression tests). The lock is NOT
  reentrant: locked bodies (`deleteLocked`, `cancelPending`,
  `finishDeferredDeletion`) use the `_addPending`/`_removePending` internals,
  never the public lock-taking wrappers. The queue READ is lock-free by design
  (atomic-rename writes; callers only ever want a snapshot).
- **An unreadable pending-delete queue is REFUSED, never reported as empty.**
  `readPendingSnapshot()` separates the two cases: ENOENT is the normal empty
  queue, while a read failure or unparseable JSON (a torn file counts — the
  cross-device fallback write is NOT atomic) comes back `degraded`. Every writer
  persists the snapshot it just read, so a tolerant `[]` on a failed read
  publishes that empty view on the next write-back and drops every live marker;
  their tombstones then stay in the archive set with no queue entry left to
  sweep them while their files are already gone, so `listArchived` un-hides them
  as rows `restoreSession` can never restore — permanently stuck ghost rows,
  the very "the deleted session came back" shape. Hence `_addPending`,
  `_removePending`, `sweepPending` (its closing full-list write-back is the
  destructive one), `listArchived` and `restoreLocked` all refuse with
  `session-manager/internal`, and `pendingQueueUnreadable` logs at the point the
  error is created so no caller can swallow it silently (the ping sweep is
  fire-and-forget). The refusal is scoped to queue-dependent work: a COLD delete
  writes no marker and reads no queue, so it still proceeds. Regression cover:
  `test/host.test.mjs` ("an unreadable pending queue is refused…").
- `sessionId` is validated by `SESSION_ID_PATTERN` at the **manager choke
  point** — `assertSessionId` is the first statement of `deleteSession`,
  `restoreSession` and `cancelPending`, so EVERY entry (RPC channel, agent
  tools, future surfaces) is covered: the RPC gate alone left the tool path
  (`execute(args)` → `manager.deleteSession` directly) exposed to model-
  controlled `../..` ids, which the raw sessions-root scan would have
  `rm -rf`'d outside the root (proven by probe; guarded by test). The tool
  JSON Schemas mirror the pattern as `pattern: '^[A-Za-z0-9_-]{4,128}$'`.
  Public entry points are `async` so a guard failure is always a rejected
  promise, never a sync throw. `readPending` additionally validates on the
  way IN (queue file is an input channel: crash leftovers, hand edits,
  corruption). Keep both guards.
- **Version is single-sourced**: the RPC `ping` response reports
  `pluginVersion()`, which reads `package.json` at runtime; the
  `VERSION_FALLBACK` literal in `lib/index.js` is only a corrupt-manifest
  safety net. Bumping `package.json` is enough (a host test asserts the match).
- `package.json → files` is a whitelist; new runtime files must be added there.
- Config: schema in `lib/index.js` (`Config`); `effectiveConfig()` merges
  per-user overrides from the settings document under namespace
  `dsh-session-manager` on top of composition config.
- Client UI strings live in the inline `zh`/`en` locale dictionaries in
  `lib/client.js` — always add a key to **both**. Styling goes through the
  `TOKENS` map (dsw CSS variables with hardcoded fallbacks); the confirm dialog
  is plain DOM, not React, and shared by the settings page and the menu item.
  It admits **one dialog at a time** (a second request resolves as `null`, i.e.
  "cancelled", so no existing caller path changes), gives each instance a fresh
  `aria-labelledby` id (a fixed id would resolve to whichever overlay came
  first), and hands focus back to the element that opened it on close — the menu
  path's opener is unmounted by then, hence the `document.contains` check.
  ⚠ **The card must use the OPAQUE modal tokens, never the menu surface.**
  `--dsw-specific-menu` resolves to a ~94%-alpha popover fill (field report:
  the dialog read as see-through over the page). Mirror the official modal
  instead (`dsh-client-ui-primitives Modal.module.css` / `Button.module.css`):
  card = `--dsw-alias-bg-layer-2` + `--dsw-radius-panel` (28px) +
  `--dsw-elevation-prominent`; mask = `--dsw-alias-bg-mask-1` +
  `--dsw-mask-blur` over `max(24px, var(--dsh-frame-overlay-top, 24px)) 24px`;
  actions = the `Button md` spec (36px tall, `--dsw-radius-md`, 14/22) with
  `RiskConfirmation`'s 72px/136px min-widths. `test/client.render.test.mjs`
  pins the tokens, and `scripts/e2e-dialog-style.mjs` compares the rendered
  styles against the live official dialog (all 8 checks must pass).
  Three lifecycle/feedback rules ride with it: (a) the overlay is attached
  inside a try/catch that resolves through the SAME "cancelled" channel as the
  degenerate-render check — a throw there used to leave `confirmOpen` set (every
  later confirm then resolved null, i.e. a silently dead delete button) and to
  reject a promise both settings call sites await outside try/catch; (b)
  `closeOpenConfirm` is released by `apply`'s injected-DOM teardown, so a
  reload with a dialog open cannot orphan the overlay, its capture keydown
  listener, or the guard; (c) `aria-describedby` names the consequence text,
  because on an irreversible delete the title alone is not the information the
  user needs. The section's feedback regions follow the same rule: the
  `role="status"` live region is mounted BEFORE its first child (a region
  created with its content is the classic missed announcement), failures land in
  a `role="alert"` banner, and `pushError` accumulates — last-write-wins
  silently dropped a partial delete's host warnings whenever its refresh also
  failed, and a swallowed `deferred/list` failure left a queued session
  rendered as an ordinary archived row with no feedback at all.
- Session ids are addressed only by exact **full session id** (index-based
  addressing was rejected with the old slash commands — indexes drift). The
  settings page filters out `origin === 'subagent'` rows.
- `e2e-artifacts/` and `.dsh-vision-router/` are gitignored artifact/leftover
  dirs — not part of the package, don't commit or clean code into them.

## Reference docs

`README.md` / `README.zh.md` document the delete semantics, config fields and
dsh integration (bundle patch, client inject list) — read the "Delete
semantics" section before touching `deleteSession`/`sweepPending`.
