# Telegram CLI

[English](README.md)

一个 TypeScript 命令行客户端，用于同步 Telegram 聊天记录、监听实时消息、搜索本地存储的消息，并在终端中查看群组信息。

## 功能

- 登录 Telegram，并查看当前账户或可用聊天列表。
- 管理多个 Telegram 账号，每个账号使用独立的会话和消息数据库。
- 将聊天记录提取到本地 SQLite 数据库，以便快速离线搜索。
- 通过增量同步和批量同步命令更新本地数据。
- 监听实时消息，并可选显示附件摘要。
- 从限制下载的频道中下载附件。
- 搜索、筛选、汇总和导出本地存储的消息。
- 通过命令行发送、编辑和删除消息。
- 查看并管理群组、成员、管理员、邀请链接、论坛话题和消息。
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
warning: using default Telegram API credentials, which have stricter flood limits and may trigger FLOOD_WAIT during frequent or large requests. Run tg config set --api-id <id> --api-hash <hash> to configure your own.
```

这表示 CLI 正在使用限制更严格的默认凭据；频繁请求或大量同步可能触发 `FLOOD_WAIT`。如需配置自己的凭据，请运行 `tg config set --api-id <id> --api-hash <hash>`。只设置 `TG_API_ID` 或 `TG_API_HASH` 其中之一会导致错误。已保存的配置文件格式错误或无法读取也会导致错误；这两种情况下 CLI 都不会改用内置凭据。

个人凭据会作为敏感配置存储在本地，切勿与他人分享。所有已添加账号共用一套 API 凭据，但每个账号都有独立的身份验证会话。

如需为 Telegram 连接持久化配置代理，请运行：

```sh
tg config set --proxy socks5://127.0.0.1:1080
```

如需仅覆盖单次命令，可在该命令的环境中设置 `TG_PROXY`：

```sh
TG_PROXY=http://127.0.0.1:8080 tg status
```

支持的代理形式包括 `socks4://`、`socks5://`、`http://` 和 `https://` 代理 URL，以及 `tg://proxy?...` 和 `https://t.me/proxy?...` 形式的 MTProxy 链接。去除首尾空白后，非空的 `TG_PROXY` 值会覆盖持久化代理；如果 `TG_PROXY` 为空或未设置，CLI 会回退到已保存的代理；如果两者均未配置，则直接连接。

所选代理会应用于账号登录和所有需要连接 Telegram 的命令，并非只应用于示例中的单个命令。代理 URL 可能包含用户名和密码或 MTProxy secret，因此应视为敏感信息。CLI 输出不会打印已配置的代理 URL。在命令行中直接输入包含凭据的代理 URL，可能会使其留在 shell 历史记录中，或通过进程检查被看到。请通过受到适当保护的环境或 secret 加载机制提供 `TG_PROXY`，或以其他方式避免将明文 secret 写入共享的 shell 历史记录和脚本。

如需以人类可读、JSON 或 YAML 格式查看生效配置，请运行：

```sh
tg config list
tg config list --json
tg config list --yaml
tg config list --show-secrets
```

该命令报告的是生效配置，而非 `config.json` 的原始内容。API 凭据会依次从环境变量、已保存配置和内置默认值中解析。代理则独立解析，依次使用 `TG_PROXY` 和已保存配置；两者均未配置时，代理保持缺省状态。

输出恰好报告五个字段：生效的 API ID、API hash、凭据来源、代理 URL 以及代理来源。API hash 默认脱敏；使用 `--show-secrets` 可显示完整值。代理 URL 始终完整输出，并可能包含凭据或 MTProxy secret，因此请勿将 `config list` 输出写入日志或与他人分享。`tg config list` 不会创建 Telegram 客户端，也不会发起网络连接。

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

## 发送消息和附件

`send` 必须指定 `<chat>`。可以发送纯文本、一个或多个文件，或带说明文字的文件：

