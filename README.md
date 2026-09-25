---
description: "Repository context row above the composer for the Harness Web UI: the workspace and branch a session runs on, a start-screen worktree checkbox, and per-project worktree preparation."
kind: "package-reference"
---

# dsh-worktree

English | [中文](README.zh.md)

## Summary

This bundle adds one row above the composer, and the row changes with the Session it belongs to:

- **Before the first prompt** it is the start screen's worktree checkbox. Checking it creates a linked git worktree and opens the blank Session in it, so whatever is typed next runs on a worktree branch — the Claude Code Desktop model, where the worktree is chosen when a Session starts.
- **In a conversation** it is status: the workspace, the branch the Session actually runs on (`main`, `worktree-calm-otter`, …), the worktree it belongs to, and the working-tree diff totals.

A repository declares for itself what a usable worktree needs — a virtualenv, a database directory, a local cache — in its own convention file. The plugin hardcodes no project's layout, so the same bundle serves a Python project that must run its app from a worktree, a Node project that only needs `npm install`, and a repository that needs nothing at all.

The bundle is standalone: no runtime dependency, no build step, and no coupling to any other plugin. It is a Cordis bundle (`dsh.bundle.patch`) with a Host half and a browser half, and its Git layer (`dsh-worktree/git`) is a plain module other plugins may import.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Install

With the harness CLI, straight from GitHub:

```bash
dsh plugin --profile desktop install Hermannmayer/dsh-worktree
```

That is the supported path for anyone else: the CLI resolves `owner/repo` through pnpm in the profile, installs the bundle, and the row is available after a restart. Replace `desktop` with the profile you use.

Inside a session, the `plugin_manager` tool installs the same bundle from a local checkout:

```text
plugin_manager action=install_bundle target=<absolute path to this package>
```

