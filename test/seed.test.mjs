/**
 * Seeding smoke test: proves a worktree created through the plugin's Git layer
 * becomes a checkout the project's own entry point can actually run from.
 *
 * It builds a throwaway repository whose shape mirrors a real project — a
 * tracked source file, a gitignored virtualenv directory, a gitignored database
 * directory, and a `data/` directory mixing tracked and ignored content — then
 * creates a worktree and asserts the convention was applied.
 */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createWorktree, readWorktreeConvention, removeWorktree, seedWorktree } from '../lib/git.js'

const run = promisify(execFile)

let passed = 0
function assert(condition, label) {
  if (!condition) throw new Error(`FAILED: ${label}`)
  passed += 1
  console.log(`  ok  ${label}`)
}

async function main() {
  console.log('convention parsing')
  const empty = await readWorktreeConvention('C:/definitely/not/here')
  assert(empty.link.length === 0 && empty.setup === null, 'a repository without the file gets no rules')

  const base = await mkdtemp(join(tmpdir(), 'dshwt-seed-'))
  const repo = join(base, 'project')
  await mkdir(join(repo, 'data', 'caches'), { recursive: true })
  await mkdir(join(repo, '.venv', 'Scripts'), { recursive: true })
  await mkdir(join(repo, 'database'), { recursive: true })
  await writeFile(join(repo, 'main.py'), 'print("runs from", __file__)\n')
  await writeFile(join(repo, 'data', 'terminology.json'), '{"tracked":true}\n')
  await writeFile(join(repo, 'data', 'universe_data.json'), '{"local":"cache"}\n')
  await writeFile(join(repo, 'data', 'caches', 'icons.bin'), 'icons\n')
  await writeFile(join(repo, '.venv', 'Scripts', 'python.exe'), 'interpreter\n')
  await writeFile(join(repo, 'database', 'user.db'), 'PRECIOUS USER DATA\n')
  await writeFile(join(repo, '.gitignore'), ['.venv/', 'database/', 'data/*.json', '!data/terminology.json', ''].join('\n'))
  await run('git', ['init', '-b', 'main'], { cwd: repo })
  await run('git', ['config', 'user.email', 't@e.com'], { cwd: repo })
  await run('git', ['config', 'user.name', 'T'], { cwd: repo })
  await run('git', ['add', 'main.py', 'data/terminology.json', '.gitignore'], { cwd: repo })
  await run('git', ['commit', '-m', 'init'], { cwd: repo })

  await writeFile(join(repo, 'dsh-worktree.json'), JSON.stringify({
    link: ['.venv', 'database'],
    linkIgnored: ['data'],
    setup: process.platform === 'win32' ? 'echo setup ran > setup.log' : 'echo setup ran > setup.log',
  }, null, 2))

  const convention = await readWorktreeConvention(repo)
  assert(convention.link.length === 2, 'reads link entries')
  assert(convention.linkIgnored.length === 1, 'reads linkIgnored entries')
  assert(convention.setup !== null, 'reads the setup command')

  console.log('bad conventions fail loudly')
  await writeFile(join(repo, 'dsh-worktree.json'), '{ "link": [".venv"], "nope": 1 }')
  let badKey = ''
  try { await readWorktreeConvention(repo) } catch (error) { badKey = error.code }
  assert(badKey === 'bad-convention', 'rejects an unknown key')
  await writeFile(join(repo, 'dsh-worktree.json'), '{ "link": ["../escape"] }')
  const escape = await readWorktreeConvention(repo)
  let escapeCode = ''
  try { await seedWorktree({ mainRoot: repo, worktreePath: join(repo, 'x'), convention: escape }) } catch (error) { escapeCode = error.code }
  assert(escapeCode === 'bad-convention', 'refuses a path escaping the checkout')
  await writeFile(join(repo, 'dsh-worktree.json'), JSON.stringify({ link: ['.venv', 'database'], linkIgnored: ['data'], setup: 'echo setup ran > setup.log' }))

  console.log('a created worktree is ready to run the project')
  const created = await createWorktree({ cwd: repo, name: 'seed-box' })
  assert(created.seeded !== null, 'creation reports a seeding result')
  assert(created.seeded.linked.includes('.venv'), 'links the virtualenv')
  assert(created.seeded.linked.includes('database'), 'links the database directory')
  assert(created.seeded.linked.some(entry => entry === 'data/universe_data.json'), `links ignored data files (${created.seeded.linked.filter(e => e.startsWith('data/')).join(', ')})`)
  assert(!created.seeded.linked.includes('data/terminology.json'), 'leaves tracked data files to git')
  assert(created.seeded.setup?.ok === true, 'runs the project setup command')

  const venv = await readFile(join(created.path, '.venv', 'Scripts', 'python.exe'), 'utf8')
  assert(venv.includes('interpreter'), 'the worktree sees the main checkout virtualenv')
  const db = await readFile(join(created.path, 'database', 'user.db'), 'utf8')
  assert(db.includes('PRECIOUS'), 'the worktree sees the main checkout database')
  const cache = await readFile(join(created.path, 'data', 'universe_data.json'), 'utf8')
  assert(cache.includes('cache'), 'the worktree sees the ignored local cache')
  const tracked = await readFile(join(created.path, 'data', 'terminology.json'), 'utf8')
  assert(tracked.includes('tracked'), 'tracked files still come from git')
  const setupLog = await readFile(join(created.path, 'setup.log'), 'utf8')
  assert(setupLog.includes('setup ran'), 'the setup command ran inside the worktree')
  const main = await readFile(join(created.path, 'main.py'), 'utf8')
  assert(main.includes('runs from'), 'the project entry point is present')

  console.log('the plugin still reports the main checkout as the repository')
  const status = await run('git', ['status', '--porcelain'], { cwd: created.path })
  assert(status.stdout.trim().startsWith('?? setup.log') || status.stdout.trim() === '?? setup.log', `the seeded worktree is otherwise clean (${JSON.stringify(status.stdout.trim())})`)

  console.log('connected paths do not appear as changes')
  // On POSIX a directory symlink is a FILE to git, so the project's own
  // `database/` rule does not match it: without the worktree's exclude the link
  // shows as untracked, and git then refuses to remove the worktree as dirty.
  assert(Array.isArray(created.seeded.excluded), 'creation reports the excluded connected paths')
  assert(created.seeded.excluded.some(pattern => pattern === '/.venv'), `excludes the linked virtualenv (${created.seeded.excluded.join(', ')})`)
  assert(created.seeded.excluded.some(pattern => pattern === '/database'), 'excludes the linked database directory')
  assert(!created.seeded.excluded.some(pattern => pattern.startsWith('/data/terminology')), 'never excludes a tracked path')
  const linkedStatus = await run('git', ['status', '--porcelain'], { cwd: created.path })
  assert(linkedStatus.stdout.trim() === '?? setup.log', `connected paths are not reported as changes (${JSON.stringify(linkedStatus.stdout.trim())})`)

  console.log('connected paths do not block removal')
  // This is the cross-platform half of the guarantee. On POSIX a directory
  // symlink is a FILE to git, so the project's own `database/` rule does not
  // match it, and without the exclude git refuses to remove the worktree as
  // dirty. Removing the one real untracked file must therefore be enough.
  await rm(join(created.path, 'setup.log'), { force: true })
  const statusAfter = await run('git', ['status', '--porcelain'], { cwd: created.path })
  assert(statusAfter.stdout.trim() === '', `only the real untracked file was left (${JSON.stringify(statusAfter.stdout.trim())})`)

  console.log('removal never follows the links')
  const removed = await removeWorktree({ cwd: repo, path: created.path, deleteBranch: true })
  assert(removed.branchDeleted === true, 'removes the worktree and its branch without force')
  // git deletes files but not the reparse points: both top-level junctions must
  // go, and the empty worktree directory must not survive either.
  assert(removed.linksRemoved >= 2, `clears the directory links git leaves behind (${removed.linksRemoved})`)
  assert(removed.leftovers.length === 0, `reports no leftovers (${removed.leftovers.join(', ')})`)
  const leftovers = await readdir(join(repo, '.dsh', 'worktrees')).catch(() => [])
  assert(!leftovers.includes('seed-box'), 'leaves no empty worktree directory behind')
  const survives = await readFile(join(repo, 'database', 'user.db'), 'utf8')
  assert(survives.includes('PRECIOUS'), 'the shared database survives removal')
  const venvSurvives = await readFile(join(repo, '.venv', 'Scripts', 'python.exe'), 'utf8')
  assert(venvSurvives.includes('interpreter'), 'the shared virtualenv survives removal')

  await rm(base, { recursive: true, force: true })
  console.log(`\nall checks passed (${passed})`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