```sh
# 仅发送文本
tg send <chat> "Text only"

# 仅发送文件；重复使用 --file，并按指定顺序发送
tg send <chat> --file ./photo.jpg --file ./clip.mp4

# 发送说明文字和文件
tg send <chat> "Group caption" --file ./photo.jpg --file ./clip.mp4
```

`--file` 可重复使用。多个文件会按指定顺序作为一个 Telegram 媒体组发送。只有提供至少一个文件时，消息文本才可省略。提供文件后，消息文本会成为媒体组的说明文字；CLI 不会另发一条纯文本消息。

Telegram 决定可接受的文件组合和媒体组数量限制。如果 Telegram 拒绝所请求的组合或数量，命令会返回错误，不会静默拆分为多条消息或多个媒体组。

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

## 群组管理

`group` 命令同时提供只读查询，以及成员、管理员、群设置、邀请链接、论坛话题和消息管理。请通过各 family 的帮助查看当前操作：

```sh
# 群组详情
tg group info <chat> --account alice --json

# 成员列表：按类型、姓名/用户名查询和结果数量筛选
tg group members <chat> --type admins --query alice --limit 50 --yaml

# 单个成员的角色、管理员权限和限制
tg group member <chat> <user>

# 管理员审计日志；--user 和 --type 均可重复指定
tg group audit <chat> --query invite --user <user> --type member_invited --type invite_changed --limit 100 --account alice --json

# 管理示例（chat 参数位于操作参数之前）
tg group member ban @team @alice --yes
tg group chat slowmode @team 30s
tg group topic --help
```

`group members` 的 `--type` 恰好支持以下七种筛选器：`recent`、`all`、`admins`、`banned`、`restricted`、`bots` 和 `contacts`。默认使用 `recent` 并返回 100 条结果；`--limit` 可设为 1 到 200。Telegram 可能返回少于其报告总数的成员，因此单页结果不保证包含整个群组的全部成员。

`group audit` 要求当前账号具有群组管理员权限。`--limit` 的范围是 1 到 500，默认返回 100 条事件。可重复的 `--user` 用于筛选操作发起者。可重复的 `--type` 恰好接受以下 17 种稳定的分组事件类型：`info_changed`、`settings_changed`、`member_joined`、`member_left`、`member_invited`、`member_banned`、`member_unbanned`、`member_restricted`、`member_unrestricted`、`admin_promoted`、`admin_demoted`、`message_deleted`、`message_edited`、`message_pinned`、`invite_changed`、`topic_changed` 和 `other`。

查询和管理操作默认输出人类可读内容；暴露 `--json` 或 `--yaml` 的操作会输出结构化成功或错误结果。失败时进程退出状态非零。命令默认使用 current 账号；`--account <name>` 可仅为本次调用选择另一个已添加账号，且不会改变 current 账号。

管理操作分为 `member`、`admin`、`chat`、`invite`、`topic` 和 `message` 六个 family。成员目标必须显式使用 `@username` 或 Telegram 数字用户 ID。时长支持 `s`、`m`、`h`、`d` 后缀；支持关闭的设置还可使用 `off`。例如 `tg group member mute @team @alice 2h --yes` 会临时禁言，`tg group chat slowmode @team off` 会关闭慢速模式。

有破坏风险的 CLI 操作在缺少 `--yes` 时会直接拒绝，且不会连接 Telegram。永久删除群组还必须用 `--confirm-title` 提供完全一致的当前群名；交互式 listen 模式则通过 Ink 弹窗确认。管理操作需要对应的管理员权限，部分操作还要求超级群组、论坛或 creator 身份。转移所有权时，如果 Telegram 要求密码，本版本只返回 `password_required`，尚不接收密码。

查询成员详情请优先使用规范路由 `tg group member info <chat> <user>`。旧形式 `tg group member <chat> <user>` 仍保留，但当群名等于 `ban`、`mute`、`info` 等保留操作名时会产生歧义，必须使用规范路由。

## Listen 中的群管理命令

交互式 `tg listen` 可使用相同语法的 slash 命令，无需重复当前群组：

```text
/member mute @alice 2h
```

