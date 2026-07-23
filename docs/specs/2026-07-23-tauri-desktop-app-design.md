# Tauri 桌面应用设计

**日期**: 2026-07-23
**状态**: Draft
**目标目录**: `desktop/`

## 1. 目标

把现有的 `tg` CLI（Node.js + TypeScript）打包成一个 Tauri v2 桌面应用，使非命令行用户也能通过桌面窗口使用 Telegram CLI 的本地消息浏览、Guard 控制台等能力，同时完全复用 CLI 已有的账户会话、SQLite 消息库与 Web UI。

具体目标：

- 产出一个可在 macOS 上安装运行的 `.app`（第一版 arm64 + x64）。
- 桌面应用启动后自动拉起 CLI 的 `tg web` 后端，并在原生窗口里展示现有 React Web UI（消息控制台 + Guard 控制台）。
- 完全复用 CLI 已登录的账户与已同步的本地数据，无需在桌面应用内重新登录。
- 不改动 CLI 的命令契约、服务层、存储层；改动局限在前端 API base 注入与新增 `desktop/` 打包层。

## 2. 非目标（YAGNI）

- **不在桌面应用内实现登录/认证流程。** 第一版依赖用户预先通过 CLI（`tg account add`）登录的账户。桌面应用只读取复用。后续可在 Web UI 增加账户管理。
- **不重写后端。** 不把 mtcute / 服务层移植到 Rust。CLI 以 sidecar 形式整体嵌入。
- **不支持 Windows / Linux 安装包。** 第一版仅 macOS。跨平台构建管线留待后续阶段，但代码与配置保持平台中立以便后续扩展。
- **不支持 CLI 与桌面应用同时运行同一账户。** SQLite/session 并发访问超出第一版范围，仅以文档提示。
- **不新增桌面专属功能**（系统托盘、通知中心集成、全局快捷键等）。第一版只是“Web UI 的桌面壳”。

## 3. 背景与约束

### 3.1 现有架构（探索结论）

- **CLI 入口** `src/index.ts` → `createApp()`（`src/cli/app.ts`）注册 13 个命令模块，含 `web` 与 `guard`。
- **数据目录** `getDataDir()`（`src/config/env.ts:85-90`）默认 `~/Library/Application Support/tg-cli/`，可被 `DATA_DIR` 环境变量覆盖。账户 session/DB 在 `accounts/<name>/` 下（`src/account/account-presets.ts`）。
- **Web 后端** `src/web/server.ts`：`node:http` server，硬编码 `HOST=127.0.0.1`，默认端口 `8734`，占用则递增。进程内直接 import 业务模块（`MessageDB`、`SyncService`、`createTelegramClient`）。`security.ts` 校验 `Host` 头须为 `127.0.0.1`/`localhost` 且 `Origin`（若有）同源。
- **Web 前端** `web/src/`：React + Vite，构建到 `dist/web/`（`web/vite.config.ts` 的 `outDir: '../dist/web'`）。`api.ts` 用相对路径 `fetch('/api/...')`，同源。无路由库，靠 `?guard=1` / `?lang=` query 切换视图与语言。i18n 纯前端。
- **运行时原生依赖**：仅 `better-sqlite3`（C++ addon，`build/Release/better_sqlite3.node`）。`@mtcute/node` 为纯 TS，无 `.node`。
- **构建**：`pnpm build` = `clean` + `build:web`（vite）+ `tsc -p tsconfig.build.json`（产物 `dist/`，镜像 `src/`）。Node 要求 `>=22.12.0`。

### 3.2 Tauri 集成约束

- Tauri v2 后端是 Rust，不能直接 `require` Node 代码。Node CLI 必须作为独立进程嵌入。
- Tauri sidecar 机制：`bundle.externalBin` 声明外部二进制，文件须命名 `<name>-<target-triple>[.exe]` 放在 `src-tauri/binaries/`，通过 `tauri-plugin-shell` 的 `Command::new_sidecar` 执行，权限在 `capabilities` 里配置 `shell:allow-execute`。
- Tauri 前端资产：`build.frontendDist` 指向预构建的 web 资产目录；开发期 `devUrl` 指向 dev server。
- 应用数据目录：`appLocalDataDir()` → `${localDataDir}/${bundleIdentifier}`。

## 4. 方案选择

