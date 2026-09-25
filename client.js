/**
 * dsh-worktree-bar — Client half.
 *
 * One row above the composer card (`conversation.input.dock`) that changes with
 * the Session it belongs to:
 *
 * - **Before the first prompt** the row is the start screen's only control: a
 *   `worktree` checkbox. Checking it creates the linked worktree and opens the
 *   blank Session in it, so whatever is typed next runs on the worktree branch;
 *   unchecking it returns to the main checkout and removes the worktree again.
 * - **In a conversation** the row is status: the workspace and the branch the
 *   Session actually runs on (`main`, `worktree-calm-otter`, …), with the
 *   worktree named beside it, plus the menu that reaches the checkout from the
 *   OS and removes a managed worktree.
 *
 * A Session's working directory is creation-time data in the harness, so the
 * start screen cannot "move" a Session into a worktree later: checking the box
 * does it the only way the harness allows — create the checkout, then open the
 * Session in it.
 *
 * Boundaries this module keeps:
 * - Plain browser module loaded through `window.__ModuleLoader__`. React comes
 *   from the loader; no Harness Client package is imported.
 * - Only `--dsw-alias-*` theme tokens decide colors, and the row sizes itself
 *   with the composer's own layout variables so it lines up with the card.
 * - Visible copy lives in this plugin's `dsh-worktree-bar` locale namespace.
 * - Nothing runs while idle: one `info` request on mount, then a slow poll that
 *   pauses whenever the page is hidden or there is no repository.
 */

