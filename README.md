# CPA Codex Tools

面向 CPA Management API 的 Codex 账号额度管理工具。项目提供 Web 端、Windows 桌面端和 Python CLI 三种入口，用于本地查看账号额度、批量查询、批量设置优先级、备份账号配置和同步优先级草稿。

本仓库只包含客户端工具，不包含 CPA 服务端，也不包含任何账号配置文件。使用前需要先部署可用的 CPA，并在 CPA 中导入 Codex 账号。

## 目录

- [功能概览](#功能概览)
- [界面预览](#界面预览)
- [快速开始](#快速开始)
- [Web 端](#web-端)
- [Docker Compose](#docker-compose)
- [桌面端](#桌面端)
- [CLI](#cli)
- [数据与缓存](#数据与缓存)
- [CPA 接口边界](#cpa-接口边界)
- [开发与验证](#开发与验证)
- [仓库结构](#仓库结构)

## 功能概览

- 统一查看 Codex 账号分组、额度状态、5h / 7d 剩余额度、优先级和查询状态。
- 支持批量查询、单账号查询、批量备份账号文件和批量同步优先级。
- Web 端支持大账号量列表虚拟滚动，移动端自动切换为账号卡片。
- Web 端会把查询到的额度快照持久化到 IndexedDB，再次加载账号列表时自动回填。
- 表格中的 `额度更新时间` 取自 `5h 额度` 里的 `下次刷新` 时间，例如 `05-03 18:53`。
- 查询失败或超时时会保留上一次成功的额度快照，避免短暂故障把可用额度信息清空。

## 界面预览

下面截图来自 README 演示模式，使用的都是虚构账号和虚构额度数据。

### 主界面总览

![主界面总览](docs/readme/dashboard-overview.png)

主界面把筛选、状态总览、账号列表和右侧详情面板放在同一页，适合做日常巡检和批量操作。

### 设置与缓存

![设置与缓存](docs/readme/settings-panel.png)

设置面板集中管理 CPA 地址、管理密钥、查询并发数、本地缓存和浏览器端下载行为。

### 优先级设置

![优先级设置](docs/readme/priority-batch-panel.png)

优先级支持批量分配和单账号微调两种方式。推荐先生成本地草稿，检查无误后再同步到 CPA 远端。

## 快速开始

克隆仓库：

```bash
git clone https://github.com/RuidongWang/CPA_Codex_tools.git
cd CPA_Codex_tools
```

最快启动 Web 端：

```bash
docker compose up web
```

打开：

```text
http://localhost:5173
```

如果不使用 Docker，也可以直接用 Node.js 启动：

```bash
cd desktop
npm install
npm run web:dev
```

## Web 端

Web 端只依赖 `desktop/` 里的 React / Vite 工程，适合本地浏览器使用。

边界：

- 使用 `desktop/src` 中的 React 界面和浏览器请求逻辑。
- 不调用 Python worker。
- 不调用 Rust / Tauri 桌面壳层。
- 由浏览器直接请求 CPA Management API，因此 CPA 或反向代理需要允许 CORS。

环境要求：

- Node.js 20 或更新版本。

开发运行：

```bash
cd desktop
npm install
npm run web:dev
```

构建：

```bash
cd desktop
npm run web:build
```

预览构建产物：

```bash
cd desktop
npm run web:preview
```

Web 端配置文件：

```text
desktop/web-server.config.ts
```

## Docker Compose

仓库根目录提供 `docker-compose.yml`，默认服务是 Web 开发模式：

```bash
docker compose up web
```

后台启动：

```bash
docker compose up -d web
```

查看状态：

```bash
docker compose ps web
```

接近构建产物的预览模式：

```bash
docker compose --profile preview up web-preview
```

预览模式端口：

```text
http://localhost:9999
```

CLI 也可以通过 Compose 按需运行：

```bash
docker compose --profile cli run --rm cli query-all \
  --cpa-base-url https://cpa.example/ \
  --management-key <management-key> \
  --json
```

Compose 只负责启动本项目的 Web / CLI 运行环境，不包含 CPA 服务端。

## 桌面端

桌面端由前端工程、Tauri 壳层和 Python sidecar 共同组成，适合需要本地 exe、固定缓存目录和桌面窗口的场景。

边界：

- 界面复用 `desktop/src`。
- 窗口管理、文件系统、系统浏览器打开外链等能力由 `desktop/src-tauri` 提供。
- 批量额度查询通过内置 Python sidecar 执行。

环境要求：

- Windows 10/11。
- Python 3.11 或更新版本。
- Node.js 20 或更新版本。
- Rust stable 工具链。
- Visual C++ Build Tools。

开发运行：

```powershell
cd .\desktop
npm install
npm run tauri:install
npm run tauri:dev
```

portable 单 exe 构建：

```powershell
cd .\desktop
python -m pip install -r .\requirements-portable-build.txt
npm run portable:build
```

默认产物：

```text
desktop/build/portable/Codex Quota Desk.exe
```

Windows PowerShell 如果遇到中文乱码，建议先切到 UTF-8：

```powershell
chcp 65001 > $null; [Console]::InputEncoding = [System.Text.UTF8Encoding]::new(); [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $OutputEncoding = [System.Text.UTF8Encoding]::new()
```

## CLI

CLI 只依赖根目录 Python 脚本，不依赖 React、Tauri 或桌面壳层。

环境要求：

- Python 3.11 或更新版本。
- `codex_quota_checker.py` 运行期只使用 Python 标准库，根目录 `requirements.txt` 为空依赖说明文件。

查看帮助：

```bash
python3 codex_quota_checker.py --help
```

查看账号列表：

```bash
python3 codex_quota_checker.py list \
  --cpa-base-url https://cpa.example/ \
  --management-key <management-key>
```

查询单个账号：

```bash
python3 codex_quota_checker.py query-one \
  --auth-index <auth-index> \
  --cpa-base-url https://cpa.example/ \
  --management-key <management-key> \
  --show-timings
```

查询多个账号：

```bash
python3 codex_quota_checker.py query-many \
  --auth-index <auth-index-1>,<auth-index-2> \
  --cpa-base-url https://cpa.example/ \
  --management-key <management-key> \
  --max-workers 6 \
  --show-timings
```

查询全部账号并输出 JSON：

```bash
python3 codex_quota_checker.py query-all \
  --cpa-base-url https://cpa.example/ \
  --management-key <management-key> \
  --json
```

进入交互模式：

```bash
python3 codex_quota_checker.py
```

## 数据与缓存

### Web 端缓存

Web 端本地缓存分两层：

- `localStorage` 保存运行配置，命名空间为 `cpa_codex_quota_cache.*`。
- IndexedDB 保存较大的列表 payload 和额度快照：
  - `payload-cache` 保存最近一次列表或查询 payload。
  - `quota-snapshots` 按 `auth_index` 保存单账号额度快照。

清空本地缓存会删除运行配置、payload 缓存和额度快照。旧版本写在 `localStorage` 的 payload 会在加载时迁移到 IndexedDB。

### 桌面端缓存

桌面端运行时统一写入固定目录 `cpa_codex_quota_cache/`：

- 开发态默认位于仓库根目录同级。
- release / portable 默认位于 exe 同级。

目录内通常包含：

- `runtime-config.json`
- `payload-cache.json`
- 内嵌 sidecar 的释放缓存

桌面端设置面板中的清空本地缓存会清掉以上内容。

## CPA 接口边界

额度查询固定通过 CPA Management API 发起，不在本地接管 Codex OAuth 刷新链。

本项目使用到的 CPA Management API：

```text
GET   /v0/management/auth-files
GET   /v0/management/auth-files/download
PATCH /v0/management/auth-files/fields
POST  /v0/management/api-call
```

最终额度请求由 CPA 代发到：

```text
https://chatgpt.com/backend-api/wham/usage
```

## 开发与验证

前端测试：

```bash
cd desktop
npm install
npm test -- --run
```

前端构建：

```bash
cd desktop
npm run web:build
```

Node 脚本测试：

```bash
cd desktop
npm run test:node
```

Python 回归测试：

```bash
python3 -m pytest test_codex_quota_checker.py
```

Docker Compose 配置检查：

```bash
docker compose --profile preview --profile cli config
```

桌面端 Rust 测试：

```powershell
cargo test --manifest-path .\desktop\src-tauri\Cargo.toml
```

版本检查：

```bash
cd desktop
npm run version:check
```

## 仓库结构

```text
.
├─ CHANGELOG.md
├─ LICENSE
├─ README.md
├─ codex_quota_checker.py
├─ docker-compose.yml
├─ requirements.txt
├─ test_codex_quota_checker.py
├─ docs/
│  ├─ readme/
│  └─ superpowers/
└─ desktop/
   ├─ package.json
   ├─ package-lock.json
   ├─ web-server.config.ts
   ├─ requirements-portable-build.txt
   ├─ src/
   ├─ src-tauri/
   └─ scripts/
```

目录职责：

- `codex_quota_checker.py` 负责 CLI 查询和桌面端 Python sidecar worker。
- `desktop/src` 放 Web 与桌面端共用的 React / TypeScript 界面逻辑。
- `desktop/src-tauri` 放桌面端专属的 Rust / Tauri 壳层。
- `desktop/scripts` 放桌面端构建、版本管理和 Tauri CLI 转发脚本。
- `docker-compose.yml` 提供本地 Web、预览和 CLI 容器入口。
- `docs/readme` 放 README 截图资源。
- `docs/superpowers/plans` 放阶段性实现计划记录。

## 版本管理

当前前端与桌面端统一以 `desktop/package.json` 作为主版本源。版本同步和检查脚本位于 `desktop/scripts/`。

## 致谢

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI/)
- [Stitch](https://stitch.withgoogle.com/)
- [LINUX DO 社区](https://linux.do/)
- Codex
