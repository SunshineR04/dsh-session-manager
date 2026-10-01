# AGENTS.md — dsh-session-manager

DeepSeek Harness (dsh) plugin that manages **archived sessions**: list, restore,
permanently delete, a Settings page, a red context-menu item,
agent tools. Plain JavaScript ESM, no
TypeScript, no linter, no bundler. Package manager is **pnpm**; Node >= 20
(e2e scripts need >= 22.12 via puppeteer-core).

## Commands

```bash
pnpm install
pnpm test   # scripts.check (node --check, every lib file) + 9 suites; the list in
            # package.json -> scripts.test is the whole truth
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
  face (the `rpc` override applies only when a test supplies one — call
  `renderSection()` with no arguments to drive the REAL `ctx.get('connection')`
  wrapper, which is how the structured-error-code test works), so the real
  `refreshUntilGone` closure is under test, and its service fakes expose the
  OFFICIAL surface only (`list` + `refresh()`) behind a Proxy that throws on any
  other name — a method the real service does not carry must fail there, never
  silently skip in production. A test that leaves the module-level
  `menuConfirmBusy` set will silently break every later menu test (they get the
  busy toast instead of a dialog), so release any held in-flight delete in the
  test's `finally` before unmounting.
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
  ⚠ Making them run in CI is NOT a workflow tweak, and that was checked rather
  than assumed (2026-09-30): of the packages the guards resolve, only
  `@deepseek-ai/dsh` (0.2.0-rc.2) is published — `dsh-session-persistence-jsonl`
  and `dsh-cordis-client-runner` are 404 on npm in any form, so the modules the
  host-side guard needs cannot be installed on a runner at all. Running the
  contract suite on a machine WITH dsh installed is therefore the only place
  these guards can execute; keep doing that on every dsh upgrade.
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
- **`test/e2e-guard.test.mjs`** pins the DESTRUCTIVE e2e guard
  (`scripts/e2e-guard.mjs`): the real-home refusal (name, prefix, case variant,
  junction/symlink), the marker validation, the seed's `home` binding, the
  instance↔home binding and its fail-closed rule. It needs no dsh and no Chrome,
  so it runs in CI — which makes the guard the one safety layer for irreversible
  deletes with machine coverage. It never writes inside the real home.
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
  with Chrome resolved as `process.env.CHROME_PATH ?? C:/Program Files/Google/Chrome/Application/chrome.exe`
  (set `CHROME_PATH` on a machine whose Chrome lives elsewhere, or on macOS/Linux).
  It must run against an isolated home seeded by `scripts/e2e-seed.mjs`, never
  against the real `~/.dsh`. **Every** script that deletes or mutates sessions
  enforces that instead of trusting the operator, and the set is larger than it
  used to be: `e2e-mutations.mjs`, `e2e-residue.mjs`, `e2e-bug2.mjs` and
  `e2e-live.mjs` really delete (their confirm click is unconditional), and
  `e2e-dialog-style.mjs` mutates the archive set on its fallback path. Each
  requires the seeded home (positional for mutations/bug2/live/dialog-style,
  `--home <path>` for residue).
  ⚠ **Two INDEPENDENT checks, both required, both in `scripts/e2e-guard.mjs` and
  both unit-tested without a browser (see above).** They used to be one, and the
  half that was missing is the half that can delete a real user's sessions:
  1. `assertDisposableHome` — the HOME is disposable. It canonicalizes with
     `realpathSync.native` (so a junction, a symlink, an 8.3 short name, a
     `\\?\` prefix or a case variant cannot walk past the comparison), refuses
     the real home by equality AND by prefix (nothing inside `~/.dsh` either),
     and then VALIDATES the marker instead of trusting its name: a regular FILE
     that parses as JSON, whose `plugin` is ours and whose recorded `home`
     canonicalizes to this very path. A directory named like the marker, a stale
     marker restored from a home snapshot, and a pre-0.4.8 marker with no `home`
     are all refused — **re-seed an old home, it will not be accepted**.
  2. `assertInstanceServesHome` — the INSTANCE behind the URL serves that home.
     A `--home` argument cannot prove this, so the script asks the page for the
     session ids it can see (the plugin's own `list` endpoint plus the
     `[data-row-key^="session:"]` rows) and requires every one of them to exist
     under the seeded home's `sessions/`, refusing on the first foreign id and
     failing CLOSED when the page reports nothing at all. Pointing a destructive
     script at your own running dsh with a valid `--home` used to pass every
     check and delete real sessions.
  Every destructive script calls both before its first click.
  ⚠ **`e2e-seed.mjs` is itself destructive**: it `rm -rf`s the target's
  `sessions/` and `storages/`, and copies your real `.credentials.yaml` in.
  The ORDER, precisely: the guard, the "already marked or EMPTY" rule, the FULL
  spec shape (`sessions` and `workspaces` non-empty arrays with usable entries),
  a `source != target` refusal, and then the marker write — every one of them
  BEFORE the first `rm`. Never move a check below the first `rm`: a guard that
  runs after the delete is not a guard. What that ordering fixes, concretely: a
  spec whose `sessions` parsed but whose `workspaces` was missing crashed AFTER
  the delete and AFTER the credential copy, leaving a mutilated, unmarked home
  holding a copy of the real `.credentials.yaml` that the seed then refused
  forever; `node scripts/e2e-seed.mjs <home> <home>` emptied the very fixture it
  was copying from and still exited 0; and a session-copy failure only warned.
  That last one is fatal now (the staleness pre-check proved the session existed
  a moment ago), and the marker goes in FIRST so any later failure leaves a home
  that is recognisable, disposable and re-seedable. Keep the guard on any new
  destructive script.
  ℹ **Assertion status — do not mistake a transcript for a test.** These can
  FAIL: `e2e-residue.mjs`, `e2e-dialog-style.mjs`, `e2e-realclick.mjs`,
  `e2e-contrast.mjs` and the guard itself. `e2e-check.mjs`, `e2e-mutations.mjs`,
  `e2e-bug2.mjs`, `e2e-live.mjs` and `e2e-probe.mjs` print a transcript and exit
  0 whatever happened: read their output, never their exit code. (A CRASH — no
  Chrome, a navigation timeout — still exits non-zero, so the exit code separates
  "broke" from "assertion failed", not "passed" from "failed".) `e2e-bug2.mjs`
  reproduces a fixed field bug (superseded by `e2e-residue.mjs`) and
  `e2e-probe.mjs` is one-off DOM reconnaissance — both are kept as diagnostics,
  not as acceptance tests.
  ⚠ **Row and menu-item lookups must go through the official hooks, never text
  or geometry.** The scripts used to find a session row by
  `button[aria-label*="的操作"]` plus a "walk up to a wide element" climb — which
  matched the **WORKSPACE** row (whose label is `工作区“…”的操作`), so those runs
  silently exercised the wrong element and their `[row] null` read as a fixture
  problem. Session rows carry NO aria-label; `data-row-key="session:<id>"` is the
  hook. Menu items must be matched by **substring** (`includes('彻底删除')`): dsh
  appends shortcut hints (`归档会话` → `归档会话Ctrl+Alt+A`), so an `===` match
  silently stopped matching once already.
  ⚠ **A session row's action cluster is in the DOM for every non-blank row, and
  it IS a descendant of the row** — an earlier revision of this file claimed the
  opposite ("not reachable by `row.querySelectorAll`; it renders in a sibling
  span"), which is contradicted by the installed 0.2.0-rc.2 bundle: the
  `rowActions` span is one of the `data-row-key` div's own children, and only
  `display:none` hides it until `:hover`/`.menuOpen`. `e2e-residue.mjs` and
  `e2e-dialog-style.mjs` already use the row-scoped form and are correct. What
  DOES follow from the CSS is the practical rule: a hidden element has a zero
  rect, so hover first, then read the rect. Locate the trigger by the official
  label `会话“<title>”的操作`, and take the title from a CHILD element
  (`[...row.children]`), never `row.textContent`: that concatenates the
  relative-date badge (`My session title21天`, i.e. a real title plus `21天`) and
  therefore never matches. POLL for the trigger (≤8s, re-hovering each round) —
  opening a session materialises the cluster on a host round-trip, so a single
  probe reports "no menu" for a row that has one. Only a non-empty session has a
  cluster at all (`新会话` renders 0 buttons), so pick a row that has one.
  ⚠ **The trigger must be scoped by TITLE when several session rows are open** —
  `document.querySelector('button[aria-label^="会话"]')` returns the FIRST
  session's button, which on a page with two rows is the wrong session.
  ⚠ `e2e-realclick.mjs`'s bug-1 checks are real `exit 1` assertions now. They were
  `console.log` calls, so a true regression (no dialog on a real click) exited 0
  while this file, README.md and README.zh.md all called it a script that can FAIL.
  ⚠ **`e2e-contrast.mjs` is the contrast acceptance test** (`node scripts/e2e-contrast.mjs
  <url> <e2e-home>`; needs a seeded home whose ARCHIVE SET IS NON-EMPTY, or it
  exits 2 with nothing to measure). It measures the plugin's danger TEXT in both
  themes against the surface it actually paints on. It exists because jsdom
  computes no colours and because this failure is theme-dependent: `red-400` is
  4.24:1 on the dark card but 3.29:1 on white, `red-600` is 4.4976:1 on white
  (just under the floor) but 3.10:1 on the dark card, so NO single scale entry
  clears AA in both. `TOKENS.dangerText` therefore uses `light-dark()`, which the
  host's own `color-scheme: light|dark` makes resolvable in inline styles; the
  shipped literals measure 4.83:1 light and 4.73:1 dark. Do not "simplify" it
  back to a single `--dsw-*` alias — measure first (`npm run` has no browser, so
  run the script).
  ⚠ **It samples three buttons on the OPAQUE card, so it cannot see the rest of
  what this plugin paints — and three more text roles WERE under AA.** All are
  fixed with their own `light-dark()` tokens and pinned by
  `test/client.render.test.mjs` (measurements from the installed theme tokens,
  per WCAG 2.x relative luminance):
  · the `role="alert"` failure banner painted `dangerText` on
    `--dsw-alias-interactive-bg-hover-danger` (`#ec13130d` light /
    `#f25a5a26` dark) = **4.44:1 light, 3.94:1 dark** — the failure channel
    itself, under the floor in BOTH themes. It now sits on the opaque
    `panelSurface` with a 1px danger border, where the same text measures
    4.83/4.73;
  · link/action labels (`Restore`, `Refresh`, `Cancel deletion`, the running
    pill) used `--dsw-alias-state-business-primary` = **4.24:1** on the light
    card (the file's own fallback `#4a5cf0` would have passed 5.15:1) →
    `TOKENS.primaryText` = `light-dark(#4868b2, #7aaaff)` = 5.39/5.99:1;
  · small meta text used `--dsw-alias-label-tertiary` = **3.70:1** light →
    `TOKENS.metaText` = `light-dark(#61666b, #adb2b8)` = 5.80/6.53:1. There is
    deliberately NO `textTertiary` token: that token may not carry text at this
    plugin's sizes (icons have a 3:1 floor, text does not);
  · the dialog's danger FILL (`--dsw-alias-state-error-primary` light `#ec1313`)
    left its white label at **4.4976:1** — the very number this file cites as the
    reason that red cannot carry text → `TOKENS.dangerFill` =
    `light-dark(#dc2626, #f25a5a)` = 4.83:1.
  The header's bulk-delete and Refresh buttons render on an EMPTY archive set
  too, so "we measured something" is not the acceptance: the script now tracks
  whether the archived ROW was sampled at all and still exits 2 when it was not.
  ⚠ **The e2e fixtures are consumable.** The seed spec bakes in ONE non-blank,
  non-archived session, and `e2e-residue.mjs` DELETES it — so a later script that
  needs a restorable/openable session (`e2e-dialog-style.mjs` on its fallback
  path) fails with `no restorable session to open` on an already-used home. That
  is a spent fixture, not a plugin bug: re-seed, or add more sessions to the spec,
  before drawing conclusions. The seed also refuses a stale spec outright (exit 2,
  nothing created), which is the supported way to find out.
  ⚠ **The desktop `dsh.cmd` shim hardcodes
  `set "DSH_HOME=<real home>"`**, so `DSH_HOME=<e2e-home> dsh ...` does NOT
  isolate — verified: `dsh plugin add` under that env created the profile in
  the real home (delete such a profile if it happens; nothing else is touched).
  Verified isolation recipe — point the CLI shipped in the dsh npm package at
  that home (a plain Node entry point, no Electron):
  `DSH_HOME=<e2e-home> node "$(npm root -g)/@deepseek-ai/dsh/lib/bin.js" --profile <name> --from-default-profile web --dump-config`
  creates the profile from the shipped template and exits without booting;
  `... plugin --profile <name> add <pkg>` installs into
  `<e2e-home>/profiles/<name>`; `... --profile <name> --no-open --port <port>`
  boots and prints the token URL. All three verified 2026-09-30.
  ⚠ **Do NOT use the `<DSH Desktop.exe> --expose-internals "<app.asar>\lib\desktop-cli.js"`
  form an earlier revision of this file recommended** — on the installed desktop
  build that asar path does not resolve and the CLI dies with `MODULE_NOT_FOUND`
  (verified 2026-09-30). If the disk CLI ever disappears, find the real entry
  point inside the asar before trusting that form again.
  ⚠ **The seed spec goes stale silently unless you check**: `e2e-seed.local.json`
  names real session ids, and session ids get deleted over time. The seed now
  refuses (exit 2, nothing created) when any named session is missing — when
  that fires, update the spec to sessions that exist TODAY, and make sure the
  session you intend to open is the NON-archived one (the sidebar hides
  archived rows by default, so an all-archived spec leaves nothing to open).
  The seed reads machine-specific data from `scripts/e2e-seed.local.json`
  (gitignored; copy `e2e-seed.local.example.json`) — keep real paths/session
  ids out of the repo. The analysis doc's ids are truncated for the same reason.

## Architecture

Two runtime halves, four **pure** modules they share, plus a bundle patch
(`cordis.patch.yml` merely inserts the plugin row; `dsh plugin add` applies it):

- **`lib/pending-queue.js`**, **`lib/session-summaries.js`**,
  **`lib/artifact-paths.js`** and **`lib/registry-writes.js` — the pure halves.**
  No `ctx`: the pending queue's format / versioning / input sanitization, the
  controller-list envelope + row projection, the three-seam artifact resolution,
  and the registry read/write rules (the last two take their seams INJECTED — a
  persistence getter, the error class — so they stay host-free). They exist so the seams whose SILENT
  failure actually reached users are unit-testable without standing up a host
  (`test/pending-queue.test.mjs`, `test/session-summaries.test.mjs`,
  `test/artifact-paths.test.mjs`, `test/registry-writes.test.mjs`). Keep them host-free — the moment one needs
  `ctx`, the extraction has lost its point. Their semantics are load-bearing: a
  malformed id that reaches the filesystem turns the raw sessions-root scan into
  a path-traversal delete, a torn queue file must be `degraded` rather than
  empty, a missed artifact resurrects a deleted session, and a controller row's
  title is a PROJECTION (see the gotcha below).
  ⚠ A new runtime file must be added to BOTH `package.json → files` (or the
  published package is broken) AND `package.json → scripts.test` when it brings a
  suite (or that suite never runs, locally or in CI).

- **`lib/index.js` — host (Node, Cordis plugin)**. `apply(ctx, config)` mounts:
  one **exact fetch route per endpoint** on the connection service
  (`connection.fetch.register({ path: `${CHANNEL}/${endpoint}`, methods:
  ['POST'], requestBody: 'buffered', fetch })` — the shape the official
  dsh-session-log-export uses) and agent tools (`tools.register`).
  It imports the four pure modules above and keeps only the ctx-bound parts:
  the manager closure, the operation lock, the RPC handler and `apply`.
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
  ⚠ **`registerTools(ctx, manager)` inside `apply` was covered by NOTHING** until
  0.4.8: every tool test called `registerTools` directly, and the apply test
  named "…but still mounts tools" asserted only a warning line. Deleting the call
  left the suite green with all three agent tools silently unmounted. The test
  now drives `apply(ctx, {})` with a fixture `tools` service and asserts three
  registrations plus one `execute`.
- **`lib/client.js` — browser half**. Hand-written, **no bundler, no JSX**:
  wrapped in `window.__ModuleLoader__.load({ id, factory })`, CJS-style
  `require` of React and the `@deepseek-ai/dsh-client-*` modules listed in
  `package.json → dsh.client.inject`. UI is `React.createElement` only.
  Two surfaces: the settings section (`ctx.slots.inject('settings.section')`,
  data from the sessions/workspaces client stores) and the session context-menu
  row (`ctx.slots.inject('sidebar.workspaces.session.menu.item')`, order 500,
  rendered with the official `MenuItemButton`).
  ⚠ **Never identify an official surface by its text or DOM shape.** The row is
  an ordinary entry in `sidebar.workspaces.session.menu.item`, which hands the
  row identity over as props — that IS the contract. A DOM/text match is not one:
  dsh 0.1.7-rc.2 appending a shortcut hint to every row's text
  (`归档会话` → `归档会话Ctrl+Alt+A`) made the match stop matching, and the row
  vanished with **no error at all** (module loaded, roster listed it, settings
  healthy, the augmentation even logged itself active). See README.md's
  "Session context menu" note.
  ⚠ **`DeleteSessionMenuItem` calls `props.useMenuOpenState()`
  unconditionally, before its `menuEnabled` early return.** Keep it that way —
  but the recorded reason was WRONG and is corrected here against 0.2.0-rc.2:
  the installed hook is `menuOpenStateFactory = (_standard, state) => () => state`
  (`dsh-client-ui-workspace/lib/client.js`), a plain closure that calls NO React
  hook, so reordering those two lines would NOT throw a hook-order error today.
  The order is retained as defensive convention (an upstream refactor could make
  it a real hook at any time), not because it currently crashes.
  ⚠ **Every symbol this half pulls out of an official client module is a hard
  upgrade dependency, and a renamed one arrives as `undefined`, not an error.**
  That is exactly how dsh 0.1.7's size-neutral icon rename
  (`IconArchiveOutline20` → `IconArchiveOutlineRegular`) threw React error #130
  and blanked the settings SECTION while the nav, the host RPC and the menu all
  stayed healthy — the client module still loaded, so the roster looked fine (a
  renamed SLOT name is even quieter: the surface simply never mounts). Guards, in
  order of who catches what: `test/client.render.test.mjs`'s Proxy throws on any
  name outside its hand-maintained `PRIMITIVE_NAMES` (client.js ADDING a name),
  and `test/contract.test.mjs`'s installed-module predicates
  (`assertPrimitivesExports`, `assertSlotsDeclared`,
  `assertControllerListShape`, `assertTitleProjection`) catch an UPSTREAM rename.
  When dsh is upgraded, run the contract suite — it is the machine-checked form
  of the old "re-check these names by hand" ritual.
  Two more members of this class, both now covered: the DOM augmentation above
  had **zero** tests, and `lib/client.js` called `sessions.refreshList()` for
  three releases while every published client service carries only `refresh()`,
  so a SUCCESSFUL cold delete reported a failed refresh. `ctx.get('sessions')`
  hands out the SERVICE, never its internal manager: pull through the module-level
  `refreshSessionList(sessions)` helper and read the store via `sessions.list`.
  Never invent a method name on an official service — the Proxy-guarded fakes and
  the contract suite now fail loudly instead.
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
  `session/pending`, `session/not-pending`, `session/data-gone`,
  `registry/unavailable`, `bad-request`, `session-manager/internal`) matched
  structurally: the RPC client attaches `error.code` to thrown errors
  (`isRunningError`), tool layer matches on code.
  ⚠ **A HAND-MADE call to an exact route must speak that envelope too** —
  discovered the hard way (2026-09-30) while probing `deferred/cancel` from an
  authenticated page: `POST /api/session-manager/<endpoint>` with
  `content-type: application/json` (exactly that; no `; charset`) and a body of
  `{ type: 'client-request', rpcId: '<any string>', method: '<NS>/<endpoint>', payload }`.
  The `method` field is REQUIRED and must name the registered endpoint:
  `rpcRouteHandler` answers `bad-request: invalid client-request message` without
  `type`/`method`, and names both sides on a mismatch. The transport answers 405
  for a non-POST, 415 for another content-type and 400 for a non-JSON body. The
  browser half never spells this out (it goes through the connection service), so
  this bullet is the only place it is written down.

