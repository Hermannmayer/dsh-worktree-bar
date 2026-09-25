/**
 * Standalone smoke test for lib/git.js — runs against a throwaway repository so
 * the developer's own checkout is never modified.
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  createWorktree, generateWorktreeName, listWorktrees, parseNumstat, remoteWebUrl,
  removeWorktree, repoInfo,
} from '../lib/git.js'

const run = promisify(execFile)

function assert(condition, label) {
  if (!condition) throw new Error(`FAILED: ${label}`)
  console.log(`  ok  ${label}`)
}

async function main() {
  console.log('remoteWebUrl')
  assert(remoteWebUrl('git@github.com:owner/repo.git') === 'https://github.com/owner/repo', 'scp form')
  assert(remoteWebUrl('https://github.com/owner/repo.git') === 'https://github.com/owner/repo', 'https form')
  assert(remoteWebUrl('ssh://git@gitlab.com/group/sub/repo.git') === 'https://gitlab.com/group/sub/repo', 'ssh url')
  assert(remoteWebUrl('') === null, 'empty')
  assert(remoteWebUrl('/local/path') === null, 'local path')

  console.log('parseNumstat')
  assert(JSON.stringify(parseNumstat('12\t3\ta.txt\n-\t-\timg.png\n')) === '{"added":12,"removed":3,"files":2}', 'mixed rows')

  console.log('generateWorktreeName')
  const name = generateWorktreeName({ takenNames: [] })
  assert(/^[a-z]+-[a-z]+-[0-9a-f]{4}$/.test(name), `shape (${name})`)

  const base = await mkdtemp(join(tmpdir(), 'dshwt-'))
  const repo = join(base, 'project')
  await mkdir(repo)
  await run('git', ['init', '-b', 'main'], { cwd: repo })
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  await run('git', ['config', 'user.name', 'Test'], { cwd: repo })
  await writeFile(join(repo, 'a.txt'), 'one\ntwo\n')
  await run('git', ['add', '.'], { cwd: repo })
  await run('git', ['commit', '-m', 'init'], { cwd: repo })
  await writeFile(join(repo, 'a.txt'), 'one\ntwo\nthree\n')
  await writeFile(join(repo, 'new.txt'), 'x\n')

  try {
    console.log('repoInfo')
    const info = await repoInfo(repo)
    assert(info.isRepo === true, 'isRepo')
    assert(info.branch === 'main', `branch (${info.branch})`)
    assert(info.repoName === 'project', 'repoName')
    assert(info.isWorktree === false, 'main checkout is not a linked worktree')
    assert(info.stats.added === 1, `added lines (${info.stats.added})`)
    assert(info.untrackedFiles === 1, `untracked (${info.untrackedFiles})`)
    assert(info.changedFiles === 2, `changed files (${info.changedFiles})`)
    assert(info.worktrees.length === 1 && info.worktrees[0].main === true, 'one main worktree')

    console.log('repoInfo outside a repository')
    const outside = await mkdtemp(join(tmpdir(), 'dshwt-bare-'))
    const noRepo = await repoInfo(outside)
    assert(noRepo.isRepo === false, 'isRepo false')
    await rm(outside, { recursive: true, force: true })

    console.log('createWorktree')
    const created = await createWorktree({ cwd: repo, name: 'test-box' })
    assert(created.branch === 'worktree-test-box', `branch (${created.branch})`)
    assert(created.path.endsWith('test-box'), 'path')
    assert(created.excluded === true, 'excluded in .git/info/exclude')

    const linked = await repoInfo(created.path)
    assert(linked.isWorktree === true, 'linked worktree detected')
    assert(linked.isPluginWorktree === true, 'managed worktree detected')
    assert(linked.worktreeName === 'test-box', `worktreeName (${linked.worktreeName})`)
    assert(linked.repoRoot === info.repoRoot, `repoRoot stays the main checkout (${linked.repoRoot})`)
    assert(linked.checkoutRoot === created.path, 'checkoutRoot is the worktree')
    assert(linked.stats.added === 0 && linked.untrackedFiles === 0, 'fresh worktree is clean')

    const status = await run('git', ['status', '--porcelain'], { cwd: repo })
    assert(status.stdout.trim() === 'M a.txt\n?? new.txt' || status.stdout.trim() === ' M a.txt\n?? new.txt', `main checkout stays clean of the worktree (${JSON.stringify(status.stdout.trim())})`)

    console.log('worktree in a subdirectory')
    const sub = join(repo, 'sub')
    await mkdir(sub)
    const fromSub = await createWorktree({ cwd: sub, name: 'sub-box' })
    assert(fromSub.repoRoot === info.repoRoot, 'a subdirectory resolves the main checkout')
    assert(fromSub.path.startsWith(join(info.repoRoot, '.dsh', 'worktrees')), 'layout anchored on the main checkout')

    console.log('a session inside a worktree creates a sibling, not a nested worktree')
    const nested = await createWorktree({ cwd: created.path, name: 'sibling-box' })
    assert(nested.repoRoot === info.repoRoot, 'anchor stays the main checkout')
    assert(nested.path === join(info.repoRoot, '.dsh', 'worktrees', 'sibling-box'), `sibling path (${nested.path})`)

    console.log('removeWorktree from inside the worktree itself')
    const removed = await removeWorktree({ cwd: created.path, path: created.path, deleteBranch: true })
    assert(removed.branchDeleted === true, 'branch deleted')
    const after = await listWorktrees(repo)
    assert(after.every(entry => !entry.path.endsWith('test-box')), 'worktree gone')
    await removeWorktree({ cwd: repo, path: nested.path, deleteBranch: true })
    await removeWorktree({ cwd: repo, path: fromSub.path, deleteBranch: true })

    console.log('removeWorktree refuses the main checkout')
    let refused = false
    try {
      await removeWorktree({ cwd: repo, path: repo })
    } catch (error) {
      refused = error.code === 'main-worktree'
    }
    assert(refused, 'main-worktree refusal')

    console.log('removeWorktree refuses a dirty worktree unless forced')
    const dirty = await createWorktree({ cwd: repo, name: 'dirty-box' })
    await writeFile(join(dirty.path, 'a.txt'), 'changed\n')
    let dirtyCode = ''
    try {
      await removeWorktree({ cwd: repo, path: dirty.path })
    } catch (error) {
      dirtyCode = error.code
    }
    assert(dirtyCode === 'dirty-worktree', `dirty refusal (${dirtyCode})`)
    const forced = await removeWorktree({ cwd: repo, path: dirty.path, force: true, deleteBranch: true })
    assert(forced.path.endsWith('dirty-box'), 'forced removal')

    console.log('\nall checks passed')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

