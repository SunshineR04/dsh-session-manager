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
//   2. Session context menu: the official workspace browser's session menu
//      (rename / fork / archive) is not extensible through any slot, so this
//      plugin augments the rendered popup with a red "permanently delete"
//      item, resolving the owning session through the React fiber tree.
//      The augmentation is passive and degrades to a no-op whenever the DOM
//      structure it expects is absent.
window.__ModuleLoader__.load({
  id: 'dsh-session-manager',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const { useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } = React
    const {
      IconArchiveOutline20,
      IconCheckOutline16,
      IconLoadingOutline16,
      IconRefreshOutline16,
      IconTrashOutline16,
      IconWarningOutline16,
    } = require('@deepseek-ai/dsh-client-ui-primitives')

    const NS = 'session-manager'
    // RPC calls ride the host's shared `/api` prefix: the URL becomes
    // `/api/session-manager/<endpoint>` and the host-side interceptor for the
    // `session-manager` namespace dispatches it (0.1.5 host composition).
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
      deleteOkOpen: '已永久删除会话「{title}」。它当前已打开，界面副本将在重启 dsh 后消失。',
      pendingBanner: '有 {n} 个会话已标记删除，重启 dsh 后完成最终清理：',
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
      deleteOkOpen: 'Permanently deleted session “{title}”. It is still open; its on-screen copy disappears after the next dsh restart.',
      pendingBanner: '{n} sessions are marked for deletion; the cleanup completes after the next dsh restart:',
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
      // reads them during render.
      const [pendingIds, setPendingIds] = useState([])
      const [recoverableIds, setRecoverableIds] = useState(() => new Set())
      const [refreshing, setRefreshing] = useState(false)
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
          }, React.createElement(entry.kind === 'ok' ? IconCheckOutline16 : IconWarningOutline16, { size: 16 }), entry.text)),
        ),
        error !== '' && React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', lineHeight: '20px', color: TOKENS.danger, padding: '8px 12px', borderRadius: '10px', background: TOKENS.dangerBg } },
          React.createElement(IconWarningOutline16, { size: 16 }), error),
        !rpcAvailable && React.createElement('div', { style: { fontSize: '13px', lineHeight: '20px', color: TOKENS.danger } }, t('unavailable')),
        pendingIds.length > 0 && React.createElement('div', {
          style: {
            display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px 12px', borderRadius: '10px',
            border: `1px solid ${TOKENS.primary}`, background: TOKENS.surface, fontSize: '13px', lineHeight: '20px',
          },
        },
          React.createElement('div', { style: { color: TOKENS.text, fontWeight: '500' } }, format(t, 'pendingBanner', { n: pendingIds.length })),
          pendingIds.map((id) => React.createElement('div', { key: id, style: { display: 'flex', alignItems: 'center', gap: '10px' } },
            React.createElement('code', { style: { flex: '1', fontSize: '12px', color: TOKENS.textTertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, id),
            recoverableIds.has(id)
              ? React.createElement('button', { type: 'button', style: rowStyles.linkButton(false), onClick: () => cancelPending(id) }, t('pendingCancel'))
              : React.createElement('span', { style: { fontSize: '12px', lineHeight: '18px', color: TOKENS.textTertiary } }, t('pendingFinalizing')),
          )),
        ),

        React.createElement('section', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            React.createElement('h3', { style: { flex: '1', fontSize: '14px', lineHeight: '22px', fontWeight: '600', margin: 0, color: TOKENS.text } },
              `${t('archivedTitle')} · ${format(t, 'count', { n: rows.length })}`),
            React.createElement('button', {
              type: 'button',
              style: { ...rowStyles.linkButton(false), cursor: refreshing ? 'default' : 'pointer' },
              disabled: refreshing,
              onClick: refreshRows,
            },
              React.createElement('span', { style: { display: 'inline-flex', animation: refreshing ? 'sm-spin 0.8s linear infinite' : 'none' } },
                React.createElement(IconRefreshOutline16, { size: 16 })),
              t('refresh')),
          ),
          sessSnapshot.phase === 'pending' && rows.length === 0
            ? React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: TOKENS.textTertiary, padding: '12px 0' } },
                React.createElement(IconLoadingOutline16, { size: 16 }), t('loading'))
            : null,
          rows.length === 0 && sessSnapshot.phase !== 'pending'
            ? React.createElement('div', { style: { fontSize: '13px', lineHeight: '20px', color: TOKENS.textTertiary, padding: '12px 0' } }, t('empty'))
            : rows.map((row) => React.createElement('div', { key: row.sessionId, style: rowStyles.row },
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
                  disabled: busy[`restore:${row.sessionId}`] === true || !rpcAvailable,
                  onClick: () => restore(row.sessionId, row.title),
                }, React.createElement(IconArchiveOutline20, { size: 16 }), t('restore')),
                React.createElement('button', {
                  type: 'button', style: rowStyles.button(true, busy[`delete:${row.sessionId}`] === true),
                  disabled: busy[`delete:${row.sessionId}`] === true || !rpcAvailable,
                  onClick: () => remove(row.sessionId, row.title, row.running),
                }, React.createElement(IconTrashOutline16, { size: 16 }), t('delete')),
              )),
        ),
      )
    }

    // ── session context-menu augmentation --------------------------------------
    const ARCHIVE_LABELS = new Set(['归档会话', 'Archive session'])
    const isSessionActionsAria = (label) => typeof label === 'string'
      && (label.includes('的操作') || label.includes('Session actions'))
      && !label.includes('工作区')
      && !label.includes('Workspace')

    /** Walk the React fiber tree from a DOM element to the session row props. */
    function sessionIdFromElement(element) {
      let node = element
      while (node && node.nodeType !== 9) {
        const key = Object.keys(node).find((k) => k.startsWith('__reactFiber$'))
        if (key !== undefined) {
          let fiber = node[key]
          while (fiber !== null) {
            const props = fiber.memoizedProps
            if (props !== null && typeof props === 'object' && props.node !== undefined && typeof props.node === 'object' && props.node !== null) {
              const id = props.node.id
              if (typeof id === 'string' && id.length > 0) return { sessionId: id, title: typeof props.node.title === 'string' ? props.node.title : '' }
            }
            fiber = fiber.return
          }
        }
        node = node.parentElement
      }
      return undefined
    }

    /** Locate the anchor (ellipsis) button of the session row whose menu popup appeared. */
    function resolveSessionForPopup(popup) {
      const popupRect = popup.getBoundingClientRect()
      let best = null
      let bestDistance = Infinity
      for (const button of document.querySelectorAll('button[aria-label]')) {
        const label = button.getAttribute('aria-label') || ''
        if (!isSessionActionsAria(label)) continue
        const rect = button.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) continue
        const distance = Math.min(Math.abs(rect.bottom - popupRect.top), Math.abs(rect.top - popupRect.bottom))
        if (distance < bestDistance) {
          bestDistance = distance
          best = button
        }
      }
      if (best === null) return undefined
      const resolved = sessionIdFromElement(best)
      return resolved === undefined ? undefined : { ...resolved, anchor: best }
    }

    function appendDeleteItem(popup, session, handlers) {
      const wrap = document.createElement('div')
      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('role', 'menuitem')
      button.setAttribute('data-sm-delete', '1')
      const icon = document.createElement('span')
      icon.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.5h11M6.5 2.5h3M4.5 4.5l.6 9a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-9M6.5 7v4.5M9.5 7v4.5"/></svg>'
      Object.assign(icon.style, { display: 'inline-flex', flex: 'none', width: '16px', height: '16px', alignItems: 'center', justifyContent: 'center', color: TOKENS.danger })
      const label = document.createElement('span')
      label.textContent = handlers.t('menuDelete')
      Object.assign(label.style, { flex: '1', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })
      Object.assign(button.style, {
        display: 'flex', alignItems: 'center', gap: '8px', width: '100%', minHeight: '40px',
        padding: '8px 10px', border: 'none', borderRadius: '10px', background: 'transparent',
        cursor: 'pointer', fontSize: '14px', lineHeight: '22px', color: TOKENS.danger, textAlign: 'left',
      })
      button.appendChild(icon)
      button.appendChild(label)
      button.addEventListener('mouseenter', () => { button.style.background = TOKENS.dangerBg })
      button.addEventListener('mouseleave', () => { button.style.background = 'transparent' })
      // Stash the resolved session on the DOM node so the document-level
      // capture listener can act without re-resolving it.
      button.__smSession = { sessionId: session.sessionId, title: session.title, popup, anchor: session.anchor }
      // Fallback path: a plain click on the button itself (in case the
      // document-level pointerdown capture listener was not mounted).
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        handlers.openDeleteFor(button)
      })
      wrap.appendChild(button)
      const separator = document.createElement('div')
      separator.setAttribute('role', 'separator')
      Object.assign(separator.style, { height: '0.5px', margin: '4px 2px', background: TOKENS.border })
      popup.appendChild(separator)
      popup.appendChild(wrap)
    }

    function installSessionMenuAugmentation(ctx, handlers) {
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
      let menuEnabled = null // lazily resolved via host ping
      const inFlight = new WeakSet()

      /** Visible plain-DOM toast: the menu path must never fail silently. */
      const fallbackToast = (text) => {
        try {
          const toast = document.createElement('div')
          toast.setAttribute('data-sm-toast', '1')
          toast.textContent = text
          Object.assign(toast.style, {
            position: 'fixed', top: '72px', left: '50%', transform: 'translateX(-50%)',
            zIndex: '2147483000', maxWidth: '560px', padding: '10px 16px', borderRadius: '10px',
            background: TOKENS.surface, color: TOKENS.danger, border: `1px solid ${TOKENS.danger}`,
            fontSize: '13px', lineHeight: '20px', boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
          })
          document.body.appendChild(toast)
          setTimeout(() => toast.remove(), 6000)
        } catch {
          // Nothing else we can do — the console still carries the error.
        }
      }

      /** One idempotent delete-confirm flow per menu item. */
      const openDeleteFor = (button) => {
        const session = button.__smSession
        if (session === undefined || inFlight.has(button)) return
        inFlight.add(button)
        const closeMenu = () => {
          try {
            if (session.popup !== undefined && session.popup !== null && document.body.contains(session.popup)
              && session.anchor !== undefined && session.anchor !== null && document.body.contains(session.anchor)) {
              session.anchor.click()
            }
          } catch {
            // Menu state is cosmetic; never let close failures surface.
          }
        }
        let decisionPromise
        try {
          decisionPromise = openConfirm({
            title: handlers.t('deleteConfirmTitle'),
            body: format(handlers.t, 'deleteConfirmBody', { title: session.title || session.sessionId }),
            confirmLabel: handlers.t('confirm'),
            cancelLabel: handlers.t('cancel'),
            danger: true,
            onRenderError: (error) => {
              try { handlers.onError(error) } catch { /* noop */ }
              fallbackToast(`${handlers.t('errorPrefix')}${errorMessage(error)}`)
            },
          })
        } catch (error) {
          inFlight.delete(button)
          try { handlers.onError(error) } catch { /* noop */ }
          fallbackToast(`${handlers.t('errorPrefix')}${errorMessage(error)}`)
          return
        }
        decisionPromise.then(async (decision) => {
          inFlight.delete(button)
          if (decision === null) {
            closeMenu()
            return
          }
          try {
            const value = await handlers.rpc('delete', { sessionId: session.sessionId })
            handlers.onDeleted({ sessionId: session.sessionId, value })
            if (Array.isArray(value?.warnings) && value.warnings.length > 0) {
              fallbackToast(value.warnings.filter((line) => typeof line === 'string').join(' '))
            }
            if (value?.openAtDelete === true) {
              // The session stays listed server-side (still open in this
              // process); the archive tombstone alone hides it, so there is
              // nothing to poll for.
              fallbackToast(format(handlers.t, 'deleteOkOpen', { title: session.title || session.sessionId }))
            } else {
              let gone = false
              if (typeof handlers.refreshAfterDelete === 'function') {
                gone = (await handlers.refreshAfterDelete(session.sessionId)) === true
              } else {
                const sessions = handlers.getSessions()
                if (sessions && typeof sessions.refreshList === 'function') {
                  await Promise.resolve(sessions.refreshList()).catch(() => {})
                }
              }
              // One message, not a success toast stacked on a failure toast:
              // the row is gone (clean success) or the delete landed but the
              // list stale (success + what the user must do), as one line.
              const deleteOkText = format(handlers.t, 'deleteOk', { title: session.title || session.sessionId })
              fallbackToast(gone ? deleteOkText : `${deleteOkText} — ${handlers.t('refreshFailed')}`)
            }
          } catch (reason) {
            try { handlers.onError(reason) } catch { /* noop */ }
            const text = isRunningError(reason)
              ? format(handlers.t, 'runningRefused', { title: session.title || session.sessionId })
              : `${handlers.t('errorPrefix')}${errorMessage(reason)}`
            fallbackToast(text)
          } finally {
            closeMenu()
          }
        }, (error) => {
          inFlight.delete(button)
          fallbackToast(`${handlers.t('errorPrefix')}${errorMessage(error)}`)
        })
      }
      handlers.openDeleteFor = openDeleteFor

      // Earliest-possible interception: a capture-phase pointerdown on the
      // document. Runs before React's delegated handlers and before any
      // later-registered capture listener, so even if some other layer
      // swallows the subsequent click, the confirm dialog still opens.
      const onDocPointerDown = (event) => {
        let button = null
        try {
          const target = event.target
          button = target !== null && typeof target.closest === 'function' ? target.closest('[data-sm-delete]') : null
        } catch {
          return
        }
        if (button === null || button.__smSession === undefined) return
        event.preventDefault()
        event.stopPropagation()
        openDeleteFor(button)
      }
      document.addEventListener('pointerdown', onDocPointerDown, true)

      try {
        console.info('[dsh-session-manager] session-menu augmentation active')
      } catch { /* noop */ }

      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const added of record.addedNodes) {
            if (added.nodeType !== 1) continue
            const element = added
            const menuItem = element.matches && element.matches('[role="menuitem"]')
              ? element
              : element.querySelector ? element.querySelector('[role="menuitem"]') : null
            if (menuItem === null || menuItem === undefined) continue
            const itemWrap = menuItem.parentElement
            const popup = itemWrap && itemWrap.parentElement
            if (popup === null || popup === undefined) continue
            const items = popup.querySelectorAll('[role="menuitem"]')
            let isSessionMenu = false
            for (const item of items) {
              if (ARCHIVE_LABELS.has((item.textContent || '').trim())) { isSessionMenu = true; break }
            }
            if (!isSessionMenu) continue
            // Self-healing augmentation: the official Menu may re-render its
            // child list and drop our appended DOM nodes. Re-append whenever
            // our marker is missing (idempotent), instead of augmenting each
            // popup only once.
            const maybe = () => {
              if (menuEnabled === false) return
              if (popup.querySelector('[data-sm-delete]') !== null) return
              const session = resolveSessionForPopup(popup)
              if (session === undefined) return
              appendDeleteItem(popup, session, handlers)
            }
            if (menuEnabled === null) {
              handlers.ping().then((value) => {
                menuEnabled = value === false ? false : true
                if (menuEnabled) maybe()
              }).catch(() => { menuEnabled = false })
            } else {
              maybe()
            }
          }
        }
      })
      observer.observe(document.body, { childList: true, subtree: true })
      return () => {
        document.removeEventListener('pointerdown', onDocPointerDown, true)
        observer.disconnect()
      }
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

      // Session context-menu augmentation.
      ctx.effect(() => installSessionMenuAugmentation(ctx, {
        t,
        rpc,
        ping,
        getSessions,
        refreshAfterDelete: async (sessionId) => {
          try {
            return await refreshUntilGone(sessionId)
          } catch {
            return false
          }
        },
        onDeleted: () => {},
        onError: (reason) => {
          try { ctx.logger && ctx.logger.warn(`session-manager: delete via menu failed: ${errorMessage(reason)}`) } catch { /* noop */ }
        },
      }), 'session-manager: session menu augmentation')
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    return module.exports
  },
})
