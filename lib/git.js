/**
 * Reusable, context-free Git layer for the dsh-worktree bundle.
 *
 * Nothing in this module knows about Cordis, the Harness, sessions, or HTTP: it
 * takes plain paths and returns plain JSON. The Host row (`../index.js`) wraps it
 * with routes, and another plugin may import it directly:
 *
 * ```js
 * import { repoInfo, createWorktree } from 'dsh-worktree/git'
 * ```
 *
 * Every command runs through `execFile` with an argument array (never a shell),
 * a hard timeout, and a bounded output buffer, so a hung or noisy git cannot
 * stall the Host process or grow memory without limit.
 *
 * Disk behavior: a linked worktree shares the repository's object database
 * (`.git`), so it costs one working-tree checkout and no duplicated history.
 *
 * A project decides for itself which untracked setup its worktrees need, through
 * a convention file read from the main checkout's root (`dsh-worktree.json` by
 * default). The plugin hardcodes no project's layout: `link` connects shared
 * directories, `copy` duplicates them, and `setup` runs the project's own
 * command. See {@link readWorktreeConvention}.
 */

import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { appendFile, cp, link, lstat, mkdir, readFile, readdir, rm, rmdir, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Default command timeout. Long enough for a large `git diff`, short enough to fail visibly. */
const GIT_TIMEOUT_MS = 20_000

/** Output cap (8 MiB) for one git invocation. */
const GIT_MAX_BUFFER = 8 * 1024 * 1024

/** Worktree directory, relative to the repository root, used when a caller passes none. */
export const DEFAULT_WORKTREE_DIR = '.dsh/worktrees'

/** Branch prefix for created worktrees. */
export const DEFAULT_BRANCH_PREFIX = 'worktree-'

/**
 * One expected Git failure with a stable code, so callers can branch on it
 * without matching messages.
 */
export class GitError extends Error {
  /**
   * @param {string} code - stable machine code (`git-missing`, `not-a-repository`, `git-failed`, …).
   * @param {string} message - human-readable, already safe to show in the UI.
   * @param {{ detail?: string }} [extra] - optional raw git stderr for diagnostics.
   */
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'GitError'
    this.code = code
    if (extra.detail !== undefined) this.detail = extra.detail
  }
}

/**
 * Run one git command.
 * @param {string} cwd - directory the command runs in.
 * @param {readonly string[]} args - arguments, passed verbatim (no shell).
 * @returns {Promise<string>} stdout.
 * @throws {GitError} `git-missing` when git is not installed, `git-failed` otherwise.
 */
export async function runGit(cwd, args) {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
      // `GIT_OPTIONAL_LOCKS=0` keeps a read-only status/diff from taking the
      // index lock, so the bar never blocks the user's own git commands.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    })
    return stdout
  } catch (error) {
    const code = error?.code
    if (code === 'ENOENT') {
      throw new GitError('git-missing', 'git is not installed or not on PATH')
    }
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
    const message = stderr !== '' ? stderr : (error instanceof Error ? error.message : String(error))
    throw new GitError('git-failed', message, { detail: `git ${args.join(' ')}` })
  }
}

/**
 * Canonical comparison form of a path: real path where it exists, resolved
 * otherwise, case-folded on Windows.
 *
 * `resolve()` alone is not enough on Windows: a short-named path
 * (`C:\\PROGRA~1\\…`) and the long name git reports are the same directory, and
 * only a real-path lookup makes them compare equal. The lookup also folds symlinks, which is the same identity rule the Harness workspace
 * registry uses. Results are memoized because a single request compares the
 * same handful of paths many times.
 */
const canonicalCache = new Map()

function canonical(path) {
  if (typeof path !== 'string' || path === '') return ''
  const key = `${process.platform === 'win32' ? 'w' : 'p'}:${path}`
  const cached = canonicalCache.get(key)
  if (cached !== undefined) return cached
  let value
  try {
    value = realpathSync.native(path)
  } catch {
    value = resolve(path)
  }
  value = value.replace(/[\\/]+$/, '')
  if (process.platform === 'win32') value = value.toLowerCase()
  if (canonicalCache.size > 4096) canonicalCache.clear()
  canonicalCache.set(key, value)
  return value
}

