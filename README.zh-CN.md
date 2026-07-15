# Telegram CLI

[项目网站](https://will-17173.github.io/telegram-cli/zh-CN/) · [Telegram CLI 使用文档](https://will-17173.github.io/telegram-cli/zh-CN/docs/) · [English README](README.md)

Telegram CLI 是一个 TypeScript 命令行界面（CLI），统一处理 Telegram 在线数据、本地 SQLite 搜索和远端管理。它的目标是成为面向人和 AI agent 的最强 Telegram CLI，让你通过同一个 `tg` 命令稳定访问 Telegram。账号会话与同步消息保留在本机。

## Telegram CLI 的亮点

Telegram CLI 将在线读取、本地持久化、文件归档、实时监听、远端写入、群组管理、账号隔离、本地 Web 界面和结构化输出放进同一个工具。

它专为 AI agent 设计：

- **稳定的命令契约**：有限结果命令支持 JSON、YAML、Markdown、退出状态和稳定错误码
- **本地优先的数据访问**：同步消息保存在 SQLite，agent 可以搜索和分析 Telegram 历史，而无需反复联网读取
- **明确的账号控制**：`--account` 可以为单次命令选择预期会话
- **写操作安全边界**：写操作总开关将只读自动化与修改 Telegram 的命令分开
- **Agent skill 支持**：`using-telegram-cli` skill 会指导受支持的 agent 完成认证、同步、查询，并避开不安全写操作

## 阅读完整文档

阅读 [Telegram CLI 完整使用文档](https://will-17173.github.io/telegram-cli/zh-CN/docs/)，了解安装、工作流、全部命令、自动化、安全边界和故障排查。

## 选择 Telegram 工作流

请根据数据新鲜度、结果去向以及命令是否修改 Telegram 来选择工作流。

### 读取 Telegram 当前数据

需要最新的服务端状态时，请使用在线命令。这些命令不会把返回消息写入 SQLite。

```sh
tg inbox
tg read @team --since 2h
tg search-online "incident" --chat @team --json
```

你还可以在线查看联系人、通知设置、文件夹和群组详情，且不会导入消息。

### 建立可搜索的本地消息库

将一个或多个聊天同步到所选账号的 SQLite 数据库。之后无需连接 Telegram，即可搜索和分析本地副本。

```sh
tg sync @team
tg search "release" --chat @team
tg recent --chat @team --hours 24
```

本地命令还可以筛选、汇总和导出已存储消息。

### 在 Web 界面浏览本地数据

启动仅限本机访问的管理界面来浏览已存储消息：

```sh
tg web
```

服务器只绑定 `127.0.0.1`，没有登录页面，仅供本机使用。它可以浏览本地 SQLite 数据，并为当前选中的聊天触发只读同步。

### 监听新消息并下载文件

`listen` 可以实时接收一个或多个聊天的新消息。它还可以下载收到的附件，并在交互模式中执行回复或群组操作。

```sh
tg listen @team --auto-download
```

### 保存增量 Markdown 归档

`archive` 将消息增量写入 Markdown，并可同时下载媒体文件。它单独记录归档进度，不会填充 SQLite。

```sh
tg archive @team --download-media
```

后续运行会追加新消息，并重试仍然缺失的引用媒体。

### 发送消息并管理群组

你可以从终端发送文本、文件或带说明文字的媒体组，也可以查看和管理群成员、管理员、邀请链接、论坛话题和消息。

```sh
tg send @team "Release is ready" --file ./report.pdf
tg group members @team --type admins
tg group member mute @team @alice 2h --yes
```

Telegram CLI 还可以管理联系人、通知设置和聊天文件夹。写操作总开关会控制修改 Telegram 的命令。

### 跨隔离账号运行自动化

每个已添加账号都有独立的会话和 SQLite 数据库。你可以为单次命令选择账号，且不会改变默认账号。

```sh
tg stats --account work --json
```

有限结果命令支持 JSON、YAML 和 Markdown 输出。失败时会返回非零退出状态和稳定错误码。

## 安装

安装 Node.js 22.12.0 或更高版本，再从 npm 安装 Telegram CLI：

```sh
npm install -g @will-17173/telegram-cli
```

## 开始使用

认证一个账号，列出聊天，同步一个聊天，再搜索本地消息：

```sh
tg account add
tg status
tg chats
tg sync @team
tg search "release" --chat @team
```

请将 `@team` 替换为聊天名称、用户名或数字标识符（ID）。运行 `tg --help` 或 `tg sync --help` 等具体命令查看可用选项。

## 了解数据去向

运行命令前，先检查它的执行范围：

| 范围 | 命令 | 结果 |
| --- | --- | --- |
| 在线读取 | `inbox`、`read`、`search-online` | 查询 Telegram，不保存返回的消息。 |
| 写入本地 | `history`、`sync`、`sync-all`、`refresh` | 将消息保存到所选账号的 SQLite 数据库。 |
| 仅本地 | `search`、`recent`、`stats`、`export`、`web` | 读取本地 SQLite，不连接 Telegram。 |
| 文件归档 | `archive` | 读取 Telegram 并写入 Markdown 或媒体文件，不写入 SQLite。 |
| 远端写入 | `send`、`edit`、`delete`，以及通知、文件夹和群组操作 | 修改 Telegram 消息或设置。 |

每个账号都有独立的会话和 SQLite 数据库。添加 `--account work` 可以为单次命令选择账号，且不会改变默认账号。

## 保护远端数据

在只读工作流或自动化任务前关闭远端写入：

```sh
tg config write-access off
tg config write-access status
```

准备再次修改 Telegram 时，运行 `tg config write-access on`。打开总开关不代表已授权某一项具体写操作。

请妥善保管 Telegram 应用程序接口（API）凭据、代理凭据、会话文件、SQLite 数据库、导出文件和归档。

## 配合编程智能体

脚本或编程智能体需要结构化输出时，请使用 JSON 或 YAML：

```sh
tg search "release" --account work --json
```

命令失败时会返回非零退出状态和稳定错误码。显式传入 `--account` 可以让自动化任务使用预期账号。

在受支持的编程智能体中安装 [`using-telegram-cli` agent skill](https://skills.sh/will-17173/telegram-cli/using-telegram-cli)：

```sh
npx skills add https://github.com/will-17173/telegram-cli \
  --skill using-telegram-cli
```

该技能涵盖认证、同步、查询和写操作安全流程。

## 开发

请使用 pnpm 和 Node.js 22.12.0 或更高版本：

```sh
pnpm install
pnpm dev --help
pnpm test
pnpm typecheck
pnpm build
```

## 许可证

本项目采用 [GPL-3.0-only](LICENSE) 许可证。