## Invariants and gotchas

- **Delete order is deliberate — per path**: `deleteLocked` writes the pending
  marker FIRST (crash safety; cold deletes included since 0.4.8), then does
  registry bookkeeping (detach from its workspace, then keep/put the id in the
  archive set as a tombstone), then disposes files, then — cold only — clears the
  tombstone and the marker, then broadcasts `ctx.emit('api-session/removed',
  sessionId)`. The marker and the tombstone are written as a PAIR or not at all: a
  tombstone with no marker left to clear it is the one strand nothing recovers
  from. `finishDeferredDeletion` (the boot sweep) disposes files FIRST and does the
  same accounting afterwards, which is fine because the session is cold there. The
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
  ⚠ **The PRIMARY seam has the same shape trap and it bit harder**:
  `sessionController.list()` answers `{ items: [...] }`, never a bare array, and
  its rows carry NO `title` and NO `createdAt` — `listFields()` adds only
  `cwd`/`origin`/`parentSessionId`. The display title is the `title` PROJECTION
  (`item.projections.values.title`), which is also where the official browser
  client reads it (`projectionValues?.title`). `collectSummaries()` used to
  require `Array.isArray(items)` and `return` immediately, so on a real host the
  map was always EMPTY and both the `list` endpoint and the
  `session_list_archived` tool reported `title: ''`/`(untitled)`, `cwd: null`,
  `updatedAt: null` for every archived session — silently, because the host
  test's fake returned exactly that invented flat-array `{ title }` shape. It
  now accepts BOTH shapes, reads the title from the projection, falls through to
  the persistence listing when the controller answers nothing usable, and warns
  once (`ctx.logger`) on an unrecognized shape instead of reporting an empty
  corpus. Keep all four; the fixture in `test/host.test.mjs` encodes the real
  shape on purpose, and `test/contract.test.mjs` now pins all three upstream
  facts — `assertControllerListShape` (the `{ items }` envelope, the
  `listState.list` delegation, the projections bag on each row) and
  `assertTitleProjection` (the `title` projection key) — against the installed
  modules.
