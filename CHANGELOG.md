# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The package version tracks the plugin, not the harness: `engines.dsh` in
`package.json` declares which harness versions a release supports.

## [Unreleased]

Nothing yet.

## [0.1.0] - 2026-09-25

First release. One row above the composer that changes with the Session it
belongs to, plus per-project worktree preparation.

### Added

- **Start-screen checkbox** — a Session that has not been prompted gets a
  `worktree` checkbox. Checking it creates a linked git worktree and opens the
  blank Session in it, so the next prompt runs on a worktree branch; unchecking
  removes a worktree this plugin created and returns to the main checkout.
- **Conversation status row** — the workspace, the branch the Session runs on,
  the worktree it belongs to, and the working-tree diff totals, each with the
  menu that reaches the checkout from the OS.
- **Per-project worktree preparation** — a repository declares its own
  `dsh-worktree.json` with `link`, `linkIgnored`, `copy`, `setup` and
  `setupTimeoutMs`, so untracked setup (a virtualenv, a database directory, a
  local cache) exists in a fresh worktree exactly as far as the project says.
  The plugin hardcodes no project's layout.
- **Host route** `POST /dsh-worktree/api/<method>` with `info`,
  `worktree.create`, `worktree.remove` and `open.external`, admitted through the
  harness's own browser-session gate (`ctx.connection.admit`).
- **Reusable Git layer** importable as `dsh-worktree/git`: repository info,
  worktree list/create/remove, the project convention, seeding and cleanup.
- **Four dependency-free test suites** (`npm test`) covering the Git layer, the
  convention and seeding, the Host route table, and the rendered Client half.

### Security

- Routes answer only an admitted browser session; a trusted but unauthenticated
  request is refused with 401 and a cross-site one with 403.
- `worktree.remove` proves the target is a worktree of that repository and never
  the main checkout; a path is never trusted from a request body alone.
- Convention paths must be relative and stay inside the checkout.
- Removal never follows a directory link, so shared content always survives.

[Unreleased]: https://github.com/Hermannmayer/dsh-worktree/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Hermannmayer/dsh-worktree/releases/tag/v0.1.0
