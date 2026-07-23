# Tauri 桌面应用实现计划

**日期**: 2026-07-23
**对应 Spec**: `docs/specs/2026-07-23-tauri-desktop-app-design.md`
**目标**: 把 `tg` CLI 打包为 macOS Tauri v2 桌面应用（方案 A：portable Node + ncc bundle 作为 sidecar）。

## 总览

四个阶段，严格顺序执行。每个阶段有独立验证门，未通过不进下一阶段。

- Phase 1 — POC：验证 ncc + better-sqlite3 + Tauri origin 三大技术风险。
- Phase 2 — 桌面壳：Rust 主进程 + 前端 base 注入 + `tauri dev` 跑通。
- Phase 3 — 打包：portable node sidecar + `cargo tauri build` 产出 `.app`。
- Phase 4 — 双架构 + 文档。

---

## Phase 1 — POC（技术可行性验证）

目标：在动 Tauri 之前，独立验证三个风险点。POC 产物不进 `desktop/`，放临时目录。

### 1.1 ncc 打包 CLI 烟测

**任务**：
1. 根项目 `package.json` devDependencies 增加 `@vercel/ncc`。
2. 写临时脚本 `scripts/poc-ncc.mjs`：用 ncc 打包 `src/index.ts` → `/tmp/tg-bundle/index.js`（`target: 'es2022'`, `sourceMap: true`）。
3. 检查 `/tmp/tg-bundle/` 下 better-sqlite3 的 `.node` 是否被 emit、路径为何（预期 `build/Release/better_sqlite3.node` 或 `prebuilds/...`）。
4. 烟测：
   - `node /tmp/tg-bundle/index.js --version` → 输出版本号。
   - `node /tmp/tg-bundle/index.js web --port 9999` → 起服务，`curl http://127.0.0.1:9999/api/health` 返回 `{"ok":true,...}`。
   - 关键断言：better-sqlite3 加载无报错（`tg web` 会初始化 `MessageDB`）。

**验证门**：上述两条烟测通过，`.node` 文件位置已记录。

**若失败**：ncc 未正确 emit `.node` → 降级方案：改用 `esbuild` 打包 JS + 手动 `cp node_modules/better-sqlite3/build/Release/*.node` 到 bundle 旁，运行时设 `NODE_PATH` 或 patch require。记录降级决策到 spec §9。

### 1.2 Tauri webview Origin 行为验证

**任务**：
1. 读 `src/web/security.ts`，确认 Origin 校验逻辑（同源才放行）。
2. 用 `curl` 模拟 Tauri webview 的 Origin：
   - `curl -H "Host: 127.0.0.1:9999" -H "Origin: http://tauri.localhost" http://127.0.0.1:9999/api/health`
   - macOS Tauri webview 实际 Origin 通常是 `http://tauri.localhost` 或 `https://tauri.localhost`。
3. 判断是否被 `forbidden_origin` 拒绝。

**验证门**：明确知道 Tauri origin 是否被放行。

**若被拒绝**：在 `src/web/security.ts` 增加对 Tauri origin 的放行（`http://tauri.localhost`、`https://tauri.localhost`），并补 `tests/web/security.test.ts` 用例。此改动同时影响 CLI，需跑 `pnpm test`。

### 1.3 POC 报告

**任务**：在 spec §9 风险表更新每项的实际验证结论（可行 / 降级方案）。提交 POC 结论到对话。

**验证门**：三大风险均有明确结论，方案 A 确认可行或已调整。

---

## Phase 2 — 桌面壳搭建

目标：`pnpm --dir desktop run tauri dev` 能起窗口、加载 Web UI、API 可达。本阶段 sidecar 用 portable node（需先完成 fetch-node 脚本）。

### 2.1 创建 `desktop/` 骨架

**任务**：
1. 建 `desktop/` 目录结构（见 spec §6.1）。
2. `desktop/package.json`：
   - `"private": true`, `"type": "module"`。
   - scripts: `bundle`（`tsx scripts/bundle-cli.ts`）、`fetch-node`（`tsx scripts/fetch-node.ts`）、`tauri`（`tauri`）、`tauri:dev`（`tauri dev`）、`tauri:build`（`tauri build`）。
   - devDependencies: `@vercel/ncc`, `tsx`, `@tauri-apps/cli`。
3. `desktop/src-tauri/Cargo.toml`：`[package]` name=`telegram-cli-desktop`，edition 2021；deps: `tauri`（features `["devtools"]`）、`tauri-plugin-shell`、`reqwest`（blocking）、`tokio`、`tauri-plugin-log`、`log`。`[build-dependencies]` `tauri-build`。
4. `desktop/src-tauri/build.rs`：`fn main() { tauri_build::build() }`。
5. 根 `.gitignore` 追加：
   ```
   /desktop/dist-bundle/
   /desktop/src-tauri/binaries/
   /desktop/src-tauri/target/
   /desktop/node_modules/
   ```