把 Node CLI 嵌入 Tauri 有三条路：

| 方案 | 描述 | 评估 |
|---|---|---|
| A. **Portable Node + ncc bundle 作为 sidecar/resources** | 用 `@vercel/ncc` 把 CLI 打成单 JS bundle（含 better-sqlite3 的 prebuild `.node`），打包官方 portable `node` 二进制为 `externalBin` sidecar，Rust 后端 spawn `node bundle.js web --port <p>` | ✅ 推荐。原生模块兼容性最稳，复用全部 CLI 逻辑，ncc 成熟。代价：体积大（嵌入 Node 运行时 ~40MB）。 |
| B. Node SEA（Single Executable Application） | Node 22 原生 SEA 把 JS 嵌入 `node` 二进制生成单可执行文件 | ❌ Node SEA 不支持嵌入 C++ 原生 addon（`.node`），better-sqlite3 无法随 SEA 打包。排除。 |
| C. Rust 原生重写后端 | 用 Rust Telegram 库重写 mtcute + 服务层 | ❌ 工作量等于重写整个项目，违背“打包现有 CLI”初衷。排除。 |

**选定方案 A。** 原生模块是硬约束，方案 A 是唯一兼顾原生模块兼容与最小改动的路径。体积代价可接受（桌面应用预期 ~60–80MB）。

### 4.1 前端集成子方案

| 子方案 | 描述 | 评估 |
|---|---|---|
| (a) **frontendDist 嵌入 dist/web，API 走 HTTP** | Tauri 用 `frontendDist=../dist/web` 加载静态资产；前端 `api.ts` 从注入的 `__TG_API_BASE__` 构造 API URL（fallback 相对路径） | ✅ 推荐。符合 Tauri 最佳实践，静态资产走 asset protocol（快、离线），API 走 localhost HTTP。CLI `tg web` 模式零破坏（fallback）。 |
| (b) webview 直接加载 `http://127.0.0.1:<port>` | 前端零改动，但 Tauri 加载外部 HTTP URL 需绕开 frontendDist、配 CSP，且偏离 Tauri 模型 | ❌ 偏离最佳实践，长期维护差。 |

**选定子方案 (a)。** 前端改动仅限 `api.ts` 的 base URL 解析（一处），保持 CLI web 模式与桌面模式同源语义统一。

### 4.2 数据目录策略

- **默认共享 CLI 的 `tg-cli` 数据目录**：桌面应用 sidecar 不设 `DATA_DIR`，直接用 `getDataDir()` 默认路径（`~/Library/Application Support/tg-cli/`）。这样用户在 CLI 登录的账户、同步的消息在桌面应用立即可见，体验最佳。
- 文档提示：不要同时运行 CLI 与桌面应用访问同一账户（SQLite 锁竞争 / session 争用）。
- 未来可加配置项切到独立 `appLocalDataDir`，第一版不做。

## 5. 架构

```
┌──────────────────────────────────────────────────────────┐
│  Tauri App (desktop/src-tauri)                            │
│                                                            │
│  ┌──────────────┐    spawn     ┌────────────────────────┐ │
│  │  Rust 主进程  │ ───────────▶ │  Sidecar: node 进程     │ │
│  │  (main.rs)   │              │  (tg web --port <p>)    │ │
│  │              │              │  ┌──────────────────┐   │ │
│  │  - 选空闲端口  │              │  │ CLI JS bundle     │   │ │
│  │  - spawn side │              │  │ (ncc, dist-bundle)│   │ │
│  │  - health 轮询 │              │  │ + better-sqlite3  │   │ │
│  │  - 退出 kill   │              │  │   .node (prebuild)│   │ │
│  │              │              │  └──────────────────┘   │ │
│  │  注入 __TG_API_BASE__ 到 webview │  HTTP 127.0.0.1:<p>   │ │
│  └──────┬───────┘              │  /api/* (现有 REST)    │ │
│         │                       └────────────────────────┘ │
│  ┌──────▼───────────────────────────────────────────────┐ │
│  │  WebView (frontendDist = dist/web)                    │ │
│  │  React UI (消息控制台 / Guard 控制台)                  │ │
│  │  fetch(`${__TG_API_BASE__}/api/...`)                  │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                            │
│  数据: ~/Library/Application Support/tg-cli/ (共享 CLI)     │
└──────────────────────────────────────────────────────────┘
```

