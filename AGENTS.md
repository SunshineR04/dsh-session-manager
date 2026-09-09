# AGENTS.md — dsh-session-manager

DeepSeek Harness (dsh) plugin that manages **archived sessions**: list, restore,
permanently delete, a Settings page, a red context-menu item,
agent tools. Plain JavaScript ESM, no
TypeScript, no linter, no bundler. Package manager is **pnpm**; Node >= 20
(e2e scripts need >= 22.12 via puppeteer-core).

## Commands

```bash
pnpm install
pnpm test   # node --check on both libs + host unit tests + client render tests
```

- `node --test test/` (as written in some docs) **fails on Windows** — Node
  resolves it as a module path. Pass files explicitly.
- **`test/client.render.test.mjs` is load-bearing**: it mounts the real
  settings section with React 18 inside jsdom (`test/client-test-env.mjs`
  must be imported before React — the act() flag is captured at import time).
  Client-side render crashes (hook order, TDZ) blank the whole settings pane
  and are invisible to host tests; always run the render tests after touching
  `lib/client.js`.
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
  against the real `~/.dsh`. ⚠ **The desktop `dsh.cmd` shim hardcodes
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
  RPC channel `/session-manager` (`connection.rpc.handle`) and agent tools
  (`tools.register`).
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
  augmentation (MutationObserver + React-fiber resolution — passive by design:
  if host DOM structure changes it must degrade to a no-op, never throw).
- Client↔host RPC envelope: `{ ok: true, value }` / `{ ok: false, error: { code, message } }`;
  domain errors are `SessionManagerError` with **stable codes**
  (`session/running`, `session/not-found`, `session/not-archived`,
  `session/pending`, `session/data-gone`, `registry/unavailable`,
  `bad-request`, `session-manager/internal`) matched structurally: the RPC
  client attaches `error.code` to thrown errors (`isRunningError`), tool layer
  matches on code.

## Invariants and gotchas

- **Delete order is deliberate**: registry bookkeeping first (detach from its
  workspace, then remove from the archive set), files second, then a
  `ctx.emit('api-session/removed', sessionId)` broadcast. A file failure after
  bookkeeping is a warning, not a resurrection. Do not reorder.
- **Never trust a single host seam during a destructive op** — this caused the
  0.1.4 field bug where deleted sessions resurfaced as *ungrouped* sidebar
  entries: the real `Workspace.sessionIds` getter filters members through the
  registry's canonical-cwd header index, so a stale index hides the id and the
  detach was skipped; the header seam failing also silently skipped the log
  deletion. Hence: the detach also checks `workspace.record.sessionIds` (raw
  record), and the artifact directory is resolved through three seams (header
  `locate` → persistence header listing → raw scan of the sessions root).
- **`api-session/removed` must be emitted after a real delete**: the host only
  emits it itself when a *live* session is disposed, so a cold delete would
  otherwise linger in every connected client's list store forever (the client
  handles the event by dropping the id — verified in
  `dsh-api-session-controller/lib/client.js`). The sidebar's 未分组/ungrouped
  bucket is "every session in the client list store not accounted by any
  workspace and not archived" — any stale summary there *is* a resurrection.
- **Open (live-idle) sessions delete immediately, via a tombstone**: dsh has no
  public "close session" API — the in-memory summary outlives the delete (its
  owner scope is the session-controller service scope, not the UI view), but
  appends open the log by path and never recreate a deleted directory, so
  files can go right away. `deleteSession` runs the read-only existence check,
  then queues the id BEFORE any mutation (crash safety), detaches it, keeps it
  in the archive set as a **tombstone** (the
  official archive filter hides the lingering summary everywhere), disposes
  files + projcache, emits `api-session/removed`, and reports
  `openAtDelete: true`. The next-boot sweep calls `finishDeferredDeletion`,
  which must clear the tombstone even when `sessionKnown` is false (files
  already gone). The settings page additionally filters queued ids out of its
  rows (client-side, via `pendingIds`). `deferred/list` reports which queued
  ids are still `recoverable` (artifact dir on disk); `deferred/cancel`
  (`cancelPending`) clears the tombstone FIRST and only then drops the marker
  (a registry failure then leaves the entry fully queued and retryable), and
  REFUSES entries whose files are already gone (`session/data-gone`) —
  un-tombstoning one would expose the artifact-less lingering summary as an
  ungrouped row, so the UI's hidden cancel button is a protocol rule, not a
  convention. `restoreSession` REFUSES queued ids
  (`session/pending`) — un-tombstoning one would expose an artifact-less husk.
  Running sessions are refused;
  `allowDeleteRunning: true` force-deletes with cold semantics (no tombstone).
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
  never the public lock-taking wrappers. `readPending` is lock-free by design
  (atomic-rename writes; callers only ever want a snapshot).
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
- Session ids are addressed only by exact **full session id** (index-based
  addressing was rejected with the old slash commands — indexes drift). The
  settings page filters out `origin === 'subagent'` rows.
- `e2e-artifacts/` and `.dsh-vision-router/` are gitignored artifact/leftover
  dirs — not part of the package, don't commit or clean code into them.

## Reference docs

`README.md` / `README.zh.md` document the delete semantics, config fields and
dsh integration (bundle patch, client inject list) — read the "Delete
semantics" section before touching `deleteSession`/`sweepPending`.
