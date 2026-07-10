# Telegram CLI

[English](README.md)

一个 TypeScript 命令行客户端，用于同步 Telegram 聊天记录、监听实时消息、搜索本地存储的消息，并在终端中管理 Telegram 任务。

## 功能

- 登录 Telegram，并查看当前账户或可用聊天列表。
- 管理多个 Telegram 账号，每个账号使用独立的会话和消息数据库。
- 将聊天记录提取到本地 SQLite 数据库，以便快速离线搜索。
- 通过增量同步和批量同步命令更新本地数据。
- 监听实时消息，并可选显示附件摘要。
- 从限制下载的频道中下载附件。
- 搜索、筛选、汇总和导出本地存储的消息。
- 通过命令行发送、编辑和删除消息。
- 在支持的场景下使用人类可读输出，或结构化的 JSON/YAML 输出。

## 为 AI Agent 设计

Telegram CLI 为 AI Agent 提供基于命令的 Telegram 和本地消息访问接口。由人工通过 `tg account add` 完成账号认证后，Agent 无需操作浏览器即可执行在线命令和本地命令。

以下接口适合 Agent 工作流：

- JSON 和 YAML 输出让 Agent 直接读取结构化数据，而不是解析终端表格。
- 非零退出码和结构化错误码让 Agent 能够检测并处理失败。
- `--account <name>` 可以明确指定账号，且不会改变 current 账号。
- 本地搜索和分析命令无需重新连接 Telegram，即可查询已同步消息。

例如，Agent 可以搜索指定账号，并将结果作为 JSON 解析：

```sh
tg search "release" --account work --json
```

## 安装

Telegram CLI 需要 Node.js 22 或更高版本。

在该软件包发布到 npm 后，可通过以下命令全局安装：

```sh
npm install -g @will-17173/telegram-cli
```

## 配置