- **One corpus read per operation** (`artifactIndex`, now
  `createArtifactResolver().index` in `lib/artifact-paths.js`): `sessionPersistence.list()`
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
- **An open-session delete leaves a residue — four rules, all load-bearing.**
  Full narrative, evidence and rejected fixes: `docs/delete-semantics.md`. In short:
  1. **The client must never pull the list for a queued id.** `pendingDeleteIds` is
     fed by the `rpc` wrapper, and `scheduleRemovedRefresh` checks it when
     scheduling AND when firing (the delete RESPONSE and the event travel on
     different channels, event first). Every other pull goes through the injected
     `pullSessions`, which re-checks the residue right after pulling; a bulk run
     containing ANY open delete skips its whole-run pull.
  2. **The tombstone hides the residue in the DEFAULT view only** — a sidebar set
     to show archived rows renders the stray. `reannouncePendingRemovals` (default
     `true`, read as `!== false`) re-announces `api-session/removed` for queued ids
     whose session is still LIVE: one repair per residue episode, never a poll loop.
  3. **Do NOT "fix" this by detaching the live session**: the agent stays
     registered for the process lifetime, `sessions.flush()` then throws for that
     id, and `session/disposed` listeners write artifacts back (doc §8.1 lists all
     of it).
  4. **The residue block is armed by a SUCCESSFUL queue read, never by the ping.**
     `observePending` sets `pendingSeeded`; `seedPendingQueue` retries a failed
     seed with the ping's own 1s/3s backoff and then warns once — keep it retried,
     with its timer in the teardown disposer.
  Regression cover: `test/host.test.mjs` + `test/client.render.test.mjs`
  (`grep -n "residue"` lists the cases) with `scripts/e2e-residue.mjs` as the
  real-Chrome acceptance. The test names are the contract.