Both links the directory into the profile (`link:` in the profile's `package.json` and `dsh-worktree` in `dsh.profile.bundles`), so the sources stay wherever you keep them and the profile is not hand-edited. The row id is `worktree`; the Client half needs no installation of its own.

Editing the sources afterwards follows the harness rule for every plugin: a **Client** change is served to the page on the next page load, while a **Host** change requires a restart, because a replaced package loads a fresh JavaScript module generation only at startup.

This package also declares `peerDependencies` on the harness packages it uses, and no `dependencies`: the platforms it sits between are supplied by the harness, and shipping a private copy of one would shadow the host's own module identity.

### Develop

The package has no runtime or development dependency, so a checkout needs nothing installed:

```bash
git clone https://github.com/Hermannmayer/dsh-worktree.git
cd dsh-worktree
npm test     # four suites: git layer, seeding, host routes, client rendering
npm run check   # node --check on every source file
```

To develop against a running profile, install the checkout as a bundle and reload the page:

```text
plugin_manager action=install_bundle target=<absolute path to the checkout>
```

`npm test` needs Node 20 or newer and never starts a browser, a terminal, or a
file manager: the Client suite renders through a small React stand-in, and the
rest run against throwaway repositories in the system temp directory.

Releases follow Semantic Versioning on the package version, with `engines.dsh`
declaring the supported harness range; every release is recorded in
[`CHANGELOG.md`](CHANGELOG.md).

### The start screen

A Session that has not been prompted yet gets the checkbox:

| Control | Click | Menu |
|---|---|---|
| `worktree` checkbox | check: create the worktree and open this Session in it. Uncheck, inside a worktree: remove a worktree this plugin created and return to the main checkout. | — |
| repository name | open the repository menu | Show in Explorer · Open repository on GitHub · Copy workspace path · Change folder… · Open in terminal · open one of the repository's other worktrees |
| branch name | open the branch menu | Copy branch name · Create pull request… · Open in terminal |

The checkbox tooltip names what the project's convention will prepare, so its effect is known before it happens. Checking it never deletes anything; unchecking only removes a checkout this plugin itself created, and leaves any other checkout exactly where it is.

### The conversation row

Once the Session has been prompted, the checkbox is gone and the row is status:

| Control | Shows | Menu |
|---|---|---|
| repository name | the workspace | as above |
| branch name | the branch this Session runs on | Copy branch name · Copy worktree path · Create pull request… · Open in terminal · **Remove worktree…** (only for a worktree this plugin created) |
| the worktree name | an isolated checkout | — (information; the branch menu owns removal) |
| `+N` `−M` | working-tree totals, with changed and untracked file counts on hover | — |

Removal always asks first, because it deletes the directory. A worktree with uncommitted changes or untracked files is refused by git, and the menu then offers an explicit **Discard changes and remove**.

A directory outside a git repository renders nothing, so the row never takes space in a workspace that cannot use it.

### Per-project worktree preparation

A Session's working directory is fixed when the Session is created, and a fresh worktree contains only tracked files — so a project whose app reads a gitignored `database/`, a virtualenv, or a local `data/` cache cannot run from one. The plugin does not guess: the **project** declares its own convention in `dsh-worktree.json` at the repository root. Without that file a worktree is a plain fresh checkout, and nothing else happens.

```json
{
  "link": [".venv", "database"],
  "linkIgnored": ["data"],
  "copy": ["config/secrets.json"],
  "setup": "uv sync --dev"
}
```

| Key | Effect |
|---|---|
| `link` | Connect one path to the main checkout with a directory link (a junction on Windows). Costs nothing, and the worktree then uses the very environment the main checkout has. |
| `linkIgnored` | For a directory that mixes tracked and untracked content: connect only its **gitignored** entries, so tracked files still come from git. `git status --ignored` decides what "gitignored" means, so no `.gitignore` matching is reimplemented here. |
| `copy` | Duplicate a path instead of connecting it, when the worktree needs its own independent copy. |
| `setup` | A shell command run inside the fresh worktree (`npm install`, `uv sync`, `make bootstrap`). |
| `setupTimeoutMs` | Time budget for `setup`; 15 minutes by default. |

Directories are connected, files are hardlinked where the filesystem allows and copied where it does not. Paths must be relative and stay inside the checkout. An unknown key, a wrong type, or an escaping path fails loudly as `bad-convention`, so a typo is reported instead of silently ignored. Seeding never fails the creation: a checkout that exists but is not yet prepared is still usable, and the result reports every entry linked, copied, or skipped, plus the setup command's outcome.

### Configuration

The row accepts these optional keys in `cordis.patch.yml`; the defaults are the documented behavior.

| Field | Default | Meaning |
|---|---|---|
| `worktreeDir` | `.dsh/worktrees` | Parent directory for created worktrees, relative to the **main checkout** (an absolute path is used as is). |
| `branchPrefix` | `worktree-` | Branch name prefix for created worktrees. |
| `baseRef` | `HEAD` | Commit-ish a new worktree branches from. |
| `excludeFromGit` | `true` | Append the worktree directory to `.git/info/exclude`, so the main checkout does not report every worktree as untracked. |
| `conventionFile` | `dsh-worktree.json` | The project convention file's name. |
| `pollMs` | `15000` | Client refresh interval in milliseconds; `0` disables polling and leaves the row to the refresh on focus. |

Example override:

```yaml
- id: worktree
  name: 'dsh-worktree'
  config:
    worktreeDir: ../worktrees
    conventionFile: .worktree-setup.json
    pollMs: 30000
```

### Where worktrees live and what they cost

A linked worktree shares the repository's object database, so it costs one working tree and no duplicated history. A `link` entry adds no bytes at all; only `copy` duplicates data, and each such entry is the project's own explicit choice. Nothing copies gitignored files unless the convention says so, and `.git/info/exclude` is written rather than any tracked file, so a created worktree changes no committed path.

The Host does nothing while idle: no file watcher, no timer, no cache. Each request runs a bounded number of git commands through `execFile` — argument arrays, no shell, a 20-second timeout and an 8 MiB output cap — and reads no file contents for the diff totals (binary rows count as files, untracked files are counted but not read). The Client asks for a refresh every `pollMs` only while a repository-backed Session view is visible, and stops entirely for a non-repository directory or a failed read. A `setup` command is the one operation whose cost is unbounded, and it is the project's own command under the project's own declared budget.

### Browser admission

The route speaks for the operator only if it passes `ctx.connection.admit()`, the same browser-session gate the harness's own `/api` bridge uses: a trusted but unauthenticated request is refused with 401, and a cross-site or foreign-Host request with 403. A composition without a browser surface has no session to require and falls back to the local Host/Origin fence. `info` reports which of the two is in force in its `admission` field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| Path | Role |
|---|---|
| [`lib/plugin.js`](lib/plugin.js) | Host row: `apply`, the `/dsh-worktree/api` route table, admission, Session directory resolution, OS hand-offs. |
| [`lib/git.js`](lib/git.js) | Context-free Git layer: repository info, worktree list/create/remove, the project convention, seeding, remote URL and name generation. Importable as `dsh-worktree/git`. |
| [`client.js`](client.js) | Browser half: the `conversation.input.dock` entry — start-screen checkbox, conversation status row, menus, locale dictionary. |
| [`index.js`](index.js) | Re-export of the Host row, for readers who expect the conventional entry file. |
| [`test/*.test.mjs`](test) | Git layer, seeding, Host route table and Client rendering, runnable with `npm test` (no framework). |
| [`cordis.patch.yml`](cordis.patch.yml) | The bundle's one `insert` row. |

### API

One fenced JSON route, `POST /dsh-worktree/api/<method>`, with `{ ok: true, value }` or `{ ok: false, error: { code, message } }`:

| Method | Request | Response |
|---|---|---|
| `info` | `{ sessionId, cwd? }` | repository, branch, checkout kind, diff totals, worktree list, the project convention, this row's options, the plugin identity and the admission in force |
| `worktree.create` | `{ sessionId, name?, cwd?, seed? }` | `{ path, name, branch, baseRef, repoRoot, excluded, seeded }` |
| `worktree.remove` | `{ sessionId, path, force?, deleteBranch?, cwd? }` | `{ path, branch, branchDeleted, linksRemoved, leftovers }` |
| `open.external` | `{ action: 'reveal' \| 'terminal' \| 'url', path \| url }` | `{ ok: true }` |

Sessions are addressed by id and the directory is resolved on the Host — the live Session header first, then session persistence, then the Client's own list-summary directory — so a request body can never point a Git command at an arbitrary directory. `worktree.remove` additionally proves the target is a worktree of that repository and never the main checkout; a path is never trusted on its own.

### Why the row has two modes

The harness fixes a Session's working directory at creation: the Workspace registry cannot move a live Session, and `ctx.sessions.create({ workspaceId })` is the only way to put one in a directory. The start screen is therefore the only place where "work in a worktree" can mean "this Session", and the plugin reads `session.blank`/`session.promptAttempted` from the slot's own `useSession` hook to know it is on that screen. Checking the box does the two steps the harness allows: create the checkout, then open a Session in it. Once a prompt exists the Session cannot move, so the row becomes information — and removal moves to the branch menu, which exists in both modes.

### Layout anchoring

`git rev-parse --show-toplevel` answers with the checkout a directory sits in, which inside a linked worktree is that worktree. Every layout decision therefore anchors on the **main** checkout — `git worktree list` guarantees it is listed first — so a Session already inside a worktree creates a sibling in the same place, and `repoRoot` in `info` always means the repository the user launched from. Identity comparisons use a real-path canonical form, because a Windows short name (`C:\PROGRA~1`) and the long name are the same directory.

### Links, and why removal is safe

A junction is a directory reparse point: `git worktree remove` deletes the checkout's files but never traverses the link, which the plugin's tests assert by removing a worktree and re-reading the shared files. Removing a linked *file* first is the case that matters on Windows, where `fs.rm` on a junction can delete the target's contents; the sweeper therefore removes links with `rm` on the link itself and prunes directories with `rmdir`, which refuses anything non-empty. `git worktree remove` also leaves the reparse points and the empty worktree folder behind, so `cleanWorktreeLinks` sweeps them afterwards — again only links and empty directories, never following a link.

### Client registration

The browser half registers a lazy module (`dsh.client.platform: web`, `immediately: true`) and contributes through `ctx.slots.inject('conversation.input.dock', …)` at `order: 30`, after the shipped todo, goal and queue entries. It sizes itself with the composer's own layout variables (`--dsh-composer-card-max-width`, `--dsh-composer-side-clearance`, `--dsh-composer-dock-inset`) so the row lines up with the card instead of spanning the conversation column. It waits for `slots`, `locale`, `workspaces` and `uiWorkspace`, and imports no Harness Client package: React comes from the module table, colors come only from `--dsw-alias-*` tokens, and copy is registered in its own `dsh-worktree` locale namespace (`en`, `zh`). The Host row exposes `dsh-worktree/git` for other plugins; no other plugin is required.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- The harness's **`cordis-plugin-development`** skill (shipped in `@deepseek-ai/dsh-agent-preset`) — bundle manifests, Host export forms, Client slot registration, and the practices this package follows.
- **`cordis_inspect_list` / `cordis_inspect_query`** — live Service, Event, Slot and Theme facts; `Slots.listSubTree` with `conversation.input.dock` shows this entry beside the shipped occupants.
- **`git help worktree`** — the underlying operations the row automates.

-----

<a id="model-experience"></a>
## Model Experience

### What the model sees

Nothing. The bundle registers no tool, injects no prompt and writes no session event: the row is a human control, and the model only ever observes the consequences of the Session it runs in (its working directory, and therefore its own repository state). A model-facing worktree tool is deliberately absent — choosing which checkout the *human* is looking at is not a model decision here.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

None; the package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The checkbox opens a Session; it cannot move one** — a Session's working directory is creation-time data in the harness, so "work in a worktree" on the start screen means "create the worktree, then open the Session there". An in-progress conversation cannot be relocated, and this package does not pretend otherwise.
- **Worktrees are fresh checkouts of a commit** — `baseRef` defaults to `HEAD`, so uncommitted changes stay in the main checkout. Untracked setup is shared or duplicated only as far as the project's convention declares.
- **A `link` is two-way** — connecting a directory means the worktree and the main checkout are the same directory for that path. That is the point for a virtualenv or a local database, and it is why `copy` exists for anything that must not be shared.
- **No automatic cleanup** — a created worktree lives until its own menu or checkbox removes it. There is no age-based or exit-time sweep, and no marker in the git metadata.
- **Line totals exclude untracked files** — `+N`/`−M` count `git diff HEAD --numstat`; untracked files appear only in the hover's file counts, because counting their lines would mean reading each file on every poll.
- **Host changes need a restart** — a replaced package loads its JavaScript once per process, so only the Client half hot-updates through a page load.
- **Subagents share the Session directory** — no per-subagent worktree; every child of an isolated Session runs in the same checkout, which is already isolated from the main one.
- **Non-git version control is unsupported** — the row is absent outside a git repository.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`npm test` runs the four suites without a test framework or dependency:

- `test/git.test.mjs` — the Git layer against a throwaway repository: parsing, real-path identity, layout anchoring from a subdirectory and from inside a worktree, dirty/locked/main removals, and the porcelain output of the main checkout after a creation.
- `test/seed.test.mjs` — the project convention against a repository whose shape mirrors a real project: parsing and refusal of bad conventions, link/copy/linkIgnored application, tracked files still coming from git, the setup command, and the guarantee that removal clears the links without touching anything shared.
- `test/host.test.mjs` — the route table over a fake Cordis context: admission branches, the fallback fence, request-shape errors, Session directory resolution, and a create → info → remove round trip.
- `test/client.test.mjs` — the browser half rendered through `test/react-shim.mjs`, a minimal React and DOM stand-in, asserting the two modes, every menu, and the endpoint sequence each control produces.

The shim exists because the deployment ships neither React nor a DOM to plugins and no Host tool can script the page; it is deliberately small (function components, dependency-skipping hooks, no reconciliation) and is not a general React.

Three harness facts are worth re-checking before changing behavior here: the Session working directory is creation-time metadata (`@deepseek-ai/dsh-session`), a plugin route's conventional admission is `ctx.connection.admit` (`@deepseek-ai/dsh-client-connection`), and a replaced package's Host code loads only on restart (the HMR row's module roots are empty in this profile).

The README pair has no `README.i18n.yaml`: that file is the harness monorepo's translation-pairing record, produced by its own tooling, which this standalone project does not run.

</details>

**Runtime invariant:** none published. The package owns one route table, which it registers inside `ctx.effect` and which the Loader disposes with the row; it writes no durable state and holds no cross-plugin state.
