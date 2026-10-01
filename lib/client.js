// dsh-session-manager — browser half.
//
// Self-contained by hand (no bundler), mirroring the dsh-vision-router client
// module: the client module system wraps this file in a CJS factory and the
// kernel adopts `{ apply, inject }` as a client plugin.
//
// Two surfaces:
//   1. Settings → Session Manager: a first-class settings section listing
//      archived sessions with restore / permanently-delete actions, plus the
//      workspace client stores; mutations go through the host-owned
//      `/session-manager` connection RPC channel.
//   2. Session context menu: a red "permanently delete" row registered into
//      the official slot `sidebar.workspaces.session.menu.item` (order 500,
//      after the shipped pin / rename / fork / archive rows). dsh 0.1.7-alpha.1
//      declared that slot; before it existed this surface had to observe the
//      DOM and resolve the session through the React fiber tree, and every
//      official change to the menu's markup could drop the item silently.
//      Do not reintroduce DOM or label matching — see the block comment above
//      `plainToast()` for what that cost.
window.__ModuleLoader__.load({
  id: 'dsh-session-manager',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const { useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } = React
    // Product icon names are size-neutral since dsh 0.1.7 (the old
    // artboard-suffixed `IconXxx20`/`IconXxx16` exports were removed): the
    // `Regular` weight keeps the one-pixel artwork and each glyph's own
    // default size, which matches the suffix these names used to carry.
    const {
      IconArchiveOutlineRegular,
      IconCheckOutlineRegular,
      IconLoadingOutlineRegular,
      IconRefreshOutlineRegular,
      IconTrashOutlineRegular,
      IconWarningOutlineRegular,
      // The row primitive the shipped pin / rename / fork / archive menu rows
      // use: it brings the row's danger colors, its hairline separator and the
      // shortcut cell, and joins the menu's DOM-driven keyboard walk.
      MenuItemButton,
    } = require('@deepseek-ai/dsh-client-ui-primitives')

    const NS = 'session-manager'
    // RPC calls ride the host's shared `/api` prefix as per-endpoint exact
    // routes: POST `${CHANNEL}/${endpoint}` with `method` = `${NS}/${endpoint}`
    // (the host half registers one route per endpoint — see RPC_ENDPOINTS).
    const CHANNEL = '/api'

    // ── locale dictionaries ---------------------------------------------------
    const zh = {
      nav: '会话管理',
      navDesc: '管理已归档的会话：恢复或彻底删除。',
      archivedTitle: '已归档会话',
      count: '{n} 个已归档会话',
      empty: '没有已归档的会话。在左侧会话列表的 ⋯ 菜单中点击「归档会话」即可归档。',
      loading: '加载中…',
      unavailable: '会话管理服务不可用：宿主 RPC 通道未连接。请确认插件已挂载后刷新页面。',
      restore: '恢复',
      restoreOk: '已恢复会话「{title}」',
      delete: '彻底删除',
      deleteConfirmTitle: '彻底删除会话？',
      deleteConfirmBody: '即将永久删除会话「{title}」及它的全部记录。此操作不可撤销。',
      confirm: '删除',
      cancel: '取消',
      confirmRenderFailed: '确认框无法显示，请重试，或改在设置页删除。',
      pendingCancelOk: '已取消删除',
      deleteOk: '已永久删除会话「{title}」',
      deleteOkOpen: '已永久删除会话「{title}」，并已从列表移除；残留的内存副本将在重启 dsh 后彻底清除。',
      selectAll: '全选',
      selectRow: '选择会话「{title}」',
      deleteSelected: '删除选中的 {n} 个',
      deleteBulkConfirmTitle: '彻底删除 {n} 个会话？',
      deleteBulkConfirmBody: '即将永久删除已选中的 {n} 个会话及其全部记录。此操作不可撤销。',
      deleteBulkRunningNote: '其中 {n} 个正在运行任务，将被跳过。',
      deleteBulkConfirmLabel: '删除 {n} 个',
      deleteBulkProgress: '正在删除 {done}/{total}…',
      deleteBulkOk: '已永久删除 {n} 个会话',
      deleteBulkOkOpen: '已永久删除 {n} 个会话并已从列表移除；其中 {m} 个的残留内存副本将在重启 dsh 后彻底清除',
      deleteBulkPartial: '批量删除完成：成功 {n} 个，失败 {m} 个。',
      deleteBulkAllRunning: '选中的 {n} 个会话都在运行任务，无法删除。请等待任务完成。',
      deleteBulkSkipped: '已跳过 {n} 个运行中的会话',
      pendingBanner: '有 {n} 个会话已标记删除，重启 dsh 后完成最终清理：',
      pendingFinalizedBanner: '有 {n} 个会话已彻底删除，界面缓存将在重启 dsh 后自动清理。',
      pendingShowFinalized: '显示已清理的条目',
      pendingHideFinalized: '隐藏已清理的条目',
      pendingCancel: '取消删除',
      pendingFinalizing: '已删除 · 重启后自动清理',
      refreshFailed: '会话列表未能自动刷新：请点击「刷新」；若旧会话仍显示，可重启应用。',
      versionLine: '插件 v{version} · 会话服务 {status}',
      rpcUnreachable: 'RPC 未连接',
      errorRpcUnavailable: '连接 RPC 不可用',
      errorRpcFailed: '会话管理 RPC 调用失败',
      statusOk: '正常',
      statusAbsent: '未挂载',
      runningRefused: '会话「{title}」正在运行任务，请等待任务完成后再删除。',
      errorPrefix: '操作失败：',
      refresh: '刷新',
      workspaceUngrouped: '未分组',
      running: '运行中',
      unknownSession: '（会话不存在）',
      menuDelete: '彻底删除',
      menuBusy: '上一个删除操作还在进行，请稍候再试',
      checking: '检查中…',
    }
    const en = {
      nav: 'Session Manager',
      navDesc: 'Manage archived sessions: restore or permanently delete them.',
      archivedTitle: 'Archived sessions',
      count: '{n} archived sessions',
      empty: 'No archived sessions. Archive one from the ⋯ menu on a session row in the left sidebar.',
      loading: 'Loading…',
      unavailable: 'Session manager unavailable: the host RPC channel is not connected. Reload the page after mounting the plugin.',
      restore: 'Restore',
      restoreOk: 'Restored session “{title}”',
      delete: 'Delete permanently',
      deleteConfirmTitle: 'Permanently delete session?',
      deleteConfirmBody: 'Session “{title}” and all of its records will be permanently deleted. This cannot be undone.',
      confirm: 'Delete',
      cancel: 'Cancel',
      confirmRenderFailed: 'The confirmation dialog could not be shown; retry, or delete from the Settings page.',
      pendingCancelOk: 'Deletion cancelled',
      deleteOk: 'Permanently deleted session “{title}”',
      deleteOkOpen: 'Permanently deleted session “{title}” and removed it from the list; the leftover in-memory copy is cleared after the next dsh restart.',
      selectAll: 'Select all',
      selectRow: 'Select session “{title}”',
      deleteSelected: 'Delete {n} selected',
      deleteBulkConfirmTitle: 'Permanently delete {n} sessions?',
      deleteBulkConfirmBody: 'The {n} selected sessions and all of their records will be permanently deleted. This cannot be undone.',
      deleteBulkRunningNote: '{n} of them have a running task and will be skipped.',
      deleteBulkConfirmLabel: 'Delete {n}',
      deleteBulkProgress: 'Deleting {done}/{total}…',
      deleteBulkOk: 'Permanently deleted {n} sessions',
      deleteBulkOkOpen: 'Permanently deleted {n} sessions and removed them from the list; {m} of their leftover in-memory copies are cleared after the next dsh restart',
      deleteBulkPartial: 'Bulk delete finished: {n} deleted, {m} failed.',
      deleteBulkAllRunning: 'All {n} selected sessions have a running task and cannot be deleted. Wait for them to finish.',
      deleteBulkSkipped: 'Skipped {n} running session(s)',
      pendingBanner: '{n} sessions are marked for deletion; the cleanup completes after the next dsh restart:',
      pendingFinalizedBanner: '{n} sessions are already permanently deleted; the on-screen copies clear after the next dsh restart.',
      pendingShowFinalized: 'Show cleaned-up entries',
      pendingHideFinalized: 'Hide cleaned-up entries',
      pendingCancel: 'Cancel deletion',
      pendingFinalizing: 'Deleted · cleaned up automatically after restart',
      refreshFailed: 'The session list could not refresh automatically: click “Refresh”; if the old row remains, restart the app.',
      versionLine: 'Plugin v{version} · session service {status}',
      rpcUnreachable: 'RPC unreachable',
      errorRpcUnavailable: 'connection RPC is unavailable',
      errorRpcFailed: 'session-manager RPC failed',
      statusOk: 'ok',
      statusAbsent: 'absent',
      runningRefused: 'Session “{title}” has a running task; wait for it to finish before deleting.',
      errorPrefix: 'Operation failed: ',
      refresh: 'Refresh',
      workspaceUngrouped: 'Ungrouped',
      running: 'Running',
      unknownSession: '(session missing)',
      menuDelete: 'Delete permanently',
      menuBusy: 'Another deletion is still in progress — please wait',
      checking: 'Checking…',
    }

    const dict = { zh, en }

    // ── tiny helpers -----------------------------------------------------------
    const format = (t, key, vars) => {
      let text = t(key) ?? key
      if (vars) for (const [name, value] of Object.entries(vars)) text = text.split(`{${name}}`).join(String(value))
      return text
    }
    const formatDate = (ms) => {
      if (ms === null || ms === undefined || ms === 0) return '—'
      try {
        return new Date(ms).toLocaleString()
      } catch {
        return '—'
      }
    }
    const errorMessage = (error) =>
      error && typeof error === 'object' && typeof error.message === 'string'
        ? error.message
        : error && typeof error === 'object' && typeof error.code === 'string'
          ? error.code
          : String(error)

    /** Stable-code match for the running refusal; the message scrape is only
     *  a fallback for errors raised before the rpc layer could attach `code`. */
    const isRunningError = (error) => (error !== null && typeof error === 'object' && error.code === 'session/running')
      || errorMessage(error).includes('session/running')

    /**
     * The first value that is actually a title.
     *
     * `??` only rejects null/undefined, so an EMPTY string passed straight
     * through: a session whose title is `''` (the official type says
     * `displayTitle` is never absent, but it can be empty) rendered as a blank
     * row with no way to tell it apart from a render failure.
     */
    const firstTitle = (...values) => values.find((value) => typeof value === 'string' && value.trim() !== '')

    /**
     * Re-pull the session list through the client service's public entry point.
     *
     * `refresh()` is the ONLY name the service carries: `refreshList()` lives
     * solely on the controller's internal `SessionManager`, and `ctx.get('sessions')`
     * hands out the service that wraps it. Verified against the published
     * 0.1.5-rc.1, 0.1.7-alpha.1 and 0.1.7-rc.1 packages plus the installed
     * 0.1.7-rc.2 — all four expose `refresh()` and none exposes `refreshList()`.
     * Every guard here used to ask for `refreshList`, so all of them silently
     * skipped and the "list did not refresh" banner was a lie.
     *
     * Returns false when the service is not mounted (or predates the method), so
     * callers keep their graceful-skip path instead of throwing.
     */
    const refreshSessionList = async (sessions) => {
      if (sessions === undefined || sessions === null || typeof sessions.refresh !== 'function') return false
      await sessions.refresh()
      return true
    }

    // ── design-token styles ----------------------------------------------------
    const TOKENS = {
      text: 'var(--dsw-alias-label-primary, #1f2328)',
      textSecondary: 'var(--dsw-alias-label-secondary, #4b5563)',
      // There is deliberately NO `textTertiary`: the aliased
      // `--dsw-alias-label-tertiary` measures 3.70:1 on the light card, so it
      // cannot carry text at this plugin's sizes (its floor is 4.5:1, not the
      // 3:1 that applies to icons). `metaText` covers that role with the
      // palette's own next step down.
      danger: 'var(--dsw-alias-state-error-primary, #e5484d)',
      // READABLE red, for danger text and icons on a FLAT surface.
      //
      // `danger` above is the theme's error red and is used here as a FILL (the
      // confirm button's background, a toast border), where it is fine. As TEXT
      // it does not clear the WCAG AA 4.5:1 floor at this plugin's sizes, and
      // MEASURED in the live GUI the two themes fail in OPPOSITE directions:
      // the aliased red-400 (#f25a5a) is 4.24:1 on the dark card (#2c2c2e) but
      // 3.29:1 on white, while red-600 (#ec1313) is 4.50:1 on white but only
      // 3.10:1 on the dark card. No single red in the scale works for both — so
      // this token builds one per scheme from that same scale.
      //
      // `light-dark()` is the right primitive: the host already declares
      // `color-scheme: light|dark` on <html> (measured), and inline styles cannot
      // carry a media query. Each branch keeps its own literal, because a var()
      // fallback inside light-dark() would pin BOTH branches to one value. The
      // literals are NOT the nearest scale entries: red-600 is 4.4976:1 on white
      // — just under the floor — so the light branch is a slightly deeper red.
      // Measured after this change: 4.83:1 light, 4.73:1 dark.
      // A browser without light-dark() drops the declaration and inherits —
      // the same failure it has today, never a worse one.
      dangerText: 'light-dark(#dc2626, #f36b6b)',
      // The FILL of a danger button, whose label is `onPrimary`. The theme's
      // error red (#ec1313 light) leaves white at 4.4976:1 — the exact number
      // this file cites as the reason that red was rejected as a TEXT colour,
      // and it is just as short of the floor under a white label. The dark
      // branch is the token's own #f25a5a (5.83:1 against the dark onPrimary).
      dangerFill: 'light-dark(#dc2626, #f25a5a)',
      // Link/action TEXT: Restore, Refresh, Cancel deletion, the running pill.
      // `primary` is the theme's accent and measures 4.24:1 on the light card —
      // under AA at these sizes — while its own fallback (#4a5cf0) would have
      // passed 5.15:1. The light branch is the palette's #4868b2 (5.39:1); dark
      // keeps the token's #7aaaff (5.99:1).
      primaryText: 'light-dark(#4868b2, #7aaaff)',
      // Small META text: the row meta line, pending ids, loading/empty states.
      // The aliased `label-tertiary` is #81858c in light = 3.70:1 on the card;
      // the palette's own next step down (#61666b, what `label-secondary`
      // resolves to) is 5.80:1. Dark keeps the token's #adb2b8 (6.53:1).
      metaText: 'light-dark(#61666b, #adb2b8)',
      hoverBg: 'var(--dsw-alias-interactive-bg-hover, rgba(31, 35, 40, 0.06))',
      border: 'var(--dsw-alias-border-l1, rgba(31, 35, 40, 0.08))',
      // Every card, row and toast in this file sits on the official OPAQUE
      // layer-2 surface. Never `--dsw-specific-menu` here: that is the popover
      // fill and it is translucent — measured on Windows as `#f8f9fa94` (58%
      // opaque) in light and `#43454a73` (45%) in dark, with the ~94% value
      // being a darwin-only override, and its companion `--dsw-menu-backdrop-
      // filter` is never applied here. None of these surfaces is a popover
      // inside the official menu, so the menu token is not used at all (the
      // floating status toast was the worst offender: it overlays arbitrary
      // page content).
      panelSurface: 'var(--dsw-alias-bg-layer-2, #ffffff)',
      panelRadius: 'var(--dsw-radius-panel, 28px)',
      panelShadow: 'var(--dsw-elevation-prominent, 0 3px 8px rgba(0, 0, 0, 0.04), 0 0 20px rgba(0, 0, 0, 0.05))',
      mask: 'var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.24))',
      maskBlur: 'var(--dsw-mask-blur, none)',
      controlRadius: 'var(--dsw-radius-md, 12px)',
      borderL3: 'var(--dsw-alias-border-l3, rgba(31, 35, 40, 0.1))',
      primary: 'var(--dsw-alias-state-business-primary, #4a5cf0)',
      primaryBg: 'var(--dsw-alias-button-primary-fill, #4a5cf0)',
      primaryHover: 'var(--dsw-alias-button-primary-hover, #3d4bd0)',
      onPrimary: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
    }

    // Keyframes for the refresh spinner and the confirm-dialog fade-in —
    // inline styles cannot declare @keyframes, so inject the stylesheet once
    // (idempotent). Returns the <style> node so `apply`'s teardown can remove
    // it with everything else this half injected.
    const ensureSpinStyle = () => {
      try {
        const existing = document.getElementById('dsh-session-manager-styles')
        if (existing !== null) return existing
        const style = document.createElement('style')
        style.id = 'dsh-session-manager-styles'
        style.textContent = '@keyframes sm-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}@keyframes sm-fade-in{from{opacity:0}to{opacity:1}}@media (prefers-reduced-motion: reduce){[data-sm-confirm]{animation:none !important}}'
        document.head.appendChild(style)
        return style
      } catch {
        // Cosmetic only — without it the icon just does not spin.
        return null
      }
    }

    // ── plain-DOM confirm dialog (shared by section + menu item) ---------------
    // One at a time, each instance labelled by its own id. Two overlays would
    // both carry a fixed title id and `aria-labelledby` would resolve to
    // whichever element came first. The menu path also serializes itself
    // (`menuConfirmBusy`); this guard covers every entry point — the row button,
    // the bulk button, the menu item, and anything programmatic or AT-driven
    // that the covering overlay cannot block.
    let confirmSeq = 0
    let confirmOpen = false
    /** Closes the open dialog, if any, releasing the one-at-a-time guard.
     *  Module scope so `apply`'s teardown can call it: a plugin reload with a
     *  dialog open would otherwise leave the orphan overlay, its document
     *  listener AND `confirmOpen === true`, so every later confirm would resolve
     *  null — a silently dead delete button on the next mount of this module. */
    let closeOpenConfirm = null
    function openConfirm({ title, body, confirmLabel, cancelLabel, danger = false, onRenderError = null, afterConfirmFocus = null }) {
      return new Promise((resolve) => {
        if (confirmOpen) {
          try { console.warn('[dsh-session-manager] a confirmation dialog is already open; ignoring the second request') } catch { /* noop */ }
          resolve(null)
          return
        }
        confirmOpen = true
        const instance = ++confirmSeq
        const titleId = `dsh-session-manager-confirm-title-${instance}`
        const bodyId = `dsh-session-manager-confirm-body-${instance}`
        // Whatever had focus before the dialog opened gets it back on close.
        const opener = document.activeElement
        const overlay = document.createElement('div')
        overlay.setAttribute('data-sm-confirm', '1')
        // Dialog semantics travel with the focus ring wired up in onKey(): with
        // aria-modal="true" the rest of the page is announced as inert, so Tab
        // must not be allowed to walk into it. `aria-describedby` names the
        // consequence text — on an irreversible delete the title alone ("delete
        // this session?") is not the information the user needs.
        overlay.setAttribute('role', 'dialog')
        overlay.setAttribute('aria-modal', 'true')
        overlay.setAttribute('aria-labelledby', titleId)
        overlay.setAttribute('aria-describedby', bodyId)
        // Official modal geometry (dsh-client-ui-primitives Modal.module.css):
        // a full-viewport flex layer painting the shared mask, with the card on
        // the opaque layer-2 surface. Dialog cards use the panel radius and the
        // prominent elevation; consumers cap growth with max-height, never their
        // own viewport calc.
        Object.assign(overlay.style, {
          position: 'fixed', inset: '0', zIndex: '2147483000',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 'max(24px, var(--dsh-frame-overlay-top, 24px)) 24px',
          background: TOKENS.mask, backdropFilter: TOKENS.maskBlur,
          animation: 'sm-fade-in var(--ds-transition-duration, .2s) ease-out',
        })
        const card = document.createElement('div')
        Object.assign(card.style, {
          width: 'min(440px, 100%)', maxHeight: '100%', boxSizing: 'border-box',
          display: 'flex', flexDirection: 'column', gap: '20px',
          borderRadius: TOKENS.panelRadius, padding: '0 0 24px',
          background: TOKENS.panelSurface,
          color: TOKENS.text, boxShadow: TOKENS.panelShadow,
          fontFamily: 'inherit', overflow: 'hidden',
        })
        const titleEl = document.createElement('div')
        titleEl.id = titleId
        titleEl.textContent = title
        Object.assign(titleEl.style, {
          fontSize: '16px', lineHeight: '24px', fontWeight: '500',
          margin: '0', padding: '22px 24px 0',
        })
        const bodyEl = document.createElement('div')
        bodyEl.id = bodyId
        bodyEl.textContent = body
        Object.assign(bodyEl.style, {
          fontSize: '14px', lineHeight: '22px', color: TOKENS.textSecondary,
          margin: '0', padding: '0 24px', whiteSpace: 'pre-wrap',
        })
        card.appendChild(titleEl)
        card.appendChild(bodyEl)

        const actions = document.createElement('div')
        Object.assign(actions.style, {
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
          gap: '8px', padding: '0 24px',
        })
        // Official Button geometry (Button.module.css `md`): 36px tall, radius-md,
        // 14/22, 14px inline padding. Cancel is the outline variant; the
        // destructive confirm keeps this plugin's red fill (same semantic as the
        // red menu row) with the official hover feedback.
        const mkButton = (text, primary) => {
          const button = document.createElement('button')
          button.type = 'button'
          button.textContent = text
          Object.assign(button.style, {
            boxSizing: 'border-box', height: '36px',
            minWidth: primary ? '136px' : '72px',
            borderRadius: TOKENS.controlRadius, cursor: 'pointer',
            fontSize: '14px', lineHeight: '22px', padding: '0 14px',
            ...(primary
              ? { border: 'none', background: danger ? TOKENS.dangerFill : TOKENS.primaryBg, color: TOKENS.onPrimary }
              : { border: `0.5px solid ${TOKENS.borderL3}`, background: 'transparent', color: TOKENS.text }),
          })
          const restBackground = primary ? (danger ? TOKENS.dangerFill : TOKENS.primaryBg) : 'transparent'
          button.addEventListener('mouseenter', () => {
            if (primary) {
              if (danger) button.style.filter = 'brightness(1.08)'
              else button.style.background = TOKENS.primaryHover
            } else {
              button.style.background = TOKENS.hoverBg
            }
          })
          button.addEventListener('mouseleave', () => {
            button.style.filter = 'none'
            button.style.background = restBackground
          })
          return button
        }
        const cancelButton = mkButton(cancelLabel, false)
        const confirmButton = mkButton(confirmLabel, true)
        cancelButton.addEventListener('click', () => finish(null))
        confirmButton.addEventListener('click', () => finish(true))
        actions.appendChild(cancelButton)
        actions.appendChild(confirmButton)
        card.appendChild(actions)
        overlay.appendChild(card)
        overlay.addEventListener('click', (event) => { if (event.target === overlay) finish(null) })
        const focusRing = [cancelButton, confirmButton]
        const onKey = (event) => {
          // Escape cancels. There is deliberately NO global Enter-to-confirm:
          // this dialog confirms an irreversible physical delete, so it must
          // not fire on an Enter that was never aimed at the Delete button.
          if (event.key === 'Escape') {
            // Claim the key: the Settings panel is a `useModalLayer` consumer
            // whose document-level Escape handler bails out on
            // `event.defaultPrevented`, so without this one Escape also closed
            // the whole panel behind the dialog (and its focus restore then won
            // the race with ours).
            event.preventDefault()
            finish(null)
            return
          }
          // Two focusable elements, cycled: Tab (or Shift+Tab) keeps focus inside
          // the dialog, which is what role="dialog" + aria-modal="true" promise.
          if (event.key !== 'Tab') return
          const index = focusRing.indexOf(document.activeElement)
          const step = event.shiftKey ? -1 : 1
          event.preventDefault()
          try {
            focusRing[(index + step + focusRing.length) % focusRing.length].focus()
          } catch { /* noop */ }
        }
        document.addEventListener('keydown', onKey, true)
        let done = false
        function finish(value) {
          if (done) return
          done = true
          confirmOpen = false
          closeOpenConfirm = null
          document.removeEventListener('keydown', onKey, true)
          overlay.remove()
          // Hand focus back to whatever opened the dialog (the row's delete
          // button, the menu trigger).
          //
          // Cancel: restore to the opener, which is usually still there.
          // Confirm: the opener is usually GONE by now — the list refreshed and
          // unmounted the row it belonged to — so restoring to it drops focus on
          // <body>, which is a WCAG 2.4.3 (Focus Order, Level A) failure and
          // strands keyboard users at the top of the document. The caller
          // supplies a stable landing spot instead (see `focusAfterDelete`).
          try {
            const restored = opener !== null && opener !== overlay && typeof opener.focus === 'function' && document.contains(opener)
            if (value === null || value === false) {
              // Cancel: the opener is usually still there (a row's own delete
              // button). The MENU path's opener is the menu item, unmounted the
              // moment the menu closes — nothing would then hold focus, so the
              // caller's landing logic has to run on this path too, which is
              // what the menu caller's own comment already claimed.
              if (restored) opener.focus()
              else if (typeof afterConfirmFocus === 'function') afterConfirmFocus()
            } else if (typeof afterConfirmFocus === 'function') afterConfirmFocus()
            else if (restored) opener.focus()
          } catch { /* noop */ }
          resolve(value)
        }
        closeOpenConfirm = () => finish(null)
        try {
          document.body.appendChild(overlay)
          // Safe default focus: Enter (or Space) from here activates CANCEL,
          // and a keyboard user can Tab to Delete deliberately.
          cancelButton.focus()
        } catch (error) {
          // Nothing was attached. Resolve through the SAME channel the
          // degenerate-render check below uses — "cancelled" — instead of
          // leaving `confirmOpen` set (which would silently neuter every later
          // confirm) and instead of rejecting a promise every caller awaits
          // outside try/catch (an unhandled rejection with no user feedback).
          finish(null)
          const failure = new Error(`session-manager: the confirm dialog could not be attached (${errorMessage(error)})`)
          if (typeof onRenderError === 'function') onRenderError(failure)
          else console.error('[dsh-session-manager]', String(failure))
          return
        }
        // Cheap render sanity check: the overlay must cover (most of) the
        // viewport. A degenerate/shrunk overlay means some host CSS (e.g. a
        // transformed body) broke fixed positioning — surface that through
        // the caller's error channel instead of failing silently.
        queueMicrotask(() => {
          try {
            if (document.body.contains(overlay)) {
              const rect = overlay.getBoundingClientRect()
              const wide = rect.width >= window.innerWidth * 0.5
              const tall = rect.height >= window.innerHeight * 0.5
              if (wide && tall) return
            }
            finish(null)
            const renderError = new Error('session-manager: confirm overlay failed to render (host CSS transform?)')
            if (typeof onRenderError === 'function') onRenderError(renderError)
            else console.error('[dsh-session-manager]', String(renderError))
          } catch {
            // Diagnostic only.
          }
        })
      })
    }

    // ── React settings section --------------------------------------------------
    const rowStyles = {
      row: {
        display: 'flex', alignItems: 'center', gap: '10px',
        padding: '10px 12px', borderRadius: '12px', background: TOKENS.panelSurface,
        // Longhands, not the `border` shorthand: the selected row overrides
        // `borderColor` on re-render, and React warns (correctly) that removing
        // a longhand while its shorthand is set is ambiguous.
        borderWidth: '1px', borderStyle: 'solid', borderColor: TOKENS.border,
      },
      title: { fontSize: '14px', lineHeight: '20px', color: TOKENS.text, fontWeight: '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      meta: { fontSize: '12px', lineHeight: '17px', color: TOKENS.metaText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      button: (danger, disabled) => ({
        display: 'inline-flex', alignItems: 'center', gap: '6px', border: '1px solid transparent',
        borderRadius: '8px', cursor: disabled ? 'not-allowed' : 'pointer', fontSize: '12.5px', lineHeight: '18px',
        padding: '5px 10px', opacity: disabled ? 0.5 : 1, background: 'transparent',
        color: danger ? TOKENS.dangerText : TOKENS.primaryText,
      }),
      linkButton: (danger) => ({
        display: 'inline-flex', alignItems: 'center', gap: '6px', border: 'none', borderRadius: '8px',
        cursor: 'pointer', fontSize: '13px', lineHeight: '20px', padding: '6px 10px', background: 'transparent',
        color: danger ? TOKENS.dangerText : TOKENS.primaryText,
      }),
    }

    /**
     * Put focus somewhere stable after a CONFIRMED delete.
     *
     * The row that was deleted — and therefore the element that opened the
     * dialog — is unmounted by the refresh that follows, so restoring to it
     * drops focus on `<body>` (measured in the real GUI; WCAG 2.4.3 needs focus
     * order to stay meaningful). Land on the next destructive control if there
     * is one, otherwise on the section itself, which is only focusable because
     * this function gives it `tabindex="-1"` — a focus target that exists is
     * exactly what keeps the user from being thrown back to the document top.
     */
    const focusAfterDelete = () => {
      try {
        // `:not([disabled])` is load-bearing, not tidiness: the bulk-delete
        // button is the FIRST match in document order (it lives in the list
        // header, ahead of every row) and is disabled whenever nothing is
        // selected — and focusing a disabled control is a spec'd no-op. Asking
        // it left focus on `<body>` after every confirmed row delete, i.e. the
        // exact WCAG 2.4.3 failure this helper exists to prevent, while the
        // section fallback below stayed unreachable.
        const next = document.querySelector('[data-sm-row-delete]:not([disabled]), [data-sm-bulk-delete]:not([disabled])')
        if (next !== null && typeof next.focus === 'function') {
          next.focus()
          return
        }
        const section = document.querySelector('[data-sm-section]')
        if (section !== null) {
          if (section.tabIndex < 0 && section.getAttribute('tabindex') === null) section.setAttribute('tabindex', '-1')
          section.focus()
          return
        }
        const fallback = document.querySelector('[data-sm-banner], [data-sm-confirm-anchor]')
        if (fallback !== null && typeof fallback.focus === 'function') {
          fallback.setAttribute('tabindex', '-1')
          fallback.focus()
          return
        }
        // Nothing addressable: focus the body deliberately so the drop is a
        // decision rather than a side effect.
        document.body.focus?.()
      } catch { /* noop */ }
    }

    const FALLBACK_WORKSPACES = Object.freeze({ items: [], archivedSessionIds: [] })
    const FALLBACK_SESSIONS = Object.freeze({ byId: {}, ids: [], phase: 'ready' })
    /** Same reason as the frozen fallbacks: `byId || {}` allocated a fresh
     *  object whenever the snapshot lacked the key, invalidating the `rows` memo
     *  on every render. */
    const EMPTY_BY_ID = Object.freeze({})

    function useStoreSubscription(store, fallback) {
      const subscribe = useMemo(() => (store && typeof store.subscribe === 'function' ? store.subscribe.bind(store) : () => () => {}), [store])
      const getSnapshot = useMemo(() => (store && typeof store.getSnapshot === 'function' ? store.getSnapshot.bind(store) : () => fallback), [store, fallback])
      return useSyncExternalStore(subscribe, getSnapshot)
    }

    function SessionManagerSection(props) {
      const t = props.t
      const rpc = props.rpc
      const sessions = typeof props.getSessions === 'function' ? props.getSessions() : props.sessions
      const workspaces = typeof props.getWorkspaces === 'function' ? props.getWorkspaces() : props.workspaces
      // Every list pull has to re-check the pending-deletion residue, so the
      // pull arrives through the inject face: this component is module scope and
      // cannot see `apply`'s closure. The fallback keeps a caller that injects
      // only the older props working (it is the pre-residue behavior).
      const pullSessions = typeof props.pullSessions === 'function' ? props.pullSessions : () => refreshSessionList(sessions)

      const wsSnapshot = useStoreSubscription(workspaces && workspaces.list, FALLBACK_WORKSPACES)
      const sessSnapshot = useStoreSubscription(sessions && sessions.list, FALLBACK_SESSIONS)

      const archivedIds = useMemo(() => (Array.isArray(wsSnapshot.archivedSessionIds) ? wsSnapshot.archivedSessionIds : []), [wsSnapshot])
      const byId = sessSnapshot.byId !== undefined && sessSnapshot.byId !== null ? sessSnapshot.byId : EMPTY_BY_ID

      // Pending (tombstoned) ids are declared before `rows` — the rows filter
      // reads them during render. They split by ACTIONABILITY: an entry whose
      // files are still on disk can be cancelled, while an entry already
      // cleaned up (the normal open-session delete) has nothing left to act
      // on — for those the tombstone is doing its job and the id disappears
      // for good after the next restart, so they must not occupy the banner
      // with a row the user can do nothing about.
      const [pendingIds, setPendingIds] = useState([])
      const [recoverableIds, setRecoverableIds] = useState(() => new Set())
      const [refreshing, setRefreshing] = useState(false)
      const [showFinalizedIds, setShowFinalizedIds] = useState(false)
      const [error, setError] = useState('')
      /** One operation can produce SEVERAL messages — a partial delete's host
       *  warnings AND its failed refresh, a batch's per-session failures AND its
       *  summary. `setError` is last-write-wins, which silently dropped the
       *  earlier one; warnings accumulate instead, and each operation starts by
       *  clearing them. */
      const pushError = (text) => {
        if (typeof text !== 'string' || text.length === 0) return
        setError((prev) => (prev === '' || prev === text ? text : `${prev}\n${text}`))
      }
      /** False once this mount is gone: the refresh's minimum-feedback delay
       *  must not setState into an unmounted component. */
      const alive = useRef(true)
      useEffect(() => () => { alive.current = false }, [])
      const loadPending = () => {
        rpc('deferred/list')
          .then((value) => {
            setPendingIds(Array.isArray(value && value.sessionIds) ? value.sessionIds : [])
            setRecoverableIds(new Set(Array.isArray(value?.recoverable) ? value.recoverable : []))
          })
          // Reporting this failure is not optional: with `pendingIds` empty, a
          // queued (tombstoned) session renders as an ordinary archived row —
          // with a Restore button the host refuses as `session/pending` — and
          // the whole pending banner disappears, with no other feedback at all.
          .catch((reason) => {
            if (alive.current) pushError(`${t('errorPrefix')}${errorMessage(reason)}`)
          })
      }
      useEffect(() => { loadPending() }, []) // eslint-disable-line react-hooks/exhaustive-deps
      useEffect(() => { ensureSpinStyle() }, []) // eslint-disable-line react-hooks/exhaustive-deps

      const cancellableIds = useMemo(() => pendingIds.filter((id) => recoverableIds.has(id)), [pendingIds, recoverableIds])
      const finalizedIds = useMemo(() => pendingIds.filter((id) => !recoverableIds.has(id)), [pendingIds, recoverableIds])

      const rows = useMemo(() => archivedIds
        .filter((sessionId) => !pendingIds.includes(sessionId))
        .map((sessionId) => {
          const summary = byId[sessionId]
          let owner = null
          for (const item of (wsSnapshot.items || [])) {
            if ((item.sessionIds || []).some((id) => String(id) === String(sessionId))) { owner = item; break }
          }
          return {
            sessionId,
            title: firstTitle(summary?.displayTitle, summary?.title) ?? t('unknownSession'),
            cwd: summary?.cwd,
            updatedAt: summary?.updatedAt ?? null,
            running: summary?.running === true,
            origin: summary?.origin,
            owner,
          }
        })
        .filter((row) => row.origin !== 'subagent')
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)), [archivedIds, byId, wsSnapshot.items, pendingIds, t])

      // ── selection + bulk delete -----------------------------------------------
      // The selection is a set of ids, but every read goes through `selectedRows`
      // below: rows that left the list (deleted elsewhere, tombstoned, or no
      // longer archived) drop out of the selection automatically, so the count
      // and the delete button can never describe rows that are not on screen.
      const [selectedIds, setSelectedIds] = useState(() => new Set())
      const [bulk, setBulk] = useState(null) // { done, total } while a bulk delete runs
      const selectedRows = useMemo(() => rows.filter((row) => selectedIds.has(row.sessionId)), [rows, selectedIds])
      const allSelected = rows.length > 0 && selectedRows.length === rows.length
      const someSelected = selectedRows.length > 0 && !allSelected
      const toggleRow = (sessionId) => {
        setSelectedIds((prev) => {
          const next = new Set(prev)
          if (next.has(sessionId)) next.delete(sessionId)
          else next.add(sessionId)
          return next
        })
      }
      const toggleAll = () => {
        setSelectedIds(allSelected ? new Set() : new Set(rows.map((row) => row.sessionId)))
      }
      // The header checkbox is tri-state; `indeterminate` has no JSX-free
      // equivalent in React, so it is written through a ref after each render.
      const selectAllRef = useRef(null)
      useEffect(() => {
        const node = selectAllRef.current
        if (node !== null) node.indeterminate = someSelected
      })

      const [busy, setBusy] = useState({})
      const [toasts, dispatchToast] = useReducer((state, action) => {
        if (action.type === 'add') return [...state, { id: action.id, kind: action.kind, text: action.text }]
        if (action.type === 'drop') return state.filter((entry) => entry.id !== action.id)
        return state
      }, [])
      const toastSeq = useRef(0)
      const toastTimers = useRef([])
      useEffect(() => () => {
        const timers = toastTimers.current
        toastTimers.current = []
        for (const timer of timers) clearTimeout(timer)
      }, [])
      const toast = (kind, text) => {
        const id = ++toastSeq.current
        dispatchToast({ type: 'add', id, kind, text })
        const timer = setTimeout(() => {
          dispatchToast({ type: 'drop', id })
          // Prune on fire: this array is only ever cleared wholesale on unmount,
          // so a long-lived page accumulated one dead handle per toast forever.
          const index = toastTimers.current.indexOf(timer)
          if (index !== -1) toastTimers.current.splice(index, 1)
        }, 5000)
        toastTimers.current.push(timer)
      }

      const cancelPending = async (sessionId) => {
        try {
          const value = await rpc('deferred/cancel', { sessionId })
          // A confirmation of something that already happened, not the button's
          // imperative label ("Cancel deletion · 3f2a…" read as an instruction).
          toast('ok', `${format(t, 'pendingCancelOk', {})} · ${sessionId.slice(0, 8)}…`)
          // The host puts the session back into the workspace the delete removed
          // it from. When it cannot (that workspace is gone, or this dsh build
          // exposes no `attachSession`) the session returns UNGROUPED — say so,
          // rather than letting the user hunt for it in 未分组.
          if (Array.isArray(value?.warnings)) {
            for (const warning of value.warnings) pushError(warning)
          }
          loadPending()
          // A failed pull here means the banner/rows may be stale — say so
          // instead of swallowing it (the cancel itself already succeeded).
          await pullSessions().catch(() => { pushError(t('refreshFailed')) })
        } catch (reason) {
          // `pushError`, not `setError`: a cancel can fail while a refresh
          // failure is already on screen, and last-write-wins dropped one.
          pushError(`${t('errorPrefix')}${errorMessage(reason)}`)
        }
      }

      // Refresh the archived rows and the pending banner: re-pull the client
      // session store (and the host queue) and spin the button icon until the
      // (single-flight) refresh settles.
      const refreshRows = async () => {
        if (refreshing) return
        setRefreshing(true)
        const startedAt = Date.now()
        try {
          await pullSessions()
          loadPending()
        } catch (reason) {
          // Accumulate: a per-row delete failure is usually still on screen.
          pushError(`${t('errorPrefix')}${errorMessage(reason)}`)
        } finally {
          // One full turn of feedback even when the store refreshes instantly.
          const remaining = 800 - (Date.now() - startedAt)
          if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining))
          if (alive.current) setRefreshing(false)
        }
      }

      // Diagnostic header: which plugin version is actually loaded and
      // whether the client session service is reachable from this scope.
      const [hostInfo, setHostInfo] = useState(null)
      useEffect(() => {
        rpc('ping')
          .then((value) => setHostInfo(value && typeof value === 'object' ? value : {}))
          .catch(() => setHostInfo({ unreachable: true }))
      }, []) // eslint-disable-line react-hooks/exhaustive-deps

      const rpcAvailable = typeof rpc === 'function'

      const restore = async (sessionId, title) => {
        setBusy((prev) => ({ ...prev, [`restore:${sessionId}`]: true }))
        setError('')
        try {
          await rpc('restore', { sessionId })
          toast('ok', format(t, 'restoreOk', { title }))
        } catch (reason) {
          // Accumulate (the deliberate `setError('')` above clears only for a
          // FRESH attempt; a concurrent failure must not be overwritten).
          pushError(`${t('errorPrefix')}${errorMessage(reason)}`)
        } finally {
          setBusy((prev) => ({ ...prev, [`restore:${sessionId}`]: false }))
        }
      }

      const remove = async (sessionId, title, running) => {
        if (running) {
          setError(format(t, 'runningRefused', { title }))
          return
        }
        const decision = await openConfirm({
          title: t('deleteConfirmTitle'),
          body: format(t, 'deleteConfirmBody', { title }),
          confirmLabel: t('confirm'),
          cancelLabel: t('cancel'),
          danger: true,
          // The row that opened this dialog is unmounted by the refresh below,
          // so a confirmed delete lands focus on a stable neighbour instead of
          // dropping it on <body> (WCAG 2.4.3).
          afterConfirmFocus: focusAfterDelete,
          // The diagnostic text stays in the Error (and in the console when no
          // handler is given); the USER-facing line is localized.
          onRenderError: () => setError(`${t('errorPrefix')}${t('confirmRenderFailed')}`),
        })
        if (decision === null) return
        setBusy((prev) => ({ ...prev, [`delete:${sessionId}`]: true }))
        setError('')
        try {
          const result = await rpc('delete', { sessionId })
          // A partial delete (bookkeeping done, some file seam degraded) must
          // not read as a clean success — surface the host's warnings.
          const warnings = Array.isArray(result?.warnings) ? result.warnings.filter((line) => typeof line === 'string') : []
          if (warnings.length > 0) pushError(warnings.join('\n'))
          if (result?.openAtDelete !== true) {
            try {
              let refreshed = true
              if (typeof props.refreshAfterDelete === 'function') {
                refreshed = (await props.refreshAfterDelete(sessionId)) !== false
              } else {
                await pullSessions()
              }
              if (!refreshed) pushError(t('refreshFailed'))
            } catch (refreshError) {
              try { console.warn(`[dsh-session-manager] session list refresh failed: ${errorMessage(refreshError)}`) } catch { /* noop */ }
              pushError(t('refreshFailed'))
            }
          }
          // An open session is tombstoned instead of unlistable: the server
          // keeps reporting it until restart, so there is nothing to poll —
          // the archive-set update alone hides the row.
          toast('ok', format(t, result?.openAtDelete === true ? 'deleteOkOpen' : 'deleteOk', { title }))
          loadPending()
        } catch (reason) {
          if (isRunningError(reason)) setError(format(t, 'runningRefused', { title }))
          else setError(`${t('errorPrefix')}${errorMessage(reason)}`)
        } finally {
          setBusy((prev) => ({ ...prev, [`delete:${sessionId}`]: false }))
        }
      }

      /**
       * Delete every selected row, one host call at a time. The host keeps the
       * per-session guarantees (id guard, running refusal, tombstone, artifact
       * and projcache cleanup, removal broadcast) and serializes mutations
       * internally, so the loop must NOT be parallel: it would only pile up on
       * the host's operation lock while making progress impossible to report.
       * A failing session never aborts the run — it is collected and reported.
       * Running sessions are skipped defensively (the host would refuse them);
       * the confirm dialog states this before the user commits.
       */
      const removeSelected = async () => {
        const targets = selectedRows
        if (targets.length === 0 || bulk !== null) return
        const running = targets.filter((row) => row.running)
        if (running.length === targets.length) {
          setError(format(t, 'deleteBulkAllRunning', { n: targets.length }))
          return
        }
        const decision = await openConfirm({
          title: format(t, 'deleteBulkConfirmTitle', { n: targets.length }),
          body: format(t, 'deleteBulkConfirmBody', { n: targets.length })
            + (running.length > 0 ? `\n${format(t, 'deleteBulkRunningNote', { n: running.length })}` : ''),
          confirmLabel: format(t, 'deleteBulkConfirmLabel', { n: targets.length }),
          cancelLabel: t('cancel'),
          danger: true,
          onRenderError: () => setError(`${t('errorPrefix')}${t('confirmRenderFailed')}`),
        })
        if (decision === null) return

        setError('')
        setBulk({ done: 0, total: targets.length })
        const failures = []
        let deleted = 0
        let openDeleted = 0
        let skipped = 0
        const warnings = []
        try {
          for (const row of targets) {
            // A row that started running mid-run is refused by the host with
            // session/running; skipping up front keeps the reported totals
            // honest — but it is COUNTED, because a run that silently drops
            // targets from its own summary ("deleted 3" after confirming 5) is
            // not honest at all.
            if (row.running) {
              skipped += 1
              setBulk((prev) => (prev === null ? prev : { ...prev, done: prev.done + 1 }))
              continue
            }
            try {
              const result = await rpc('delete', { sessionId: row.sessionId })
              deleted += 1
              if (result?.openAtDelete === true) openDeleted += 1
              if (Array.isArray(result?.warnings)) {
                for (const line of result.warnings) if (typeof line === 'string') warnings.push(`${row.title}: ${line}`)
              }
            } catch (reason) {
              failures.push(`${row.title} — ${isRunningError(reason) ? t('running') : errorMessage(reason)}`)
            }
            setBulk((prev) => (prev === null ? prev : { ...prev, done: prev.done + 1 }))
          }
        } finally {
          setBulk(null)
        }

        // One refresh for the whole run: `api-session/removed` already dropped
        // each id from the client store, and re-pulling per session would just
        // re-fetch the same list N times. A run with ANY open delete skips it:
        // those sessions are still live in the host, so the pull would re-learn
        // their tombstones (`pullSessions` would then ask the host to repair, but
        // not pulling at all is the cheaper half of the same rule) — the deleted
        // rows are already gone from the store.
        if (deleted > 0 && openDeleted === 0) {
          try {
            await pullSessions()
          } catch (refreshError) {
            try { console.warn(`[dsh-session-manager] session list refresh failed: ${errorMessage(refreshError)}`) } catch { /* noop */ }
            pushError(t('refreshFailed'))
          }
        }
        loadPending()
        setSelectedIds(new Set())

        if (warnings.length > 0) pushError(warnings.join('\n'))
        if (failures.length > 0) {
          const summary = format(t, 'deleteBulkPartial', { n: deleted, m: failures.length })
          pushError(`${summary}${skipped > 0 ? `\n${format(t, 'deleteBulkSkipped', { n: skipped })}` : ''}\n${failures.join('\n')}`)
          return
        }
        if (deleted === 0) {
          // Never return in silence right after a confirmation: when every target
          // became running between the snapshot and the loop, the click produced
          // no feedback at all. The pre-flight refusal uses the same line.
          if (skipped > 0) pushError(format(t, 'deleteBulkAllRunning', { n: skipped }))
          return
        }
        const skippedNote = skipped > 0 ? ` · ${format(t, 'deleteBulkSkipped', { n: skipped })}` : ''
        toast('ok', `${openDeleted > 0
          ? format(t, 'deleteBulkOkOpen', { n: deleted, m: openDeleted })
          : format(t, 'deleteBulkOk', { n: deleted })}${skippedNote}`)
      }

      return React.createElement('div', { 'data-sm-section': '1', style: { display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '760px' } },
        React.createElement('div', null,
          React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px' } },
            React.createElement('h2', { style: { fontSize: '16px', lineHeight: '24px', fontWeight: '600', margin: '0 0 6px', color: TOKENS.text } }, t('nav')),
            React.createElement('span', { style: { fontSize: '12px', lineHeight: '16px', color: TOKENS.metaText } },
              hostInfo === null
                ? t('checking')
                : hostInfo.unreachable === true
                  ? t('rpcUnreachable')
                  : format(t, 'versionLine', {
                      version: hostInfo.version ?? '?',
                      status: t(sessions !== undefined ? 'statusOk' : 'statusAbsent'),
                    })),
          ),
          React.createElement('p', { style: { fontSize: '13px', lineHeight: '20px', margin: 0, color: TOKENS.metaText } }, t('navDesc')),
        ),
        // The live region is mounted UNCONDITIONALLY: a region created in the
        // same commit as its first child is the classic way a screen reader
        // misses the announcement (there is nothing to observe yet).
        React.createElement('div', {
          role: 'status',
          'aria-live': 'polite',
          style: { display: 'flex', flexDirection: 'column', gap: '6px' },
        },
          toasts.map((entry) => React.createElement('div', {
            key: entry.id,
            style: {
              display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', lineHeight: '20px',
              padding: '8px 12px', borderRadius: '10px', border: `1px solid ${TOKENS.border}`,
              color: entry.kind === 'ok' ? TOKENS.text : TOKENS.dangerText, background: TOKENS.panelSurface,
            },
          }, React.createElement(entry.kind === 'ok' ? IconCheckOutlineRegular : IconWarningOutlineRegular, { size: 16 }), entry.text)),
        ),
        // role="alert" (not just colour): this banner carries refusals and
        // failures a user must not have to be looking at the screen to learn.
        // The failure channel, so its text is the one that MUST clear AA. It
        // used to sit on `--dsw-alias-interactive-bg-hover-danger`, a red WASH
        // over the card: measured on the real tokens that is 4.44:1 in light and
        // 3.94:1 in dark — both under the floor, and the reason no tinted variant
        // is used anywhere in this file. Opaque surface + a red border, the same
        // treatment the toasts already use.
        error !== '' && React.createElement('div', { role: 'alert', style: { display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '13px', lineHeight: '20px', color: TOKENS.dangerText, padding: '8px 12px', borderRadius: '10px', background: TOKENS.panelSurface, border: `1px solid ${TOKENS.danger}` } },
          React.createElement(IconWarningOutlineRegular, { size: 16 }),
          // `pushError` ACCUMULATES, joining entries with '\n' — without
          // `pre-wrap` the CSS would collapse every newline and a partial
          // delete's host warnings plus its failed refresh would reach the user
          // as one run-on line.
          React.createElement('span', { style: { flex: '1', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, error)),
        // Driven by the ping ANSWER, not by `typeof rpc === 'function'` (which
        // the inject face always satisfies, making this guidance unreachable —
        // the real unreachable case showed a raw English error instead).
        hostInfo !== null && hostInfo.unreachable === true && React.createElement('div', { style: { fontSize: '13px', lineHeight: '20px', color: TOKENS.dangerText } }, t('unavailable')),
        pendingIds.length > 0 && React.createElement('div', {
          style: {
            display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px 12px', borderRadius: '10px',
            border: `1px solid ${TOKENS.primary}`, background: TOKENS.panelSurface, fontSize: '13px', lineHeight: '20px',
          },
        },
          React.createElement('div', { style: { color: TOKENS.text, fontWeight: '500' } },
            cancellableIds.length > 0
              ? format(t, 'pendingBanner', { n: cancellableIds.length })
              : format(t, 'pendingFinalizedBanner', { n: finalizedIds.length })),
          // Only entries with files still on disk are worth a row: they are the
          // ones the user can still cancel. A cleaned-up entry has nothing left
          // to act on, so it collapses into the one-line summary above (with an
          // expander, for anyone who wants the ids).
          cancellableIds.map((id) => React.createElement('div', { key: id, style: { display: 'flex', alignItems: 'center', gap: '10px' } },
            React.createElement('code', { style: { flex: '1', fontSize: '12px', color: TOKENS.metaText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, id),
            // The id belongs in the accessible NAME, not only in a sibling
            // <code>: two recoverable entries used to expose two identical
            // "cancel deletion" buttons to a screen reader's button list.
            React.createElement('button', {
              type: 'button',
              style: rowStyles.linkButton(false),
              'aria-label': `${t('pendingCancel')} ${id}`,
              onClick: () => cancelPending(id),
            }, t('pendingCancel')),
          )),
          finalizedIds.length > 0 && React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            React.createElement('button', {
              type: 'button',
              style: { ...rowStyles.linkButton(false), alignSelf: 'flex-start', fontSize: '12px', padding: '0' },
              'aria-expanded': showFinalizedIds,
              onClick: () => setShowFinalizedIds((prev) => !prev),
            }, showFinalizedIds ? t('pendingHideFinalized') : t('pendingShowFinalized')),
            showFinalizedIds && finalizedIds.map((id) => React.createElement('div', { key: id, style: { display: 'flex', alignItems: 'center', gap: '10px' } },
              React.createElement('code', { style: { flex: '1', fontSize: '12px', color: TOKENS.metaText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, id),
              React.createElement('span', { style: { fontSize: '12px', lineHeight: '18px', color: TOKENS.metaText } }, t('pendingFinalizing')),
            )),
          ),
        ),

        React.createElement('section', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            React.createElement('h3', { style: { flex: '1', fontSize: '14px', lineHeight: '22px', fontWeight: '600', margin: 0, color: TOKENS.text } },
              `${t('archivedTitle')} · ${format(t, 'count', { n: rows.length })}`),
            bulk !== null
              ? React.createElement('span', { style: { fontSize: '12.5px', lineHeight: '20px', color: TOKENS.textSecondary } },
                  format(t, 'deleteBulkProgress', { done: bulk.done, total: bulk.total }))
              : null,
            React.createElement('button', {
              type: 'button',
              'data-sm-bulk-delete': '1',
              style: { ...rowStyles.linkButton(true), opacity: selectedRows.length === 0 || bulk !== null ? 0.5 : 1, cursor: selectedRows.length === 0 || bulk !== null ? 'default' : 'pointer' },
              disabled: selectedRows.length === 0 || bulk !== null || !rpcAvailable,
              onClick: removeSelected,
            }, React.createElement(IconTrashOutlineRegular, { size: 16 }), format(t, 'deleteSelected', { n: selectedRows.length })),
            React.createElement('button', {
              type: 'button',
              style: { ...rowStyles.linkButton(false), cursor: refreshing ? 'default' : 'pointer' },
              disabled: refreshing,
              onClick: refreshRows,
            },
              React.createElement('span', { style: { display: 'inline-flex', animation: refreshing ? 'sm-spin 0.8s linear infinite' : 'none' } },
                React.createElement(IconRefreshOutlineRegular, { size: 16 })),
              t('refresh')),
          ),
          rows.length > 0 && React.createElement('label', {
            style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', lineHeight: '20px', color: TOKENS.textSecondary, cursor: bulk !== null ? 'default' : 'pointer', padding: '0 2px' },
          },
            React.createElement('input', {
              ref: selectAllRef,
              type: 'checkbox',
              checked: allSelected,
              disabled: bulk !== null,
              'aria-label': t('selectAll'),
              style: { margin: 0, cursor: bulk !== null ? 'default' : 'pointer' },
              onChange: toggleAll,
            }),
            t('selectAll')),
          sessSnapshot.phase === 'pending' && rows.length === 0
            ? React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: TOKENS.metaText, padding: '12px 0' } },
                React.createElement(IconLoadingOutlineRegular, { size: 16 }), t('loading'))
            : null,
          rows.length === 0 && sessSnapshot.phase !== 'pending'
            ? React.createElement('div', { style: { fontSize: '13px', lineHeight: '20px', color: TOKENS.metaText, padding: '12px 0' } }, t('empty'))
            : rows.map((row) => {
              const checked = selectedIds.has(row.sessionId)
              return React.createElement('div', {
                key: row.sessionId,
                style: { ...rowStyles.row, ...(checked ? { borderColor: TOKENS.primary, background: TOKENS.hoverBg } : {}) },
              },
                React.createElement('input', {
                  type: 'checkbox',
                  checked,
                  disabled: bulk !== null,
                  'aria-label': format(t, 'selectRow', { title: row.title }),
                  style: { flex: 'none', margin: 0, cursor: bulk !== null ? 'default' : 'pointer' },
                  onChange: () => toggleRow(row.sessionId),
                }),
                React.createElement('div', { style: { flex: '1', minWidth: '0', display: 'flex', flexDirection: 'column', gap: '2px' } },
                  React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: '0' } },
                    React.createElement('span', { style: rowStyles.title }, row.title),
                    row.running && React.createElement('span', { style: { fontSize: '11px', lineHeight: '16px', padding: '0 6px', borderRadius: '999px', color: TOKENS.primaryText, border: `1px solid ${TOKENS.primary}` } }, t('running')),
                  ),
                  React.createElement('div', { style: rowStyles.meta },
                    `${row.owner ? row.owner.title : t('workspaceUngrouped')} · ${row.cwd ?? '—'} · ${formatDate(row.updatedAt)}`),
                ),
                React.createElement('button', {
                  type: 'button', style: rowStyles.button(false, busy[`restore:${row.sessionId}`] === true),
                  disabled: busy[`restore:${row.sessionId}`] === true || !rpcAvailable || bulk !== null,
                  onClick: () => restore(row.sessionId, row.title),
                }, React.createElement(IconArchiveOutlineRegular, { size: 16 }), t('restore')),
                React.createElement('button', {
                  type: 'button', 'data-sm-row-delete': '1', style: rowStyles.button(true, busy[`delete:${row.sessionId}`] === true),
                  disabled: busy[`delete:${row.sessionId}`] === true || !rpcAvailable || bulk !== null,
                  onClick: () => remove(row.sessionId, row.title, row.running),
                }, React.createElement(IconTrashOutlineRegular, { size: 16 }), t('delete')),
              )
            }),
        ),
      )
    }

    // ── session context-menu item ---------------------------------------------
    //
    // One entry in the official Session row "..." menu, registered from apply()
    // into the slot `sidebar.workspaces.session.menu.item` at order 500 — after
    // the shipped pin(100) / rename(200) / fork(300) / archive(400) rows.
    //
    // That slot arrived in dsh 0.1.7-alpha.1. Before it existed this surface had
    // to observe the DOM and resolve the owning Session through the React fiber
    // tree, which made every official change to the menu's markup able to drop
    // the item silently — and did: 0.1.7-rc.2 appended a keyboard-shortcut hint
    // to each row's text, so the label match that identified a session menu
    // stopped matching and the whole augmentation never ran (no error, the
    // module roster looked fine, the settings page stayed healthy). Do not
    // reintroduce text or DOM matching here: the slot hands the row identity
    // over as props.

    /** Plain-DOM toasts this half appended to <body>, with their removal
     *  timers: teardown must take both, or a node outlives the plugin by up to
     *  the full display window (and its timer fires into a dead module). */
    const liveToasts = new Set()

    /** Visible plain-DOM toast: the menu path must never fail silently.
     *  `kind` is `'ok' | 'err'`. It used to be drawn in the error colour
     *  unconditionally, which made the menu path's only feedback channel paint a
     *  SUCCESSFUL permanent delete exactly like a failure; and it is named
     *  `plainToast` because the section component defines its own `toast(kind,
     *  text)` on top of it, so a one-argument call in there used to compile to a
     *  warning-icon toast with `undefined` text. */
    function plainToast(kind, text) {
      try {
        const failed = kind === 'err'
        const node = document.createElement('div')
        node.setAttribute('data-sm-toast', '1')
        // Announced, not just drawn: the menu path has no other channel.
        node.setAttribute('role', failed ? 'alert' : 'status')
        node.setAttribute('aria-live', failed ? 'assertive' : 'polite')
        node.textContent = text
        Object.assign(node.style, {
          position: 'fixed', top: '72px', left: '50%', transform: 'translateX(-50%)',
          zIndex: '2147483000', maxWidth: '560px', padding: '10px 16px', borderRadius: '10px',
          background: TOKENS.panelSurface,
          color: failed ? TOKENS.dangerText : TOKENS.text,
          border: `1px solid ${failed ? TOKENS.danger : TOKENS.border}`,
          fontSize: '13px', lineHeight: '20px', boxShadow: TOKENS.panelShadow,
        })
        document.body.appendChild(node)
        const entry = { node, timer: null }
        entry.timer = setTimeout(() => {
          liveToasts.delete(entry)
          node.remove()
        }, 6000)
        liveToasts.add(entry)
      } catch {
        // Nothing else we can do — the console still carries the error.
      }
    }

    /** Remove every toast this half still owns (plugin teardown / re-apply). */
    function clearPlainToasts() {
      for (const entry of liveToasts) {
        if (entry.timer !== null) clearTimeout(entry.timer)
        try { entry.node.remove() } catch { /* noop */ }
      }
      liveToasts.clear()
    }

    // One confirmation flow at a time. Selecting a row closes the menu, which
    // unmounts the item, so this cannot live in component state.
    let menuConfirmBusy = false

    /** Confirm → delete → report. The menu item's entire behaviour. */
    async function runMenuDelete(input) {
      // Destructure FIRST: the busy guard below needs `t`, and reading it from
      // the destructuring that used to sit after the guard is a TDZ throw on the
      // exact path that is supposed to report something.
      const { sessionId, t, rpc, sessions, refreshAfterDelete, pullSessions, onError } = input
      // A second delete can arrive while the first is still confirming or
      // deleting. Returning silently here used to be the whole behavior — no
      // dialog, no toast, no error — and the menu is the flagship entry point,
      // so it read as "the button is broken". This file's own rule is that the
      // menu path must never fail silently, so say so.
      if (menuConfirmBusy) {
        plainToast('err', t('menuBusy'))
        return
      }
      menuConfirmBusy = true
      const label = input.title || sessionId
      const report = (error) => { try { if (typeof onError === 'function') onError(error) } catch { /* noop */ } }
      try {
        let decision
        try {
          decision = await openConfirm({
            title: t('deleteConfirmTitle'),
            body: format(t, 'deleteConfirmBody', { title: label }),
            confirmLabel: t('confirm'),
            cancelLabel: t('cancel'),
            danger: true,
            // Confirmed: the row this menu belonged to is gone (the menu closed
            // and the list refreshed), so land on a stable element. Cancelled:
            // `finish(null)` restores to the opener, and the opener here is
            // already unmounted, so fall forward too.
            afterConfirmFocus: () => {
              const row = document.querySelector(`[data-row-key="session:${sessionId}"]`)
              if (row !== null && typeof row.focus === 'function') {
                row.setAttribute('tabindex', '-1')
                row.focus()
                return
              }
              focusAfterDelete()
            },
            // The raw diagnostic goes to the host log through `report`; the
            // user-facing line is localized.
            onRenderError: (error) => {
              report(error)
              plainToast('err', `${t('errorPrefix')}${t('confirmRenderFailed')}`)
            },
          })
        } catch (error) {
          // openConfirm resolves null on every failure it knows about, so this
          // is a defensive net for a caller-side throw only.
          report(error)
          plainToast('err', `${t('errorPrefix')}${errorMessage(error)}`)
          return
        }
        // openConfirm resolves true (confirmed) or null (cancel, backdrop,
        // Escape, degenerate render) — never false.
        if (decision === null) return
        try {
          const value = await rpc('delete', { sessionId })
          if (Array.isArray(value?.warnings) && value.warnings.length > 0) {
            plainToast('err', value.warnings.filter((line) => typeof line === 'string').join(' '))
          }
          if (value?.openAtDelete === true) {
            // The session stays listed server-side (still open in this
            // process); the archive tombstone alone hides it, so there is
            // nothing to poll for. The rpc wrapper already marked the id as
            // queued, which keeps later removal events from pulling it back.
            plainToast('ok', format(t, 'deleteOkOpen', { title: label }))
          } else {
            let gone = false
            if (typeof refreshAfterDelete === 'function') {
              gone = (await refreshAfterDelete(sessionId)) === true
            } else if (typeof pullSessions === 'function') {
              await pullSessions().catch(() => {})
            } else {
              await refreshSessionList(sessions).catch(() => {})
            }
            // One message, not a success toast stacked on a failure toast:
            // the row is gone (clean success) or the delete landed but the
            // list is stale (success + what the user must do), as one line.
            const deleteOkText = format(t, 'deleteOk', { title: label })
            plainToast(gone ? 'ok' : 'err', gone ? deleteOkText : `${deleteOkText} — ${t('refreshFailed')}`)
          }
        } catch (reason) {
          report(reason)
          plainToast('err', isRunningError(reason)
            ? format(t, 'runningRefused', { title: label })
            : `${t('errorPrefix')}${errorMessage(reason)}`)
        }
      } finally {
        menuConfirmBusy = false
      }
    }

    /**
     * The red "delete permanently" row of a Session's "..." menu. Receives the
     * owner's row identity (`sessionId`, `displayTitle`), the injected
     * `useMenuOpenState` hook, and this plugin's own inject face.
     */
    function DeleteSessionMenuItem(props) {
      // Hard rule: this hook runs unconditionally and first. The early return
      // below is the only exit, and moving it above the hook crashes the whole
      // slot entry with a hook-order error.
      const [, setMenuOpen] = props.useMenuOpenState()
      // menuDeleteAvailable === false hides the row, and so does an unanswered
      // ping — the same pessimism the pre-slot implementation had while it
      // waited on that same answer. The answer is read through the GETTER when
      // the inject face provides one, because the cached inject result freezes a
      // plain value for the entry's lifetime: a value captured while the ping was
      // still in flight would keep the row hidden for the whole page. This
      // `useEffect` is the component's only real React hook and it also runs
      // unconditionally, before the early return, so the hook order stays stable
      // across the hidden and visible renders. (`useMenuOpenState` is a plain
      // closure, not a hook — but keep it first: an upstream refactor could make
      // it one.)
      const menuEnabled = typeof props.getMenuEnabled === 'function' ? props.getMenuEnabled() : props.menuEnabled
      useEffect(() => {
        // Ask for one more ping when the row is hidden because the host never
        // answered: the entry remounts on every menu open, so a host that has
        // recovered since boot reveals the row on the NEXT open rather than
        // needing a page reload.
        if (menuEnabled !== true) props.requestMenuPing?.()
      }, [menuEnabled])
      if (menuEnabled !== true) return null
      return React.createElement(MenuItemButton, {
        danger: true,
        separatorBefore: true,
        // 14 is what the shipped rows pass and what the menu's own `.itemIcon`
        // cell pins any icon inside it to.
        icon: React.createElement(IconTrashOutlineRegular, { size: 14 }),
        onSelect: () => {
          setMenuOpen(false)
          void runMenuDelete({
            sessionId: props.sessionId,
            title: props.displayTitle,
            t: props.t,
            rpc: props.rpc,
            sessions: typeof props.getSessions === 'function' ? props.getSessions() : props.sessions,
            refreshAfterDelete: props.refreshAfterDelete,
            pullSessions: props.pullSessions,
            onError: props.onError,
          }).catch(() => {})
        },
      }, props.t('menuDelete'))
    }

    // ── client plugin entry ----------------------------------------------------
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, dict), 'session-manager: locale')
      const t = ctx.locale.bind(NS)

      const getConnection = () => {
        try { return ctx.get('connection') } catch { return undefined }
      }
      const getSessions = () => {
        try { return ctx.get('sessions') } catch { return undefined }
      }
      const getWorkspaces = () => {
        try { return ctx.get('workspaces') } catch { return undefined }
      }
      const getRemote = () => {
        try { return ctx.get('remote') } catch { return undefined }
      }

      const rpc = async (endpoint, payload = {}) => {
        const connection = getConnection()
        if (connection === undefined || connection.rpc === undefined || typeof connection.rpc.call !== 'function') {
          throw new Error(t('errorRpcUnavailable'))
        }
        const result = await connection.rpc.call(CHANNEL, `${NS}/${endpoint}`, payload)
        if (result === undefined || typeof result !== 'object' || result.ok !== true) {
          const domainError = result !== null && typeof result === 'object' ? result.error : undefined
          // A domain failure carries the host's own `code: message`; only the
          // transport-shaped fallback needs localizing here.
          const error = new Error(domainError !== undefined ? `${domainError.code}: ${domainError.message}` : t('errorRpcFailed'))
          // Structured stable code so callers match on it instead of scraping
          // the message string (the textual check stays as a fallback).
          if (domainError !== undefined && typeof domainError.code === 'string') error.code = domainError.code
          throw error
        }
        const value = result.value
        // The request/response pair is the single place every surface's mutation
        // passes through, so the pending-deletion residue watch is fed here
        // instead of in each component (the settings section and the menu item
        // are module-scope components that cannot see this closure):
        //   · a queue read reports the ids currently queued for deletion;
        //   · a successful open-session delete adds its id;
        //   · a successful cancel removes it again (the session is live again,
        //     so its removals must refresh the list like any other).
        if (endpoint === 'deferred/list') observePending(value)
        else if (endpoint === 'delete' && value?.openAtDelete === true) rememberPendingDelete(payload.sessionId)
        else if (endpoint === 'deferred/cancel') forgetPendingDelete(payload.sessionId)
        return value
      }

      const ping = () => rpc('ping', {}).then((value) => value && typeof value === 'object' ? value.menuDeleteAvailable : true)

      // ── pending-deletion residue (open-session tombstones) -------------------
      //
      // A permanent delete of an OPEN session cannot close the host's in-memory
      // copy: dsh exposes no public "close session" API, so the files go, the id
      // stays in the archive set as a tombstone, and the host keeps listing the
      // session. Every official view hides it ONLY while archived rows are
      // hidden, so a sidebar set to 视图选项 → 全部对话（显示已归档）/仅显示已归档
      // renders the tombstone in 未分组. Worse, our own list pulls used to drag
      // the id back into the store right after the delete, because the host
      // session list still returns it.
      //
      // This block owns the two halves of the client-side repair:
      //   1. never pull the list for an id the host has queued for deletion —
      //      the official `api-session/removed` already dropped it, and a pull
      //      only re-materializes the residue (`scheduleRemovedRefresh`);
      //   2. when such an id IS back in the store (another client's pull, a
      //      reload, a pre-fix pull), ask the host once per episode: the queue
      //      read is also the host's repair hook (`reannouncePendingRemovals`),
      //      which re-announces the removal so clients drop it again.
      const pendingDeleteIds = new Set()
      let pendingSeeded = false
      let pendingSeedAttempts = 0
      let pendingSeedTimer = null
      let residueSeen = false
      let storeWatched = false
      let storeUnsubscribe = null
      let repairTimer = null

      /** Ids in `pendingDeleteIds` are the host's queue, so they leave this set
       *  only when the deletion is canceled — never because one response
       *  omitted them (one can be in flight across a manual delete). */
      const rememberPendingDelete = (sessionId) => {
        if (typeof sessionId === 'string' && sessionId.length > 0) pendingDeleteIds.add(sessionId)
      }

      const forgetPendingDelete = (sessionId) => {
        pendingDeleteIds.delete(sessionId)
        residueSeen = false
      }

      /** The queue read: seeds this block through `rpc` and, on a host with
       *  `reannouncePendingRemovals`, re-announces queued live removals.
       *  Resolves true only when the host ANSWERED — a rejected read must not
       *  be mistaken for "the queue is empty" (see `seedPendingQueue`). */
      const requestPendingQueue = () => rpc('deferred/list').then(() => true, () => false)

      /** Seed the residue watch from the queue.
       *
       *  A FAILED first read used to disarm the whole block for the page's
       *  lifetime: `pendingSeeded` was set from the ping alone (which only
       *  proves the host is reachable), while `pendingDeleteIds` and the store
       *  watch are armed exclusively by a successful read (`observePending`).
       *  With the block disarmed the event-driven list pull re-materialises
       *  every queued husk and the host repair is never asked — the 0.4.1 field
       *  bug, silently. So the flag is set by the read ITSELF and a failure is
       *  retried with the ping's own 1s/3s backoff. */
      const seedPendingQueue = () => {
        if (pendingSeeded) return
        void requestPendingQueue().then((answered) => {
          // `observePending` has already marked the seed when the host answered.
          if (answered || pendingSeeded) return
          if (pendingSeedAttempts >= 2) {
            try {
              console.warn('[dsh-session-manager] the pending-deletion queue could not be read; the deleted-session residue repair stays off for this page')
            } catch { /* noop */ }
            return
          }
          const delay = pendingSeedAttempts === 0 ? 1000 : 3000
          pendingSeedAttempts += 1
          pendingSeedTimer = setTimeout(() => {
            pendingSeedTimer = null
            seedPendingQueue()
          }, delay)
        })
      }

      const scheduleRepair = () => {
        if (repairTimer !== null) return
        repairTimer = setTimeout(() => {
          repairTimer = null
          void requestPendingQueue()
        }, 300)
      }

      /** One repair per residue episode: the flag clears as soon as no queued id
       *  is in the store, so a later pull can trigger exactly one more — and a
       *  host without the repair hook cannot be polled in a loop. */
      const evaluateResidue = () => {
        const snapshot = getSessions()?.list?.getSnapshot?.()
        const byId = snapshot !== null && typeof snapshot === 'object' ? snapshot.byId : undefined
        if (byId === undefined || byId === null) return
        let present = false
        for (const id of pendingDeleteIds) {
          if (byId[id] !== undefined) {
            present = true
            break
          }
        }
        if (!present) {
          residueSeen = false
          return
        }
        if (residueSeen) return
        residueSeen = true
        scheduleRepair()
      }

      const watchSessionStore = () => {
        if (storeWatched) return
        const list = getSessions()?.list
        if (list === undefined || typeof list.subscribe !== 'function') return
        try {
          const off = list.subscribe(() => { evaluateResidue() })
          storeWatched = true
          if (typeof off === 'function') storeUnsubscribe = off
        } catch {
          // A store we cannot observe only means the repair runs when a queue
          // read reports ids again.
        }
      }

      const observePending = (value) => {
        const ids = value !== null && typeof value === 'object' && Array.isArray(value.sessionIds) ? value.sessionIds : []
        for (const id of ids) rememberPendingDelete(id)
        // A read that LANDED is the only proof this block is armed: it is what
        // feeds `pendingDeleteIds` and installs the store watch, and it is what
        // cancels any pending seed retry (see `seedPendingQueue`).
        pendingSeeded = true
        pendingSeedAttempts = 0
        if (pendingSeedTimer !== null) {
          clearTimeout(pendingSeedTimer)
          pendingSeedTimer = null
        }
        watchSessionStore()
        evaluateResidue()
      }

      ctx.effect(() => () => {
        if (repairTimer !== null) {
          clearTimeout(repairTimer)
          repairTimer = null
        }
        if (pendingSeedTimer !== null) {
          clearTimeout(pendingSeedTimer)
          pendingSeedTimer = null
        }
        if (typeof storeUnsubscribe === 'function') storeUnsubscribe()
        storeUnsubscribe = null
      }, 'session-manager: pending-deletion residue watch')

      /** The pull the surfaces use for anything that is not an id-specific
       *  verification: refresh the list, then re-check the residue.
       *
       *  A pull always re-learns the host's own list, and that list still holds
       *  the in-memory copy of every queued open-session delete — so ANY pull
       *  re-materialises those husks in the store, not only the event-driven one
       *  `scheduleRemovedRefresh` guards. When the store is observable its
       *  subscription already reacts; this call is the second trigger for the
       *  case where it is not (see the body). Either way the host answers with
       *  one `api-session/removed` per episode — `evaluateResidue` never polls.
       *
       *  Lives inside `apply` and is injected into the surfaces, because the
       *  settings section is module scope and cannot see this closure. */
      const pullSessions = async () => {
        const refreshed = await refreshSessionList(getSessions())
        // The store watch normally reacts to the pull's own store update, but it
        // is a SEAM: a store whose `subscribe` is missing or throws leaves
        // `watchSessionStore` uninstalled, and then a pull-induced husk would sit
        // there until the next queue read. Re-checking here makes the repair
        // independent of that seam (and is a no-op otherwise: `evaluateResidue`
        // is idempotent per residue episode).
        evaluateResidue()
        return refreshed
      }

      /** Poll the session-list store until the id is gone — at most 4 pulls,
       *  800ms apart. Each pull goes through refreshSessionList(); the store's
       *  refresh is single-flight, so overlapping calls collapse into one pull.
       *  The store is checked BEFORE each wait: the row is normally already gone
       *  (the host pushes `api-session/removed`), and the poll interval must not
       *  become a fixed tax on every successful delete. */
      const refreshUntilGone = async (sessionId) => {
        const sessions = getSessions()
        if (sessions === undefined || typeof sessions.refresh !== 'function') return false
        const list = sessions.list
        const stillThere = () => {
          try {
            const snapshot = list !== undefined && typeof list.getSnapshot === 'function' ? list.getSnapshot() : undefined
            return snapshot !== undefined && snapshot.byId !== undefined && snapshot.byId[sessionId] !== undefined
          } catch {
            return false
          }
        }
        let lastError
        try {
          for (let attempt = 0; attempt < 4; attempt++) {
            try {
              await sessions.refresh()
            } catch (error) {
              lastError = error
            }
            if (!stillThere()) return true
            if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 800))
          }
          if (lastError !== undefined) {
            try { console.warn(`[dsh-session-manager] session list refresh failed: ${errorMessage(lastError)}`) } catch { /* noop */ }
          }
          return !stillThere()
        } finally {
          // EVERY pull above re-learned the host's list, which still holds the
          // in-memory copy of any OTHER queued open-session delete: re-check the
          // residue so the host can re-announce them (one repair per episode).
          // This lives in `finally` on purpose — on the early-return success
          // path (`!stillThere()`) the re-check used to be skipped, i.e. it was
          // unreachable in exactly the case where a pull had just re-learned
          // the host's still-live copies and the store, when it cannot be
          // watched, has no other trigger.
          evaluateResidue()
        }
      }

      // Belt-and-braces refresh when any surface (host command, agent tool,
      // another client) removes a session. The official controller already drops
      // the id itself on this event (`api-session/removed` → handleSessionRemoved
      // → a local recordMutation, no network pull), so this pull is redundancy —
      // and it is DEBOUNCED, because `refresh()` is single-flight only for
      // OVERLAPPING calls, while a bulk delete emits one event per session, each
      // spaced by its own round-trip.
      let removedRefreshTimer = null
      let removedRefreshIds = new Set()
      const scheduleRemovedRefresh = (sessionId) => {
        // A queued id is an OPEN-session delete: the host still lists that
        // session's in-memory copy, so pulling the list here would drag the
        // residue straight back into the store (and a sidebar that shows
        // archived rows would render it). The official controller already
        // dropped the id locally — nothing to catch up on.
        if (typeof sessionId === 'string' && pendingDeleteIds.has(sessionId)) return
        if (typeof sessionId === 'string' && sessionId.length > 0) removedRefreshIds.add(sessionId)
        if (removedRefreshTimer !== null) clearTimeout(removedRefreshTimer)
        removedRefreshTimer = setTimeout(() => {
          removedRefreshTimer = null
          const ids = removedRefreshIds
          removedRefreshIds = new Set()
          // Re-check at FIRE time, not only when scheduling: the delete RESPONSE
          // and this EVENT travel on different channels, so a queued open-session
          // delete is often only known by now (its response landed after the
          // event scheduled this pull). Any queued id in the window suppresses
          // the pull — one pull refreshes the whole list, so it would resurrect
          // exactly the husk this guard exists to keep out.
          for (const id of ids) {
            if (pendingDeleteIds.has(id)) return
          }
          void refreshSessionList(getSessions()).catch(() => {})
        }, 250)
      }
      ctx.effect(() => {
        let off
        try {
          const remote = getRemote()
          if (remote !== undefined && typeof remote.$on === 'function') off = remote.$on('api-session/removed', scheduleRemovedRefresh)
        } catch {
          // No remote event surface — refreshes still happen after local mutations.
        }
        return () => {
          if (removedRefreshTimer !== null) {
            clearTimeout(removedRefreshTimer)
            removedRefreshTimer = null
          }
          removedRefreshIds = new Set()
          if (typeof off === 'function') off()
        }
      }, 'session-manager: session-list refresh on removal')

      // Everything this half injects into the HOST's document is released on
      // teardown: the shipped <style>, any plain-DOM toast still on screen, and
      // an open confirm dialog (which would otherwise leave `confirmOpen` set —
      // see `closeOpenConfirm`).
      const styleNode = ensureSpinStyle()
      ctx.effect(() => () => {
        try { if (styleNode !== null) styleNode.remove() } catch { /* noop */ }
        clearPlainToasts()
        try { if (closeOpenConfirm !== null) closeOpenConfirm() } catch { /* noop */ }
      }, 'session-manager: injected DOM teardown')

      // Settings section (first-class, like the vision-router page).
      ctx.effect(() => ctx.slots.inject('settings.section', function* () {
        yield ctx.slots.register(
          {
            name: 'settings.section',
            id: 'session-manager',
            order: 13,
            label: () => t('nav'),
            inject: () => ({
              t,
              rpc,
              sessions: getSessions(),
              workspaces: getWorkspaces(),
              // Live handles, preferred by the component. The renderer evaluates
              // one entry's inject() ONCE and caches the result for that entry's
              // lifetime, so a service captured as a VALUE freezes at whatever
              // the first render saw: a store that had not mounted yet would
              // render "No archived sessions" for the rest of the page, with no
              // error anywhere. Reading through these during render gets the
              // current handle every time.
              getSessions,
              getWorkspaces,
              refreshAfterDelete: refreshUntilGone,
              pullSessions,
            }),
          },
          SessionManagerSection,
        )
      }), 'session-manager: settings section')

      // Session context-menu row — the official slot (see the block comment
      // above DeleteSessionMenuItem). `menuEnabled` is the ping answer the
      // pre-slot implementation waited on before it appended anything, so the
      // `menuDeleteAvailable` config keeps its exact meaning: the row stays
      // hidden until the host has confirmed it is welcome, and a ping that
      // never answers leaves it hidden too.
      // The slot framework evaluates one entry's inject() ONCE and caches the
      // result for that entry's lifetime (`cachedRootInject` memoizes in a WeakMap
      // keyed by the entry, with no invalidation), and the entry first renders when
      // the user opens the "…" menu. A VALUE read from a closure therefore has to
      // be settled before that first render, which is why there are two short
      // retries. Two things make that robust rather than a race:
      //   - the entry component reads the answer through `getMenuEnabled`, so an
      //     open that happens while the ping is still IN FLIGHT (the frozen value
      //     would be `null` for the whole page) recovers on the next open;
      //   - a ping that FAILED is retried when the user next opens the menu, so a
      //     host that was merely unreachable at boot still gets its row. A host
      //     that ANSWERED "no" (`menuDeleteAvailable: false`) is never re-pinged:
      //     that would be one request per menu open, forever.
      let menuEnabled = null
      let menuPingTimer = null
      let menuPingFailed = false
      const settleMenuEnabled = (attempt) => {
        ping().then((value) => {
          menuEnabled = value !== false
          menuPingFailed = false
          // The first successful ping is also this client's "the host is
          // reachable" moment: seed the pending-deletion residue watch from the
          // queue, and give a host with `reannouncePendingRemovals` the chance
          // to re-announce queued live removals to every connected client. The
          // seed marks itself as done only once a queue read actually lands —
          // see `seedPendingQueue`, which also retries a failed one.
          seedPendingQueue()
        }).catch(() => {
          if (attempt < 2) {
            menuPingTimer = setTimeout(() => {
              menuPingTimer = null
              settleMenuEnabled(attempt + 1)
            }, attempt === 0 ? 1000 : 3000)
          } else {
            // The host never ANSWERED. Remember that distinctly from a host that
            // answered "no": only this case is worth re-pinging.
            menuEnabled = false
            menuPingFailed = true
          }
        })
      }
      settleMenuEnabled(0)
      ctx.effect(() => () => {
        if (menuPingTimer !== null) {
          clearTimeout(menuPingTimer)
          menuPingTimer = null
        }
      }, 'session-manager: menu ping retry timer')

      ctx.effect(() => ctx.slots.inject('sidebar.workspaces.session.menu.item', function* () {
        yield ctx.slots.register(
          {
            name: 'sidebar.workspaces.session.menu.item',
            id: 'session-manager-delete',
            order: 500,
            inject: () => ({
              t,
              rpc,
              sessions: getSessions(),
              getSessions,
              refreshAfterDelete: refreshUntilGone,
              pullSessions,
              menuEnabled,
              // LIVE, not the frozen value above: the inject result is cached
              // for the entry's lifetime, so a value captured while the ping was
              // still in flight (or before the retries settled) would keep the
              // row hidden for the WHOLE page. The entry component remounts on
              // each menu open — only inject() is cached — so reading through
              // this getter lets the next open show the row.
              getMenuEnabled: () => menuEnabled,
              // One more attempt when the user opens the menu after a FAILED
              // boot ping: the row is hidden only because the host did not
              // answer, which may no longer be true. Never re-arms for a host
              // that answered "no", and never stacks a second attempt while a
              // retry is already scheduled.
              requestMenuPing: () => {
                if (menuPingFailed && menuPingTimer === null) settleMenuEnabled(0)
              },
              onError: (reason) => {
                try { ctx.logger && ctx.logger.warn(`session-manager: delete via menu failed: ${errorMessage(reason)}`) } catch { /* noop */ }
              },
            }),
          },
          DeleteSessionMenuItem,
        )
      }), 'session-manager: session menu item')
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    return module.exports
  },
})
