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
//      `toast()` for what that cost.
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
      pendingBanner: '有 {n} 个会话已标记删除，重启 dsh 后完成最终清理：',
      pendingFinalizedBanner: '有 {n} 个会话已彻底删除，界面缓存将在重启 dsh 后自动清理。',
      pendingShowFinalized: '显示已清理的条目',
      pendingHideFinalized: '隐藏已清理的条目',
      pendingCancel: '取消删除',
      pendingFinalizing: '已删除 · 重启后自动清理',
      refreshFailed: '会话列表未能自动刷新：请点击「刷新」；若旧会话仍显示，可重启应用。',
      versionLine: '插件 v{version} · 会话服务 {status}',
      runningRefused: '会话「{title}」正在运行任务，请等待任务完成后再删除。',
      errorPrefix: '操作失败：',
      refresh: '刷新',
      workspaceUngrouped: '未分组',
      running: '运行中',
      unknownSession: '（会话不存在）',
      menuDelete: '彻底删除',
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
      pendingBanner: '{n} sessions are marked for deletion; the cleanup completes after the next dsh restart:',
      pendingFinalizedBanner: '{n} sessions are already permanently deleted; the on-screen copies clear after the next dsh restart.',
      pendingShowFinalized: 'Show cleaned-up entries',
      pendingHideFinalized: 'Hide cleaned-up entries',
      pendingCancel: 'Cancel deletion',
      pendingFinalizing: 'Deleted · cleaned up automatically after restart',
      refreshFailed: 'The session list could not refresh automatically: click “Refresh”; if the old row remains, restart the app.',
      versionLine: 'Plugin v{version} · session service {status}',
      runningRefused: 'Session “{title}” has a running task; wait for it to finish before deleting.',
      errorPrefix: 'Operation failed: ',
      refresh: 'Refresh',
      workspaceUngrouped: 'Ungrouped',
      running: 'Running',
      unknownSession: '(session missing)',
      menuDelete: 'Delete permanently',
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

    // ── design-token styles ----------------------------------------------------
    const TOKENS = {
      text: 'var(--dsw-alias-label-primary, #1f2328)',
      textSecondary: 'var(--dsw-alias-label-secondary, #4b5563)',
      textTertiary: 'var(--dsw-alias-label-tertiary, #8a9199)',
      danger: 'var(--dsw-alias-state-error-primary, #e5484d)',
      dangerBg: 'var(--dsw-alias-interactive-bg-hover-danger, rgba(229, 72, 77, 0.12))',
      hoverBg: 'var(--dsw-alias-interactive-bg-hover, rgba(31, 35, 40, 0.06))',
      border: 'var(--dsw-alias-border-l1, rgba(31, 35, 40, 0.08))',
      surface: 'var(--dsw-specific-menu, #ffffff)',
      primary: 'var(--dsw-alias-state-business-primary, #4a5cf0)',
      primaryBg: 'var(--dsw-alias-button-primary-fill, #4a5cf0)',
      onPrimary: 'var(--dsw-alias-button-primary-text, #ffffff)',
    }

    // Keyframes for the refresh spinner and the confirm-dialog fade-in —
    // inline styles cannot declare @keyframes, so inject the stylesheet once
    // (idempotent).
    const ensureSpinStyle = () => {
      try {
        if (document.getElementById('dsh-session-manager-styles') !== null) return
        const style = document.createElement('style')
        style.id = 'dsh-session-manager-styles'
        style.textContent = '@keyframes sm-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}@keyframes sm-fade-in{from{opacity:0}to{opacity:1}}'
        document.head.appendChild(style)
      } catch {
        // Cosmetic only — without it the icon just does not spin.
      }
    }

    // ── plain-DOM confirm dialog (shared by section + menu item) ---------------
    function openConfirm({ title, body, confirmLabel, cancelLabel, danger = false, onRenderError = null }) {
      return new Promise((resolve) => {
        const overlay = document.createElement('div')
        overlay.setAttribute('data-sm-confirm', '1')
        Object.assign(overlay.style, {
          position: 'fixed', inset: '0', zIndex: '2147483000',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0, 0, 0, 0.45)', animation: 'sm-fade-in .12s ease-out',
        })
        const card = document.createElement('div')
        Object.assign(card.style, {
          width: '400px', maxWidth: 'calc(100vw - 48px)', boxSizing: 'border-box',
          borderRadius: '16px', padding: '20px', background: TOKENS.surface,
          color: TOKENS.text, boxShadow: '0 24px 64px rgba(0,0,0,0.35)',
          fontFamily: 'inherit',
        })
        const titleEl = document.createElement('div')
        titleEl.textContent = title
        Object.assign(titleEl.style, { fontSize: '16px', lineHeight: '24px', fontWeight: '600', marginBottom: '8px' })
        const bodyEl = document.createElement('div')
        bodyEl.textContent = body
        Object.assign(bodyEl.style, { fontSize: '13px', lineHeight: '20px', color: TOKENS.textSecondary, marginBottom: '16px', whiteSpace: 'pre-wrap' })
        card.appendChild(titleEl)
        card.appendChild(bodyEl)

        const actions = document.createElement('div')
        Object.assign(actions.style, { display: 'flex', justifyContent: 'flex-end', gap: '8px' })
        const mkButton = (text, primary) => {
          const button = document.createElement('button')
          button.type = 'button'
          button.textContent = text
          Object.assign(button.style, {
            border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '13px', lineHeight: '20px',
            padding: '7px 14px',
            ...(primary
              ? { background: danger ? TOKENS.danger : TOKENS.primaryBg, color: '#fff' }
              : { background: 'transparent', color: TOKENS.textSecondary }),
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
        const onKey = (event) => {
          // Escape cancels. There is deliberately NO global Enter-to-confirm:
          // this dialog confirms an irreversible physical delete, so it must
          // not fire on an Enter that was never aimed at the Delete button.
          if (event.key === 'Escape') finish(null)
        }
        document.addEventListener('keydown', onKey, true)
        let done = false
        function finish(value) {
          if (done) return
          done = true
          document.removeEventListener('keydown', onKey, true)
          overlay.remove()
          resolve(value)
        }
        document.body.appendChild(overlay)
        // Safe default focus: Enter (or Space) from here activates CANCEL,
        // and a keyboard user can Tab to Delete deliberately.
        try { cancelButton.focus() } catch { /* noop */ }
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
        padding: '10px 12px', border: `1px solid ${TOKENS.border}`, borderRadius: '12px',
        background: TOKENS.surface,
      },
      title: { fontSize: '14px', lineHeight: '20px', color: TOKENS.text, fontWeight: '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      meta: { fontSize: '12px', lineHeight: '17px', color: TOKENS.textTertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      button: (danger, disabled) => ({
        display: 'inline-flex', alignItems: 'center', gap: '6px', border: '1px solid transparent',
        borderRadius: '8px', cursor: disabled ? 'not-allowed' : 'pointer', fontSize: '12.5px', lineHeight: '18px',
        padding: '5px 10px', opacity: disabled ? 0.5 : 1, background: 'transparent',
        color: danger ? TOKENS.danger : TOKENS.primary,
      }),
      linkButton: (danger) => ({
        display: 'inline-flex', alignItems: 'center', gap: '6px', border: 'none', borderRadius: '8px',
        cursor: 'pointer', fontSize: '13px', lineHeight: '20px', padding: '6px 10px', background: 'transparent',
        color: danger ? TOKENS.danger : TOKENS.primary,
      }),
    }

    const FALLBACK_WORKSPACES = Object.freeze({ items: [], archivedSessionIds: [] })
    const FALLBACK_SESSIONS = Object.freeze({ byId: {}, ids: [], phase: 'ready' })

    function useStoreSubscription(store, fallback) {
      const subscribe = useMemo(() => (store && typeof store.subscribe === 'function' ? store.subscribe.bind(store) : () => () => {}), [store])
      const getSnapshot = useMemo(() => (store && typeof store.getSnapshot === 'function' ? store.getSnapshot.bind(store) : () => fallback), [store, fallback])
      return useSyncExternalStore(subscribe, getSnapshot)
    }

    function SessionManagerSection(props) {
      const t = props.t
      const rpc = props.rpc
      const sessions = props.sessions
      const workspaces = props.workspaces

      const wsSnapshot = useStoreSubscription(workspaces && workspaces.list, FALLBACK_WORKSPACES)
      const sessSnapshot = useStoreSubscription(sessions && sessions.list, FALLBACK_SESSIONS)

      const archivedIds = useMemo(() => (Array.isArray(wsSnapshot.archivedSessionIds) ? wsSnapshot.archivedSessionIds : []), [wsSnapshot])
      const byId = sessSnapshot.byId || {}

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
      const loadPending = () => {
        rpc('deferred/list')
          .then((value) => {
            setPendingIds(Array.isArray(value && value.sessionIds) ? value.sessionIds : [])
            setRecoverableIds(new Set(Array.isArray(value?.recoverable) ? value.recoverable : []))
          })
          .catch(() => {})
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
            title: summary?.displayTitle ?? summary?.title ?? t('unknownSession'),
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
      const [error, setError] = useState('')
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
        const timer = setTimeout(() => dispatchToast({ type: 'drop', id }), 5000)
        toastTimers.current.push(timer)
      }

      const cancelPending = async (sessionId) => {
        try {
          await rpc('deferred/cancel', { sessionId })
          toast('ok', format(t, 'pendingCancel', {}) + ` · ${sessionId.slice(0, 8)}…`)
          loadPending()
          if (sessions && typeof sessions.refreshList === 'function') await sessions.refreshList().catch(() => {})
        } catch (reason) {
          setError(`${t('errorPrefix')}${errorMessage(reason)}`)
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
          if (sessions && typeof sessions.refreshList === 'function') await sessions.refreshList()
          loadPending()
        } catch (reason) {
          setError(`${t('errorPrefix')}${errorMessage(reason)}`)
        } finally {
          // One full turn of feedback even when the store refreshes instantly.
          const remaining = 800 - (Date.now() - startedAt)
          if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining))
          setRefreshing(false)
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
          setError(`${t('errorPrefix')}${errorMessage(reason)}`)
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
          onRenderError: (error) => setError(`${t('errorPrefix')}${errorMessage(error)}`),
        })
        if (decision === null) return
        setBusy((prev) => ({ ...prev, [`delete:${sessionId}`]: true }))
        setError('')
        try {
          const result = await rpc('delete', { sessionId })
          // A partial delete (bookkeeping done, some file seam degraded) must
          // not read as a clean success — surface the host's warnings.
          const warnings = Array.isArray(result?.warnings) ? result.warnings.filter((line) => typeof line === 'string') : []
          if (warnings.length > 0) setError(warnings.join('\n'))
          if (result?.openAtDelete !== true) {
            try {
              let refreshed = true
              if (typeof props.refreshAfterDelete === 'function') {
                refreshed = (await props.refreshAfterDelete(sessionId)) !== false
              } else if (sessions && typeof sessions.refreshList === 'function') {
                await sessions.refreshList()
              }
              if (!refreshed) setError(t('refreshFailed'))
            } catch (refreshError) {
              try { console.warn(`[dsh-session-manager] session list refresh failed: ${errorMessage(refreshError)}`) } catch { /* noop */ }
              setError(t('refreshFailed'))
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
          onRenderError: (renderError) => setError(`${t('errorPrefix')}${errorMessage(renderError)}`),
        })
        if (decision === null) return

        setError('')
        setBulk({ done: 0, total: targets.length })
        const failures = []
        let deleted = 0
        let openDeleted = 0
        const warnings = []
        try {
          for (const row of targets) {
            // A row that started running mid-run is refused by the host with
            // session/running; skipping up front keeps the reported totals honest.
            if (row.running) continue
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
        // re-fetch the same list N times.
        try {
          if (sessions && typeof sessions.refreshList === 'function') await sessions.refreshList()
        } catch (refreshError) {
          try { console.warn(`[dsh-session-manager] session list refresh failed: ${errorMessage(refreshError)}`) } catch { /* noop */ }
          setError(t('refreshFailed'))
        }
        loadPending()
        setSelectedIds(new Set())

        if (warnings.length > 0) setError(warnings.join('\n'))
        if (failures.length > 0) {
          const summary = format(t, 'deleteBulkPartial', { n: deleted, m: failures.length })
          setError(`${summary}\n${failures.join('\n')}`)
          return
        }
        if (deleted === 0) return
        toast('ok', openDeleted > 0
          ? format(t, 'deleteBulkOkOpen', { n: deleted, m: openDeleted })
          : format(t, 'deleteBulkOk', { n: deleted }))
      }

      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '760px' } },
        React.createElement('div', null,
          React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px' } },
            React.createElement('h2', { style: { fontSize: '16px', lineHeight: '24px', fontWeight: '600', margin: '0 0 6px', color: TOKENS.text } }, t('nav')),
            React.createElement('span', { style: { fontSize: '12px', lineHeight: '16px', color: TOKENS.textTertiary } },
              hostInfo === null
                ? t('checking')
                : hostInfo.unreachable === true
                  ? 'RPC unreachable'
                  : format(t, 'versionLine', {
                      version: hostInfo.version ?? '?',
                      status: sessions !== undefined ? 'ok' : 'absent',
                    })),
          ),
          React.createElement('p', { style: { fontSize: '13px', lineHeight: '20px', margin: 0, color: TOKENS.textTertiary } }, t('navDesc')),
        ),
        toasts.length > 0 && React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          toasts.map((entry) => React.createElement('div', {
            key: entry.id,
            style: {
              display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', lineHeight: '20px',
              padding: '8px 12px', borderRadius: '10px', border: `1px solid ${TOKENS.border}`,
              color: entry.kind === 'ok' ? TOKENS.text : TOKENS.danger, background: TOKENS.surface,
            },
          }, React.createElement(entry.kind === 'ok' ? IconCheckOutlineRegular : IconWarningOutlineRegular, { size: 16 }), entry.text)),
        ),
        error !== '' && React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', lineHeight: '20px', color: TOKENS.danger, padding: '8px 12px', borderRadius: '10px', background: TOKENS.dangerBg } },
          React.createElement(IconWarningOutlineRegular, { size: 16 }), error),
        !rpcAvailable && React.createElement('div', { style: { fontSize: '13px', lineHeight: '20px', color: TOKENS.danger } }, t('unavailable')),
        pendingIds.length > 0 && React.createElement('div', {
          style: {
            display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px 12px', borderRadius: '10px',
            border: `1px solid ${TOKENS.primary}`, background: TOKENS.surface, fontSize: '13px', lineHeight: '20px',
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
            React.createElement('code', { style: { flex: '1', fontSize: '12px', color: TOKENS.textTertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, id),
            React.createElement('button', { type: 'button', style: rowStyles.linkButton(false), onClick: () => cancelPending(id) }, t('pendingCancel')),
          )),
          finalizedIds.length > 0 && React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            React.createElement('button', {
              type: 'button',
              style: { ...rowStyles.linkButton(false), alignSelf: 'flex-start', fontSize: '12px', padding: '0' },
              'aria-expanded': showFinalizedIds,
              onClick: () => setShowFinalizedIds((prev) => !prev),
            }, showFinalizedIds ? t('pendingHideFinalized') : t('pendingShowFinalized')),
            showFinalizedIds && finalizedIds.map((id) => React.createElement('div', { key: id, style: { display: 'flex', alignItems: 'center', gap: '10px' } },
              React.createElement('code', { style: { flex: '1', fontSize: '12px', color: TOKENS.textTertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, id),
              React.createElement('span', { style: { fontSize: '12px', lineHeight: '18px', color: TOKENS.textTertiary } }, t('pendingFinalizing')),
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
            ? React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: TOKENS.textTertiary, padding: '12px 0' } },
                React.createElement(IconLoadingOutlineRegular, { size: 16 }), t('loading'))
            : null,
          rows.length === 0 && sessSnapshot.phase !== 'pending'
            ? React.createElement('div', { style: { fontSize: '13px', lineHeight: '20px', color: TOKENS.textTertiary, padding: '12px 0' } }, t('empty'))
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
                    row.running && React.createElement('span', { style: { fontSize: '11px', lineHeight: '16px', padding: '0 6px', borderRadius: '999px', color: TOKENS.primary, border: `1px solid ${TOKENS.primary}` } }, t('running')),
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
                  type: 'button', style: rowStyles.button(true, busy[`delete:${row.sessionId}`] === true),
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

    /** Visible plain-DOM toast: the menu path must never fail silently. */
    function toast(text) {
      try {
        const node = document.createElement('div')
        node.setAttribute('data-sm-toast', '1')
        node.textContent = text
        Object.assign(node.style, {
          position: 'fixed', top: '72px', left: '50%', transform: 'translateX(-50%)',
          zIndex: '2147483000', maxWidth: '560px', padding: '10px 16px', borderRadius: '10px',
          background: TOKENS.surface, color: TOKENS.danger, border: `1px solid ${TOKENS.danger}`,
          fontSize: '13px', lineHeight: '20px', boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
        })
        document.body.appendChild(node)
        setTimeout(() => node.remove(), 6000)
      } catch {
        // Nothing else we can do — the console still carries the error.
      }
    }

    // One confirmation flow at a time. Selecting a row closes the menu, which
    // unmounts the item, so this cannot live in component state.
    let menuConfirmBusy = false

    /** Confirm → delete → report. The menu item's entire behaviour. */
    async function runMenuDelete(input) {
      if (menuConfirmBusy) return
      menuConfirmBusy = true
      const { sessionId, t, rpc, sessions, refreshAfterDelete, onDeleted, onError } = input
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
            onRenderError: (error) => {
              report(error)
              toast(`${t('errorPrefix')}${errorMessage(error)}`)
            },
          })
        } catch (error) {
          report(error)
          toast(`${t('errorPrefix')}${errorMessage(error)}`)
          return
        }
        // openConfirm resolves true (confirmed) or null (cancel, backdrop,
        // Escape, degenerate render) — never false.
        if (decision === null) return
        try {
          const value = await rpc('delete', { sessionId })
          if (typeof onDeleted === 'function') onDeleted({ sessionId, value })
          if (Array.isArray(value?.warnings) && value.warnings.length > 0) {
            toast(value.warnings.filter((line) => typeof line === 'string').join(' '))
          }
          if (value?.openAtDelete === true) {
            // The session stays listed server-side (still open in this
            // process); the archive tombstone alone hides it, so there is
            // nothing to poll for.
            toast(format(t, 'deleteOkOpen', { title: label }))
          } else {
            let gone = false
            if (typeof refreshAfterDelete === 'function') {
              gone = (await refreshAfterDelete(sessionId)) === true
            } else if (sessions && typeof sessions.refreshList === 'function') {
              await Promise.resolve(sessions.refreshList()).catch(() => {})
            }
            // One message, not a success toast stacked on a failure toast:
            // the row is gone (clean success) or the delete landed but the
            // list is stale (success + what the user must do), as one line.
            const deleteOkText = format(t, 'deleteOk', { title: label })
            toast(gone ? deleteOkText : `${deleteOkText} — ${t('refreshFailed')}`)
          }
        } catch (reason) {
          report(reason)
          toast(isRunningError(reason)
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
      // menuDeleteAvailable === false hides the row; so does `null`, i.e. the
      // ping has not answered yet — the same pessimism the pre-slot
      // implementation had while it waited on that same answer.
      if (props.menuEnabled !== true) return null
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
            sessions: props.sessions,
            refreshAfterDelete: props.refreshAfterDelete,
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
          throw new Error('connection RPC is unavailable')
        }
        const result = await connection.rpc.call(CHANNEL, `${NS}/${endpoint}`, payload)
        if (result === undefined || typeof result !== 'object' || result.ok !== true) {
          const domainError = result !== null && typeof result === 'object' ? result.error : undefined
          const error = new Error(domainError !== undefined ? `${domainError.code}: ${domainError.message}` : 'session-manager RPC failed')
          // Structured stable code so callers match on it instead of scraping
          // the message string (the textual check stays as a fallback).
          if (domainError !== undefined && typeof domainError.code === 'string') error.code = domainError.code
          throw error
        }
        return result.value
      }

      const ping = () => rpc('ping', {}).then((value) => value && typeof value === 'object' ? value.menuDeleteAvailable : true)

      /** Poll the session-list store until the id is gone (up to ~6s),
       *  re-pulling via refreshList between polls. */
      const refreshUntilGone = async (sessionId) => {
        const sessions = getSessions()
        if (sessions === undefined || typeof sessions.refreshList !== 'function') return false
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
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            await sessions.refreshList()
          } catch (error) {
            lastError = error
          }
          await new Promise((resolve) => setTimeout(resolve, 800))
          if (!stillThere()) return true
        }
        if (lastError !== undefined) {
          try { console.warn(`[dsh-session-manager] session list refresh failed: ${errorMessage(lastError)}`) } catch { /* noop */ }
        }
        return !stillThere()
      }

      // Keep the session list fresh when any surface (host command, agent
      // tool, another client) removes a session.
      try {
        const remote = getRemote()
        if (remote !== undefined && typeof remote.$on === 'function') {
          remote.$on('api-session/removed', () => {
            const sessions = getSessions()
            if (sessions && typeof sessions.refreshList === 'function') {
              Promise.resolve(sessions.refreshList()).catch(() => {})
            }
          })
        }
      } catch {
        // No remote event surface — refreshes still happen after local mutations.
      }

      ensureSpinStyle()

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
              refreshAfterDelete: refreshUntilGone,
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
      let menuEnabled = null
      ping().then((value) => { menuEnabled = value === false ? false : true }).catch(() => { menuEnabled = false })

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
              refreshAfterDelete: refreshUntilGone,
              menuEnabled,
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