### 5.1 组件

| 组件 | 位置 | 职责 | 依赖 |
|---|---|---|---|
| **Rust 主进程** | `desktop/src-tauri/src/main.rs` | 选端口、spawn sidecar、health 轮询、注入 API base、退出清理、托管 webview | tauri, tauri-plugin-shell |
| **Tauri 配置** | `desktop/src-tauri/tauri.conf.json` | bundle id、frontendDist、externalBin、CSP、window、capabilities | — |
| **Capabilities** | `desktop/src-tauri/capabilities/default.json` | 授予 shell:allow-execute（限定 sidecar `node`） | — |
| **CLI JS Bundle** | `desktop/dist-bundle/index.js` | ncc 打包的 CLI 全量代码（含 web server + 命令） | ncc |
| **Portable Node** | `desktop/src-tauri/binaries/node-<triple>` | 官方 node 二进制，作为 externalBin sidecar | nodejs.org |
| **better-sqlite3 .node** | 随 ncc bundle emit | 预编译原生模块（目标平台） | better-sqlite3 prebuild |
| **前端 api.ts 改造** | `web/src/api.ts` | base URL 注入解析 | 现有 |
| **构建脚本** | `desktop/scripts/` | 下载 node、跑 ncc、拷 prebuild、触发 tauri build | pnpm |

### 5.2 数据流

1. 用户启动 `.app` → Tauri Rust 主进程 `setup`。
2. Rust 绑定一个临时 TCP 端口 `P`（绑后立即释放，传给 sidecar；sidecar 的 `tg web` 接受 `--port P`）。
3. Rust 通过 `tauri-plugin-shell` `Command::new_sidecar("node")` 执行，args = `["<resource>/dist-bundle/index.js", "web", "--port", P]`，env 不设 `DATA_DIR`（共享 CLI 目录）。
4. Rust 轮询 `http://127.0.0.1:P/api/health` 直到 `ok`（超时 30s 报错）。
5. Rust 通过 webview 初始化脚本注入 `window.__TG_API_BASE__ = "http://127.0.0.1:P"`。
6. WebView 加载 `frontendDist`（`dist/web/index.html`），前端 `api.ts` 读 `__TG_API_BASE__`，请求 `http://127.0.0.1:P/api/...`。
7. 用户操作（浏览消息、触发 sync、Guard 编辑）→ 前端 fetch → sidecar HTTP server → 进程内业务层 → SQLite/Telegram。
8. 应用退出 → Rust kill sidecar 子进程。

## 6. 详细设计

### 6.1 目录结构

```
desktop/
├── README.md
├── package.json                    # desktop 子包脚本（ncc、下载 node、tauri build）
├── scripts/
│   ├── fetch-node.ts               # 下载官方 portable node 到 binaries/
│   ├── bundle-cli.ts               # ncc 打包 src/index.ts → dist-bundle/index.js
│   └── prepare-sidecar.ts          # 组装 binaries/node-<triple> + 校验 .node
├── dist-bundle/                    # ncc 产物（gitignore）
│   └── index.js
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── build.rs
    ├── capabilities/
    │   └── default.json
    ├── binaries/                   # sidecar 二进制（gitignore）
    │   └── node-<triple>
    ├── icons/
    └── src/
        └── main.rs
```

根项目 `.gitignore` 追加：`/desktop/dist-bundle/`、`/desktop/src-tauri/binaries/`、`/desktop/src-tauri/target/`。

### 6.2 前端改造（`web/src/api.ts`）

仅改 base URL 解析，保持 CLI web 模式不变：