配置个人 Telegram API 凭据是可选的。如需使用自己的凭据，请先在 [my.telegram.org](https://my.telegram.org) 创建，然后通过以下命令保存：

```sh
tg config set --api-id <id> --api-hash <hash>
```

如果 `TG_API_ID` 和 `TG_API_HASH` 均未设置，且已保存的配置文件不存在，CLI 会使用内置的 Telegram API 凭据。创建 Telegram 客户端时，每个进程只会向 stderr 输出一次以下警告：

```text
warning: using default Telegram API credentials. Run tg config set --api-id <id> --api-hash <hash> to configure your own.
```

这表示 CLI 正在使用默认凭据；如需配置自己的凭据，请运行 `tg config set --api-id <id> --api-hash <hash>`。只设置 `TG_API_ID` 或 `TG_API_HASH` 其中之一会导致错误。已保存的配置文件格式错误或无法读取也会导致错误；这两种情况下 CLI 都不会改用内置凭据。

个人凭据会作为敏感配置存储在本地，切勿与他人分享。所有已添加账号共用一套 API 凭据，但每个账号都有独立的身份验证会话。

运行 `tg account add` 完成身份验证并创建本地会话。其他命令不会启动交互式登录流程。

你可以通过环境变量修改配置、账号会话和消息数据库的根目录：

```sh
export DATA_DIR=/path/to/tg-cli-data
```

## 快速开始

```sh
# 添加并登录第一个账号
tg account add

# 检查身份验证状态
tg status

# 列出聊天，然后在出现 `<chat>` 的位置使用聊天名称、用户名或 ID
tg chats

# 将聊天记录保存到本地
tg sync <chat>

# 搜索已同步到本地的消息
tg search "keyword" --chat <chat>

# 同步全部聊天
tg sync-all --max-chats 20 --delay 1

# 监听实时消息并自动下载收到的附件
tg listen <chat-or-id> --auto-download

# 使用纯文本输出、下载附件并隐藏消息中的附件摘要
tg listen <chat-or-id> --no-interactive --auto-download --no-media

# 发送消息
tg send <chat> "Hello from tg"
```

## 多账号

每个 Telegram 账号都有独立持久化的身份验证会话和本地消息数据库。通过以下命令交互式登录并添加账号：

```sh
tg account add
```

添加的第一个账号会自动成为 current 账号。继续添加其他账号时不会自动切换 current 账号，可通过以下命令查看或更改选择：

```sh
# 列出已添加的账号
tg account list

# 查看 current 账号
tg account current

# 设置命令默认使用的账号
tg account switch <name>

# 删除账号及其本地会话和数据
tg account remove <name> --force
```

各命令默认使用 current 账号。支持 `--account` 的命令可以临时指定另一个已添加的账号，且不会改变 current 账号：

```sh
tg chats --account <name>
tg sync-all --account <name>
tg search "keyword" --account <name>
```

账号名称可通过 `tg account list` 查看，通常由 Telegram 用户名生成。各账号的会话和消息数据库分别保存在 `DATA_DIR` 下对应的账号目录中。

Telegram API 凭据对所有已添加账号生效，添加其他账号时无需单独配置 API 凭据。

## 在线命令与本地命令

在线命令会连接 Telegram，因此需要有效的账号会话。这类命令包括 `status`、`whoami`、`chats`、`history`、`sync`、`sync-all`、`refresh`、`info`、`send`、`edit`、`delete` 和 `listen`。

本地命令只读取或修改所选账号的消息数据库，不会连接 Telegram。这类命令包括 `search`、`recent`、`stats`、`top`、`timeline`、`today`、`filter`、`export` 和 `purge`。

## 命令参考

运行内置帮助以查看完整且最新的命令列表：

```sh
tg --help
```

常用命令：

| 命令 | 用途 |
| --- | --- |
| `tg account add` | 登录并添加另一个 Telegram 账号。 |
| `tg account list` | 列出已添加的账号及 current 状态。 |
| `tg account current` | 查看 current 账号。 |
| `tg account switch <name>` | 设置各命令默认使用的账号。 |
| `tg account remove <name> --force` | 删除账号及其本地会话和数据。 |
| `tg whoami` | 显示当前登录账号的基本信息。 |
| `tg config set --api-id <id> --api-hash <hash>` | 持久化保存 Telegram API 凭据。 |
| `tg status` | 检查 Telegram 账户是否已完成身份验证。 |
| `tg chats` | 列出可用聊天。 |
| `tg history <chat> -n <limit>` | 获取并保存完整聊天历史（默认最多 1000 条）。 |
| `tg sync <chat>` | 将聊天消息同步到本地存储。 |
| `tg sync-all` | 从全部聊天同步消息，按本地已同步进度做增量更新。 |
| `tg refresh` | 与 `sync-all` 相同用途的批量同步命令。 |
| `tg listen [chat ...]` | 实时监听指定聊天（或监听全部聊天）。 |
| `tg listen --no-media` | 监听时隐藏附件摘要。 |
| `tg listen <chat-or-id> --auto-download` | 监听时自动下载收到的附件。 |
| `tg search "keyword" --chat <chat>` | 搜索已存储在本地的消息。 |
| `tg recent`, `tg today`, `tg stats`, `tg top`, `tg timeline` | 浏览本地消息数据。 |
| `tg filter <keywords>` | 按关键词筛选本地消息（支持按聊天和时间范围过滤）。 |
| `tg export <chat>` | 导出本地存储的消息。 |
| `tg send <chat> "Hello from tg"` | 发送消息。 |
| `tg edit <chat> <msgId> <text>` | 编辑消息。 |
| `tg delete <chat> <msgIds...>` | 删除一条或多条消息。 |
| `tg purge <chat> --yes` | 移除某个聊天在本地存储的消息。 |
| `tg info <chat>` | 查看聊天元信息。 |

所有同步类命令都会写入本地 SQLite 数据库。`sync-all` 和 `refresh` 根据本地已保存的消息 ID 增量处理多个聊天。

许多命令支持通过 `--json` 或 `--yaml` 输出结构化数据。命令失败时会返回非零退出码，脚本无需解析人类可读文本即可判断执行结果。

常用选项：

| 选项 | 用途 |
| --- | --- |
| `--account <name>` | 临时使用已添加的账号，不改变 current 账号。 |
| `--json` / `--yaml` | 在命令支持时输出结构化数据。 |
| `-v`, `--verbose` | 启用调试日志。 |
| `-V`, `--version` | 输出当前安装版本。 |

使用 `tg <command> --help` 查看命令专用选项。例如，`listen` 支持自动重连和纯文本模式，`search` 支持发送者、时间、正则表达式和结果数量筛选。

### 同步与监听行为

- `sync-all` 和 `refresh` 是写入本地数据库的批量同步流程，不是只读命令。
- `listen` 会实时打印每条到达消息；可用 `--no-media` 关闭附件摘要显示。
- `listen --auto-download` 同时支持交互式和纯文本模式，附件保存在 `~/Downloads/telegram-cli`，最多同时下载 3 个附件。
- 下载失败会被报告，但监听器会继续运行。`--no-media` 只隐藏附件摘要；与 `--auto-download` 组合时仍会下载附件。

## 故障排查

### 没有可用的当前账号

如果命令返回 `account_required`，请添加账号或选择已有账号：

```sh
tg account add
tg account switch <name>
```

### 账号会话已经失效

如果 Telegram 返回 `AUTH_KEY_UNREGISTERED`，请删除失效的本地会话并重新登录：

```sh
tg account remove <name> --force
tg account add
```

### 默认 API 凭据警告

内置 API 凭据仍可使用，但 CLI 创建 Telegram 客户端时会输出警告。配置个人凭据即可移除该警告：

```sh
tg config set --api-id <id> --api-hash <hash>
```

通过环境变量配置时，必须同时设置 `TG_API_ID` 和 `TG_API_HASH`。只设置其中一个会导致配置错误。

## 本地数据与隐私

除非你明确复制或导出，否则持久化配置、身份验证会话和已同步消息都会保留在本机。`DATA_DIR` 下的相关文件如下：

```text
config.json
accounts.json
accounts/<name>/session
accounts/<name>/messages.db
```

请将持久化配置、`.env`、Telegram 凭据、会话文件和 SQLite 数据视为敏感信息，切勿与他人分享或将它们提交到版本控制中。

## 开发

本项目使用 pnpm：

```sh
pnpm install
pnpm dev --help
pnpm test
pnpm typecheck
```

在本地进行源码开发时，请在项目根目录创建 `.env` 文件：

```dotenv
TG_API_ID=your_telegram_api_id
TG_API_HASH=your_telegram_api_hash
```

`pnpm dev` 仅在本地源码开发时加载此文件。安装后的 `tg` 不会自动加载 `.env`；如需持久化生产配置，请使用 `tg config set --api-id <id> --api-hash <hash>`。

## 许可证

采用 [GPL-3.0](LICENSE) 许可证。