/** Whether `child` is `parent` itself or sits below it. */
export function isInside(parent, child) {
  const p = canonical(parent)
  const c = canonical(child)
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/** Git prints native paths with forward slashes; normalize before comparing or returning. */
function normalizeGitPath(value) {
  return resolve(value)
}

/** Short display name of a worktree: its directory's base name. */
function worktreeName(path) {
  return basename(path) || path
}

/**
 * The repository that contains `cwd`.
 * @param {string} cwd - an existing directory.
 * @returns {Promise<{ root: string, gitDir: string, commonDir: string }>} absolute, normalized paths.
 * @throws {GitError} `not-a-repository` when no repository contains the directory.
 */
export async function resolveRepo(cwd) {
  let root
  try {
    root = (await runGit(cwd, ['rev-parse', '--show-toplevel'])).trim()
  } catch (error) {
    if (error instanceof GitError && error.code === 'git-missing') throw error
    throw new GitError('not-a-repository', `"${cwd}" is not inside a git repository`)
  }
  if (root === '') throw new GitError('not-a-repository', `"${cwd}" is not inside a git repository`)
  const [gitDir, commonDir] = await Promise.all([
    runGit(root, ['rev-parse', '--absolute-git-dir']).then(value => value.trim()),
    runGit(root, ['rev-parse', '--git-common-dir']).then(value => value.trim()),
  ])
  return {
    root: normalizeGitPath(root),
    gitDir: normalizeGitPath(gitDir),
    commonDir: normalizeGitPath(isAbsolute(commonDir) ? commonDir : join(root, commonDir)),
  }
}

/**
 * Every linked checkout of a repository, current checkout first.
 * @param {string} cwd - any directory inside the repository.
 * @returns {Promise<Array<{ path: string, name: string, head: string | null, branch: string | null, detached: boolean, bare: boolean, prunable: boolean, locked: boolean }>>}
 */
export async function listWorktrees(cwd) {
  const raw = await runGit(cwd, ['worktree', 'list', '--porcelain'])
  const records = []
  let current = null
  const flush = () => {
    if (current !== null) records.push(current)
    current = null
  }
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush()
      current = {
        path: normalizeGitPath(line.slice('worktree '.length).trim()),
        head: null,
        branch: null,
        detached: false,
        bare: false,
        prunable: false,
        locked: false,
      }
      continue
    }
    if (current === null) continue
    if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length).trim()
    else if (line.startsWith('branch ')) current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
    else if (line === 'detached') current.detached = true
    else if (line === 'bare') current.bare = true
    else if (line.startsWith('prunable')) current.prunable = true
    else if (line.startsWith('locked')) current.locked = true
  }
  flush()
  return records.map(record => ({ ...record, name: worktreeName(record.path) }))
}

/**
 * Parse `git diff HEAD --numstat` into line totals.
 * @param {string} raw - numstat output.
 * @returns {{ added: number, removed: number, files: number }} binary rows count as files but zero lines.
 */
export function parseNumstat(raw) {
  let added = 0
  let removed = 0
  let files = 0
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    const [add, remove] = line.split('\t')
    if (add === undefined || remove === undefined) continue
    files += 1
    // A binary file reports "-" in both columns.
    if (add !== '-') added += Number(add) || 0
    if (remove !== '-') removed += Number(remove) || 0
  }
  return { added, removed, files }
}

/**
 * Normalize a git remote URL into a browsable HTTPS URL.
 * @param {string | null} remoteUrl - an `origin` URL in any common spelling.
 * @returns {string | null} `https://host/owner/repo` without a trailing `.git`, or null.
 */
export function remoteWebUrl(remoteUrl) {
  if (typeof remoteUrl !== 'string' || remoteUrl.trim() === '') return null
  const value = remoteUrl.trim()
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/)(.+)$/.exec(value)
  let host
  let pathPart
  if (scp !== null) {
    host = scp[1]
    pathPart = scp[2]
  } else {
    try {
      const url = new URL(value)
      if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'ssh:' && url.protocol !== 'git:') return null
      host = url.hostname
      pathPart = url.pathname
    } catch {
      return null
    }
  }
  const clean = pathPart.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '')
  if (clean === '' || !clean.includes('/')) return null
  return `https://${host}/${clean}`
}

