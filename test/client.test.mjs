/**
 * Client-half smoke test: renders the row through the shim and drives its
 * controls, asserting the Host calls it makes.
 *
 * It catches what installation cannot: a component that throws, a menu that
 * never opens, a checkbox that calls the wrong endpoint, or a control that
 * silently does nothing.
 */

import { createReact, findAll, installDom, setResponder, textOf } from './react-shim.mjs'

let passed = 0
function assert(condition, label) {
  if (!condition) throw new Error(`FAILED: ${label}`)
  passed += 1
  console.log(`  ok  ${label}`)
}

/** The default Host snapshot; individual tests override fields. */
function info(overrides = {}) {
  return {
    isRepo: true,
    cwd: 'C:/work/repo',
    repoRoot: 'C:/work/repo',
    repoName: 'repo',
    checkoutRoot: 'C:/work/repo',
    branch: 'main',
    head: 'abc1234',
    detached: false,
    isWorktree: false,
    isPluginWorktree: false,
    worktreeName: null,
    webUrl: 'https://github.com/owner/repo',
    compareUrl: null,
    stats: { added: 3, removed: 1, files: 2 },
    changedFiles: 2,
    untrackedFiles: 0,
    worktrees: [{ path: 'C:/work/repo', name: 'repo', branch: 'main', main: true, current: true, managed: false }],
    convention: { source: 'C:/work/repo/dsh-worktree.json', file: 'dsh-worktree.json', link: ['.venv'], linkIgnored: ['data'], copy: [], setup: null },
    options: {},
    ...overrides,
  }
}

/** Load the Client half once, with the DOM shim already installed. */
async function loadClient() {
  const runtime = createReact()
  const dom = installDom()
  let definition = null
  globalThis.window.__ModuleLoader__.load = (value) => {
    definition = value
  }
  await import('../client.js')
  if (definition === null) throw new Error('client.js did not register a module definition')

  const host = {
    /** Recorded Host route calls. */
    calls: [],
    /** Directories registered as Workspaces. */
    workspaces: [],
    /** Workspace ids opened as Sessions. */
    opened: [],
    /** Directories returned by the directory picker. */
    picked: 'C:/picked/dir',
    /** The current route responder. */
    responder: () => info(),
    /** Locale registrations made by apply(). */
    locales: [],
    /** The registered slot entry. */
    registration: null,
  }

  setResponder((url, body) => host.responder(url, body))
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init?.body ?? '{}')
    host.calls.push({ url, body })
    const answer = host.responder(url, body)
    if (answer !== null && typeof answer === 'object' && answer.__error === true) {
      return { ok: false, status: answer.status ?? 400, json: async () => ({ ok: false, error: { code: answer.code, message: answer.message } }) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, value: answer }) }
  }

  const ctx = {
    effect(fn) {
      return fn()
    },
    get(name) {
      if (name === 'workspaces') {
        return {
          create: async ({ path }) => {
            host.workspaces.push(path)
            return { workspaceId: `ws-${host.workspaces.length}`, path }
          },
        }
      }
      if (name === 'uiWorkspace') {
        return {
          openWorkspace: async (workspaceId) => {
            host.opened.push(workspaceId)
          },
          pickDirectory: async () => host.picked,
        }
      }
      return undefined
    },
    locale: {
      register(namespace, locale, dictionary) {
        host.locales.push({ namespace, locale, entries: Object.keys(dictionary).length })
        return () => {}
      },
      bind(namespace) {
        // The real service returns a bound translator; the shim returns the same
        // English fallback the component uses so assertions read the EN copy.
        return (key, vars) => {
          const template = {
            'copied': 'Copied',
            'cancel': 'Cancel',
            'worktree': 'worktree',
            'worktree.hint': 'Start this session in an isolated copy of the repository',
            'worktree.creating': 'creating worktree…',
            'worktree.leaving': 'removing…',
            'worktree.remove': 'Remove worktree…',
            'worktree.removeNow': 'Remove {name}',
            'worktree.removeForce': 'Discard changes and remove',
            'worktree.removeConfirm': 'Remove {name}? Its directory and uncommitted work are deleted, and this session moves to the main checkout.',
            'worktree.dirty': 'This worktree has uncommitted changes or untracked files.',
            'worktree.removed': 'Worktree removed.',
            'worktree.kept': 'This checkout was not created by this plugin, so it was left in place.',
            'worktree.prepared': 'Worktree ready · {items}',
            'worktree.setupFailed': 'The project setup command failed, so the worktree may need finishing by hand: {command}',
            'worktree.noConvention': 'This repository declares no worktree setup, so it is a plain fresh checkout.',
            'worktree.willPrepare': 'will prepare {items}',
            'worktree.active': 'This session runs in the worktree {name}',
            'worktree.other': 'Open worktree {name}',
            'showInExplorer': 'Show in Explorer',
            'copyPath': 'Copy workspace path',
            'copyBranch': 'Copy branch name',
            'copyWorktreePath': 'Copy worktree path',
            'openInTerminal': 'Open in terminal',
            'openOnGitHub': 'Open repository on GitHub',
            'createPr': 'Create pull request…',
            'changeFolder': 'Change folder…',
            'stats.title': '{changed} changed, {untracked} untracked',
            'detached': 'detached HEAD',
            'workspace': 'workspace {name}',
            'branch': 'branch {name}',
          }[key] ?? key
          return typeof vars === 'object' && vars !== null
            ? template.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match))
            : template
        }
      },
    },
    slots: {
      inject(key, callback) {
        host.injectedKey = key
        callback()
        return () => {}
      },
      register(options, Component) {
        host.registration = { options, Component }
        return () => {}
      },
    },
  }

  const plugin = definition.factory((name) => {
    if (name === 'react') return runtime.React
    throw new Error(`client.js required an unexpected module: ${name}`)
  })
  assert(plugin.inject.includes('slots'), 'declares the slots service')
  plugin.apply(ctx)
  assert(host.registration !== null, 'registered a conversation.input.dock entry')
  assert(host.injectedKey === 'conversation.input.dock', `injected into the dock slot (${host.injectedKey})`)
  assert(host.registration.options.order === 30, 'ordered after the shipped dock entries')
  assert(host.locales.length === 2, `registered 2 locale dictionaries (${host.locales.map(entry => entry.locale).join(',')})`)

  /**
   * Render the registered component.
   * @param {object} options - render options.
   * @param {string} options.sessionId - the session.
   * @param {boolean} [options.blank] - whether the Session has no prompt yet.
   * @param {boolean} [options.attempted] - whether a prompt was attempted.
   */
  const render = async ({ sessionId = 'session-1', blank = true, attempted = false } = {}) => {
    const injected = host.registration.options.inject(sessionId)
    const useSession = (selector) => selector({ sessionId, blank, promptAttempted: attempted, running: false })
    const element = runtime.React.createElement(host.registration.Component, { sessionId, useSession, ...injected })
    const tree = await runtime.mount(element)
    return { tree, runtime }
  }

  return { host, runtime, render, dom }
}

