---
description: "Harness Web UI 输入框上方的仓库状态行：会话真正运行的工作区与分支、开始界面上的 worktree 复选框，以及按项目声明的 worktree 初始化。"
kind: "package-reference"
---

# dsh-worktree-bar

[English](README.md) | 中文

## 概要

本 bundle 在输入框上方增加一行，而这一行随所属会话变化：

- **首次提问之前**，它是开始界面上的 worktree 复选框。勾选后创建链接的 git worktree，并在其中打开这个空白会话——之后输入的一切都跑在 worktree 分支上。这就是 Claude Code Desktop 的模型：worktree 在会话开始时选定。
- **进入对话之后**，它是状态行：工作区、会话真正所在的分支（`main`、`worktree-calm-otter`…）、所属 worktree，以及工作区改动统计。

仓库自己声明一个可用的 worktree 需要什么——虚拟环境、数据库目录、本地缓存——写在它自己的约定文件里。插件不硬编码任何项目的布局，因此同一个 bundle 既能服务「必须在 worktree 里跑起来」的 Python 项目，也能服务只需要 `npm install` 的 Node 项目，以及什么都不需要的仓库。

本 bundle 完全独立：无运行时依赖、无构建步骤、不耦合任何其他插件。它是一个 Cordis bundle（`dsh.bundle.patch`），由 Host 半边和浏览器半边组成；其 Git 层（`dsh-worktree-bar/git`）是普通模块，其他插件可以直接引入。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型侧体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [维护者备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 安装

用 Harness CLI 直接从 GitHub 安装：

```bash
dsh plugin --profile desktop install Hermannmayer/dsh-worktree-bar
```

这是给其他使用者的推荐路径：CLI 在 profile 目录中通过 pnpm 解析 `owner/repo`、安装该 bundle，重启后即可使用。把 `desktop` 换成你自己的 profile 名。没有全局 CLI 时，同一条命令可以写成 `npx @deepseek-ai/dsh plugin --profile desktop install Hermannmayer/dsh-worktree-bar`。

在会话里也可以用 `plugin_manager` 工具从本地检出安装同一个 bundle：

```text
plugin_manager action=install_bundle target=<本包的绝对路径>
```

两种方式都会把该目录 link 进 profile（profile 的 `package.json` 里出现 `link:`，`dsh.profile.bundles` 追加 `dsh-worktree-bar`），源码可以继续放在任何位置，profile 不需要手改。行 id 是 `worktree`；浏览器半边不需要单独安装。

之后修改源码遵循 Harness 对所有插件的规则：**Client** 改动在下次页面加载时生效，**Host** 改动需要重启——被替换的包只有在启动时才会加载新的 JavaScript 模块。

本包只声明 `peerDependencies`（它所使用的 Harness 包），没有任何 `dependencies`：这些平台由 Harness 提供，自带一份私有副本会遮蔽宿主自身的模块身份。

### 开发

本包没有任何运行时依赖或开发依赖，检出后无需安装即可开发：

```bash
git clone https://github.com/Hermannmayer/dsh-worktree-bar.git
cd dsh-worktree-bar
npm test        # 四套用例：Git 层、初始化、Host 路由、Client 渲染
npm run check   # 对每个源文件执行 node --check
```

要在运行中的 profile 上开发，把检出目录作为 bundle 安装，然后刷新页面：

```text
plugin_manager action=install_bundle target=<检出目录的绝对路径>
```

`npm test` 需要 Node 20 或更高版本，且**不会**启动浏览器、终端或文件管理器：Client 套件通过一个很小的 React 替身渲染，其余用例都在系统临时目录里的一次性仓库上运行。

发布遵循语义化版本，版本号是包的版本，兼容的 Harness 范围由 `engines.dsh` 声明；每次发布记录在 [`CHANGELOG.md`](CHANGELOG.md)。

### 开始界面

尚未提问的会话会得到复选框：

| 控件 | 点击 | 菜单 |
|---|---|---|
| `worktree` 复选框 | 勾选：创建 worktree 并把本会话开在里面。已在 worktree 内时取消勾选：移除本插件创建的 worktree 并回到主检出。 | — |
| 仓库名 | 打开仓库菜单 | 在文件管理器中显示 · 在 GitHub 中打开仓库 · 复制工作区路径 · 切换目录… · 在终端中打开 · 打开该仓库的其他 worktree |
| 分支名 | 打开分支菜单 | 复制分支名 · 创建 Pull Request… · 在终端中打开 |

复选框的 tooltip 会说明本项目的约定将准备什么，所以点之前就知道后果。勾选不会删除任何东西；取消勾选只移除**本插件自己创建**的检出，其他检出原样保留。

### 对话中的状态行

会话提问之后复选框消失，这一行变成状态：

| 控件 | 显示 | 菜单 |
|---|---|---|
| 仓库名 | 工作区 | 同上 |
| 分支名 | 本会话所在分支 | 复制分支名 · 复制 worktree 路径 · 创建 Pull Request… · 在终端中打开 · **移除 worktree…**（仅本插件创建的 worktree） |
| worktree 名 | 隔离的检出 | —（仅信息；移除由分支菜单负责） |
| `+N` `−M` | 工作区改动统计，悬停显示改动与未跟踪文件数 | — |

移除前一定先询问，因为它会删除目录。带未提交改动或未跟踪文件的 worktree 会被 git 拒绝，此时菜单会额外给出明确的 **丢弃改动并移除**。

非 git 目录下不渲染任何内容，因此不可用的工作区不会白白占位。

### 按项目声明 worktree 初始化

会话的工作目录在创建时就固定，而新建的 worktree 只含被跟踪文件——因此若项目的程序要读 gitignore 掉的 `database/`、虚拟环境或本地 `data/` 缓存，它在 worktree 里是跑不起来的。插件不做猜测：由**项目**在仓库根目录的 `dsh-worktree.json` 里声明自己的约定。没有该文件时，worktree 就是一个干净的全新检出，不做任何多余的事。

```json
{
  "link": [".venv", "database"],
  "linkIgnored": ["data"],
  "copy": ["config/secrets.json"],
  "setup": "uv sync --dev"
}
```

| 键 | 作用 |
|---|---|
| `link` | 用目录联接（Windows 上的 junction）把某个路径连到主检出。零成本，worktree 直接用主检出已有的那套环境。 |
| `linkIgnored` | 用于「已跟踪与未跟踪混在一起」的目录：只连接其中**被 gitignore** 的条目，被跟踪的文件仍来自 git。什么算「被 gitignore」由 `git status --ignored` 决定，插件不重新实现匹配规则。 |
| `copy` | 复制而非连接，用于 worktree 需要独立副本的路径。 |
| `setup` | 在新建 worktree 内执行的 shell 命令（`npm install`、`uv sync`、`make bootstrap`）。 |
| `setupTimeoutMs` | `setup` 的时间预算；默认 15 分钟。 |

目录用联接，文件在文件系统允许时用硬链接、否则复制。路径必须是相对路径且不得越出检出。未知键、类型错误或越界路径都会以 `bad-convention` 明确报错，因此拼写错误会被报告而不是被静静忽略。初始化不会让创建失败：已存在但尚未准备好的检出仍可使用，返回值会逐条报告哪些被连接、复制或跳过，以及 setup 命令的结果。

### 配置

行配置（`cordis.patch.yml`）可选字段如下，默认值即文档所述行为。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `worktreeDir` | `.dsh/worktrees` | 新建 worktree 的父目录，相对**主检出**（可用绝对路径）。 |
| `branchPrefix` | `worktree-` | 新建 worktree 的分支前缀。 |
| `baseRef` | `HEAD` | 新 worktree 的分支起点。 |
| `excludeFromGit` | `true` | 把 worktree 目录追加到 `.git/info/exclude`，避免主检出把每个 worktree 报成未跟踪。 |
| `conventionFile` | `dsh-worktree.json` | 项目约定文件的文件名。 |
| `pollMs` | `15000` | Client 刷新间隔（毫秒）；`0` 表示不轮询，只靠聚焦时刷新。 |

覆盖示例：

```yaml
- id: worktree
  name: 'dsh-worktree-bar'
  config:
    worktreeDir: ../worktrees
    conventionFile: .worktree-setup.json
    pollMs: 30000
```

### worktree 的位置与开销

链接 worktree 共享仓库的对象库，因此只多一份工作区，不复制历史。`link` 条目不增加任何字节；只有 `copy` 会复制数据，而每一条都是项目自己的明确选择。除非约定要求，否则不复制任何被 gitignore 的文件；且只写 `.git/info/exclude`、不改任何被跟踪的文件——创建 worktree 不会改动任何已提交路径。

Host 空闲时不做任何事：无文件监听、无定时器、无缓存。每个请求只跑有限几条 git 命令，全部经 `execFile`——参数数组、不过 shell、20 秒超时、8 MiB 输出上限；改动统计不读取文件内容（二进制行只计入文件数，未跟踪文件只计数不读取）。Client 只在「有仓库的会话视图可见」时按 `pollMs` 刷新；非仓库目录或读取失败时完全停止轮询。唯一成本不设上界的操作是 `setup`，而它是项目自己的命令、走项目自己声明的预算。

### 浏览器准入

该路由只有在通过 `ctx.connection.admit()` 时才代表操作者——这与 Harness 自身 `/api` 桥使用同一道浏览器会话闸门：可信但未认证的请求返回 401，跨站或 Host 不符的请求返回 403。没有浏览器面的组合没有会话可要求，此时退回本地的 Host/Origin 围栏。`info` 会在 `admission` 字段里报告当前生效的是哪一种。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 源文件对照

| 路径 | 职责 |
|---|---|
| [`lib/plugin.js`](lib/plugin.js) | Host 行：`apply`、`/dsh-worktree/api` 路由表、准入、会话目录解析、交给操作系统的动作。 |
| [`lib/git.js`](lib/git.js) | 与上下文无关的 Git 层：仓库信息、worktree 列表/创建/移除、项目约定、初始化、远端 URL 与名称生成。可作为 `dsh-worktree-bar/git` 引入。 |
| [`client.js`](client.js) | 浏览器半边：`conversation.input.dock` 条目——开始界面复选框、对话状态行、菜单与语言字典。 |
| [`index.js`](index.js) | Host 行的再导出，方便按惯例寻找入口文件的读者。 |
| [`test/*.test.mjs`](test) | Git 层、初始化、Host 路由表与 Client 渲染四套用例，`npm test` 直接运行（无测试框架）。 |
| [`cordis.patch.yml`](cordis.patch.yml) | bundle 的唯一一条 `insert` 行。 |

### API

一条带闸门的 JSON 路由 `POST /dsh-worktree/api/<method>`，返回 `{ ok: true, value }` 或 `{ ok: false, error: { code, message } }`：

| 方法 | 请求 | 响应 |
|---|---|---|
| `info` | `{ sessionId, cwd? }` | 仓库、分支、检出类型、改动统计、worktree 列表、项目约定、本行配置、插件身份与生效中的准入方式 |
| `worktree.create` | `{ sessionId, name?, cwd?, seed? }` | `{ path, name, branch, baseRef, repoRoot, excluded, seeded }` |
| `worktree.remove` | `{ sessionId, path, force?, deleteBranch?, cwd? }` | `{ path, branch, branchDeleted, linksRemoved, leftovers }` |
| `open.external` | `{ action: 'reveal' \| 'terminal' \| 'url', path \| url }` | `{ ok: true }` |

会话只用 id 寻址，目录由 Host 解析——优先活会话的 header，其次会话持久化，最后是 Client 自带的列表摘要目录——因此请求体永远无法把 git 命令指向任意目录。`worktree.remove` 还会先证明目标是该仓库的 worktree 且不是主检出；单独一个路径永不被信任。

### 为什么这一行有两种形态

Harness 在会话创建时就固定其工作目录：Workspace 注册表无法搬移活会话，`ctx.sessions.create({ workspaceId })` 是把会话放进某个目录的唯一方式。因此只有开始界面能让「在 worktree 里工作」意味着「这个会话」。插件通过插槽自带的 `useSession` 钩子读 `session.blank` / `session.promptAttempted` 来判断自己是否在这个界面上。勾选执行 Harness 允许的两步：创建检出，然后在其中打开会话。一旦有了提问，会话就无法搬移，这一行随之变成信息，而移除操作移到两种形态都存在的分支菜单里。

### 哪些名字故意保持原样

包名现在叫 `dsh-worktree-bar`，但有三处刻意不改，因为改了会破坏使用者手上已有的东西：

| 名字 | 为什么保留 |
|---|---|
| 路由路径 `POST /dsh-worktree/api/<method>` | 它是 Client 与 Host 之间的共享契约。Client 半边每次页面加载都会重新下发，而 Host 模块要活到重启，改了前缀会让两者在中间这段时间里对不上。 |
| 约定文件 `dsh-worktree.json` | 它是**你的仓库**里的文件，可能已经提交。这个文件名描述的是概念，不是本包；不该因为插件改了包名就让项目去改文件名。 |
| `.git/info/exclude` 里的标记（`# dsh-worktree`）与 `dshwt-` 类名前缀 | 它们已经被写进仓库文件与样式表；改名只会产生重复的块，而它们对使用者不可见。 |

凡是人会输入或读到的东西——包名、安装命令、仓库地址、语言命名空间、`dsh-worktree-bar/git` 子路径、`info` 里的身份——都已经是新名字。

### 布局锚点

`git rev-parse --show-toplevel` 回答的是「目录所在的那个检出」，在链接 worktree 内就是该 worktree 本身。因此所有布局决策都锚定**主检出**——`git worktree list` 保证它列在第一条——于是已经在 worktree 里的会话会把新 worktree 建在同一处的兄弟位置，`info` 里的 `repoRoot` 也始终表示用户启动时的那个仓库。路径同一性比较使用 realpath 规范化形式，因为 Windows 短名（`C:\PROGRA~1`）与长名是同一个目录。

### 联接，以及为什么移除是安全的

junction 是目录重解析点：`git worktree remove` 会删除检出内的文件，但从不穿过联接——插件的用例通过「移除后重新读取被共享的文件」来断言这一点。真正需要当心的是在 Windows 上对 junction 直接 `fs.rm`，它可能删掉目标内容；因此清理器对链接本身用 `rm`、对目录用 `rmdir`（非空即拒绝）。`git worktree remove` 还会留下重解析点与空的 worktree 目录，于是 `cleanWorktreeLinks` 随后清扫——同样只处理链接与空目录，绝不穿过链接。

### Client 注册

浏览器半边注册一个懒加载模块（`dsh.client.platform: web`、`immediately: true`），并通过 `ctx.slots.inject('conversation.input.dock', …)` 在 `order: 30` 贡献条目，排在自带的 todo / goal / queue 之后。它用输入框自身的布局变量（`--dsh-composer-card-max-width`、`--dsh-composer-side-clearance`、`--dsh-composer-dock-inset`）确定宽度，从而与输入卡片对齐，而不是铺满整个会话列。它会等待 `slots`、`locale`、`workspaces` 与 `uiWorkspace`，且不引入任何 Harness Client 包：React 来自模块表，颜色只取 `--dsw-alias-*` token，文案注册在自己的 `dsh-worktree-bar` 语言命名空间（`en`、`zh`）。Host 行对外暴露 `dsh-worktree-bar/git` 供其他插件复用；不依赖任何其他插件。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- Harness 自带的 **`cordis-plugin-development`** skill（位于 `@deepseek-ai/dsh-agent-preset`）——bundle manifest、Host 导出形式、Client slot 注册，以及本包遵循的各项实践。
- **`cordis_inspect_list` / `cordis_inspect_query`**——实时的 Service、Event、Slot 与 Theme 事实；用 `Slots.listSubTree` 查 `conversation.input.dock` 可看到本条目与自带占用者并列。
- **`git help worktree`**——本行所自动化的底层操作。

-----

<a id="model-experience"></a>
## 模型侧体验

### 模型能看到什么

什么都没有。本 bundle 不注册工具、不注入提示词、不写会话事件：这一行是给人用的控件，模型只会观察到它所运行的那个会话的后果（工作目录，以及随之而来的仓库状态）。这里刻意不提供面向模型的 worktree 工具——选择**人**正在看哪个检出，不是模型该做的决定。

#### Token 影响

每个请求零额外 token。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **复选框只能开启会话，不能搬移会话**——会话工作目录在 Harness 里是创建期数据，所以开始界面上的「在 worktree 里工作」意味着「先建 worktree，再把会话开进去」。进行中的对话无法迁移，本包也不假装可以。
- **worktree 是某个提交的全新检出**——`baseRef` 默认 `HEAD`，未提交的改动留在主检出。未跟踪的初始化内容只按项目约定的范围共享或复制。
- **`link` 是双向的**——连接一个目录意味着 worktree 与主检出在该路径上是同一个目录。对虚拟环境或本地数据库这正是目的，也正因此才需要 `copy` 来处理不能共享的东西。
- **没有自动清理**——创建的 worktree 一直存在，直到从它自己的菜单或复选框移除；既没有按时间的清扫，也不在 git 元数据里打标记。
- **行数统计不含未跟踪文件**——`+N`/`−M` 来自 `git diff HEAD --numstat`；未跟踪文件只出现在悬停提示的文件计数里，因为统计它们的行数意味着每次轮询都要读一遍文件。
- **Host 改动需要重启**——被替换的包每个进程只加载一次 JavaScript，只有 Client 半边能靠页面加载热更新。
- **子代理共享会话目录**——没有按子代理的 worktree；隔离会话的每个子代理都在同一检出中运行，而该检出本身已与主检出隔离。
- **不支持非 git 版本控制**——非 git 仓库下该行不出现。

<a id="dev-note"></a>
### 维护者备注

<details>
<summary>维护者工作上下文——点击展开</summary>

`npm test` 不依赖测试框架或外部依赖，依次跑四套用例：

- `test/git.test.mjs`——在一次性仓库上验证 Git 层：解析、realpath 同一性、从子目录与从 worktree 内部的布局锚定、脏/锁定/主检出的移除拒绝，以及创建后主检出的 porcelain 输出。
- `test/seed.test.mjs`——在一个形态贴近真实项目的仓库上验证项目约定：约定的解析与坏约定拒绝、link/copy/linkIgnored 的落实、被跟踪文件仍来自 git、setup 命令，以及「移除会清掉链接且不碰任何被共享内容」这一保证。
- `test/host.test.mjs`——在假的 Cordis 上下文上验证路由表：准入分支、回退围栏、请求形状错误、会话目录解析，以及 create → info → remove 的完整来回。
- `test/client.test.mjs`——用 `test/react-shim.mjs`（最小 React 与 DOM 替身）渲染浏览器半边，断言两种形态、每个菜单，以及各控件产生的端点调用顺序。

写替身是因为部署环境不向插件提供 React 或 DOM，Host 侧工具也无法驱动页面；它刻意保持很小（函数组件、按依赖跳过的 hooks、不做 reconciliation），不是通用 React。

改动行为前值得复核的三条 Harness 事实：会话工作目录是创建期元数据（`@deepseek-ai/dsh-session`）；插件路由的规范准入是 `ctx.connection.admit`（`@deepseek-ai/dsh-client-connection`）；被替换包的 Host 代码只在重启时加载（本 profile 中 HMR 行的模块监听根为空）。

本项目的 README 配对没有 `README.i18n.yaml`：那是 Harness monorepo 的翻译配对记录，由它自己的工具生成，本独立项目不运行该工具。

</details>

**运行时不变式：** 未发布。本包只拥有一张路由表，在 `ctx.effect` 中注册、随行一起被 Loader 释放；不写持久状态，也不持有跨插件状态。
