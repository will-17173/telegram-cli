# Telegram CLI

[项目网站](https://will-17173.github.io/telegram-cli/zh-CN/) · [Telegram CLI 使用文档](https://will-17173.github.io/telegram-cli/zh-CN/docs/) · [English README](README.md)

Telegram CLI 是一个用 TypeScript 编写的命令行界面（CLI），用于在终端中读取、同步、搜索、归档和管理 Telegram。它将账号会话与同步消息保存在你的电脑上。

## 阅读完整文档

阅读 [Telegram CLI 完整使用文档](https://will-17173.github.io/telegram-cli/zh-CN/docs/)，了解安装、工作流、全部命令、自动化、安全边界和故障排查。

## 它能做什么

你可以使用 Telegram CLI：

- 管理多个账号，并隔离各账号的会话和消息数据库。
- 在线读取和搜索 Telegram，不保存查询结果。
- 将消息同步到 SQLite，用于本地搜索、分析和导出。
- 监听新消息并下载附件。
- 将聊天增量归档为 Markdown 文件。
- 发送消息，并管理联系人、文件夹、通知和群组。
- 为脚本和编程智能体输出 JSON、YAML 或 Markdown。

## 安装

安装 Node.js 22 或更高版本，再从 npm 安装 Telegram CLI：

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

请将 `@team` 替换为聊天名称、用户名或数字 ID。运行 `tg --help` 或 `tg sync --help` 等具体命令查看可用选项。

## 了解数据去向

运行命令前，先检查它的执行范围：

| 范围 | 命令 | 结果 |
| --- | --- | --- |
| 在线读取 | `inbox`、`read`、`search-online` | 查询 Telegram，不保存返回的消息。 |
| 写入本地 | `history`、`sync`、`sync-all`、`refresh` | 将消息保存到所选账号的 SQLite 数据库。 |
| 仅本地 | `search`、`recent`、`stats`、`export` | 读取本地 SQLite，不连接 Telegram。 |
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

请妥善保管 API 凭据、代理凭据、会话文件、SQLite 数据库、导出文件和归档。

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

请使用 pnpm 和 Node.js 22 或更高版本：

```sh
pnpm install
pnpm dev --help
pnpm test
pnpm typecheck
pnpm build
```

## 许可证

本项目采用 [GPL-3.0-only](LICENSE) 许可证。