```ts
// 桌面模式：Tauri 注入 window.__TG_API_BASE__
// CLI web 模式：undefined，回落相对路径（同源）
// 注意：Tauri 在 webview 加载后才注入该值，故每次请求时惰性读取，
// 不能用模块顶层常量（会在注入前求值成空串）。
function apiBase(): string {
  return (
    (typeof window !== 'undefined' &&
      (window as unknown as { __TG_API_BASE__?: string }).__TG_API_BASE__) ||
    ''
  )
}

export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`)
  ...
}
// postJson / patchJson / deleteJson 同理在 path 前加 apiBase()
```

影响：`web/src/api.ts` 一处。无新依赖。CLI `tg web` 下 `__TG_API_BASE__` 不存在，行为不变。

### 6.3 Rust 主进程（`desktop/src-tauri/src/main.rs`）

核心逻辑：

```rust
// 伪代码
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let port = pick_free_port();          // 绑 127.0.0.1:0 取端口
            let bundle = resolve_resource(app, "dist-bundle/index.js");
            let sidecar = app.shell().sidecar("node")?;
            let (mut rx, child) = sidecar.args([
                bundle.to_str().unwrap(), "web", "--port", &port.to_string()
            ]).spawn()?;
            // 后台 await rx（日志）
            // 轮询 health
            spawn_health_wait(port);
            // 注入 API base
            app.get_webview_window("main").unwrap()
               .eval(&format!("window.__TG_API_BASE__='http://127.0.0.1:{}'", port))?;
            // 注册退出清理：app.on_window_event CloseRequested → child.kill()
            state::set(child);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

要点：
- **端口选择**：绑 `127.0.0.1:0` 拿系统分配端口，传给 sidecar（避免 8734 冲突）。
- **Health 轮询**：用 `reqwest`（blocking 或 tokio）轮询 `/api/health`，最多 30s，失败弹错误对话框。
- **资源路径**：`dist-bundle/index.js` 通过 `tauri.conf.json` 的 `bundle.resources` 打包，运行时 `app.path().resolve_resource`。
- **退出清理**：监听 window `CloseRequested`，`child.kill()`。另存 `Child` 到 `app.state` 防止提前 drop。
- **日志**：sidecar 的 stdout/stderr 通过 `tauri-plugin-log` 写文件，便于排查。

### 6.4 Tauri 配置（`tauri.conf.json`）要点

```jsonc
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Telegram CLI",
  "version": "0.8.1",            // 与 CLI 同步
  "identifier": "com.will17173.telegram-cli",
  "build": {
    "frontendDist": "../dist/web",   // 复用根项目 web 构建产物
    "beforeBuildCommand": "pnpm --dir .. run build:web && pnpm run bundle",
    "devUrl": "http://localhost:5173"
  },
  "app": {
    "windows": [{
      "title": "Telegram CLI",
      "width": 1200, "height": 800,
      "url": "index.html"
    }],
    "security": {
      "csp": "default-src 'self' tauri: asset:; connect-src 'self' http://127.0.0.1:*; img-src 'self' data: blob: asset: tauri:; style-src 'self' 'unsafe-inline'"
    }
  },
  "bundle": {
    "active": true,
    "targets": ["app", "dmg"],     // macOS 第一版
    "externalBin": ["binaries/node"],
    "resources": ["../dist-bundle/**/*"],
    "macOS": { "minimumSystemVersion": "11.0" }
  }
}
```

CSP 要点：`connect-src` 放行 `http://127.0.0.1:*`（动态端口）；`img-src` 放行 `data:`/`blob:`（现有 base64 缩略图）；`style-src 'unsafe-inline'`（React 内联样式）。

### 6.5 Capabilities（`capabilities/default.json`）

```jsonc
{
  "identifier": "default",
  "windows": ["main"],
  "permissions": [
    "core:default",
    {
      "identifier": "shell:allow-execute",
      "allow": [{ "name": "binaries/node", "sidecar": true, "args": true }]
    }
  ]
}
```

### 6.6 CLI 打包（ncc + prebuild）

`scripts/bundle-cli.ts`：

```ts
// 伪代码
import { build } from '@vercel/ncc'
await build('src/index.ts', {
  out: 'desktop/dist-bundle',
  minify: false,            // 保留可读性，便于排查
  sourceMap: true,
  target: 'es2022',
  // better-sqlite3 的 .node 会被 ncc 作为 asset emit 到 dist-bundle/，
  // 运行时通过相对路径 require
})
```

better-sqlite3 原生模块处理：
- ncc 会把 `better-sqlite3` 的 JS wrapper 内联，但 `.node` 二进制以 asset 形式 emit 到 `dist-bundle/`（通常 `dist-bundle/build/Release/better_sqlite3.node` 或通过 `prebuilds/`）。
- **关键风险**：ncc emit 的 `.node` 必须是目标平台的预编译版本。本地 `build/Release/better_sqlite3.node` 是当前机器架构。跨平台构建时需在目标平台跑 ncc，或用 `better-sqlite3` 的 `prebuild-install` 取目标平台 prebuild 替换。
- macOS 第一版：在 arm64 机器上 `pnpm rebuild better-sqlite3` 产生 arm64 `.node`；x64 需交叉或 x64 机器构建。**此点需 POC 验证 ncc 对 better-sqlite3 v12 的 asset emit 行为**（见 §9 风险）。