### 2.2 fetch-node 脚本

**文件**: `desktop/scripts/fetch-node.ts`

**任务**：
1. 读取 `process.env.NODE_VERSION`（默认 `v22.12.0`）。
2. 用 `rustc --print host-tuple` 取 target triple（如 `aarch64-apple-darwin`）。
3. 映射 triple → node 平台包名：
   - `aarch64-apple-darwin` → `darwin-arm64`
   - `x86_64-apple-darwin` → `darwin-x64`
4. 从 `https://nodejs.org/dist/<ver>/node-<ver>-<plat>.tar.gz` 下载、解压、取 `bin/node`，拷到 `desktop/src-tauri/binaries/node-<triple>`（无扩展名，chmod 0o755）。
5. 若文件已存在且版本匹配则跳过。

**验证门**：`ls desktop/src-tauri/binaries/node-*` 存在且 `./node-<triple> --version` 输出 `v22.12.0`。

### 2.3 bundle-cli 脚本

**文件**: `desktop/scripts/bundle-cli.ts`

**任务**：
1. 用 `@vercel/ncc` build `../src/index.ts` → `desktop/dist-bundle/`，`target: 'es2022'`, `sourceMap: true`, `minify: false`。
2. 校验 `desktop/dist-bundle/` 下存在 better-sqlite3 `.node`（按 Phase 1 记录的路径）。
3. 若 Phase 1 用了降级方案（手动拷 `.node`），在此脚本补充 `cp` 步骤。

**验证门**：`desktop/dist-bundle/index.js` 存在；`node desktop/dist-bundle/index.js --version` 正常。

### 2.4 前端 api.ts base 注入改造

**文件**: `web/src/api.ts`

**任务**：
1. 在文件顶部加 `API_BASE` 常量（见 spec §6.2 代码）。
2. 把 `getJson` / `postJson` / `patchJson` / `deleteJson` 的 `fetch(path, ...)` 改为 `fetch(`${API_BASE}${path}`, ...)`。
3. 新增 `tests/web/api-base.test.ts`（或在现有 web 测试位置）：mock `window.__TG_API_BASE__`，断言 fetch 被调用时 URL 带前缀；删除该属性后回落相对路径。

**验证门**：`pnpm test` 通过；`pnpm typecheck` 通过；`pnpm build:web` 成功。

### 2.5 Rust 主进程

**文件**: `desktop/src-tauri/src/main.rs`

**任务**：实现 spec §6.3 伪代码对应的真实代码：
1. `pick_free_port()`：`TcpListener::bind("127.0.0.1:0")` 取 `local_addr().port()`，drop listener。
2. `resolve_resource`：用 `app.path().resolve_resource("dist-bundle/index.js")` 取 bundle 绝对路径。
3. `Command::new_sidecar("node")`，args = `[bundle_path, "web", "--port", port]`，`.spawn()`，存 `Child` 到 `Mutex<Option<Child>>` 的 `AppState`。
4. 后台线程收 sidecar stdout/stderr，写 `tauri-plugin-log`。
5. health 轮询：另起线程，用 `reqwest::blocking` 每 200ms GET `http://127.0.0.1:<port>/api/health`，最多 30s；成功后 `window.eval("window.__TG_API_BASE__='http://127.0.0.1:<port>'")`；超时则 `app.dialog().message(...)` 报错。
6. 退出清理：`app.on_window_event`，`WindowEvent::CloseRequested` 或 `Destroyed` → 取 `Child` 执行 `kill()`。

**验证门**：`cargo build`（在 `desktop/src-tauri`）通过。

### 2.6 Tauri 配置与 capabilities

**文件**:
- `desktop/src-tauri/tauri.conf.json`（见 spec §6.4）
- `desktop/src-tauri/capabilities/default.json`（见 spec §6.5）
- `desktop/src-tauri/icons/`：先用 `tauri icon` 生成占位图标（或用项目现有 logo）。

**任务**：
1. 写 tauri.conf.json，`frontendDist: "../dist/web"`，`devUrl: "http://localhost:5173"`。
2. `beforeBuildCommand`: `pnpm --dir .. run build:web && pnpm run bundle`。
3. `beforeDevCommand`: `pnpm --dir .. run build:web && pnpm run bundle`（dev 也需 bundle；vite watch 由根项目 vite 提供，需在根 `web/vite.config.ts` 加 `server: { port: 5173, strictPort: true }`）。
4. `bundle.resources`: `["../dist-bundle/**/*"]`。
5. `bundle.externalBin`: `["binaries/node"]`。
6. CSP 按 spec §6.4。
7. capabilities 按 spec §6.5。

**验证门**：`cargo tauri dev` 能启动（即便有侧问题也能进 webview）。

### 2.7 根项目 vite dev 端口固定

