# dsh-session-manager

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that
manages **archived sessions**. The official workspace browser only has an
"archive session" action — archived sessions then disappear from every view,
with no way to list, restore, or permanently delete them. This plugin fills
that gap and adds a red **Delete permanently** item to the session context menu.

[中文文档](README.zh.md)

## Features

### 1. Settings page: Settings → Session Manager

- Lists every **archived session**: title, owning workspace, project directory,
  update time, running state
- **Restore** (returns to its pre-archive position) and red
  **Delete permanently** per session
- Destructive confirm dialog — every delete is a direct physical delete,
  there is no backup layer
- Backed by the official session / workspace client stores — fully reactive

### 2. Session context menu: red "Delete permanently"

Hover a session row in the left sidebar → ⋯ menu: below the built-in
Rename / Fork session / Archive session items, a red **Delete permanently**
item appears (native danger styling, same confirm dialog).

> The official workspace browser exposes no slot for session menus, so the
> plugin augments the rendered popup via DOM observation + React-fiber
> resolution. The augmentation is passive: if the host UI structure changes
> and resolution fails, the button simply does not appear — nothing else is
> affected.

### 3. `/sessions` slash commands (host-dependent)

```
/sessions                          # overview
/sessions archived                 # list archived sessions
/sessions restore <#|id>           # restore (accepts the list index)
/sessions delete <id>              # permanent delete (full id only)
/sessions pending                  # sessions queued for deletion at the next restart
/sessions pending cancel <id>      # cancel one queued deletion
```

> Slash commands ride the host's plugin-command registry. It is available in `dsh web` compositions; **the current desktop build does not mount that service**, so there is no slash surface there — use the Settings page, the context-menu item or the agent tools instead.

### 4. Agent tools

| Tool | Notes |
| --- | --- |
| `session_list_archived` | List archived sessions as JSON |
| `session_restore_archived` | Restore by id (reversible, no confirmation) |
| `session_delete_permanently` | Delete by id; **requires `confirm: true`**; refuses running sessions |

## Install

```bash
git clone https://github.com/SunshineR04/dsh-session-manager.git
dsh plugin --profile <name> add "file:/path/to/dsh-session-manager"
```

`dsh plugin add` installs through pnpm and appends the package to
`dsh.profile.bundles`; this package's `cordis.patch.yml` bundle layer mounts
the plugin row automatically. **Restart the dsh desktop app afterwards**
(new bundles are not hot-loaded).

Alternatively mount it manually in the profile's `cordis.patch.yml` (the
bundle channel above is easier):

```yaml
- insert:
    - id: session-manager
      name: dsh-session-manager
```

## Delete semantics

Deleting runs in this order:

1. **Registry bookkeeping first (durable + broadcast)**: detaches the id from
   its workspace's `sessionIds` and removes it from the global archive set.
   The detach does not trust the workspace's filtered `sessionIds` view alone —
   a stale registry header index can hide the id from that getter (which used
   to let deleted sessions survive, resurfacing as *ungrouped* entries), so
   the raw workspace record is checked as a fallback.
2. Removes the session artifact directory
   `~/.dsh/sessions/<encoded-project>/<session-id>/` (`session.jsonl.zstd`).
   The directory is resolved through three seams in turn — registry header +
   persistence `locate`, the persistence header listing, then a raw scan of
   the sessions root for a directory named exactly the session id — so a
   degenerated header seam can no longer silently skip the deletion.
3. Removes the metadata checkpoint
   `~/.dsh/storages/session_projcache/sessions/<id>.json` (and `.bak-*`).
4. **Broadcasts the official `api-session/removed` event**, so every connected
   client drops the session from its list store immediately. (The host itself
   only emits this event when a live session is disposed, which a cold delete
   never is.)

The SQLite search index reconciles itself once the source files are gone;
attachments are content-addressed and intentionally kept.

- Every delete is a **direct physical deletion** — there is no backup
  layer, so double-check the confirm dialog.
- **Deleting an open session works immediately**: its registry accounting,
  files and metadata are removed at once (post-delete flushes cannot recreate
  anything — appends open the log by path and never recreate a deleted
  directory). Because dsh has no public "close session" API, the in-memory
  copy lingers (and still shows in that open view) until the owning UI scope
  dies; the id is kept in the archive set as a **tombstone**, so it is hidden
  from the workspace browser and every listing meanwhile, and the next dsh
  restart finishes the cleanup. Running sessions are still refused.
- **Pending banner**: the settings page lists sessions marked for deletion.
  Entries whose files are already gone (normal open-session deletes) show a
  "deleted · cleaned up after restart" hint with no cancel; only entries with
  files still on disk (e.g. a mid-delete crash leftover) offer **Cancel
  deletion**, which clears the tombstone as well.
- Restore only removes the id from the archive set — archiving keeps the
  workspace `sessionIds` slot, so the session returns to its previous position.

## Config

| Field | Default | Description |
| --- | --- | --- |
| `sessionListLimit` | `500` | Max entries per list call |
| `allowDeleteRunning` | `false` | Allow deleting live sessions (dangerous) |
| `toolDeleteRequiresConfirm` | `true` | Agent delete tool requires `confirm: true` |
| `menuDeleteAvailable` | `true` | Mount the red menu item |

## Develop

```bash
pnpm install
pnpm test   # syntax check + host unit tests + client render smoke tests
```

The render tests mount the real client settings section with React inside
jsdom (`test/client.render.test.mjs`) — they catch UI crashes the host tests
cannot see.

### Browser E2E (optional)

Boots a throwaway dsh web instance against an isolated `DSH_HOME` (never your
real data) and drives the UI with puppeteer-core + local Chrome:

```bash
cp scripts/e2e-seed.local.example.json scripts/e2e-seed.local.json
#    ^ fill in your own session/workspace data (gitignored, never committed)
node scripts/e2e-seed.mjs <e2e-home> ~/.dsh         # 1. seed the isolated test HOME
# 2. create a profile in that HOME with this plugin, then start the test web instance:
#    DSH_HOME=<e2e-home> dsh --profile sm-test --port 43123 --no-open
node scripts/e2e-check.mjs <printed token URL>      # 3. read-only checks: menu item / settings page
node scripts/e2e-mutations.mjs <URL> <e2e-home>     # 4. closed loop: restore → archive → delete
```

## References

Built after studying these projects (some locally inspectable under
`~/.dsh/profiles/desktop/node_modules`):

- [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) —
  the community-plugin reference for bundle patches, client injection,
  settings-section registration and host routes
- [ysr666/dsh-vision-router](https://github.com/ysr666/dsh-vision-router) —
  the hand-written no-bundler client skeleton this package follows
- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) —
  the host itself: workspace controller, session controller, jsonl persistence,
  workspace domain (archive-set semantics)
- [koishijs/koishi](https://github.com/koishijs/koishi) — Cordis runtime upstream
- [tmux-plugins/tmux-resurrect](https://github.com/tmux-plugins/tmux-resurrect),
  [opencode-ai/opencode](https://github.com/opencode-ai/opencode) —
  conceptual references for session save/restore/cleanup UX

## License

MIT