输入 `/` 会打开模糊匹配菜单。使用 Up/Down 移动、Tab 补全、Enter 执行、Esc 关闭菜单、结果或确认框。有风险的操作会打开确认弹窗；删除群组还会要求输入完全一致的群名。监听多个群组时，必须先用 `--send-to <chat>` 明确发送目标，例如 `tg listen @team @ops --send-to @team`，之后才能使用群管理命令。

## 在线命令与本地命令

在线命令会连接 Telegram，因此需要有效的账号会话。这类命令包括 `status`、`whoami`、`chats`、`history`、`sync`、`sync-all`、`refresh`、`info`、全部 `group` 查询与管理 family、`send`、`edit`、`delete` 和 `listen`。

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
| `tg config set --proxy <url>` | 为账号登录及所有需要连接 Telegram 的命令保存可选代理。 |
| `tg config list [--show-secrets]` | 显示生效配置值及其来源；代理 URL 始终可见。 |
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
| `tg send <chat> [message] [--file <path> ...]` | 发送文本、文件或带说明文字的媒体组。 |
| `tg edit <chat> <msgId> <text>` | 编辑消息。 |
| `tg delete <chat> <msgIds...>` | 删除一条或多条消息。 |
| `tg purge <chat> --yes` | 移除某个聊天在本地存储的消息。 |
| `tg info <chat>` | 查看聊天元信息。 |
| `tg group info <chat>` | 查看普通群组或超级群组的只读详情。 |
| `tg group members <chat> [--type <type>] [--query <text>] [--limit <count>]` | 列出并筛选成员（默认 `recent`、100 条；最大 200 条）。 |
| `tg group member <chat> <user>` | 查看单个成员的角色、权限和限制。 |
| `tg group audit <chat> [--query <text>] [--user <user>] [--type <type>] [--limit <count>]` | 查询管理员审计日志（默认 100 条；最大 500 条）。 |

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
- 在交互式 `listen` 中，可用 `/reply <消息ID> <内容>` 回复消息；通过可重复的 `--file <路径>` 添加附件，包含空格的路径需要使用引号。
- 联系人卡片会在附件摘要中显示可用的姓名和手机号。联系人卡片不属于可下载附件，使用 `--no-media` 时不会显示。
- `listen --auto-download` 同时支持交互式和纯文本模式，附件保存在 `~/Downloads/telegram-cli`，最多同时下载 3 个附件。
- 下载时保留 Telegram 提供的文件名。无文件名时，依次根据 MIME 类型、媒体类型推断扩展名，最后回退为 `.bin`。
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

除 API 凭据外，`config.json` 文件还可能包含可选的 `proxy` 设置。CLI 的成功和错误输出不会打印已保存的代理 URL，但代理 URL 可能包含凭据或 MTProxy secret，因此仍须保护 `config.json`、环境和 shell 历史记录。

## 开发

本项目使用 pnpm：

```sh
pnpm install
pnpm dev --help
pnpm test
pnpm typecheck
```

开发时，可以将当前源码目录设置为全局 `tg` 命令，并直接运行 TypeScript 源码。在项目根目录执行：

```sh
mkdir -p ~/.local/bin
cat > ~/.local/bin/tg <<EOF
#!/bin/sh
exec "$(pwd)/node_modules/.bin/tsx" "$(pwd)/src/dev.ts" "\$@"
EOF
chmod +x ~/.local/bin/tg
rehash
```

请确保 `~/.local/bin` 已加入 `PATH`。之后执行 `tg` 时会加载最新的源码修改。

在本地进行源码开发时，请在项目根目录创建 `.env` 文件：

```dotenv
TG_API_ID=your_telegram_api_id
TG_API_HASH=your_telegram_api_hash
```

`pnpm dev` 仅在本地源码开发时加载此文件。安装后的 `tg` 不会自动加载 `.env`；如需持久化生产配置，请使用 `tg config set --api-id <id> --api-hash <hash>`。

## 许可证

采用 [GPL-3.0](LICENSE) 许可证。
