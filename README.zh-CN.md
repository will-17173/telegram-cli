# Telegram CLI

[English](README.md)

一个 TypeScript 命令行客户端，用于同步 Telegram 聊天记录、监听实时消息、搜索本地存储的消息，并在终端中管理 Telegram 任务。

## 功能

- 登录 Telegram，并查看当前账户或可用聊天列表。
- 将聊天记录提取到本地 SQLite 数据库，以便快速离线搜索。
- 通过增量同步和批量同步命令更新本地数据。
- 监听实时消息，并可选显示附件摘要。
- 搜索、筛选、汇总和导出本地存储的消息。
- 通过命令行发送、编辑和删除消息。
- 在支持的场景下使用人类可读输出，或结构化的 JSON/YAML 输出。

## 安装

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

个人凭据会作为敏感配置存储在本地，切勿与他人分享。首次运行命令时，可能会提示你完成身份验证并创建本地会话。

你也可以通过环境变量覆盖本地存储路径：

```sh
export DATA_DIR=/path/to/tg-cli-data
export DB_PATH=/path/to/messages.db
```

## 快速开始

```sh
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

# 监听实时消息（可指定多个聊天）
tg listen <chat-or-id> [another-chat ...] --no-media

# 发送消息
tg send <chat> "Hello from tg"
```

## 命令参考

运行内置帮助以查看完整且最新的命令列表：

```sh
tg --help
```

常用命令：

| 命令 | 用途 |
| --- | --- |
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
| `tg search "keyword" --chat <chat>` | 搜索已存储在本地的消息。 |
| `tg recent`, `tg today`, `tg stats`, `tg top`, `tg timeline` | 浏览本地消息数据。 |
| `tg filter <keywords>` | 按关键词筛选本地消息（支持按聊天和时间范围过滤）。 |
| `tg export <chat>` | 导出本地存储的消息。 |
| `tg send <chat> "Hello from tg"` | 发送消息。 |
| `tg edit <chat> <msgId> <text>` | 编辑消息。 |
| `tg delete <chat> <msgIds...>` | 删除一条或多条消息。 |
| `tg purge <chat> --yes` | 移除某个聊天在本地存储的消息。 |
| `tg info <chat>` | 查看聊天元信息。 |

所有同步类命令都会写入本地 SQLite 数据库，`sync-all` 和 `refresh` 可按批次处理多个聊天并支持增量同步。

说明：
- `sync-all` 和 `refresh` 是写入本地数据库的批量同步流程，不是只读命令。
- `listen` 会实时打印每条到达消息；可用 `--no-media` 关闭附件摘要显示。
- 支持真彩色的交互式终端会直接显示内嵌照片预览，无需下载原图。
- 若偶尔看到 Telegram 同步警告（如会话重置/差异计算相关信息），通常不影响命令执行结果。

许多命令支持通过 `--json` 或 `--yaml` 输出结构化数据。使用 `tg <command> --help` 查看各命令的选项。

## 本地数据与隐私

已同步的消息存储在本地 SQLite 数据库中。除非你明确复制或导出，否则持久化配置、身份验证会话和本地数据都会保留在你的设备上。

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