`scripts/fetch-node.ts`：从 `https://nodejs.org/dist/v22.12.0/` 下载对应平台 `node` 二进制，重命名为 `node-<triple>` 放 `src-tauri/binaries/`。`<triple>` 由 `rustc --print host-tuple` 得到（macOS arm64 = `aarch64-apple-darwin`，x64 = `x86_64-apple-darwin`）。

### 6.7 构建流程

桌面应用构建（`pnpm --dir desktop run build`）：

1. `pnpm --dir .. run build:web` → 生成 `dist/web/`（根项目现有脚本）。
2. `pnpm run bundle` → `bundle-cli.ts`：ncc 打包 CLI → `desktop/dist-bundle/index.js`（+ `.node` asset）。
3. `pnpm run fetch-node` → 下载 portable node → `desktop/src-tauri/binaries/node-<triple>`。
4. `cargo tauri build`（或 `pnpm tauri build`）→ 编译 Rust、打包 `.app` / `.dmg`，嵌入 `dist/web`、`dist-bundle`、sidecar `node`。

开发模式（`pnpm --dir desktop run tauri dev`）：
- `beforeDevCommand` 跑 `build:web`（Vite 持续 watch）+ `bundle`（ncc 一次性）。
- `devUrl` 指向 Vite dev server（根项目 `web/` 的 vite，需固定 `--port 5173`，并在 `web/vite.config.ts` 增加 `--strictPort`）。
- **sidecar 统一用 portable `node`**（与 prod 同路径，无分支）：dev 前需手动跑一次 `pnpm run fetch-node`。Rust 侧 `Command::new_sidecar("node")` 在 dev/prod 完全一致，仅 `frontendDist`（prod）vs `devUrl`（dev）不同。这避免维护两套进程拉起逻辑。

## 7. 安全考量

- **Sidecar 隔离**：仅 `binaries/node` 一个 sidecar 被 `shell:allow-execute` 授权，`args: true`（因参数含动态端口与资源路径）。前端无法通过 shell 插件执行任意命令——sidecar 标识固定为 `binaries/node`。
- **CSP**：`connect-src` 限定 `http://127.0.0.1:*`，不允许任意远程。`default-src 'self'` 限制资源来源。
- **现有 web 安全层**：sidecar 的 `security.ts` 仍校验 `Host: 127.0.0.1:<port>`。Tauri webview 发起的 fetch Origin 为 `http://tauri.localhost`（macOS）或类似——**需验证 `security.ts` 的 Origin 同源校验是否拒绝**。若拒绝，需在 `security.ts` 放行 Tauri origin（`http://tauri.localhost`、`https://tauri.localhost`）或改为只校验 Host 不校验 Origin。这是关键集成点（见 §9）。
- **数据目录权限**：沿用 CLI 现有 `config.json` 0o600、SQLite 文件权限，无新增。
- **不暴露网络**：sidecar 仍只绑 `127.0.0.1`，桌面应用不改变其绑定。

## 8. 测试策略

| 层 | 方式 |
|---|---|
| 前端 api.ts base 注入 | Vitest 单测：mock `window.__TG_API_BASE__`，断言 fetch URL；undefined 时回落相对路径。 |
| Rust 主进程 | 单测 `pick_free_port`、health 轮询逻辑（mock HTTP）。集成测试：spawn 真实 sidecar（系统 node + dev bundle），断言 `/api/health` 可达、webview 能加载。 |
| ncc bundle | 构建后跑 `node dist-bundle/index.js --version` 与 `node dist-bundle/index.js web --port <p>` 烟测，确认 better-sqlite3 加载成功、web server 起来。 |
| 端到端 | 手动：`pnpm tauri dev` 启动，确认窗口加载、账户列表可见、消息浏览、触发 sync、Guard 控制台可用。 |
| 跨架构 | macOS arm64 + x64 各构建一次 `.dmg` 烟测（x64 可借 Rosetta 或 CI runner）。 |

