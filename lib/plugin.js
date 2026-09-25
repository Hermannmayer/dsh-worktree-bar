/**
 * dsh-worktree-bar — Host half.
 *
 * One fenced JSON route (`POST /dsh-worktree/api/<method>`) over the reusable Git
 * layer in [`git.js`](git.js):
 *
 * | Method | Purpose |
 * |---|---|
 * | `info` | Repository, branch, worktree and diff facts for one Session's directory. |
 * | `worktree.create` | Create a linked worktree on a fresh branch. |
 * | `worktree.remove` | Remove a linked worktree, optionally with its branch. |
 * | `open.external` | Reveal a path, open a terminal, or open a URL. |
 *
 * The Client half is a plain browser module and never runs git itself. Sessions
 * are addressed by id and their directory is resolved on the Host from the
 * Session store (which is the authority), so a Client can never point this API
 * at an arbitrary directory through a request body. Requests are admitted
 * through the harness's own browser session (`ctx.connection.admit`), the same
 * gate the `/api` bridge uses; see {@link admitRequest}.
 *
 * Design notes for reuse and cost:
 * - No runtime dependency: only Node built-ins and this bundle's own files.
 * - Every git call is an argument array (no shell) with a timeout and a bounded
 *   buffer, so a slow repository degrades into an error instead of a stall, and
 *   a huge `git diff` cannot grow Host memory without limit.
 * - Nothing is watched and nothing is cached: a request costs the git commands
 *   it names and nothing while idle.
 */

import { execFile, spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { createWorktree, GitError, removeWorktree, repoInfo } from './git.js'

/** Plugin identity, as the Loader row names it. */
export const name = 'dsh-worktree-bar'

/** The services this row needs before it may mount. */
export const inject = ['webServer', 'sessions']

/**
 * Route prefix owned by this plugin. One owner per prefix, so it is namespaced.
 *
 * It keeps the original spelling on purpose: the package was renamed, but this
 * path is the Client's and the Host's shared contract, and a path is not worth
 * breaking a running deployment's row over. The Client half is served fresh on
 * every page load while the Host module lives until the process restarts, so
 * renaming the prefix would leave the two halves disagreeing in between.
 */
const ROUTE_PREFIX = '/dsh-worktree/api'

/** Reported by `info`, so a running deployment's version and lane are observable. */
const PLUGIN_IDENTITY = { name: 'dsh-worktree-bar', version: '0.1.0' }

/** Largest accepted JSON request body. Every method's payload is a few short strings. */
const MAX_BODY_BYTES = 64 * 1024

/** How long to wait for a not-yet-attached Session before falling back. */
const SESSION_ATTACH_ATTEMPTS = 3

/** Delay between Session attach attempts, in milliseconds. */
const SESSION_ATTACH_DELAY_MS = 120

/**
 * One expected request failure with a stable code, mirroring `GitError` so the
 * Client can branch on `code` instead of matching a message.
 */
class RequestError extends Error {
  /**
   * @param {string} code - stable machine code.
   * @param {string} message - human-readable text, safe to show.
   * @param {number} [status] - HTTP status; defaults to 400.
   */
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'RequestError'
    this.code = code
    this.status = status
  }
}

/** Resolve one config value, keeping `undefined` when the row omits it. */
function optionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Normalize the row's raw `config` object.
 *
 * The row declares no schema, so unknown keys are ignored and every key is
 * optional: the defaults below are the documented behavior.
 * @param {unknown} config - the Loader row's config.
 * @returns {{ worktreeDir: string | undefined, branchPrefix: string | undefined, baseRef: string | undefined, excludeFromGit: boolean, conventionFile: string | undefined, pollMs: number | undefined }} resolved options.
 */
function optionsOf(config) {
  const record = config !== null && typeof config === 'object' ? config : {}
  const pollMs = typeof record.pollMs === 'number' && Number.isFinite(record.pollMs) && record.pollMs >= 0
    ? record.pollMs
    : undefined
  return {
    worktreeDir: optionalString(record.worktreeDir),
    branchPrefix: optionalString(record.branchPrefix),
    baseRef: optionalString(record.baseRef),
    excludeFromGit: record.excludeFromGit !== false,
    conventionFile: optionalString(record.conventionFile),
    pollMs,
  }
}

