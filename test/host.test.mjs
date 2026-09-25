/**
 * Host-half test: mounts the plugin row over a fake Cordis context and drives the
 * route table with fake HTTP requests.
 *
 * It covers what the running deployment cannot easily show: the browser-session
 * admission branch, the local fallback fence, request-shape errors, Session
 * directory resolution, and a full create → info → remove round trip through the
 * HTTP surface.
 *
 * Everything runs against a throwaway repository; no real terminal, file manager,
 * or browser is ever launched.
 */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { apply, inject, name } from '../lib/plugin.js'

const run = promisify(execFile)
const SESSION = 'session-under-test'

let passed = 0
function assert(condition, label) {
  if (!condition) throw new Error(`FAILED: ${label}`)
  passed += 1
  console.log(`  ok  ${label}`)
}

/** A request stand-in: an async iterable body plus the fields the handler reads. */
function fakeRequest({ method = 'POST', path = 'info', headers = {}, body = '{}', host = '127.0.0.1:19387' } = {}) {
  const allHeaders = { host, 'content-type': 'application/json', ...headers }
  const chunks = body === null ? [] : [Buffer.from(body, 'utf8')]
  return {
    method,
    url: `/dsh-worktree/api/${path}`,
    headers: allHeaders,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** A response stand-in that records what the handler wrote. */
function fakeResponse() {
  const state = { status: 0, headers: null, body: '' }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers
    },
    end(text) {
      state.body = typeof text === 'string' ? text : ''
    },
    json() {
      return JSON.parse(state.body)
    },
  }
}

/**
 * Mount the plugin over a fake context.
 * @param {object} options - mount options.
 * @param {object | undefined} options.connection - the browser-session gate, when present.
 * @param {string | undefined} options.liveCwd - the Session header's directory.
 * @param {string | undefined} options.persistedCwd - the directory session persistence would answer.
 * @returns {{ route: object, scope: object }} the registered route and the inject scope handed to the plugin.
 */
function mount({ connection, liveCwd, persistedCwd } = {}) {
  let route = null
  const scope = { connection }
  const ctx = {
    logger: { debug() {}, warn() {}, info() {} },
    effect(fn) {
      return fn()
    },
    inject(deps, callback) {
      if (!deps.includes('connection')) return () => {}
      return callback(scope) ?? (() => {})
    },
    get(service) {
      if (service === 'connection') return connection
      if (service === 'sessionPersistence') {
        return persistedCwd === undefined ? undefined : {
          open: async () => ({ header: { cwd: persistedCwd }, close: async () => {} }),
        }
      }
      return undefined
    },
    sessions: {
      get: (id) => (id === SESSION && liveCwd !== undefined ? { header: { cwd: liveCwd } } : undefined),
    },
    webServer: {
      register(candidate) {
        route = candidate
        return () => {
          route = null
        }
      },
    },
  }
  apply(ctx, {})
  if (route === null) throw new Error('apply() registered no route')
  return { route, scope }
}

/** Drive one request through a mounted route. */
async function request(mounted, options) {
  const response = fakeResponse()
  await mounted.route.handler(fakeRequest(options), response)
  return response
}

/** A loopback request that the fallback fence accepts. */
const localRequest = { host: '127.0.0.1:19387' }