/** Buttons whose visible text contains a fragment. */
function buttonByText(tree, fragment) {
  return findAll(tree, node => node.type === 'button' && textOf(node).includes(fragment))[0] ?? null
}

/** Buttons whose class list contains a fragment. */
function buttonByClass(tree, fragment) {
  return findAll(tree, node => node.type === 'button' && typeof node.props.className === 'string' && node.props.className.includes(fragment))[0] ?? null
}

async function main() {
  const client = await loadClient()
  const { host } = client

  console.log('row without a repository')
  host.responder = () => ({ isRepo: false, cwd: 'C:/tmp', reason: 'not-a-repository' })
  const outside = await client.render({ sessionId: 'session-outside' })
  assert(outside.tree === null, 'renders nothing outside a repository')
  outside.runtime.unmount()

  console.log('start screen: the checkbox is the only control')
  host.responder = () => info()
  const start = await client.render({ sessionId: 'session-start', blank: true })
  assert(textOf(start.tree).includes('repo'), 'shows the workspace name')
  assert(textOf(start.tree).includes('main'), 'shows the current branch')
  const checkbox = findAll(start.tree, node => node.props?.role === 'checkbox')[0]
  assert(checkbox !== undefined, 'renders a worktree checkbox')
  assert(checkbox.props['aria-checked'] === 'false', 'starts unchecked')
  assert(checkbox.props.title.startsWith('Start this session in an isolated copy of the repository'), 'carries the isolated-copy tooltip')
  assert(checkbox.props.title.includes('.venv'), `the tooltip names what the project convention will prepare (${checkbox.props.title})`)
  const firstInfo = host.calls.filter(call => call.url.endsWith('/info')).at(-1)
  assert(firstInfo.body.sessionId === 'session-start', 'sends the Session id')
  assert(client.dom.intervals.length === 1 && client.dom.intervals[0].ms === 15000, 'polls slowly instead of streaming')

  console.log('checking the box creates the worktree, then opens the Session there')
  host.responder = url => (url.endsWith('worktree.create')
    ? { path: 'C:/work/repo/.dsh/worktrees/calm-otter', name: 'calm-otter', branch: 'worktree-calm-otter', seeded: { linked: ['.venv'], copied: [], skipped: [], setup: null } }
    : info())
  checkbox.props.onClick()
  await start.runtime.settle(60)
  const createCall = host.calls.find(call => call.url.endsWith('worktree.create'))
  assert(createCall !== undefined, 'calls worktree.create')
  assert(createCall.body.sessionId === 'session-start', 'creates for the current Session')
  assert(host.workspaces[0] === 'C:/work/repo/.dsh/worktrees/calm-otter', `registers the worktree as a Workspace (${host.workspaces[0]})`)
  assert(host.opened[0] === 'ws-1', 'opens the Session in that Workspace')
  start.runtime.unmount()

  console.log('repository menu')
  const main = await client.render({ sessionId: 'session-main', blank: false })
  const repoChip = buttonByClass(main.tree, 'dshwt-chip')
  assert(repoChip !== null, 'renders the repository chip')
  repoChip.props.onClick()
  await main.runtime.settle()
  assert(textOf(main.runtime.tree).includes('Show in Explorer'), 'menu lists Show in Explorer')
  assert(textOf(main.runtime.tree).includes('Copy workspace path'), 'menu lists Copy workspace path')
  assert(textOf(main.runtime.tree).includes('Open repository on GitHub'), 'menu lists the GitHub link')

  console.log('copy action')
  buttonByText(main.runtime.tree, 'Copy workspace path').props.onClick()
  await main.runtime.settle()
  assert(client.dom.clipboard.includes('C:/work/repo'), 'copies the workspace path')
  main.runtime.unmount()

  console.log('conversation inside a worktree: status, not a control')
  host.responder = () => info({
    cwd: 'C:/work/repo/.dsh/worktrees/calm-otter',
    checkoutRoot: 'C:/work/repo/.dsh/worktrees/calm-otter',
    branch: 'worktree-calm-otter',
    isWorktree: true,
    isPluginWorktree: true,
    worktreeName: 'calm-otter',
    compareUrl: 'https://github.com/owner/repo/compare/main...worktree-calm-otter?expand=1',
    worktrees: [
      { path: 'C:/work/repo', name: 'repo', branch: 'main', main: true, current: false, managed: false },
      { path: 'C:/work/repo/.dsh/worktrees/calm-otter', name: 'calm-otter', branch: 'worktree-calm-otter', main: false, current: true, managed: true },
    ],
  })
  const inside = await client.render({ sessionId: 'session-worktree', blank: false })
  assert(textOf(inside.tree).includes('worktree-calm-otter'), 'shows the worktree branch name')
  assert(textOf(inside.tree).includes('calm-otter'), 'shows the worktree name')
  assert(findAll(inside.tree, node => node.props?.role === 'checkbox').length === 0, 'no checkbox once the conversation started')

  console.log('removal needs confirmation, from the branch menu')
  const branchChip = findAll(inside.tree, node => node.type === 'button' && typeof node.props?.className === 'string' && node.props.className.includes('dshwt-chip'))[1]
  assert(branchChip !== undefined, 'the row has a second chip for the branch')
  assert(textOf(branchChip).includes('worktree-calm-otter'), 'the branch chip names the worktree branch')
  branchChip.props.onClick()
  await inside.runtime.settle()
  assert(textOf(inside.runtime.tree).includes('Remove worktree'), 'offers removal')
  assert(textOf(inside.runtime.tree).includes('Create pull request'), 'offers the compare URL')
  buttonByText(inside.runtime.tree, 'Remove worktree').props.onClick()
  await inside.runtime.settle()
  assert(textOf(inside.runtime.tree).includes('Remove calm-otter?'), 'asks before deleting')
  host.responder = url => (url.endsWith('worktree.remove')
    ? { path: 'C:/work/repo/.dsh/worktrees/calm-otter', branch: 'worktree-calm-otter', branchDeleted: true }
    : info({ isWorktree: true, isPluginWorktree: true, worktreeName: 'calm-otter', cwd: 'C:/work/repo/.dsh/worktrees/calm-otter' }))
  buttonByText(inside.runtime.tree, 'Remove calm-otter').props.onClick()
  await inside.runtime.settle(60)
  const removeCall = host.calls.find(call => call.url.endsWith('worktree.remove'))
  assert(removeCall !== undefined, 'calls worktree.remove')
  assert(removeCall.body.path === 'C:/work/repo/.dsh/worktrees/calm-otter', 'removes the worktree the Session runs in')
  assert(host.workspaces.includes('C:/work/repo'), 'returns the user to the main checkout')
  inside.runtime.unmount()

  console.log('a refused removal asks again with force')
  host.responder = url => (url.endsWith('worktree.remove')
    ? { __error: true, code: 'dirty-worktree', message: 'contains modified or untracked files' }
    : info({ isWorktree: true, isPluginWorktree: true, worktreeName: 'calm-otter', cwd: 'C:/work/repo/.dsh/worktrees/calm-otter' }))
  const dirty = await client.render({ sessionId: 'session-dirty', blank: false })
  findAll(dirty.tree, node => typeof node.props?.title === 'string' && node.props.title.includes('calm-otter'))[0].props.onClick()
  await dirty.runtime.settle()
  buttonByText(dirty.runtime.tree, 'Remove worktree').props.onClick()
  await dirty.runtime.settle()
  buttonByText(dirty.runtime.tree, 'Remove calm-otter').props.onClick()
  await dirty.runtime.settle(60)
  assert(textOf(dirty.runtime.tree).includes('Discard changes and remove'), 'offers a forced removal after a dirty refusal')
  dirty.runtime.unmount()

  console.log('start screen inside a managed worktree: unchecking removes it')
  host.responder = url => (url.endsWith('worktree.remove')
    ? { path: 'C:/work/repo/.dsh/worktrees/calm-otter', branch: 'worktree-calm-otter', branchDeleted: true }
    : info({ isWorktree: true, isPluginWorktree: true, worktreeName: 'calm-otter', cwd: 'C:/work/repo/.dsh/worktrees/calm-otter', branch: 'worktree-calm-otter' }))
  const startIsolated = await client.render({ sessionId: 'session-start-isolated', blank: true })
  const onCheckbox = findAll(startIsolated.tree, node => node.props?.role === 'checkbox')[0]
  assert(onCheckbox.props['aria-checked'] === 'true', 'shows as checked inside a managed worktree')
  const before = host.calls.filter(call => call.url.endsWith('worktree.remove')).length
  onCheckbox.props.onClick()
  await startIsolated.runtime.settle(60)
  assert(host.calls.filter(call => call.url.endsWith('worktree.remove')).length === before + 1, 'unchecking removes the worktree')
  assert(host.workspaces.includes('C:/work/repo'), 'and returns to the main checkout')
  startIsolated.runtime.unmount()

  console.log('start screen inside a foreign checkout: nothing is deleted')
  host.responder = url => (url.endsWith('worktree.remove')
    ? { path: 'x', branch: null, branchDeleted: false }
    : info({
      isWorktree: true,
      isPluginWorktree: false,
      worktreeName: null,
      cwd: 'C:/elsewhere/wt',
      checkoutRoot: 'C:/elsewhere/wt',
      repoRoot: 'C:/work/repo',
      worktrees: [
        { path: 'C:/work/repo', name: 'repo', branch: 'main', main: true, current: false, managed: false },
        { path: 'C:/elsewhere/wt', name: 'wt', branch: 'feature', main: false, current: true, managed: false },
      ],
    }))
  const foreign = await client.render({ sessionId: 'session-foreign', blank: true })
  const foreignBox = findAll(foreign.tree, node => node.props?.role === 'checkbox')[0]
  assert(foreignBox.props['aria-checked'] === 'true', 'shows as checked in any worktree')
  const beforeForeign = host.calls.filter(call => call.url.endsWith('worktree.remove')).length
  foreignBox.props.onClick()
  await foreign.runtime.settle(60)
  assert(host.calls.filter(call => call.url.endsWith('worktree.remove')).length === beforeForeign, 'refuses to delete a checkout it did not create')
  assert(host.workspaces.includes('C:/work/repo'), 'still opens the main checkout')
  foreign.runtime.unmount()

  console.log('an unreachable Host stays silent')
  host.responder = () => ({ __error: true, code: 'forbidden', message: 'forbidden', status: 403 })
  const broken = await client.render({ sessionId: 'session-broken' })
  assert(broken.tree === null, 'renders nothing when the route refuses')
  broken.runtime.unmount()

  client.dom.restore()
  console.log(`\nall checks passed (${passed})`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