/** Await one delay. */
function delay(ms) {
  return new Promise(resolveDelay => {
    setTimeout(resolveDelay, ms)
  })
}

/**
 * Read and parse a bounded JSON body.
 * @param {import('node:http').IncomingMessage} request - the HTTP request.
 * @returns {Promise<Record<string, unknown>>} the parsed object (empty for a bodyless request).
 */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new RequestError('body-too-large', 'request body is too large', 413)
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  let text
  try {
    text = Buffer.concat(chunks).toString('utf8')
  } catch {
    throw new RequestError('bad-json', 'request body is not valid UTF-8')
  }
  if (text.trim() === '') return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new RequestError('bad-json', 'request body is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RequestError('bad-json', 'request body must be a JSON object')
  }
  return parsed
}

/**
 * One required string field.
 * @param {Record<string, unknown>} payload - parsed body.
 * @param {string} field - field name.
 * @returns {string} the trimmed non-empty value.
 */
function requireString(payload, field) {
  const value = payload[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RequestError('bad-request', `"${field}" is required`)
  }
  return value
}

/** Write one JSON response. */
function writeJson(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

/**
 * Local fallback fence for compositions with no browser session at all.
 *
 * It mirrors the harness's `src/api-request-trust.ts`: the Host header must name
 * a loopback authority (or one this deployment trusts), an attached Origin must
 * match it, and a cross-site marker refuses. It is a DNS-rebinding and
 * cross-site defense, never authentication — which is why the primary path is
 * {@link admitRequest}'s call into the harness's own admission.
 *
 * @param {import('node:http').IncomingMessage} request - the HTTP request.
 * @param {readonly string[]} trustedHosts - extra authorities this deployment serves.
 * @returns {boolean} whether the request passes the local fence.
 */
function isTrustedRequest(request, trustedHosts) {
  const hostHeader = request.headers.host
  if (typeof hostHeader !== 'string' || hostHeader === '') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${hostHeader}`)
  } catch {
    return false
  }
  const hostname = hostUrl.hostname
  const loopback = hostname === 'localhost'
    || hostname === '[::1]'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  if (!loopback && !trustedHosts.includes(hostUrl.host) && !trustedHosts.includes(hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (typeof origin !== 'string') return true
  try {
    return new URL(origin).hostname === hostname
  } catch {
    return false
  }
}

/**
 * Admit one request, the way the harness's own `/api` bridge does.
 *
 * `ctx.connection.admit()` applies the Host/Origin fence and then the browser
 * session check, so this route answers only the authenticated GUI page: a
 * trusted-but-unauthenticated request is refused with 401 and a cross-site one
 * with 403. No plugin route may invent a weaker tier than that, which is why the
 * local fence above is only the fallback for a composition that has no browser
 * surface (and therefore no session to require).
 *
 * The service is captured through `ctx.inject` rather than read per request:
 * the browser surface may mount after this row, and `ctx.get` would then answer
 * `undefined` forever.
 *
 * @param {{ current: object | undefined }} admission - the live connection holder.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 * @param {import('node:http').IncomingMessage} request - the HTTP request.
 * @returns {number} 0 when admitted, otherwise the rejection status.
 */
function admitRequest(admission, ctx, request) {
  const connection = admission.current
  if (connection !== undefined && typeof connection.admit === 'function') {
    const outcome = connection.admit(request)
    if (outcome !== null && typeof outcome === 'object' && typeof outcome.rejection === 'number') {
      return outcome.rejection
    }
    return 0
  }
  const trustedHosts = ctx.get('webRuntime')?.trustedHosts ?? []
  return isTrustedRequest(request, trustedHosts) ? 0 : 403
}

/**
 * The authoritative working directory of one Session.
 *
 * The live Session header wins; a Session the web page has not attached yet is
 * read from session persistence; the caller's own list-summary directory is the
 * last resort before failing, so a request never silently operates on the Host
 * process cwd.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 * @param {string} sessionId - the requesting Session.
 * @param {unknown} clientCwd - the Client's own view of the directory, when it has one.
 * @returns {Promise<string>} an absolute directory.
 */
async function sessionCwd(ctx, sessionId, clientCwd) {
  for (let attempt = 0; attempt < SESSION_ATTACH_ATTEMPTS; attempt += 1) {
    const live = ctx.sessions.get(sessionId)
    const cwd = live?.header?.cwd
    if (typeof cwd === 'string' && cwd !== '' && isAbsolute(cwd)) return cwd
    await delay(SESSION_ATTACH_DELAY_MS)
  }
  const persistence = ctx.get('sessionPersistence')
  if (persistence !== undefined) {
    try {
      const handle = await persistence.open(sessionId, 'read')
      try {
        const cwd = handle.header?.cwd
        if (typeof cwd === 'string' && cwd !== '' && isAbsolute(cwd)) return cwd
      } finally {
        await handle.close()
      }
    } catch {
      // A Session that was never persisted falls through to the Client's view.
    }
  }
  if (typeof clientCwd === 'string' && clientCwd !== '' && isAbsolute(clientCwd)) return clientCwd
  throw new RequestError('no-session-directory', `cannot resolve the working directory of session "${sessionId}"`)
}

/**
 * Launch a detached OS process, ignoring its output.
 * @param {string} file - executable.
 * @param {readonly string[]} args - arguments (no shell interpolation).
 * @returns {Promise<void>} resolves once the process is spawned or its failure is known.
 */
function launchDetached(file, args) {
  return new Promise((resolveLaunch, rejectLaunch) => {
    let settled = false
    const child = spawn(file, [...args], { detached: true, stdio: 'ignore', windowsHide: false })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      rejectLaunch(new RequestError('launch-failed', error.message))
    })
    child.once('spawn', () => {
      if (settled) return
      settled = true
      child.unref()
      resolveLaunch()
    })
  })
}

/** Whether an executable is on PATH (best effort, no shell). */
function hasExecutable(file) {
  return new Promise(resolveProbe => {
    execFile(process.platform === 'win32' ? 'where' : 'which', [file], { windowsHide: true }, error => {
      resolveProbe(error === null || error === undefined)
    })
  })
}

/**
 * Open a directory in the OS file manager.
 * @param {string} path - directory to reveal.
 * @returns {Promise<void>} resolves once the launcher was started.
 */
function revealPath(path) {
  if (process.platform === 'win32') return launchDetached('explorer.exe', [path])
  if (process.platform === 'darwin') return launchDetached('open', [path])
  return launchDetached('xdg-open', [path])
}

/**
 * Open an interactive shell in a directory.
 * @param {string} path - the shell's working directory.
 * @returns {Promise<void>} resolves once the terminal was started.
 */
async function openTerminal(path) {
  if (process.platform === 'win32') {
    if (await hasExecutable('wt.exe')) {
      await launchDetached('wt.exe', ['-d', path])
      return
    }
    const comspec = process.env.ComSpec ?? 'cmd.exe'
    // `start "" /D <dir> cmd.exe` is the only form where `start` treats the
    // quoted path as a directory instead of a window title.
    await launchDetached(comspec, ['/c', 'start', '', '/D', path, 'cmd.exe'])
    return
  }
  if (process.platform === 'darwin') {
    await launchDetached('open', ['-a', 'Terminal', path])
    return
  }
  await launchDetached('xdg-open', [path])
}

/**
 * Open an HTTP(S) URL in the user's browser.
 * @param {string} url - the URL to open.
 * @returns {Promise<void>} resolves once the launcher was started.
 */
function openUrl(url) {
  if (process.platform === 'win32') {
    return launchDetached(process.env.ComSpec ?? 'cmd.exe', ['/c', 'start', '', url])
  }
  if (process.platform === 'darwin') return launchDetached('open', [url])
  return launchDetached('xdg-open', [url])
}

/**
 * Map one thrown value onto the wire error body.
 * @param {unknown} error - the thrown value.
 * @returns {{ status: number, body: { ok: false, error: { code: string, message: string } } }} the response.
 */
function failureOf(error) {
  if (error instanceof RequestError) {
    return { status: error.status, body: { ok: false, error: { code: error.code, message: error.message } } }
  }
  if (error instanceof GitError) {
    const status = error.code === 'not-a-repository' || error.code === 'git-missing' ? 409 : 400
    return { status, body: { ok: false, error: { code: error.code, message: error.message } } }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { status: 500, body: { ok: false, error: { code: 'internal', message } } }
}

/**
 * Plugin body: register the one fenced route table.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context (webServer, sessions).
 * @param {unknown} config - this row's config; see {@link optionsOf}.
 * @returns {void}
 */
export function apply(ctx, config) {
  const options = optionsOf(config)

  /**
   * The live browser-session gate, once the browser surface has mounted. Read
   * through this holder so `info` can report which admission is in force and
   * requests never depend on mount order.
   */
  const admission = { current: ctx.get('connection') }
  ctx.effect(() => ctx.inject(['connection'], (scope) => {
    admission.current = scope.connection
    return () => {
      admission.current = undefined
    }
  }), 'dsh-worktree-bar: browser-session admission')

  /** Which admission decides requests: the harness gate, or the local fence. */
  const admissionMode = () => (admission.current === undefined ? 'local-fence' : 'browser-session')

  /** @type {Record<string, (payload: Record<string, unknown>) => Promise<unknown>>} */
  const methods = {
    /** Repository context of one Session's directory. */
    info: async (payload) => {
      const sessionId = requireString(payload, 'sessionId')
      const cwd = await sessionCwd(ctx, sessionId, payload.cwd)
      return { sessionId, plugin: PLUGIN_IDENTITY, admission: admissionMode(), options, ...(await repoInfo(cwd, options)) }
    },

    /** Create a linked worktree for the repository the Session works in. */
    'worktree.create': async (payload) => {
      const sessionId = requireString(payload, 'sessionId')
      const cwd = await sessionCwd(ctx, sessionId, payload.cwd)
      const created = await createWorktree({
        cwd,
        name: optionalString(payload.name),
        worktreeDir: options.worktreeDir,
        branchPrefix: options.branchPrefix,
        baseRef: options.baseRef,
        excludeFromGit: options.excludeFromGit,
        conventionFile: options.conventionFile,
        seed: payload.seed !== false,
      })
      return { sessionId, ...created }
    },

    /** Remove one linked worktree of the repository the Session works in. */
    'worktree.remove': async (payload) => {
      const sessionId = requireString(payload, 'sessionId')
      const cwd = await sessionCwd(ctx, sessionId, payload.cwd)
      const removed = await removeWorktree({
        cwd,
        path: requireString(payload, 'path'),
        force: payload.force === true,
        deleteBranch: payload.deleteBranch === true,
      })
      return { sessionId, ...removed }
    },

    /** Hand a path or URL to the operating system. */
    'open.external': async (payload) => {
      const action = requireString(payload, 'action')
      if (action === 'reveal') {
        await revealPath(requireString(payload, 'path'))
        return { ok: true }
      }
      if (action === 'terminal') {
        await openTerminal(requireString(payload, 'path'))
        return { ok: true }
      }
      if (action === 'url') {
        const url = requireString(payload, 'url')
        if (!/^https?:\/\//i.test(url)) throw new RequestError('bad-url', 'only http(s) URLs can be opened')
        await openUrl(url)
        return { ok: true }
      }
      throw new RequestError('bad-request', `unknown action "${action}"`)
    },
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        writeJson(response, 405, { ok: false, error: { code: 'method-not-allowed', message: 'POST only' } })
        return
      }
      const rejection = admitRequest(admission, ctx, request)
      if (rejection !== 0) {
        writeJson(response, rejection, {
          ok: false,
          error: {
            code: rejection === 401 ? 'unauthorized' : 'forbidden',
            message: rejection === 401
              ? 'this page has no browser session for the Host'
              : 'forbidden',
          },
        })
        return
      }
      const pathname = new URL(request.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith(`${ROUTE_PREFIX}/`) ? pathname.slice(ROUTE_PREFIX.length + 1) : ''
      const handler = method === '' || method.includes('/') ? undefined : methods[method]
      if (handler === undefined) {
        writeJson(response, 404, { ok: false, error: { code: 'not-found', message: `unknown worktree API method "${method}"` } })
        return
      }
      try {
        const payload = await readJsonBody(request)
        writeJson(response, 200, { ok: true, value: await handler(payload) })
      } catch (error) {
        ctx.logger?.debug?.(error)
        const failure = failureOf(error)
        writeJson(response, failure.status, failure.body)
      }
    },
  }), 'dsh-worktree-bar: /dsh-worktree/api routes')
}