async function main() {
  const base = await mkdtemp(join(tmpdir(), 'dshwt-host-'))
  const repo = join(base, 'project')
  await mkdir(repo)
  await run('git', ['init', '-b', 'main'], { cwd: repo })
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  await run('git', ['config', 'user.name', 'Test'], { cwd: repo })
  await writeFile(join(repo, 'a.txt'), 'hello\n')
  await run('git', ['add', '.'], { cwd: repo })
  await run('git', ['commit', '-m', 'init'], { cwd: repo })

  try {
    assert(name === 'dsh-worktree-bar', 'exports the plugin name')
    assert(inject.includes('webServer') && inject.includes('sessions'), 'declares its required services')

    console.log('admission through the harness browser session')
    const admitted = mount({ connection: { admit: () => ({ peer: {} }) }, liveCwd: repo })
    const infoResponse = await request(admitted, { body: JSON.stringify({ sessionId: SESSION }) })
    assert(infoResponse.state.status === 200, 'admits the authenticated page')
    const info = infoResponse.json().value
    assert(info.admission === 'browser-session', `reports the harness gate (${info.admission})`)
    assert(info.plugin?.version === '0.1.0', 'reports its own identity')
    assert(info.isRepo === true && info.branch === 'main', 'reports the repository and branch')
    assert(info.repoName === 'project', 'reports the repository name')

    const unauthenticated = mount({ connection: { admit: () => ({ rejection: 401 }) }, liveCwd: repo })
    const refused = await request(unauthenticated, { body: JSON.stringify({ sessionId: SESSION }) })
    assert(refused.state.status === 401, 'refuses a trusted but unauthenticated request')
    assert(refused.json().error.code === 'unauthorized', 'names the refusal')

    const crossSite = mount({ connection: { admit: () => ({ rejection: 403 }) }, liveCwd: repo })
    assert((await request(crossSite, { body: '{}' })).state.status === 403, 'refuses a cross-site request')

    console.log('fallback fence without a browser surface')
    const noGate = mount({ liveCwd: repo })
    const local = await request(noGate, { body: JSON.stringify({ sessionId: SESSION }), ...localRequest })
    assert(local.state.status === 200, 'admits a loopback request')
    assert(local.json().value.admission === 'local-fence', 'reports the fallback fence')
    assert((await request(noGate, { body: '{}', host: 'evil.example.com' })).state.status === 403, 'refuses a foreign Host')
    assert((await request(noGate, { body: '{}', headers: { 'sec-fetch-site': 'cross-site' } })).state.status === 403, 'refuses a cross-site marker')
    assert((await request(noGate, { body: '{}', headers: { origin: 'http://evil.example.com' } })).state.status === 403, 'refuses a foreign Origin')
    assert((await request(noGate, { body: JSON.stringify({ sessionId: SESSION }), headers: { origin: 'http://127.0.0.1:19387' } })).state.status === 200, 'accepts a matching Origin')

    console.log('request shape')
    assert((await request(admitted, { method: 'GET', body: null })).state.status === 405, 'refuses a non-POST method')
    assert((await request(admitted, { path: 'nope', body: '{}' })).state.status === 404, 'refuses an unknown method')
    assert((await request(admitted, { body: '{oops' })).state.status === 400, 'refuses invalid JSON')
    assert((await request(admitted, { body: JSON.stringify({}) })).json().error.code === 'bad-request', 'requires a session id')
    assert((await request(admitted, { body: JSON.stringify({ sessionId: 42 }) })).state.status === 400, 'refuses a non-string session id')
    const huge = await request(admitted, { body: JSON.stringify({ sessionId: SESSION, pad: 'x'.repeat(70 * 1024) }) })
    assert(huge.state.status === 413, 'refuses an oversized body')
    assert((await request(admitted, { body: JSON.stringify({ sessionId: SESSION + '-missing' }) })).json().error.code === 'no-session-directory', 'reports an unresolvable Session directory')

    console.log('Session directory resolution')
    const persisted = mount({ liveCwd: undefined, persistedCwd: repo })
    const fromPersistence = await request(persisted, { body: JSON.stringify({ sessionId: SESSION }) })
    assert(fromPersistence.json().value.isRepo === true, 'falls back to session persistence')
    const fromClient = mount({ liveCwd: undefined })
    const clientSupplied = await request(fromClient, { body: JSON.stringify({ sessionId: SESSION, cwd: repo }) })
    assert(clientSupplied.json().value.isRepo === true, 'falls back to the Client-provided directory')

    console.log('worktree round trip through the route')
    const created = await request(admitted, { path: 'worktree.create', body: JSON.stringify({ sessionId: SESSION, name: 'route-box' }) })
    assert(created.state.status === 200, 'creates a worktree')
    const createdValue = created.json().value
    assert(createdValue.branch === 'worktree-route-box', `returns the branch (${createdValue.branch})`)
    assert(createdValue.path.startsWith(join(await realpath(repo), '.dsh', 'worktrees')), 'creates inside the configured root')

    const inWorktree = mount({ connection: { admit: () => ({ peer: {} }) }, liveCwd: createdValue.path })
    const worktreeInfo = (await request(inWorktree, { body: JSON.stringify({ sessionId: SESSION }) })).json().value
    assert(worktreeInfo.isPluginWorktree === true, 'reports the Session as being inside a managed worktree')
    assert(worktreeInfo.worktreeName === 'route-box', 'reports the worktree name')
    assert(worktreeInfo.repoRoot === info.repoRoot, 'keeps the main checkout as the repository root')

    const removed = await request(admitted, { path: 'worktree.remove', body: JSON.stringify({ sessionId: SESSION, path: createdValue.path, deleteBranch: true }) })
    assert(removed.state.status === 200, 'removes the worktree')
    assert(removed.json().value.branchDeleted === true, 'deletes its branch')
    const gone = await request(admitted, { path: 'worktree.remove', body: JSON.stringify({ sessionId: SESSION, path: createdValue.path }) })
    assert(gone.state.status === 400, 'refuses to remove an unknown worktree')
    const mainRefusal = await request(admitted, { path: 'worktree.remove', body: JSON.stringify({ sessionId: SESSION, path: repo }) })
    assert(mainRefusal.json().error.code === 'main-worktree', 'refuses to remove the main checkout')

    console.log('open.external validation')
    assert((await request(admitted, { path: 'open.external', body: JSON.stringify({ action: 'nope', path: repo }) })).state.status === 400, 'refuses an unknown action')
    assert((await request(admitted, { path: 'open.external', body: JSON.stringify({ action: 'url', url: 'file:///etc/passwd' }) })).state.status === 400, 'refuses a non-http URL')
    assert((await request(admitted, { path: 'open.external', body: JSON.stringify({ action: 'url' }) })).state.status === 400, 'requires the URL')

    console.log('repo route on a directory outside any repository')
    const outside = await mkdtemp(join(tmpdir(), 'dshwt-host-bare-'))
    const noRepo = mount({ connection: { admit: () => ({ peer: {} }) }, liveCwd: outside })
    const noRepoValue = (await request(noRepo, { body: JSON.stringify({ sessionId: SESSION }) })).json().value
    assert(noRepoValue.isRepo === false, 'answers isRepo false instead of failing')
    await rm(outside, { recursive: true, force: true })

    console.log(`\nall checks passed (${passed})`)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
