# Telegram CLI

[English](README.md)

一个 TypeScript 命令行客户端，用于同步 Telegram 聊天记录、监听实时消息、搜索本地存储的消息，并在终端中查看群组信息。

## 你可以做什么

- 管理多个 Telegram 账号，并隔离各账号的会话和消息数据库。
- 将聊天记录同步到 SQLite，用于离线搜索、筛选、分析和导出。
- 监听实时消息并下载收到的附件。
- 通过命令行发送、编辑和删除消息。
- 查看并管理群组、成员、管理员、邀请链接和论坛话题。
- 在脚本和智能体工作流中使用人类可读输出，或结构化的 JSON 和 YAML 输出。

## 为 AI 智能体设计

Telegram CLI 为 AI 智能体提供基于命令的 Telegram 和本地消息访问接口。通过 `tg account add` 完成账号认证后，智能体无需操作浏览器即可执行在线命令和本地命令。

以下接口适合智能体工作流：

- JSON 和 YAML 输出让智能体直接读取结构化数据，而不是解析终端表格。
- 非零退出码和结构化错误码让智能体能够检测并处理失败。
- `--account <name>` 可以明确指定账号，且不会改变当前账号。
- 本地搜索和分析命令无需重新连接 Telegram，即可查询已同步消息。

例如，智能体可以搜索指定账号，并将结果作为 JSON 解析：

```sh
tg search "release" --account work --json
```

### Agent Skill