**文件**: `web/vite.config.ts`

**任务**：加 `server: { port: 5173, strictPort: true }`，使 `devUrl` 稳定。

**验证门**：`pnpm --dir web exec vite --port 5173` 起在 5173。

### 2.8 Phase 2 集成验证

**任务**：
1. `pnpm --dir desktop run fetch-node`（一次）。
2. `pnpm --dir desktop run tauri:dev`。
3. 手动验证：窗口弹出 → 加载 Web UI → 账户列表可见 → 浏览消息 → 触发 sync → Guard 控制台。
4. 关闭窗口 → `ps aux | grep node` 确认 sidecar 进程被清理。

**验证门**：上述全通过。Phase 2 完成。

---

## Phase 3 — 打包与 sidecar

目标：`cargo tauri build` 产出可分发的 macOS `.app` / `.dmg`（arm64）。

### 3.1 tauri build 跑通

**任务**：
1. `pnpm --dir desktop run fetch-node`（确保 portable node 就位）。
2. `pnpm --dir desktop run tauri:build`。
3. 修复打包期问题（资源路径、CSP、签名占位）。

**验证门**：`desktop/src-tauri/target/release/bundle/` 下生成 `.app` 和 `.dmg`。

### 3.2 发布产物烟测

**任务**：
1. 双击 `.app` 启动（脱离终端）。
2. 验证同 Phase 2.8 的功能清单。
3. 确认 sidecar 进程在退出后清理。
4. 确认数据读写落在 `~/Library/Application Support/tg-cli/`（与 CLI 共享）。

**验证门**：独立 `.app` 全功能可用。

### 3.3 macOS 签名/公证（可选，第一版可跳过）

**任务**：若需分发给其他用户（Gatekeeper 拦截），配置 Apple Developer 证书与 `tauri.conf.json` 的 `macOS.signingIdentity`。第一版若无证书，文档说明需用户右键打开。

**验证门**：记录签名状态；无证书则文档提示。

---

## Phase 4 — 双架构与文档

### 4.1 x64 构建

**任务**：
1. 在 x64 macOS（或 CI runner）重复 `fetch-node`（取 `darwin-x64` node）+ `pnpm rebuild better-sqlite3`（产 x64 `.node`）+ `bundle` + `tauri:build`。
2. 验证 x64 `.app` 在 x64 Mac 上运行。

**验证门**：x64 `.dmg` 产出并烟测。

### 4.2 desktop/README.md

**任务**：写 `desktop/README.md`：
- 前置依赖（Rust、Node 22、pnpm）。
- 开发：`pnpm install`、`fetch-node`、`tauri:dev`。
- 构建：`tauri:build`，产物位置。
- 架构说明（sidecar 模型、数据目录共享、与 CLI 的关系）。
- 已知限制（并发、签名、体积）。

### 4.3 根 README 提及

**任务**：在根 `README.md` 与 `README.zh-CN.md` 增加简短段落，指向 `desktop/README.md`。

**验证门**：文档完整。

### 4.4 CI（可选）

**任务**：若需自动化，加 GitHub Actions：macos-14（arm64）+ macos-13（x64）runner 各跑 `tauri:build`，上传 `.dmg` artifact。第一版可手动构建。

---

## 验证总门（全部完成后）

- [ ] `pnpm test && pnpm typecheck`（根项目）通过。
- [ ] `desktop/` 下 `tauri:dev` 与 `tauri:build` 均可工作。
- [ ] macOS arm64 + x64 `.dmg` 产出并烟测通过。
- [ ] 退出应用无残留 `node` 进程。
- [ ] 数据目录与 CLI 共享，账户/消息可见。
- [ ] `desktop/README.md` 完整。
- [ ] spec §9 风险表所有项有实际结论。

## 文件清单（新增/修改）

**新增**：
- `desktop/package.json`
- `desktop/README.md`
- `desktop/scripts/fetch-node.ts`
- `desktop/scripts/bundle-cli.ts`
- `desktop/src-tauri/Cargo.toml`
- `desktop/src-tauri/build.rs`
- `desktop/src-tauri/tauri.conf.json`
- `desktop/src-tauri/capabilities/default.json`
- `desktop/src-tauri/src/main.rs`
- `desktop/src-tauri/icons/*`
- `tests/web/api-base.test.ts`（或合适位置）

**修改**：
- `web/src/api.ts`（base URL 注入）
- `web/vite.config.ts`（固定 dev 端口）
- `package.json`（加 `@vercel/ncc` devDep，可选 desktop workspace）
- `.gitignore`（desktop 产物）
- `src/web/security.ts`（仅当 Phase 1.2 确认需放行 Tauri origin）
- `README.md` / `README.zh-CN.md`（提及桌面应用）
- `docs/specs/2026-07-23-tauri-desktop-app-design.md`（POC 结论回填 §9）