- **Open (live-idle) sessions delete immediately, via a tombstone.** dsh has no
  public "close session" API, so the in-memory summary outlives the delete while
  the files can go right away. `deleteSession` queues the id BEFORE any mutation
  (crash safety), detaches it, keeps it in the archive set as a **tombstone**,
  disposes files + projcache, emits `api-session/removed`, and reports
  `openAtDelete: true`; the next-boot sweep clears the tombstone even when
  `sessionKnown` is false, and the settings page filters queued ids out of its
  rows. `deferred/list` reports which queued ids are still `recoverable`;
  `deferred/cancel` REFUSES an id that is not queued at all
  (`session/not-pending` — see below), READS the queue, DROPS THE MARKER, then
  clears the tombstone — **and rewrites the marker if the registry write fails** —
  and REFUSES entries whose files are already gone (`session/data-gone`) — which
  is why the cancel button's absence on cleaned-up ids is a protocol rule, not a
  convention. Only `recoverable` ids get a Cancel button; cleaned-up ids collapse
  into one summary line. `restoreSession` REFUSES queued ids (`session/pending`);
  a RUNNING task is refused unless `allowDeleteRunning`. `isOpen` alone decides
  the treatment (tombstone, pending marker, `openAtDelete`). Rationale and
  rejected alternatives: `docs/delete-semantics.md`.
  ⚠ **Cancelling is the one operation that puts a session BACK, so it requires
  the id to actually be queued.** Without that guard a cancel of a merely
  ARCHIVED id cleared its archive membership and returned success — a restore
  nobody asked for, reachable from a stale client, a second window, a hand-made
  request or two hosts on one home. `cancelPending` now answers
  `session/not-pending` and touches nothing (not even an empty queue file);
  `restoreSession`'s `session/pending` refusal is its mirror image. It comes
  BEFORE the `session/data-gone` probe on purpose: for an id nobody queued, the
  request itself is wrong, not the state of its files.
  ⚠ **The cancel's two durable writes are ordered marker-FIRST for a data-safety
  reason — do not "restore" the old tombstone-first order.** A crash or failure
  between them strands one of two states: "marker dropped, tombstone set" is
  harmless (hidden, and nothing finishes a deletion without a queued marker)
  while "tombstone cleared, marker set" is DATA LOSS — the boot sweep reads the
  surviving marker and deletes the session the user just cancelled, after telling
  them the cancel failed (proven by probe, then pinned by the host test "a cancel
  the registry refuses puts the marker back…"). The marker is rolled back with
  `_addPending` when `unarchiveThrough` fails, so the registry-failure case stays
  retryable too.
  ⚠ **`finishDeferredDeletion` keeps the OPPOSITE order (tombstone first, marker
  last), also deliberately.** There both writes pull toward the same outcome
  (finish the deletion), so a stranded marker is just an unfinished delete that
  the next boot completes, whereas a stranded tombstone would hide a session that
  can never be restored; the marker also goes last because "the queue no longer
  holds the id" is what the caller and the boot-sweep test read as "finished".
  ⚠ **A liveness seam that THROWS is not the same as one that answers "no".**
  `readLiveEntry` separates them: `deleteSession` treats "unknown" as cold (the
  user asked for this deletion; refusing over a diagnostic read would break a
  confirmed delete), while the autonomous boot sweep KEEPS the entry queued —
  a seam that is down is exactly when a session may still be open. The host test
  "a failed liveness check leaves the entry queued" is that contract.
  ⚠ **Registry bookkeeping in the commit zone is best-effort for the DETACH
  half**: a throwing `workspace.detachSession` is collected as a warning instead
  of aborting, because aborting mid-loop left the session half-detached, still
  archived and with its files intact — the "ungrouped resurrection" shape. An
  unusable registry still fails the delete at the archive-set write, which
  reports `details.queued === true` — for a COLD delete too, whose marker is now
  equally durable.
- **A COLD delete takes the same route and finishes inside the same call.** It
  writes the marker before any mutation and puts the id in the archive set as a
  tombstone, then disposes the files and — because no in-memory copy can outlive
  it — clears the tombstone and drops the marker itself. A failure in the file
  phase (or a throwing detach) leaves it tombstoned AND queued instead of
  reporting a finished delete whose residue the sidebar would render as a live
  session again; the boot sweep then finishes it (that is `finishDeferredDeletion`
  doing exactly what it already did). The marker is what closed the crash window:
  a cold delete used to write none, so a crash between the archive-set write and
  the `rm` left a session that was un-archived, detached and unqueued while its
  files stayed on disk — the next start listed it again as an ungrouped row and
  this plugin could no longer list, restore or retry it. The corpus read inside
  the file phase makes that window wide, not instantaneous. The ONE exception:
  when the queue cannot be read at all, a cold delete still proceeds (the escape
  hatch below) and REPORTS that it is not crash-safe; an OPEN delete still refuses
  there, because its marker is the only thing that could finish it.
  Regression cover: the four host tests around "a cold delete …" plus the
  platform-aware "a file failure after bookkeeping is a warning, not an aborted
  delete", which now asserts the tombstone+queue on Windows and the clean finish
  on POSIX.
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
  ⚠ **The lock is per-MANAGER, so two hosts sharing one `DSH_HOME` can still lose
  a marker** — confirmed, not theoretical: `node scripts/twohost-race-probe.mjs`
  (two managers, one temp home, one concurrent `addPending` each) prints
  `RESULT: LOST 1 marker(s): …`, and WHICH side loses varies run to run. Both read
  the same snapshot, both write their own on top, last write wins. A lost marker
  strands its tombstone in the archive set with no queue entry left to sweep it
  while its files are already gone — the stuck-ghost-row shape this plugin exists
  to prevent. Nothing here can serialize across processes: a faithful fix needs
  per-id atomic marker files (`open(…, 'wx')`, a queue-format change) or a real
  cross-process lock. ⚠ A verify-then-retry around the aggregate write is NOT a
  fix: the winner's verification can complete before the loser clobbers it, so it
  converges only by luck — do not add one and call this closed. Until the format
  changes, the supported configuration is ONE host per `DSH_HOME`; this bullet
  plus the probe are the whole record of why.
  ⚠ **That lock only serializes THIS plugin.** Archive-set writes must therefore
  go through the registry's OWN serialized entry points —
  `unarchiveThrough(reg, id)` / `archiveThrough(reg, id)` prefer
  `reg.unarchiveSession(id)` and `reg.archiveSession(id, { stopActivity: true })`
  and fall back to a `setState` spread only when they are absent. `setState` is a
  bare `global.set` in `dsh-workspace`, while every official mutation (archive,
  unarchive, pin, workspace create) runs on the registry's internal
  `enqueueOperation` queue: a hand-rolled read-modify-write lets our stale
  snapshot undo a concurrent official write, restoring the `pinnedSessionIds` /
  `defaultWorkspaceId` / `workspaceIds` we read a moment earlier. Official calls
  are also no-op-safe, and `archiveSession` drops the id from the PIN set (a
  hand-rolled add leaves it dangling). `stopActivity: true` is REQUIRED: without
  it `archiveSession` throws for running work, which would break
  `allowDeleteRunning` after it had already decided to proceed.
  ⚠ **A registry we cannot write safely is refused BEFORE anything is touched**
  (`assertRegistryWritable`, called at the top of `deleteLocked`, `restoreLocked`,
  `cancelPending` and `finishDeferredDeletion`): a registry exposing neither
  `requireState` nor the official pair has no faithful state to spread, and a
  refusal raised after the detach would strand the session (detached, still
  archived, no marker). `registryState()`'s reconstruction is marked
  `reconstructed: true` and reads only.
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
  STILL PROCEEDS on an unreadable queue (that escape hatch is deliberate — it is
  the only delete left when the file is corrupt) but now says so in its warnings,
  because without a marker it is not crash-safe; an OPEN delete refuses, since its
  marker is the only record that could finish it. Regression cover:
  `test/host.test.mjs` ("an unreadable pending queue is refused…" and "a cold
  delete still proceeds when the queue is unreadable, and says what that costs").
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
  ⚠ **The agent tool gates in front of the manager, in this order:** validate
  through `manager.assertSessionId` FIRST (a malformed id must always answer
  `bad-request` and never be masked into not-found/not-archived by the gates),
  then `manager.sessionKnown` → `session/not-found`, then `manager.isArchived`
  → `session/not-archived`. The archived gate is deliberate and does NOT apply
  to the human surfaces: the context-menu row is offered on every session row
  (documented feature), the settings page lists archived rows. It exists because
  the tool is model-facing and only the model could know an id it was never
  asked about. `isArchived`/`sessionKnown` are cheap registry reads (no corpus
  walk) and return `false` on a registry failure — a gate may only refuse,
  never widen access.
- **Version is single-sourced**: the RPC `ping` response reports
  `pluginVersion()`, which reads `package.json` at runtime; the
  `VERSION_FALLBACK` literal in `lib/index.js` is only a corrupt-manifest
  safety net. Bumping `package.json` is enough (a host test asserts the match).
- `package.json → files` is a whitelist; new runtime files must be added there.
- Config: schema in `lib/index.js` (`Config`); the supported channel is the
  COMPOSITION config (the profile entry's `config:`), which the Loader resolves
  into `apply(ctx, config)`. `effectiveConfig()` also merges per-user overrides
  read as `ctx.get('settings')?.get?.('dsh-session-manager')` — **that path is
  inert today**: the installed settings service (`SettingsForms`) exposes
  `configure`/`describe`/`update`/`documentPath`/… and **no `get`**, so the read
  yields nothing and the `sessionListLimit` clamp is the only thing that ever
  exercises the merge. It is kept as a forward-compatible seam — do not document
  it as a working feature, and do not "fix" it by inventing a settings method.
  ⚠ The host test's `settings` fake used to HAND the manager a `get()` the real
  service does not have, and drove the clamp through it — the exact fake-shape
  class this file warns about elsewhere. The fake is gone: the clamp is exercised
  through the composition config (`createSessionManager(ctx, { sessionListLimit })`,
  including `truncated`), and a settings service WITHOUT `get` is asserted to be
  tolerated.
- Client UI strings live in the inline `zh`/`en` locale dictionaries in
  `lib/client.js` — always add a key to **both**. Styling goes through the
  `TOKENS` map (dsw CSS variables with hardcoded fallbacks); the confirm dialog
  is plain DOM, not React, and shared by the settings page and the menu item.
  It admits **one dialog at a time** (a second request resolves as `null`, i.e.
  "cancelled", so no existing caller path changes), gives each instance a fresh
  `aria-labelledby` id (a fixed id would resolve to whichever overlay came
  first), and hands focus back to the element that opened it on close — the menu
  path's opener is unmounted by then, hence the `document.contains` check.
  ⚠ **The cancel path has to fall forward too.** `finish()` runs the caller's
  landing callback on a CONFIRMED decision; the menu item IS the opener and is
  unmounted when the menu closes, so a cancel there used to leave focus on
  `<body>` while the comment claimed otherwise. On cancel it now restores to a
  live opener when there is one and otherwise runs the caller's callback — whose
  menu-path version focuses the session ROW, which is the better target anyway.
  ⚠ **The dialog's Escape must call `preventDefault()`.** The Settings panel is a
  `useModalLayer` consumer whose document-level Escape handler bails out on
  `event.defaultPrevented`; our capture-phase listener runs first, so without it
  ONE Escape cancelled the dialog AND closed the Settings page behind it (and the
  panel's focus restore then overrode ours).
  ⚠ **Focus landing must skip DISABLED controls.** `focusAfterDelete` asks
  `[data-sm-row-delete], [data-sm-bulk-delete]` — and the bulk button is first in
  document order while being `disabled` with an empty selection, and `.focus()` on
  a disabled control is a spec'd no-op, so the chain never reached the section
  fallback and every confirmed row delete dropped focus on `<body>` (WCAG 2.4.3
  again). The selector carries `:not([disabled])`, and the render test asserts
  WHICH target was asked — an assertion that only counted focus requests passed
  while this shipped. There is no `scripts/e2e-focus.mjs`; the browser half of
  that check was never written and the suite is the coverage.
  ⚠ **Every card, row and toast must use the OPAQUE modal tokens, never the
  menu surface.** Measured on Windows: `--dsw-specific-menu` →
  `--dsw-menu-surface-fill` = `#f8f9fa94` (58% opaque) in light and `#43454a73`
  (45%) in dark; the ~94% figure is a `html[data-platform=darwin]` override
  only, so the previous "~94%-alpha" note understated the problem (field report:
  the dialog read as see-through). None of this plugin's surfaces is a popover
  inside the official menu, so that token is not used at all now, and its
  companion `--dsw-menu-backdrop-filter` was never applied anyway. Mirror the
  official modal
  instead (`dsh-client-ui-primitives Modal.module.css` / `Button.module.css`):
  card = `--dsw-alias-bg-layer-2` + `--dsw-radius-panel` (28px) +
  `--dsw-elevation-prominent`; mask = `--dsw-alias-bg-mask-1` +
  `--dsw-mask-blur` over `max(24px, var(--dsh-frame-overlay-top, 24px)) 24px`;
  actions = the `Button md` spec (36px tall, `--dsw-radius-md`, 14/22) with
  `RiskConfirmation`'s 72px/136px min-widths. `test/client.render.test.mjs`
  pins the tokens, and `scripts/e2e-dialog-style.mjs` compares the rendered
  styles against the live official dialog (all 8 checks must pass). The SAME rule
  now covers the danger TEXT roles — see the contrast bullet above; a red WASH
  behind danger text is unreadable by construction, so the failure banner uses the
  opaque surface with a red border.
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
  ⚠ **A bulk run must report the running sessions it SKIPPED.** `deleted` counted
  only successes while the summary mentioned only deleted/failed, so confirming
  five sessions and deleting two read as "deleted 2". The run now counts the
  skips, adds them to the partial summary and to the success line, advances the
  progress counter for them too, and — if every target turned running — never
  returns in silence (the pre-flight refusal says the same thing when it fires).
  ⚠ **The plain-DOM toast takes a `kind` (`'ok' | 'err'`) and is named
  `plainToast`.** It used to paint every message in the error colour, so the menu
  path's ONLY feedback channel drew a successful permanent delete exactly like a
  failure; and sharing the name `toast` with the component-local
  `toast(kind, text)` meant a one-argument call inside the component silently
  produced a warning toast with `undefined` text.
- Session ids are addressed only by exact **full session id** (index-based
  addressing was rejected with the old slash commands — indexes drift). The
  settings page filters out `origin === 'subagent'` rows.
- `e2e-artifacts/` and `.dsh-vision-router/` are gitignored artifact/leftover
  dirs — not part of the package, don't commit or clean code into them.

## Reference docs

`README.md` / `README.zh.md` document the delete semantics and config fields
(the user-facing "one host per `DSH_HOME`" warning and the cancel/tombstone
rules). `docs/delete-semantics.md` carries the long-form residue/tombstone
narrative that AGENTS.md only summarises, with the field evidence — read it
before touching `deleteSession`/`sweepPending`. The client
injection list lives in `package.json → dsh.client.inject` (the READMEs do not
carry it).