/** The default branch a change request would target, best effort. */
async function defaultBase(root) {
  try {
    const head = (await runGit(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim()
    const name = head.replace(/^[^/]+\//, '')
    if (name !== '') return name
  } catch {
    // No remote HEAD: fall through to local branch probing.
  }
  for (const candidate of ['main', 'master']) {
    try {
      await runGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`])
      return candidate
    } catch {
      continue
    }
  }
  return null
}

/**
 * Where created worktrees live for one repository.
 * @param {string} repoRoot - the MAIN checkout's root (not a linked worktree's).
 * @param {string | undefined} worktreeDir - configured directory; relative paths resolve against the root.
 * @returns {string} absolute directory.
 */
export function worktreeRootOf(repoRoot, worktreeDir) {
  const configured = typeof worktreeDir === 'string' && worktreeDir.trim() !== '' ? worktreeDir.trim() : DEFAULT_WORKTREE_DIR
  return isAbsolute(configured) ? resolve(configured) : resolve(repoRoot, configured)
}

/**
 * The checkout that actually contains a directory.
 *
 * Worktrees nest inside one another's parent directories (a linked worktree at
 * `<repo>/.dsh/worktrees/<name>` is inside the main checkout too), so the match
 * with the LONGEST path wins rather than the first one listed.
 *
 * @param {Array<{ path: string }>} worktrees - the listed checkouts.
 * @param {string} path - the directory to place.
 * @returns {{ path: string } | null} the innermost containing checkout, or null.
 */
export function deepestContaining(worktrees, path) {
  let match = null
  for (const entry of worktrees) {
    if (!isInside(entry.path, path)) continue
    if (match === null || canonical(entry.path).length > canonical(match.path).length) match = entry
  }
  return match
}

/**
 * The main checkout of a repository.
 *
 * `git rev-parse --show-toplevel` answers with the checkout a directory sits in,
 * which inside a linked worktree is that worktree — not the repository the user
 * thinks of. `git worktree list` guarantees the main worktree is listed first,
 * so that record is the layout anchor for every path this module derives.
 *
 * @param {Array<{ path: string }>} worktrees - the listed checkouts.
 * @param {string} fallback - the resolved checkout root, used when the list is empty.
 * @returns {string} the main checkout's absolute path.
 */
export function mainRootOf(worktrees, fallback) {
  return worktrees.length > 0 ? worktrees[0].path : fallback
}

/**
 * The complete Git state of one session directory, as the Client bar needs it.
 *
 * `repoRoot` is always the MAIN checkout (so "copy repository path" means the
 * repository), while `cwd` and `checkoutRoot` name the session's own working
 * tree.
 *
 * @param {string} cwd - the session's working directory.
 * @param {{ worktreeDir?: string }} [options] - layout options; must match the creation options.
 * @returns {Promise<object>} a plain JSON snapshot; `isRepo: false` when `cwd` is outside a repository.
 */
export async function repoInfo(cwd, options = {}) {
  let directoryExists = true
  try {
    const info = await stat(cwd)
    directoryExists = info.isDirectory()
  } catch {
    directoryExists = false
  }
  if (!directoryExists) {
    return { isRepo: false, cwd, reason: 'missing-directory' }
  }

  let repo
  try {
    repo = await resolveRepo(cwd)
  } catch (error) {
    if (error instanceof GitError && error.code === 'git-missing') throw error
    return { isRepo: false, cwd, reason: 'not-a-repository' }
  }

  const worktrees = await listWorktrees(cwd).catch(() => [])
  const repoRoot = mainRootOf(worktrees, repo.root)
  const checkout = deepestContaining(worktrees, cwd)
  const checkoutRoot = checkout?.path ?? repo.root
  const worktreeRoot = worktreeRootOf(repoRoot, options.worktreeDir)
  const isLinked = canonical(repo.gitDir) !== canonical(repo.commonDir)
  const managed = isLinked && isInside(worktreeRoot, checkoutRoot)

  const [branchRef, head, remoteUrl, numstat, status] = await Promise.all([
    runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).then(value => value.trim()).catch(() => ''),
    runGit(cwd, ['rev-parse', '--short', 'HEAD']).then(value => value.trim()).catch(() => ''),
    runGit(cwd, ['remote', 'get-url', 'origin']).then(value => value.trim()).catch(() => ''),
    runGit(cwd, ['diff', 'HEAD', '--numstat']).catch(() => ''),
    runGit(cwd, ['status', '--porcelain', '--untracked-files=normal']).catch(() => ''),
  ])

  const detached = branchRef === '' || branchRef === 'HEAD'
  const stats = parseNumstat(numstat)
  let untracked = 0
  let changed = 0
  for (const line of status.split('\n')) {
    if (line.trim() === '') continue
    changed += 1
    if (line.startsWith('??')) untracked += 1
  }

  const webUrl = remoteWebUrl(remoteUrl)
  const base = webUrl === null ? null : await defaultBase(repoRoot)

  return {
    isRepo: true,
    cwd,
    repoRoot,
    repoName: basename(repoRoot) || repoRoot,
    checkoutRoot,
    branch: detached ? null : branchRef,
    head: head === '' ? null : head,
    detached,
    isWorktree: isLinked,
    isPluginWorktree: managed,
    worktreeName: managed ? basename(checkoutRoot) : null,
    worktreeRoot,
    worktreeRootOutsideRepo: !isInside(repoRoot, worktreeRoot),
    remoteUrl: remoteUrl === '' ? null : remoteUrl,
    webUrl,
    defaultBase: base,
    compareUrl: webUrl !== null && base !== null && !detached
      ? `${webUrl}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branchRef)}?expand=1`
      : null,
    stats,
    changedFiles: changed,
    untrackedFiles: untracked,
    // What a new worktree of this repository would be prepared with, so the UI
    // can say it before creating one instead of surprising the user afterwards.
    convention: await readWorktreeConvention(repoRoot, { file: options.conventionFile })
      .then(convention => ({
        source: convention.source,
        file: basename(convention.source),
        link: convention.link,
        linkIgnored: convention.linkIgnored,
        copy: convention.copy,
        setup: convention.setup,
      }))
      .catch(error => ({ source: null, file: options.conventionFile ?? CONVENTION_FILE, link: [], copy: [], setup: null, error: error instanceof Error ? error.message : String(error) })),
    worktrees: worktrees.map(entry => ({
      path: entry.path,
      name: entry.name,
      branch: entry.branch,
      head: entry.head,
      detached: entry.detached,
      bare: entry.bare,
      locked: entry.locked,
      current: canonical(entry.path) === canonical(checkoutRoot),
      main: canonical(entry.path) === canonical(repoRoot),
      managed: isInside(worktreeRoot, entry.path),
    })),
  }
}

/** Short, readable, collision-resistant worktree names (`calm-otter-4f2a`). */
const NAME_ADJECTIVES = [
  'calm', 'bright', 'swift', 'quiet', 'clever', 'bold', 'gentle', 'eager',
  'steady', 'vivid', 'kind', 'sharp', 'warm', 'nimble', 'sunny', 'brave',
]
const NAME_NOUNS = [
  'otter', 'harbor', 'falcon', 'willow', 'cobalt', 'ember', 'meadow', 'comet',
  'lantern', 'cedar', 'orbit', 'pebble', 'thistle', 'anchor', 'quartz', 'sparrow',
]

/**
 * Generate a worktree name that is not already used by a branch or directory.
 * @param {{ takenNames?: readonly string[] }} [options] - names to avoid.
 * @returns {string} a name like `calm-otter-4f2a`.
 */
export function generateWorktreeName(options = {}) {
  const taken = new Set((options.takenNames ?? []).map(name => name.toLowerCase()))
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const adjective = NAME_ADJECTIVES[Math.floor(Math.random() * NAME_ADJECTIVES.length)]
    const noun = NAME_NOUNS[Math.floor(Math.random() * NAME_NOUNS.length)]
    const suffix = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')
    const name = `${adjective}-${noun}-${suffix}`
    if (!taken.has(name.toLowerCase())) return name
  }
  return `worktree-${Date.now().toString(36)}`
}

/**
 * Register the worktree directory in the repository's local exclude file, so the
 * main checkout does not report every created worktree as untracked. The file
 * lives in `.git/info/exclude` and is never committed, so this changes no
 * tracked file.
 *
 * @param {{ root: string, gitDir: string, commonDir: string }} layout - resolved repository paths.
 * @param {string} repoRoot - the repository root.
 * @param {string} worktreeRoot - the created worktrees' parent directory.
 * @returns {Promise<boolean>} whether a new line was written.
 */
export async function excludeWorktreeRoot(layout, repoRoot, worktreeRoot) {
  const pattern = isInside(repoRoot, worktreeRoot)
    ? `${relative(repoRoot, worktreeRoot).split(sep).join('/')}/`
    : worktreeRoot.split(sep).join('/') + '/'
  const file = join(layout.commonDir, 'info', 'exclude')
  let current = ''
  try {
    current = await readFile(file, 'utf8')
  } catch {
    current = ''
  }
  const present = current.split('\n').some(line => line.trim() === pattern)
  if (present) return false
  await mkdir(dirname(file), { recursive: true })
  const prefix = current === '' || current.endsWith('\n') ? '' : '\n'
  await appendFile(file, `${prefix}# dsh-worktree\n${pattern}\n`, 'utf8')
  return true
}

/**
 * @typedef {object} WorktreeConvention
 * @property {string} source - the file this convention was read from (absolute).
 * @property {string[]} link - paths connected to the main checkout with a directory link.
 * @property {string[]} linkIgnored - directories whose gitignored entries are connected one by one.
 * @property {string[]} copy - paths copied from the main checkout into the worktree.
 * @property {string | null} setup - command the project runs inside a fresh worktree.
 * @property {number} setupTimeoutMs - maximum duration of that command.
 */

/** Convention file name, relative to the main checkout's root. */
export const CONVENTION_FILE = 'dsh-worktree.json'

/** Default time budget for a project's own setup command. */
const DEFAULT_SETUP_TIMEOUT_MS = 15 * 60 * 1000

/** Only these keys are accepted, so a typo is reported instead of ignored. */
const CONVENTION_KEYS = new Set(['link', 'linkIgnored', 'copy', 'setup', 'setupTimeoutMs'])

/**
 * Read a project's worktree convention.
 *
 * The plugin ships no notion of any project's layout. A repository that needs
 * untracked setup inside its worktrees — a virtualenv, a database directory, a
 * build cache — declares it in its own convention file, so the same plugin
 * serves a Python project, a Node project, and a repository that needs nothing.
 * A repository without the file gets plain `git worktree` behavior and no
 * surprise writes.
 *
 * ```json
 * {
 *   "link": [".venv", "database"],
 *   "linkIgnored": ["data"],
 *   "copy": ["config/secrets.json"],
 *   "setup": "uv sync --dev"
 * }
 * ```
 *
 * `link` connects one path. `linkIgnored` connects every gitignored entry inside
 * a directory that mixes tracked and untracked content — a `data/` holding both
 * committed fixtures and a local cache — so the tracked files still come from
 * git while the local ones stay shared.
 *
 * @param {string} repoRoot - the MAIN checkout's root.
 * @param {{ file?: string }} [options] - override the convention file name.
 * @returns {Promise<WorktreeConvention>} the parsed convention, or an empty one.
 * @throws {GitError} `bad-convention` when the file exists but cannot be used.
 */
export async function readWorktreeConvention(repoRoot, options = {}) {
  const name = typeof options.file === 'string' && options.file.trim() !== '' ? options.file.trim() : CONVENTION_FILE
  const source = resolve(repoRoot, name)
  let text
  try {
    text = await readFile(source, 'utf8')
  } catch {
    // No convention file is the common case, not a failure.
    return { source, link: [], linkIgnored: [], copy: [], setup: null, setupTimeoutMs: DEFAULT_SETUP_TIMEOUT_MS }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new GitError('bad-convention', `${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GitError('bad-convention', `${name} must contain a JSON object`)
  }
  for (const key of Object.keys(parsed)) {
    if (!CONVENTION_KEYS.has(key)) {
      throw new GitError('bad-convention', `${name} has an unknown key "${key}" (accepted: ${[...CONVENTION_KEYS].join(', ')})`)
    }
  }
  const paths = (key) => {
    const value = parsed[key]
    if (value === undefined) return []
    if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || entry.trim() === '')) {
      throw new GitError('bad-convention', `${name}: "${key}" must be an array of non-empty relative paths`)
    }
    return value.map(entry => entry.trim())
  }
  const setup = parsed.setup === undefined ? null : parsed.setup
  if (setup !== null && (typeof setup !== 'string' || setup.trim() === '')) {
    throw new GitError('bad-convention', `${name}: "setup" must be a non-empty command string`)
  }
  const timeout = parsed.setupTimeoutMs === undefined ? DEFAULT_SETUP_TIMEOUT_MS : parsed.setupTimeoutMs
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
    throw new GitError('bad-convention', `${name}: "setupTimeoutMs" must be a positive number`)
  }
  return { source, link: paths('link'), linkIgnored: paths('linkIgnored'), copy: paths('copy'), setup: setup === null ? null : setup.trim(), setupTimeoutMs: timeout }
}

/** Reject anything that could escape the checkout a convention entry applies to. */
function assertContainedPath(entry) {
  if (isAbsolute(entry) || /^[A-Za-z]:/.test(entry) || entry.startsWith('\\\\')) {
    throw new GitError('bad-convention', `convention paths must be relative: "${entry}"`)
  }
  const normalized = entry.replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalized === '' || normalized.split('/').includes('..')) {
    throw new GitError('bad-convention', `convention path "${entry}" must stay inside the checkout`)
  }
  return normalized.split('/').join(sep)
}

/** Whether one path exists, without following a link. */
async function exists(path) {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Prepare a fresh worktree according to the project's convention.
 *
 * Each entry is applied independently and reported, so one missing source
 * directory cannot silently skip the rest. `link` uses a directory link
 * (`mklink /J` semantics on Windows, `symlink` elsewhere), which costs nothing
 * and — unlike copying — keeps the worktree on the very virtualenv, database or
 * cache the main checkout already has. `git worktree remove` does not follow
 * such a link, so the shared target always survives removal.
 *
 * @param {object} request - seeding request.
 * @param {string} request.mainRoot - the MAIN checkout's root.
 * @param {string} request.worktreePath - the fresh worktree.
 * @param {WorktreeConvention} request.convention - the project's convention.
 * @param {AbortSignal} [request.signal] - caller lifetime for the setup command.
 * @returns {Promise<{ linked: string[], copied: string[], setup: { command: string, ok: boolean, output: string } | null, skipped: string[] }>}
 */
export async function seedWorktree(request) {
  const { mainRoot, worktreePath, convention } = request
  const linked = []
  const copied = []
  const skipped = []

  /**
   * Connect one existing path into the worktree.
   *
   * A directory becomes a directory link, which is free and two-way. A file
   * cannot be a junction target, so it is hardlinked: the worktree sees the main
   * checkout's bytes at no extra cost, and a rewrite through an editor lands in
   * one place rather than silently diverging. Filesystems without hardlinks (or
   * a cross-device target) fall back to a copy, reported as such.
   */
  const connect = async (from, to, label) => {
    if (await exists(to)) {
      skipped.push(`${label} (already in the worktree)`)
      return
    }
    await mkdir(dirname(to), { recursive: true })
    const info = await stat(from)
    if (info.isDirectory()) {
      await symlink(from, to, process.platform === 'win32' ? 'junction' : 'dir')
      linked.push(label)
      return
    }
    try {
      await link(from, to)
      linked.push(label)
    } catch {
      await cp(from, to, { force: false, errorOnExist: false })
      copied.push(label)
    }
  }

  for (const entry of convention.link) {
    const relativePath = assertContainedPath(entry)
    const from = join(mainRoot, relativePath)
    if (!(await exists(from))) {
      skipped.push(`${entry} (not in the main checkout)`)
      continue
    }
    await connect(from, join(worktreePath, relativePath), entry)
  }

  for (const entry of convention.linkIgnored) {
    const relativePath = assertContainedPath(entry)
    const from = join(mainRoot, relativePath)
    if (!(await exists(from))) {
      skipped.push(`${entry} (not in the main checkout)`)
      continue
    }
    let ignored
    try {
      ignored = await ignoredEntries(mainRoot, relativePath)
    } catch (error) {
      skipped.push(`${entry} (${error instanceof Error ? error.message : String(error)})`)
      continue
    }
    for (const name of ignored) {
      await connect(join(from, name), join(worktreePath, relativePath, name), `${entry}/${name}`)
    }
  }

  for (const entry of convention.copy) {
    const relativePath = assertContainedPath(entry)
    const from = join(mainRoot, relativePath)
    const to = join(worktreePath, relativePath)
    if (!(await exists(from))) {
      skipped.push(`${entry} (not in the main checkout)`)
      continue
    }
    if (await exists(to)) {
      skipped.push(`${entry} (already in the worktree)`)
      continue
    }
    await mkdir(dirname(to), { recursive: true })
    await cp(from, to, { recursive: true, force: false, errorOnExist: false })
    copied.push(entry)
  }

  let setup = null
  if (convention.setup !== null) {
    setup = await runSetupCommand(convention.setup, worktreePath, convention.setupTimeoutMs, request.signal)
  }

  return { linked, copied, setup, skipped }
}

/**
 * The gitignored entries directly inside one directory of the main checkout.
 *
 * `git status --ignored` is the authority on what "gitignored" means here: it
 * already knows every `.gitignore` layer, so the plugin reimplements none of
 * that matching. Only direct children are returned, because a whole ignored
 * directory can be linked as one entry.
 *
 * @param {string} repoRoot - the main checkout.
 * @param {string} relativePath - the directory to inspect, repository-relative.
 * @returns {Promise<string[]>} ignored direct children, by name.
 */
async function ignoredEntries(repoRoot, relativePath) {
  const output = await runGit(repoRoot, ['status', '--porcelain', '--ignored', '--untracked-files=all', '--', relativePath.split(sep).join('/')])
  const names = new Set()
  const prefix = `${relativePath.split(sep).join('/')}/`
  for (const line of output.split('\n')) {
    if (!line.startsWith('!! ')) continue
    const reported = line.slice(3).trim()
    if (!reported.startsWith(prefix)) continue
    const rest = reported.slice(prefix.length)
    // Nested files arrive path-relative; keep the top-level entry only.
    const name = rest.split('/')[0]
    if (name !== '') names.add(name)
  }
  return [...names].sort()
}

/**
 * Remove the directory links and empty directories a removed worktree leaves.
 *
 * `git worktree remove` deletes the checkout's files but leaves the reparse
 * points the convention created, and an empty worktree directory that still
 * contains them. This removes only links and empty directories, never follows a
 * link, and never touches the shared target it points at.
 *
 * @param {string} root - the removed worktree's path.
 * @returns {Promise<{ removed: number, leftovers: string[] }>} what was cleaned.
 */
export async function cleanWorktreeLinks(root) {
  let removed = 0
  const leftovers = []

  const sweep = async (directory) => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        try {
          await rm(path, { recursive: false, force: true })
          removed += 1
        } catch {
          leftovers.push(path)
        }
        continue
      }
      if (entry.isDirectory()) await sweep(path)
    }
  }

  await sweep(root)
  // Second pass: remove the now-empty directories bottom-up, root last.
  const prune = async (directory) => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) await prune(join(directory, entry.name))
    }
    try {
      const remaining = await readdir(directory)
      // `rmdir` is the correct primitive for an already-empty directory: it
      // refuses anything non-empty and never traverses into a link.
      if (remaining.length === 0) await rmdir(directory)
    } catch {
      leftovers.push(directory)
    }
  }
  await prune(root)
  return { removed, leftovers }
}

/**
 * Run the project's own setup command inside a worktree.
 *
 * The command is the project's, executed through the platform shell because that
 * is what a setup command means (`npm install`, `uv sync`, `make bootstrap`); its
 * output is captured and bounded, and a failure is reported rather than thrown,
 * because a worktree that exists but is not yet prepared is still a usable
 * checkout.
 *
 * @param {string} command - the shell command.
 * @param {string} cwd - the worktree to run it in.
 * @param {number} timeoutMs - maximum duration.
 * @param {AbortSignal} [signal] - caller lifetime.
 * @returns {Promise<{ command: string, ok: boolean, output: string }>} the outcome.
 */
async function runSetupCommand(command, cwd, timeoutMs, signal) {
  const shell = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh'
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command]
  try {
    const { stdout, stderr } = await execFileAsync(shell, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
      signal,
    })
    return { command, ok: true, output: tailOf(`${stdout}${stderr}`.trim()) }
  } catch (error) {
    const stdout = typeof error?.stdout === 'string' ? error.stdout : ''
    const stderr = typeof error?.stderr === 'string' ? error.stderr : ''
    const detail = `${stdout}${stderr}`.trim() || (error instanceof Error ? error.message : String(error))
    return { command, ok: false, output: tailOf(detail) }
  }
}

/** Keep the last part of a command's output; a setup log can be long. */
function tailOf(text, limit = 4000) {
  return text.length <= limit ? text : `…${text.slice(text.length - limit)}`
}

/**
 * Create a linked worktree on a fresh branch.
 *
 * @param {object} request - creation request.
 * @param {string} request.cwd - any directory inside the repository.
 * @param {string} [request.name] - worktree name; generated when omitted.
 * @param {string} [request.worktreeDir] - parent directory for created worktrees.
 * @param {string} [request.branchPrefix] - branch prefix; defaults to `worktree-`.
 * @param {string} [request.baseRef] - commit-ish to branch from; defaults to `HEAD`.
 * @param {boolean} [request.excludeFromGit] - write the worktree directory into `.git/info/exclude`.
 * @returns {Promise<{ path: string, name: string, branch: string, baseRef: string, repoRoot: string, excluded: boolean }>}
 * @throws {GitError} `not-a-repository`, `git-failed` (git's own refusal is the message).
 */
export async function createWorktree(request) {
  const cwd = request.cwd
  const repo = await resolveRepo(cwd)
  const existing = await listWorktrees(cwd).catch(() => [])
  // The layout anchor is the MAIN checkout: a Session inside a linked worktree
  // must create its next worktree in the same place the repository's other
  // worktrees live, not nested inside the worktree it already sits in.
  const repoRoot = mainRootOf(existing, repo.root)
  const worktreeRoot = worktreeRootOf(repoRoot, request.worktreeDir)
  const branchPrefix = typeof request.branchPrefix === 'string' && request.branchPrefix.trim() !== ''
    ? request.branchPrefix.trim()
    : DEFAULT_BRANCH_PREFIX
  const baseRef = typeof request.baseRef === 'string' && request.baseRef.trim() !== '' ? request.baseRef.trim() : 'HEAD'

  const takenDirs = new Set(existing.map(entry => canonical(entry.path)))
  const takenBranches = new Set(existing.map(entry => entry.branch).filter(branch => typeof branch === 'string'))
  const names = existing.map(entry => entry.name)
  let name = typeof request.name === 'string' && request.name.trim() !== '' ? request.name.trim() : ''
  if (name !== '') {
    if (!/^[\w][\w.-]*$/.test(name) || name === '.' || name === '..') {
      throw new GitError('bad-name', `"${name}" is not a usable worktree name`)
    }
  } else {
    name = generateWorktreeName({ takenNames: names })
  }
  const branch = `${branchPrefix}${name}`
  const path = join(worktreeRoot, name)
  if (takenDirs.has(canonical(path))) {
    throw new GitError('name-taken', `a worktree already exists at ${path}`)
  }
  if (takenBranches.has(branch)) {
    throw new GitError('branch-taken', `branch "${branch}" already exists`)
  }

  await mkdir(worktreeRoot, { recursive: true })
  await runGit(repoRoot, ['worktree', 'add', '-b', branch, path, baseRef])

  let excluded = false
  if (request.excludeFromGit !== false && isInside(repoRoot, worktreeRoot)) {
    try {
      excluded = await excludeWorktreeRoot(repo, repoRoot, worktreeRoot)
    } catch {
      // Best effort: an unwritable .git/info/exclude must not fail the creation.
      excluded = false
    }
  }

  // The project's own convention decides what a usable checkout needs. Seeding
  // runs after the worktree exists and never fails the creation: a checkout that
  // is present but not yet prepared is still usable, and its report says so.
  let seeded = null
  if (request.seed !== false) {
    try {
      const convention = await readWorktreeConvention(repoRoot, { file: request.conventionFile })
      seeded = await seedWorktree({ mainRoot: repoRoot, worktreePath: path, convention, signal: request.signal })
    } catch (error) {
      seeded = {
        linked: [],
        copied: [],
        setup: null,
        skipped: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
  return { path, name, branch, baseRef, repoRoot, excluded, seeded }
}

/**
 * Remove one linked worktree, optionally deleting its branch.
 *
 * The main checkout can never be removed through this function, and the target
 * must be a worktree of the repository `cwd` belongs to — a path is never
 * trusted straight from a caller without that membership check.
 *
 * @param {object} request - removal request.
 * @param {string} request.cwd - any directory inside the repository.
 * @param {string} request.path - the worktree to remove.
 * @param {boolean} [request.force] - discard uncommitted changes and untracked files.
 * @param {boolean} [request.deleteBranch] - delete the worktree's branch afterwards.
 * @returns {Promise<{ path: string, branch: string | null, branchDeleted: boolean }>}
 * @throws {GitError} `unknown-worktree`, `main-worktree`, `dirty-worktree`, `git-failed`.
 */
export async function removeWorktree(request) {
  const repo = await resolveRepo(request.cwd)
  const target = resolve(request.path)
  const worktrees = await listWorktrees(request.cwd)
  // Commands run from the MAIN checkout: removing the worktree a Session sits in
  // must not depend on that worktree still being a usable git working directory.
  const repoRoot = mainRootOf(worktrees, repo.root)
  if (canonical(target) === canonical(repoRoot)) {
    throw new GitError('main-worktree', 'the main checkout cannot be removed as a worktree')
  }
  const entry = worktrees.find(candidate => canonical(candidate.path) === canonical(target))
    ?? deepestContaining(worktrees, target)
  if (entry === undefined || entry === null) {
    throw new GitError('unknown-worktree', `${target} is not a worktree of ${repoRoot}`)
  }
  if (canonical(entry.path) === canonical(repoRoot)) {
    throw new GitError('main-worktree', 'the main checkout cannot be removed as a worktree')
  }
  if (entry.locked) {
    throw new GitError('locked-worktree', `worktree ${entry.path} is locked; run \`git worktree unlock\` first`)
  }
  const args = ['worktree', 'remove']
  if (request.force === true) args.push('--force')
  args.push(entry.path)
  try {
    await runGit(repoRoot, args)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/contains modified or untracked files|is dirty/i.test(message)) {
      throw new GitError('dirty-worktree', message, { detail: 'worktree-remove-dirty' })
    }
    throw error
  }
  let branchDeleted = false
  if (request.deleteBranch === true && typeof entry.branch === 'string' && entry.branch !== '') {
    try {
      await runGit(repoRoot, ['branch', '-D', entry.branch])
      branchDeleted = true
    } catch {
      branchDeleted = false
    }
  }
  await runGit(repoRoot, ['worktree', 'prune']).catch(() => '')
  // git leaves the convention's directory links (and the empty worktree folder
  // holding them) behind; clear them without ever following a link.
  const cleaned = await cleanWorktreeLinks(entry.path).catch(() => ({ removed: 0, leftovers: [] }))
  return { path: entry.path, branch: entry.branch ?? null, branchDeleted, linksRemoved: cleaned.removed, leftovers: cleaned.leftovers }
}

/**
 * @typedef {object} RepoLayout
 * @property {string} root - repository root.
 * @property {string} gitDir - this checkout's git directory.
 * @property {string} commonDir - the shared git directory.
 */