window.__ModuleLoader__.load({
  id: 'dsh-worktree-bar',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'dsh-worktree-bar'
    /**
     * Host route prefix registered by `lib/plugin.js`.
     *
     * It keeps the original spelling while the package carries its new name:
     * this path is the two halves' shared contract, and the Client is served
     * fresh on every page load while the Host module lives until a restart, so
     * renaming it would leave them disagreeing in between.
     */
    const API = '/dsh-worktree/api/'
    /** Poll interval when the Host config names none. */
    const DEFAULT_POLL_MS = 15000
    /** How long one inline notice stays on screen. */
    const NOTICE_MS = 7000

    const EN = {
      'worktree': 'worktree',
      'worktree.hint': 'Start this session in an isolated copy of the repository',
      'worktree.creating': 'creating worktree…',
      'worktree.leaving': 'removing…',
      'worktree.active': 'This session runs in the worktree {name}',
      'worktree.kept': 'This checkout was not created by this plugin, so it was left in place.',
      'worktree.remove': 'Remove worktree…',
      'worktree.removeNow': 'Remove {name}',
      'worktree.removeConfirm': 'Remove {name}? Its directory and uncommitted work are deleted, and this session moves to the main checkout.',
      'worktree.removeForce': 'Discard changes and remove',
      'worktree.dirty': 'This worktree has uncommitted changes or untracked files.',
      'worktree.removed': 'Worktree removed.',
      'worktree.prepared': 'Worktree ready · {items}',
      'worktree.setupFailed': 'The project setup command failed, so the worktree may need finishing by hand: {command}',
      'worktree.noConvention': 'This repository declares no worktree setup, so it is a plain fresh checkout.',
      'worktree.willPrepare': 'will prepare {items}',
      'worktree.other': 'Open worktree {name}',
      'copyPath': 'Copy workspace path',
      'copyBranch': 'Copy branch name',
      'copyWorktreePath': 'Copy worktree path',
      'showInExplorer': 'Show in Explorer',
      'openInTerminal': 'Open in terminal',
      'openOnGitHub': 'Open repository on GitHub',
      'createPr': 'Create pull request…',
      'changeFolder': 'Change folder…',
      'copied': 'Copied',
      'cancel': 'Cancel',
      'stats.title': '{changed} changed, {untracked} untracked',
      'detached': 'detached HEAD',
      'noWorkspaceUi': 'The Workspace UI plugin is not mounted, so no session can be opened.',
      'workspace': 'workspace {name}',
      'branch': 'branch {name}',
    }

    const ZH = {
      'worktree': 'worktree',
      'worktree.hint': '在仓库的隔离副本中开始本次会话',
      'worktree.creating': '正在创建 worktree…',
      'worktree.leaving': '正在移除…',
      'worktree.active': '当前会话运行在 worktree {name} 中',
      'worktree.kept': '该检出不是本插件创建的，已原样保留。',
      'worktree.remove': '移除 worktree…',
      'worktree.removeNow': '移除 {name}',
      'worktree.removeConfirm': '移除 {name}？它的目录和未提交的改动都会被删除，当前会话将回到主检出。',
      'worktree.removeForce': '丢弃改动并移除',
      'worktree.dirty': '该 worktree 有未提交的改动或未跟踪文件。',
      'worktree.removed': 'worktree 已移除。',
      'worktree.prepared': 'worktree 已就绪 · {items}',
      'worktree.setupFailed': '项目的初始化命令执行失败，worktree 可能需要手工补完：{command}',
      'worktree.noConvention': '该仓库未声明 worktree 初始化约定，将是一个干净的全新检出。',
      'worktree.willPrepare': '将准备 {items}',
      'worktree.other': '打开 worktree {name}',
      'copyPath': '复制工作区路径',
      'copyBranch': '复制分支名',
      'copyWorktreePath': '复制 worktree 路径',
      'showInExplorer': '在文件管理器中显示',
      'openInTerminal': '在终端中打开',
      'openOnGitHub': '在 GitHub 中打开仓库',
      'createPr': '创建 Pull Request…',
      'changeFolder': '切换目录…',
      'copied': '已复制',
      'cancel': '取消',
      'stats.title': '{changed} 个改动，{untracked} 个未跟踪',
      'detached': '游离 HEAD',
      'noWorkspaceUi': 'Workspace UI 插件未挂载，无法打开会话。',
      'workspace': '工作区 {name}',
      'branch': '分支 {name}',
    }

    /**
     * Every rule here reads a theme token for color and the composer's own layout
     * variables for geometry: the row must line up with the composer card, which
     * is narrower than the conversation column and centred inside it.
     */
    const CSS = [
      '.dshwt-bar{position:relative;box-sizing:border-box;display:flex;align-items:center;gap:6px;flex:none;',
      'width:calc(100% - var(--dsh-composer-side-clearance,16px) * 2 - var(--dsh-composer-dock-inset,8px) * 2);',
      'max-width:calc(var(--dsh-composer-card-max-width,952px) - var(--dsh-composer-dock-inset,8px) * 2);',
      'margin:0 auto;padding:0 var(--dsh-composer-dock-inset,8px);',
      'color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dshwt-chip{display:inline-flex;align-items:center;gap:6px;max-width:260px;height:26px;padding:0 8px;border:1px solid transparent;border-radius:var(--dsw-radius-md,6px);background:transparent;color:inherit;font:inherit;cursor:pointer}',
      '.dshwt-chip:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dshwt-chip[aria-expanded="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dshwt-chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dshwt-chip:disabled{cursor:default;color:var(--dsw-alias-state-idle-primary)}',
      '.dshwt-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshwt-spacer{flex:1 1 auto}',
      '.dshwt-stats{display:inline-flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums}',
      '.dshwt-add{color:var(--dsw-alias-state-success-primary)}',
      '.dshwt-del{color:var(--dsw-alias-state-error-primary)}',
      '.dshwt-pill{border:1px solid var(--dsw-alias-border-l1)}',
      '.dshwt-pill[data-on="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}',
      '.dshwt-check{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,6px);background:transparent;color:inherit;font:inherit;cursor:pointer}',
      '.dshwt-check:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}',
      '.dshwt-check:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dshwt-check:disabled{cursor:default;color:var(--dsw-alias-state-idle-primary)}',
      '.dshwt-box{display:grid;place-items:center;width:13px;height:13px;flex:none;border:1px solid var(--dsw-alias-border-l2);border-radius:3px;color:transparent}',
      '.dshwt-check[aria-checked="true"] .dshwt-box{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}',
      '.dshwt-notice{margin-left:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshwt-notice[data-level="error"]{color:var(--dsw-alias-state-error-primary)}',
      '.dshwt-notice[data-level="warn"]{color:var(--dsw-alias-state-warn-primary)}',
      '.dshwt-notice[data-level="ok"]{color:var(--dsw-alias-state-success-primary)}',
      '.dshwt-menu{position:absolute;bottom:calc(100% + 6px);z-index:30;min-width:240px;max-width:340px;padding:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-overlay)}',
      '.dshwt-menu[data-anchor="left"]{left:var(--dsh-composer-dock-inset,8px)}',
      '.dshwt-menu[data-anchor="right"]{right:var(--dsh-composer-dock-inset,8px)}',
      '.dshwt-menuHead{padding:6px 8px;color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.dshwt-item{display:flex;align-items:center;gap:8px;width:100%;height:28px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer}',
      '.dshwt-item:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dshwt-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.dshwt-item[data-danger="true"]{color:var(--dsw-alias-state-error-primary)}',
      '.dshwt-item:disabled{color:var(--dsw-alias-state-idle-primary);cursor:default}',
      '.dshwt-sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l1)}',
      '.dshwt-warn{margin:4px 8px 6px;color:var(--dsw-alias-state-warn-primary);font-size:11px;line-height:16px}',
    ].join('')

    /** One expected Host failure, carrying the Host's stable code. */
    class ApiError extends Error {
      constructor(code, message) {
        super(message)
        this.name = 'ApiError'
        this.code = code
      }
    }

    /**
     * Call one Host method.
     * @param {string} method - API method name.
     * @param {Record<string, unknown>} payload - request body.
     * @returns {Promise<any>} the response value.
     */
    async function api(method, payload) {
      let response
      try {
        response = await fetch(`${API}${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? {}),
        })
      } catch (error) {
        throw new ApiError('unreachable', error instanceof Error ? error.message : String(error))
      }
      let body = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      if (body !== null && typeof body === 'object' && body.ok === true) return body.value
      const code = body?.error?.code ?? `http-${response.status}`
      const message = body?.error?.message ?? `dsh-worktree-bar: ${method} failed with HTTP ${response.status}`
      throw new ApiError(code, message)
    }

    /** Human-readable text for any thrown value. */
    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    /** Fill `{name}` placeholders, the same syntax the locale service uses. */
    function format(template, vars) {
      if (typeof template !== 'string') return ''
      if (vars === undefined || vars === null) return template
      return template.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match))
    }

    /**
     * Copy text to the clipboard, falling back to a hidden textarea when the
     * async clipboard API is unavailable (an unfocused or non-secure page).
     * @param {string} text - text to copy.
     * @returns {Promise<boolean>} whether the copy was issued.
     */
    async function copyText(text) {
      try {
        if (navigator.clipboard !== undefined && navigator.clipboard.writeText !== undefined) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        // Fall through to the selection copy.
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const copied = document.execCommand('copy')
        area.remove()
        return copied
      } catch {
        return false
      }
    }

    /** One 14px stroked glyph. Kept inline: the plugin imports no icon package. */
    function Icon(props) {
      const paths = ICONS[props.name] ?? []
      return h('svg', {
        width: props.size ?? 14,
        height: props.size ?? 14,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { flex: 'none' },
      }, paths.map((d, index) => h('path', { key: index, d })))
    }

    const ICONS = {
      repo: ['M2 4.6A1.6 1.6 0 0 1 3.6 3h2.5l1.3 1.6h5A1.6 1.6 0 0 1 14 6.2v5.2A1.6 1.6 0 0 1 12.4 13H3.6A1.6 1.6 0 0 1 2 11.4z'],
      branch: [
        'M4.6 2a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 1 1 0-3.6',
        'M4.6 10.4a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 1 1 0-3.6',
        'M11.4 3.6a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 1 1 0-3.6',
        'M4.6 5.8v4.6',
        'M4.6 8.4h4.2a2.6 2.6 0 0 0 2.6-2.6',
      ],
      check: ['M3.2 8.2l3.1 3.1 6.5-7'],
      terminal: ['M3 5l3.4 3.4L3 11.8', 'M8.6 12.2h4.4'],
      external: ['M9 3.2h3.8V7', 'M12.8 3.2 6.6 9.4', 'M11.4 9.6v2.6a1.6 1.6 0 0 1-1.6 1.6H4.2a1.6 1.6 0 0 1-1.6-1.6V6.6A1.6 1.6 0 0 1 4.2 5h2.6'],
      copy: ['M5.6 5.6V3.6A1.6 1.6 0 0 1 7.2 2h5.2A1.6 1.6 0 0 1 14 3.6v5.2a1.6 1.6 0 0 1-1.6 1.6h-2', 'M3.6 5.6h5.2A1.6 1.6 0 0 1 10.4 7.2v5.2A1.6 1.6 0 0 1 8.8 14H3.6A1.6 1.6 0 0 1 2 12.4V7.2a1.6 1.6 0 0 1 1.6-1.6z'],
      worktree: ['M8 2.4 2.6 5.4v5.2L8 13.6l5.4-3V5.4z', 'M2.6 5.4 8 8.4l5.4-3', 'M8 8.4v5.2'],
      remove: ['M4.2 4.2l7.6 7.6', 'M11.8 4.2l-7.6 7.6'],
    }

    /** One clickable menu row. */
    function MenuItem(props) {
      return h('button', {
        type: 'button',
        role: 'menuitem',
        className: 'dshwt-item',
        'data-danger': props.danger === true ? 'true' : 'false',
        disabled: props.disabled === true,
        onClick: props.onSelect,
      }, props.icon === undefined ? null : h(Icon, { name: props.icon }), h('span', { className: 'dshwt-text' }, props.label))
    }

    /**
     * Render one menu entry definition.
     * @param {{ id: string, label: string, icon?: string, danger?: boolean, disabled?: boolean, onSelect?: () => void, separatorBefore?: boolean }} entry - the row.
     * @returns {import('react').ReactNode} the row.
     */
    function renderEntry(entry) {
      return h(React.Fragment, { key: entry.id },
        entry.separatorBefore === true ? h('div', { className: 'dshwt-sep' }) : null,
        h(MenuItem, {
          label: entry.label,
          icon: entry.icon,
          danger: entry.danger,
          disabled: entry.disabled,
          onSelect: entry.onSelect,
        }))
    }

    /**
     * The workspace row above the composer.
     *
     * @param {object} props - slot props plus this plugin's inject face.
     * @returns {import('react').ReactNode} the row, or nothing without a repository.
     */
    function WorktreeBar(props) {
      const { sessionId, openPathInNewSession } = props
      const t = typeof props.t === 'function'
        ? props.t
        : typeof props.translate === 'function'
          ? props.translate
          : (key, vars) => format(EN[key] ?? key, vars)
      const useSession = props.useSession

      // The start screen's only control is this row's checkbox, and it belongs to
      // a Session that has not been prompted yet. `blank` is that fact.
      const selectBlank = React.useCallback(snapshot => snapshot.blank === true, [])
      const selectAttempted = React.useCallback(snapshot => snapshot.promptAttempted === true, [])
      const blank = typeof useSession === 'function' ? useSession(selectBlank) === true : false
      const attempted = typeof useSession === 'function' ? useSession(selectAttempted) === true : false
      const startScreen = blank && !attempted

      const [state, setState] = React.useState({ phase: 'loading' })
      const [menu, setMenu] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [dirty, setDirty] = React.useState(false)
      const barRef = React.useRef(null)
      const generationRef = React.useRef(0)

      const value = state.phase === 'ready' ? state.value : null
      // Poll only where a repository was actually found: a directory outside git
      // has nothing to refresh, and an unreachable Host must not be hammered.
      const configuredPollMs = typeof value?.options?.pollMs === 'number' && value.options.pollMs >= 0
        ? value.options.pollMs
        : DEFAULT_POLL_MS
      const pollMs = value?.isRepo === true ? configuredPollMs : 0

      const load = React.useCallback(async () => {
        const generation = generationRef.current + 1
        generationRef.current = generation
        try {
          const next = await api('info', { sessionId })
          if (generation !== generationRef.current) return
          setState({ phase: 'ready', value: next })
        } catch (error) {
          if (generation !== generationRef.current) return
          setState({ phase: 'error', message: messageOf(error) })
        }
      }, [sessionId])

      React.useEffect(() => {
        setState({ phase: 'loading' })
        setMenu(null)
        setDirty(false)
        void load()
      }, [load])

      React.useEffect(() => {
        if (pollMs <= 0) return undefined
        const refresh = () => {
          if (document.visibilityState === 'visible') void load()
        }
        const timer = setInterval(refresh, pollMs)
        document.addEventListener('visibilitychange', refresh)
        window.addEventListener('focus', refresh)
        return () => {
          clearInterval(timer)
          document.removeEventListener('visibilitychange', refresh)
          window.removeEventListener('focus', refresh)
        }
      }, [load, pollMs])

      React.useEffect(() => {
        if (menu === null) return undefined
        const onPointerDown = (event) => {
          if (barRef.current !== null && !barRef.current.contains(event.target)) setMenu(null)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setMenu(null)
        }
        document.addEventListener('mousedown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('mousedown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [menu])

      React.useEffect(() => {
        if (notice === null) return undefined
        const timer = setTimeout(() => setNotice(null), NOTICE_MS)
        return () => clearTimeout(timer)
      }, [notice])

      React.useEffect(() => {
        if (state.phase === 'error') console.warn('dsh-worktree-bar: repository context unavailable —', state.message)
      }, [state])

      const report = React.useCallback((level, text) => {
        setNotice({ level, text })
      }, [])

      const run = React.useCallback(async (kind, operation) => {
        setBusy(kind)
        try {
          await operation()
        } catch (error) {
          report('error', messageOf(error))
        } finally {
          setBusy(null)
          void load()
        }
      }, [load, report])

      const copy = React.useCallback(async (text) => {
        const copied = await copyText(text)
        report(copied ? 'ok' : 'error', copied ? t('copied') : text)
      }, [report, t])

      const openExternal = React.useCallback(async (payload) => {
        await run('open', async () => {
          await api('open.external', payload)
        })
      }, [run])

      /** Start screen: create the worktree, then open the blank Session in it. */
      const startIsolated = React.useCallback(async () => {
        setMenu(null)
        await run('create', async () => {
          const created = await api('worktree.create', { sessionId })
          // Report what the project's convention prepared before navigation, so a
          // failed setup command is visible while it still matters.
          const seeded = created.seeded ?? null
          if (seeded?.setup?.ok === false) {
            report('warn', t('worktree.setupFailed', { command: seeded.setup.command }))
          } else if (seeded !== null) {
            const items = [...(seeded.linked ?? []), ...(seeded.copied ?? [])]
            if (items.length > 0) report('ok', t('worktree.prepared', { items: items.join(', ') }))
          }
          await openPathInNewSession(created.path)
        })
      }, [openPathInNewSession, report, run, sessionId, t])

      /**
       * Start screen: leave the worktree again. A checkout this plugin created is
       * removed with its branch; any other checkout is left exactly as it is,
       * because deleting a directory this plugin did not make would be a
       * destructive guess.
       */
      const leaveIsolated = React.useCallback(async () => {
        setMenu(null)
        const target = value?.cwd
        if (typeof target !== 'string') return
        await run('leave', async () => {
          if (value?.isPluginWorktree === true) {
            await api('worktree.remove', { sessionId, path: target, deleteBranch: true })
          } else {
            report('warn', t('worktree.kept'))
          }
          if (typeof value?.repoRoot === 'string') await openPathInNewSession(value.repoRoot)
        })
      }, [openPathInNewSession, report, run, sessionId, t, value])
      const removeWorktree = React.useCallback(async (force) => {
        const target = value?.cwd
        if (typeof target !== 'string') return
        setBusy('remove')
        try {
          await api('worktree.remove', { sessionId, path: target, force, deleteBranch: true })
          setMenu(null)
          setDirty(false)
          report('ok', t('worktree.removed'))
          if (typeof value?.repoRoot === 'string') await openPathInNewSession(value.repoRoot)
        } catch (error) {
          if (error instanceof ApiError && error.code === 'dirty-worktree') {
            setDirty(true)
            report('warn', t('worktree.dirty'))
          } else {
            report('error', messageOf(error))
          }
        } finally {
          setBusy(null)
          void load()
        }
      }, [load, openPathInNewSession, report, sessionId, t, value])

      const changeFolder = React.useCallback(async () => {
        setMenu(null)
        await run('folder', async () => {
          await props.changeFolder()
        })
      }, [props, run])

      if (value === null) return null
      if (value.isRepo !== true) return null

      const branchLabel = value.branch ?? value.head ?? t('detached')
      const stats = value.stats ?? { added: 0, removed: 0 }
      const showStats = stats.added > 0 || stats.removed > 0
      // `inWorktree` is "this Session runs in an isolated checkout" and drives the
      // checkbox; `managed` is "this plugin created that checkout" and is the only
      // thing removal may delete. They differ for a worktree the user made by hand.
      const inWorktree = value.isWorktree === true
      const managed = value.isPluginWorktree === true
      const worktreeLabel = value.worktreeName ?? branchLabel

      const repoEntries = [
        { id: 'reveal', label: t('showInExplorer'), icon: 'repo', onSelect: () => { setMenu(null); void openExternal({ action: 'reveal', path: value.repoRoot }) } },
        value.webUrl === null ? null : { id: 'github', label: t('openOnGitHub'), icon: 'external', onSelect: () => { setMenu(null); void openExternal({ action: 'url', url: value.webUrl }) } },
        { id: 'copyPath', label: t('copyPath'), icon: 'copy', onSelect: () => { setMenu(null); void copy(value.repoRoot) } },
        { id: 'folder', label: t('changeFolder'), icon: 'repo', onSelect: () => { void changeFolder() } },
        { id: 'terminal', label: t('openInTerminal'), icon: 'terminal', separatorBefore: true, onSelect: () => { setMenu(null); void openExternal({ action: 'terminal', path: value.repoRoot }) } },
      ].filter(entry => entry !== null)

      const otherWorktrees = (value.worktrees ?? []).filter(entry => entry.current !== true && entry.main !== true)
      for (const entry of otherWorktrees) {
        repoEntries.push({
          id: `worktree:${entry.path}`,
          label: t('worktree.other', { name: entry.name }),
          icon: 'worktree',
          separatorBefore: entry === otherWorktrees[0],
          onSelect: () => {
            setMenu(null)
            void run('open', async () => { await openPathInNewSession(entry.path) })
          },
        })
      }

      const branchEntries = [
        { id: 'copyBranch', label: t('copyBranch'), icon: 'copy', disabled: value.branch === null, onSelect: () => { setMenu(null); void copy(value.branch ?? '') } },
        inWorktree ? { id: 'copyWorktree', label: t('copyWorktreePath'), icon: 'copy', onSelect: () => { setMenu(null); void copy(value.cwd) } } : null,
        value.compareUrl === null ? null : { id: 'pr', label: t('createPr'), icon: 'external', onSelect: () => { setMenu(null); void openExternal({ action: 'url', url: value.compareUrl }) } },
        { id: 'branchTerminal', label: t('openInTerminal'), icon: 'terminal', separatorBefore: true, onSelect: () => { setMenu(null); void openExternal({ action: 'terminal', path: value.cwd }) } },
        // A worktree is removed where its branch is: the branch chip is present in
        // every mode, so removal never depends on the start screen. Only a
        // checkout this plugin created may be deleted.
        managed && startScreen === false ? { id: 'branchRemove', label: t('worktree.remove'), icon: 'remove', danger: true, separatorBefore: true, onSelect: () => { setMenu('worktree-confirm') } } : null,
      ].filter(entry => entry !== null)

      const worktreeEntries = [
        { id: 'wtCopy', label: t('copyWorktreePath'), icon: 'copy', onSelect: () => { setMenu(null); void copy(value.cwd) } },
        { id: 'wtReveal', label: t('showInExplorer'), icon: 'repo', onSelect: () => { setMenu(null); void openExternal({ action: 'reveal', path: value.cwd }) } },
        value.compareUrl === null ? null : { id: 'wtPr', label: t('createPr'), icon: 'external', onSelect: () => { setMenu(null); void openExternal({ action: 'url', url: value.compareUrl }) } },
        { id: 'wtTerminal', label: t('openInTerminal'), icon: 'terminal', separatorBefore: true, onSelect: () => { setMenu(null); void openExternal({ action: 'terminal', path: value.cwd }) } },
        { id: 'wtRemove', label: t('worktree.remove'), icon: 'remove', danger: true, separatorBefore: true, onSelect: () => { setMenu('worktree-confirm') } },
      ].filter(entry => entry !== null)

      const confirmEntries = [
        { id: 'wtConfirmRemove', label: dirty ? t('worktree.removeForce') : t('worktree.removeNow', { name: worktreeLabel }), icon: 'remove', danger: true, onSelect: () => { void removeWorktree(dirty) } },
        { id: 'wtCancel', label: t('cancel'), onSelect: () => { setMenu('worktree') } },
      ]

      const anchoredRight = menu === 'worktree' || menu === 'worktree-confirm' || menu === 'start'
      const menuEntries = menu === 'repo'
        ? repoEntries
        : menu === 'branch'
          ? branchEntries
          : menu === 'worktree-confirm'
            ? confirmEntries
            : menu === 'worktree' ? worktreeEntries : []

      // The tooltip states what checking the box will actually do in THIS
      // repository, read from the project's own convention file.
      const willPrepare = [
        ...(value.convention?.link ?? []),
        ...(value.convention?.linkIgnored ?? []).map(entry => `${entry}/*`),
        ...(value.convention?.copy ?? []),
      ]
      const checkboxTitle = inWorktree
        ? t('worktree.active', { name: worktreeLabel })
        : value.convention?.error !== undefined
          ? value.convention.error
          : willPrepare.length > 0
            ? `${t('worktree.hint')} · ${t('worktree.willPrepare', { items: willPrepare.join(', ') })}`
            : `${t('worktree.hint')} · ${t('worktree.noConvention')}`

      const checkbox = h('button', {
        type: 'button',
        className: 'dshwt-check',
        role: 'checkbox',
        'aria-checked': inWorktree ? 'true' : 'false',
        disabled: busy !== null,
        title: checkboxTitle,
        onClick: () => {
          if (busy !== null) return
          void (inWorktree ? leaveIsolated() : startIsolated())
        },
      },
      h('span', { className: 'dshwt-box' }, h(Icon, { name: 'check', size: 10 })),
      h('span', { className: 'dshwt-text' }, busy === 'create' ? t('worktree.creating') : busy === 'leave' ? t('worktree.leaving') : t('worktree')))

      return h('div', { className: 'dshwt-bar', ref: barRef },
        h('button', {
          type: 'button',
          className: 'dshwt-chip',
          'aria-haspopup': 'menu',
          'aria-expanded': menu === 'repo' ? 'true' : 'false',
          title: t('workspace', { name: value.repoRoot }),
          onClick: () => setMenu(menu === 'repo' ? null : 'repo'),
        }, h(Icon, { name: 'repo' }), h('span', { className: 'dshwt-text' }, value.repoName)),

        h('button', {
          type: 'button',
          className: 'dshwt-chip',
          'aria-haspopup': 'menu',
          'aria-expanded': menu === 'branch' ? 'true' : 'false',
          title: inWorktree ? t('worktree.active', { name: worktreeLabel }) : t('branch', { name: branchLabel }),
          onClick: () => setMenu(menu === 'branch' ? null : 'branch'),
        }, h(Icon, { name: 'branch' }), h('span', { className: 'dshwt-text' }, branchLabel)),

        h('span', { className: 'dshwt-spacer' }),

        notice === null ? null : h('span', { className: 'dshwt-notice', 'data-level': notice.level, title: notice.text }, notice.text),

        showStats
          ? h('span', {
            className: 'dshwt-stats',
            title: t('stats.title', { changed: value.changedFiles ?? 0, untracked: value.untrackedFiles ?? 0 }),
          },
          h('span', { className: 'dshwt-add' }, `+${stats.added}`),
          h('span', { className: 'dshwt-del' }, `-${stats.removed}`))
          : null,

        // Any isolated checkout is named on the row; the branch chip above already
        // carries its branch. In a conversation the name is information, and only a
        // checkout this plugin manages offers removal through the branch menu.
        !startScreen && inWorktree
          ? h('span', { className: 'dshwt-chip dshwt-pill', 'data-on': 'true', title: t('worktree.active', { name: worktreeLabel }) },
            h(Icon, { name: 'worktree' }), h('span', { className: 'dshwt-text' }, worktreeLabel))
          : null,

        startScreen ? checkbox : null,

        menu === null || (menuEntries.length === 0 && menu !== 'start')
          ? null
          : h('div', { className: 'dshwt-menu', role: 'menu', 'data-anchor': anchoredRight ? 'right' : 'left' },
            menu === 'worktree' || menu === 'worktree-confirm'
              ? h('div', { className: 'dshwt-menuHead' }, t('worktree.active', { name: worktreeLabel }))
              : null,
            menu === 'worktree-confirm'
              ? h('div', { className: 'dshwt-warn' }, t('worktree.removeConfirm', { name: worktreeLabel }), dirty ? ` ${t('worktree.dirty')}` : '')
              : null,
            menuEntries.map(renderEntry)))
    }

    return {
      /**
       * Activation waits for the slot registry, the locale service, and the two
       * Workspace services that open a Session. All four ship with the Web
       * bundle, so waiting costs nothing there and keeps the row out of
       * compositions where its controls could not work.
       */
      inject: ['slots', 'locale', 'workspaces', 'uiWorkspace'],
      apply(ctx) {
        ctx.effect(() => {
          const releaseEn = ctx.locale.register(NS, 'en', EN)
          const releaseZh = ctx.locale.register(NS, 'zh', ZH)
          return () => {
            releaseEn()
            releaseZh()
          }
        }, 'dsh-worktree-bar: dictionaries')

        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.plugin = 'dsh-worktree-bar'
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => {
            tag.remove()
          }
        }, 'dsh-worktree-bar: styles')

        /**
         * Register a directory as a Workspace and open a Session in it.
         *
         * A Session's working directory is fixed at creation, so this is the only
         * way to put work into a different checkout: the checkout gets a Session,
         * and the one that asked keeps running where it is.
         *
         * @param {string} path - an existing directory.
         * @returns {Promise<void>} resolves once the new Session is selected.
         */
        const openPathInNewSession = async (path) => {
          const workspaces = ctx.get('workspaces')
          const uiWorkspace = ctx.get('uiWorkspace')
          if (workspaces === undefined || uiWorkspace === undefined) {
            throw new Error(EN['noWorkspaceUi'])
          }
          const view = await workspaces.create({ path })
          await uiWorkspace.openWorkspace(view.workspaceId)
        }

        /** Ask the OS for a directory, then open a Session there. */
        const changeFolder = async () => {
          const uiWorkspace = ctx.get('uiWorkspace')
          if (uiWorkspace === undefined) throw new Error(EN['noWorkspaceUi'])
          const path = await uiWorkspace.pickDirectory()
          if (typeof path === 'string' && path !== '') await openPathInNewSession(path)
        }

        // `ctx.locale.bind` is the same translator the framework's `t` seat
        // projects; passing it through the inject face keeps copy localized even
        // where that seat is absent for a dynamically loaded module.
        const translate = ctx.locale.bind(NS)

        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'worktree',
          order: 30,
          locale: NS,
          inject: () => ({ openPathInNewSession, changeFolder, translate }),
        }, WorktreeBar))
      },
    }
  },
})