不引入新测试框架；Rust 侧用 `cargo test`，TS 侧沿用 Vitest。

## 9. 风险与未决项

| 风险 | 影响 | 缓解 / 结论 |
|---|---|---|
| **ncc 对 better-sqlite3 v12 的 `.node` asset emit 行为** | 打包后 sidecar 可能找不到/加载错 `.node`，启动失败 | ✅ **POC 已验证可行**（2026-07-23）：ncc CLI 正确 emit `build/Release/better_sqlite3.node`（arm64，1.9MB）+ `mtcute.wasm`/`mtcute-simd.wasm`。`node dist-bundle/index.js --version` → `0.8.1`；`node dist-bundle/index.js web --port <p>` → `/api/health` 返回 `{"ok":true}`，证明 better-sqlite3 在 bundle 内正确加载、web server 正常。无需降级方案。注意：必须用 ncc **CLI**（`ncc build`）而非 programmatic API（后者在本项目下报错）。 |
| **`security.ts` Origin 校验拒绝 Tauri webview** | 前端 fetch 全部 403 | ✅ **POC 已确认会被拒**（2026-07-23）：`security.ts:8-11` 对存在的 Origin 头要求 `=== http://<host>`；Tauri webview 跨源请求带 `Origin: http://tauri.localhost`，必被 `forbidden_origin` 拒。**需改 `src/web/security.ts` 放行 Tauri origin**（`http://tauri.localhost`、`https://tauri.localhost`），并补 `tests/web/security.test.ts`。改动同时影响 CLI，需跑 `pnpm test`。 |
| **better-sqlite3 跨架构预编译** | x64 `.app` 在 arm64 上无法用（反之亦然） | macOS 提供双架构构建；或用 `lipo` 合并 universal `.node`。第一版分别构建 arm64 / x64 两个 `.dmg`。ncc emit 的 `.node` 来自当前机器 `pnpm rebuild` 产物，故必须在目标架构机器上跑 ncc。 |
| **应用体积** | `.app` 约 60–90MB（含 Node 运行时） | 接受。ncc bundle 本身约 7.6MB（index.js 5.4MB + .node 1.9MB + wasm），加上 portable node ~40MB。未来可探索 Bun compile 作为优化。 |
| **sidecar 端口与系统冲突** | 极低（用 `:0` 动态分配） | 已用动态端口。 |
| **sidecar 崩溃后无自动重启** | 后端挂了前端报错 | 第一版仅日志 + 错误提示；自动重启留待后续。 |
| **CLI 与桌面应用并发同账户** | SQLite 锁竞争 / session 争用 | 文档明确禁止；第一版不做检测。 |

## 10. 分阶段交付

1. **Phase 1 — POC（验证技术可行性）**
   - ncc 打包 CLI，系统 node 跑 `tg web`，验证 better-sqlite3 加载、web server 正常。
   - 验证 `security.ts` 对 Tauri origin 的行为（先用 curl 模拟不同 Origin）。
   - 产出 POC 报告，确认方案 A 可行或需调整。

2. **Phase 2 — 桌面壳搭建**
   - `desktop/` 骨架（Cargo.toml、tauri.conf.json、capabilities、main.rs）。
   - Rust spawn sidecar + health 轮询 + 退出清理。
   - 前端 `api.ts` base 注入改造 + 单测。
   - `tauri dev` 跑通：窗口加载、API 可达。

3. **Phase 3 — 打包与 sidecar**
   - `fetch-node` / `bundle-cli` / `prepare-sidecar` 脚本。
   - portable node 作为 externalBin。
   - `cargo tauri build` 产出 macOS `.app` / `.dmg`（arm64）。

4. **Phase 4 — 双架构与文档**
   - x64 构建。
   - `desktop/README.md`（构建、签名、发布说明）。
   - 根 README 提及桌面应用。

## 11. 成功标准

- `pnpm --dir desktop run build` 在 macOS arm64 上产出可运行的 `.app`。
- 启动 `.app`：窗口显示现有 Web UI，账户列表（来自 CLI 已登录账户）可见、可切换。
- 消息浏览、触发 sync、Guard 控制台全部可用。
- 退出应用后 sidecar `node` 进程被清理（无残留）。
- 现有 `pnpm test && pnpm typecheck` 在根项目仍通过（前端改动不破坏 CLI 测试）。