安装 [`using-telegram-cli`](https://skills.sh/will-17173/telegram-cli/using-telegram-cli) 技能，可以指导受支持的 AI 编程智能体完成账号认证、消息同步与查询、结构化输出自动化，并安全处理 Telegram 写操作：

```sh
npx skills add https://github.com/will-17173/telegram-cli \
  --skill using-telegram-cli
```

如需让技能跨项目可用，请添加 `--global`，避免将其安装到当前项目中。

## 安装

Telegram CLI 需要 Node.js 22 或更高版本。

通过 npm 全局安装：

```sh
npm install -g @will-17173/telegram-cli
```

## 快速开始

登录账号、检查状态并列出聊天：

```sh
tg account add
tg status
tg chats
```

从 `tg chats` 的结果中选择聊天名称、用户名或 ID，然后同步并搜索消息：

```sh
tg sync <chat>
tg search "keyword" --chat <chat>
```

你还可以批量同步聊天、监听实时消息或发送消息：

```sh
tg sync-all --max-chats 20 --delay 1
tg listen <chat-or-id> --auto-download
tg send <chat> "Hello from tg"
```

## 在线读取与管理 Telegram

`history`、`sync` 和 `sync-all` 会从 Telegram 获取消息，并持久化到本地 SQLite 数据库。相比之下，`read`、`search-online` 和 `inbox` 直接查询 Telegram，只返回临时结果，不会写入本地消息数据库。`inbox` 只列出有未读消息的聊天，不会把任何消息标记为已读。

```sh
tg inbox --markdown
tg read @team --since 7d --until 2d
tg search-online release --chat @team --json
```

时间边界支持以 `s`、`m`、`h`、`d` 或 `w` 结尾的相对时长（如 `7d`），也支持包含时区的 ISO 时间戳（如 `2026-07-13T00:00:00Z` 或 `2026-07-13T08:00:00+08:00`）。相对值表示命令启动前的对应时长；`--since` 必须早于 `--until`。

联系人、通知设置、文件夹，以及普通群组、超级群组或频道对话框也可以通过在线命令操作：

```sh
tg contact info +8613800000000
tg notification mute @team 8h
tg folder chat add Work @team
tg group list --admin
```

文件夹命令接受标题或数字文件夹 ID。标题不一定唯一：请先运行 `tg folder list`，然后在 `folder info` 和 `folder chat add/remove` 中优先使用返回的文件夹 ID，脚本中尤其如此。

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

Telegram CLI 支持 SOCKS4、SOCKS5、HTTP、HTTPS 和 MTProxy。代理会应用于账号登录和所有需要连接 Telegram 的命令。包含凭据的代理 URL 应视为敏感信息。

如需以人类可读、JSON 或 YAML 格式查看生效配置，请运行：

```sh
tg config list
tg config list --json
tg config list --yaml
tg config list --show-secrets
```

该命令报告的是生效配置，而非 `config.json` 的原始内容。API hash 默认脱敏；使用 `--show-secrets` 可显示完整值。

运行 `tg account add` 完成身份验证并创建本地会话。其他命令不会启动交互式登录流程。

你可以通过环境变量修改配置、账号会话和消息数据库的根目录：

```sh
export DATA_DIR=/path/to/tg-cli-data
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

## 将聊天归档为 Markdown

`archive` 必须指定范围：传入一个或多个聊天 ID/用户名，或使用 `--all`，两者不能同时使用。命令默认使用当前账号，并写入该账号数据目录下的 `archive`；可用 `--account <name>` 临时选择账号，用 `--output <路径>` 修改输出目录。

```sh
# 首次归档并下载附件：此前七天
tg archive @team --download-media

# 自定义范围（相对时长或带时区的 ISO 时间）
tg archive @team --since 30d --until 2026-07-13T00:00:00Z

# 归档所有聊天的完整可用历史并下载附件
tg archive --all --full --download-media
```

首次运行默认归档此前恰好七天。`--since` 和 `--until` 用于自定义范围；`--full` 取消起始时间限制，不能与 `--since` 同时使用。后续运行采用增量模式：清单和 Markdown 中的消息标记会共同恢复已归档的最大消息 ID，即使两者游标不一致也可继续。`--rebuild` 会替换 Markdown 文件；未指定新范围或 `--full` 时，会复用清单记录的初始范围。`--download-media` 将可下载附件保存到归档目录的 `media/` 下，并在增量恢复时重试标记中引用但缺失的附件。

任一聊天或附件失败时，命令返回 `archive_partial_failure`，保留其他聊天的成功结果，并以状态码 1 退出。自动化场景建议使用 `--json` 或 `--yaml`，检查 `completed`、`failed` 和 `warnings`。

归档可能发起大量 Telegram 历史和媒体请求，因此可能遇到 flood wait 或其他速率限制。媒体下载可独立失败：已成功归档的消息和聊天仍保留在磁盘上，警告会指出失败的附件，任何部分失败仍会导致非零退出码。

## 多账号

每个 Telegram 账号都有独立持久化的身份验证会话和本地消息数据库。通过以下命令交互式登录并添加账号：

```sh
tg account add
```

添加的第一个账号会自动成为当前账号。继续添加其他账号时不会自动切换，可通过以下命令查看或更改选择：

```sh
# 列出已添加的账号
tg account list

# 查看当前账号
tg account current

# 从交互式列表中选择默认账号
tg account switch

# 按名称设置默认账号
tg account switch <name>

# 删除账号及其本地会话和数据
tg account remove <name> --force
```

如需结束远端会话但保留已添加账号、账号设置和本地消息，可显式登出；`--yes` 可在非交互环境中确认登出。登录已登出的账号是需要 TTY 的交互式重新认证流程，会创建或替换其本地 Telegram 会话；脚本和非交互智能体会收到稳定错误码 `interaction_required`。

```sh
tg account logout work --yes
tg account login work
```

在交互式终端中，`tg account switch` 会列出已添加账号、标记当前账号，并接受账号序号。编写脚本或使用 `--json`、`--yaml`、非交互式输入时，请传入 `<name>`。

各命令默认使用当前账号。支持 `--account` 的命令可以临时指定另一个已添加的账号，且不会改变当前账号：

```sh
tg chats --account <name>
tg sync-all --account <name>
tg search "keyword" --account <name>
```

账号名称可通过 `tg account list` 查看，通常由 Telegram 用户名生成。各账号的会话和消息数据库分别保存在 `DATA_DIR` 下对应的账号目录中。

Telegram API 凭据对所有已添加账号生效，添加其他账号时无需单独配置 API 凭据。

## 群组管理

`group` 命令同时支持只读查询，以及成员、管理员、群设置、邀请链接、论坛话题和消息管理。请通过各命令组的帮助查看可用操作：

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

`group audit` 要求当前账号具有群组管理员权限。`--limit` 的范围是 1 到 500，默认返回 100 条事件。可重复的 `--user` 用于筛选操作发起者。可重复的 `--type` 支持以下事件组：

- **群组**：`info_changed`、`settings_changed`
- **成员**：`member_joined`、`member_left`、`member_invited`、`member_banned`、`member_unbanned`、`member_restricted`、`member_unrestricted`
- **管理员**：`admin_promoted`、`admin_demoted`
- **消息**：`message_deleted`、`message_edited`、`message_pinned`
- **邀请与话题**：`invite_changed`、`topic_changed`
- **其他**：`other`

查询和管理操作默认输出人类可读内容；支持 `--json` 或 `--yaml` 的操作会输出结构化成功或错误结果。失败时进程退出状态非零。命令默认使用当前账号；`--account <name>` 可仅为本次调用选择另一个已添加账号，且不会改变当前账号。

管理操作分为 `member`、`admin`、`chat`、`invite`、`topic` 和 `message` 六个命令组。成员目标必须显式使用 `@username` 或 Telegram 数字用户 ID。时长支持 `s`、`m`、`h`、`d` 后缀；支持关闭的设置还可使用 `off`。例如 `tg group member mute @team @alice 2h --yes` 会临时禁言，`tg group chat slowmode @team off` 会关闭慢速模式。

有破坏风险的 CLI 操作在缺少 `--yes` 时会直接拒绝，且不会连接 Telegram。永久删除群组还必须用 `--confirm-title` 提供完全一致的当前群名；交互式 `listen` 模式则通过 Ink 弹窗确认。管理操作需要对应的管理员权限，部分操作还要求超级群组、论坛或群主身份。转移所有权会在确认后通过安全的交互式终端提示读取 Telegram 2FA 密码。用户和智能体绝不能自动操作该提示，也不能通过命令参数、环境变量或会被记录的输入传递密码。

查询成员详情请优先使用规范路由 `tg group member info <chat> <user>`。旧形式 `tg group member <chat> <user>` 仍保留，但当群名等于 `ban`、`mute`、`info` 等保留操作名时会产生歧义，必须使用规范路由。

## 监听模式中的斜杠命令

交互式 `tg listen` 会在同一个菜单中展示所有支持的斜杠命令，包括 `/reply` 和完整的群管理命令目录。群管理命令沿用原有语法，无需重复当前群组：

```text
/reply <消息ID> <内容>
/member mute @alice 2h
```

输入 `/` 会打开统一命令菜单，并优先显示 `/reply`。匹配顺序依次为完整匹配、前缀匹配和有序模糊匹配，因此 `/rep`、`/rpy` 都能找到 `/reply`，`/ban` 能找到 `/member ban`。使用**上方向键**和**下方向键**移动。**Tab** 补全选中的命令。**Enter** 补全未完成的命令或执行完整命令。**Esc** 关闭菜单、结果或确认框。

群管理命令原有的可用性和权限检查保持不变：不可用操作仍会禁用，有风险的操作会打开确认弹窗，删除群组还会要求输入完全一致的群名。监听多个群组时，必须先用 `--send-to <chat>` 明确发送目标，例如 `tg listen @team @ops --send-to @team`，之后才能使用群管理命令。

## 在线命令与本地命令

在线命令会连接 Telegram，因此需要有效的账号会话。`read`、`search-online` 和 `inbox` 返回临时结果；`inbox` 不会把消息标记为已读。`history`、`sync`、`sync-all` 和 `refresh` 会持久化获取到的消息。其他在线命令包括 `status`、`whoami`、`chats`、`contact`、`notification`、`folder`、`archive`、`info`、全部 `group` 查询与管理命令组、`send`、`edit`、`delete` 和 `listen`。全局在线搜索和大规模归档可能触发 Telegram flood wait 或其他速率限制。

本地命令只读取或修改所选账号的消息数据库，不会连接 Telegram。这类命令包括 `search`、`recent`、`stats`、`top`、`timeline`、`today`、`filter`、`export` 和 `purge`。

## 查看最近消息

`tg recent` 默认显示最近 24 小时内存储的 50 条消息。你可以按聊天或发送者筛选，也可以调整时间范围和数量：

```sh
tg recent --chat <chat> --sender <sender> --hours 6 --limit 100
```

人类可读输出会将每个 Telegram 媒体组合并为一行，并汇总其中的附件。`ID` 列列出该行包含的所有原始消息 ID。如果回复目标已存储在本地同一聊天中，输出会显示原消息的时间、发送者、ID 和文本。否则会标出本地缺失的消息 ID。

JSON 和 YAML 输出保留已存储消息的结构，便于脚本处理。`recent` 只读取本地 SQLite 数据，不会连接 Telegram。

## 命令参考

运行内置帮助以查看完整且最新的命令列表：

```sh
tg --help
```

常用命令：

| 命令 | 用途 |
| --- | --- |
| `tg account add` | 登录并添加另一个 Telegram 账号。 |
| `tg account list` | 列出已添加的账号及当前状态。 |
| `tg account current` | 查看当前账号。 |
| `tg account switch [name]` | 交互式选择默认账号，或按名称设置账号。 |
| `tg account remove <name> --force` | 删除账号及其本地会话和数据。 |
| `tg account logout <name> --yes` / `tg account login <name>` | 非交互确认登出，或交互式重新认证并创建新的本地会话；本地消息会保留。 |
| `tg whoami` | 显示当前登录账号的基本信息。 |
| `tg config set --api-id <id> --api-hash <hash>` | 持久化保存 Telegram API 凭据。 |
| `tg config set --proxy <url>` | 为账号登录及所有需要连接 Telegram 的命令保存可选代理。 |
| `tg config list [--show-secrets]` | 显示生效配置值及其来源；代理 URL 始终可见。 |
| `tg config write-access [status\|on\|off]` | 查看或控制远端 Telegram 写操作权限。 |
| `tg status` | 检查 Telegram 账户是否已完成身份验证。 |
| `tg chats` | 列出可用聊天。 |
| `tg inbox` | 在线列出未读聊天，且不把消息标记为已读。 |
| `tg read <chat> [--since <time>] [--until <time>]` | 读取 Telegram 最近消息，不持久化到本地。 |
| `tg search-online <query> [--chat <chat>]` | 在 Telegram 全局或单个聊天内搜索，不持久化结果。 |
| `tg contact list` / `tg contact info <user_or_phone>` | 列出联系人，或按 ID、用户名、手机号查询联系人。 |
| `tg notification info/mute/unmute <chat>` | 查看或修改 Telegram 通知设置。 |
| `tg folder list/info/chat --help` | 查找文件夹，并查看或修改其中显式包含的聊天。 |
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
| `tg archive <chat ...>` / `tg archive --all` | 将指定聊天或全部聊天增量归档为 Markdown 文件。 |
| `tg send <chat> [message] [--file <path> ...]` | 发送文本、文件或带说明文字的媒体组。 |
| `tg edit <chat> <msgId> <text>` | 编辑消息。 |
| `tg delete <chat> <msgIds...>` | 删除一条或多条消息。 |
| `tg purge <chat> --yes` | 移除某个聊天在本地存储的消息。 |
| `tg info <chat>` | 查看聊天元信息。 |
| `tg group info <chat>` | 查看普通群组或超级群组的只读详情。 |
| `tg group list [--admin]` | 列出普通群组、超级群组和频道对话框；`--admin` 仅保留自己管理或拥有的聊天。 |
| `tg group members <chat> [--type <type>] [--query <text>] [--limit <count>]` | 列出并筛选成员（默认 `recent`、100 条；最大 200 条）。 |
| `tg group member <chat> <user>` | 查看单个成员的角色、权限和限制。 |
| `tg group audit <chat> [--query <text>] [--user <user>] [--type <type>] [--limit <count>]` | 查询管理员审计日志（默认 100 条；最大 500 条）。 |
| `tg group member/admin/chat/invite/topic/message --help` | 按类别查找群组管理操作。 |

所有同步类命令都会写入本地 SQLite 数据库。`sync-all` 和 `refresh` 根据本地已保存的消息 ID 增量处理多个聊天。

有限结果命令明确支持 `--json`、`--yaml` 和 `--markdown` 输出。未明确指定格式时，输出到非 TTY 仍默认使用 YAML；交互式终端使用富文本人类可读输出。`listen` 是无界数据流，不属于这些有限结果输出格式。命令失败时会返回非零退出码，脚本无需解析人类可读文本即可判断执行结果。

常用选项：

| 选项 | 用途 |
| --- | --- |
| `--account <name>` | 临时使用已添加的账号，不改变当前账号。 |
| `--json` / `--yaml` / `--markdown` | 为有限结果命令选择 JSON、YAML 或 Markdown 输出。 |
| `-v`, `--verbose` | 启用调试日志。 |
| `-V`, `--version` | 输出当前安装版本。 |

使用 `tg <command> --help` 查看命令专用选项。例如，`listen` 支持自动重连和纯文本模式，`search` 支持发送者、时间、正则表达式和结果数量筛选。

### 错误码

结构化输出会在 `error.code` 中提供稳定的顶层命令错误码，并在可用时附带操作相关详情：

- **账号：** `account_logged_out`、`account_identity_mismatch`、`interaction_required`
- **联系人：** `contact_not_found`
- **通知和文件夹：** `invalid_notification_duration`、`folder_not_found`、`ambiguous_folder`、`folder_operation_unsupported`
- **群组所有权：** `password_required`、`password_invalid`
- **归档：** `archive_account_mismatch`、`archive_failed`、`archive_partial_failure`。附件失败但归档保留部分结果时，顶层错误码为 `archive_partial_failure`，命令以非零状态退出；每条媒体警告的 `archive_media_failed` 位于 `error.details.warnings[].code`。
- **写操作安全和速率限制：** `write_access_disabled`、`flood_wait`

### 远端写操作安全

运行 `tg config write-access off` 可阻止 `send`、`edit`、`delete`、通知修改、文件夹修改和群组管理等命令对 Telegram 执行变更。该开关只限制远端 Telegram 写操作；本地数据库操作、配置修改（包括重新开启写权限）和 Telegram 读取操作仍可使用。

### 同步与监听行为

以下规则说明同步、监听、回复和下载功能如何影响本地数据与终端输出。

- `sync-all` 和 `refresh` 是写入本地数据库的批量同步流程，不是只读命令。
- `listen` 会实时打印每条到达消息；可用 `--no-media` 关闭附件摘要显示。
- Telegram 媒体组会显示为一条收到的消息，并合并附件摘要。
- 回复输出会在本地原消息可用时显示其上下文，否则标出缺失的消息 ID。
- 在交互式 `listen` 中，可用 `/reply <消息ID> <内容>` 回复消息；通过可重复的 `--file <路径>` 添加附件，包含空格的路径需要使用引号。
- 联系人卡片会在附件摘要中显示可用的姓名和手机号。联系人卡片不属于可下载附件，使用 `--no-media` 时不会显示。
- `listen --auto-download` 同时支持交互式和纯文本模式，附件保存在 `~/Downloads/telegram-cli`，最多同时下载 3 个附件。
- 下载时保留 Telegram 提供的文件名。无文件名时，依次根据 MIME 类型、媒体类型推断扩展名，最后回退为 `.bin`。
- 下载失败会被报告，但监听器会继续运行。`--no-media` 只隐藏附件摘要；与 `--auto-download` 组合时仍会下载附件。

## 故障排查

按照以下步骤解决常见的账号、会话和 API 凭据问题。

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
