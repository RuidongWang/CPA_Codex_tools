# CPA Codex Tools

面向 CPA Management API 的 Codex 账号额度管理 Web 工具。项目只保留本地浏览器使用场景，用于查看账号额度、批量查询、批量下载账号配置、生成优先级草稿并同步到 CPA。

本仓库只包含客户端工具，不包含 CPA 服务端，也不包含任何账号配置文件。使用前需要先部署可用的 CPA，并在 CPA 中导入 Codex 账号。

## 目录

- [功能概览](#功能概览)
- [界面预览](#界面预览)
- [快速开始](#快速开始)
- [Web 端](#web-端)
- [Docker Compose](#docker-compose)
- [数据与缓存](#数据与缓存)
- [CPA 接口边界](#cpa-接口边界)
- [开发与验证](#开发与验证)
- [仓库结构](#仓库结构)

## 功能概览

- 统一查看 Codex 账号分组、额度状态、5h / 7d 剩余额度、优先级和查询状态。
- 支持批量查询、单账号查询、批量下载账号配置和批量同步优先级。
- 支持 Keeper 可视化监控，维护策略参考 [CPACodexKeeper](https://github.com/5345asda/CPACodexKeeper)，可按策略演练或执行删除、禁用、启用和刷新维护动作。
- 支持大账号量列表虚拟滚动，移动端自动切换为账号卡片。
- 查询到的额度快照会持久化到 IndexedDB，再次加载账号列表时自动回填。
- 表格中的 `额度更新时间` 取自接口 body 中 `rate_limit.primary_window.reset_at` 对应的下一次刷新时间。
- 查询失败或超时时会保留上一次成功的额度快照，避免短暂故障把可用额度信息清空。
- 项目已移除 Python CLI、Tauri 桌面壳层、桌面 sidecar 和 portable exe 构建链路。

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
docker compose up -d web
```

打开：

```text
http://localhost:5173
```

不使用 Docker 时：

```bash
cd web
npm install
npm run web:dev
```

## Web 端

Web 端位于 `web/`，由 React、TypeScript 和 Vite 构建。

运行边界：

- 浏览器直接请求 CPA Management API。
- CPA 或前置反向代理需要允许本地 Web 页面跨域访问。
- 浏览器下载账号配置 JSON，不需要配置本地备份路径。
- Keeper 维护策略在设置面板中配置，支持禁用阈值、过期阈值、维护并发和维护时自动刷新临期证书。
- 本地缓存只保存在当前浏览器内，不会上传到仓库或第三方服务。

环境要求：

- Node.js 20 或更新版本。

开发运行：

```bash
cd web
npm install
npm run web:dev
```

构建：

```bash
cd web
npm run web:build
```

预览构建产物：

```bash
cd web
npm run web:preview
```

端口配置文件：

```text
web/web-server.config.ts
```

## Docker Compose

仓库根目录提供 `docker-compose.yml`，默认服务是 Web 开发模式：

```bash
docker compose up -d web
```

查看状态：

```bash
docker compose ps web
```

查看日志：

```bash
docker compose logs -f web
```

接近构建产物的预览模式：

```bash
docker compose --profile preview up -d web-preview
```

预览模式端口：

```text
http://localhost:9999
```

停止服务：

```bash
docker compose down
```

Compose 只负责启动本项目的 Web 环境，不包含 CPA 服务端。

## 数据与缓存

Web 端本地缓存使用两类浏览器存储：

- `localStorage` 保存 CPA 地址、管理密钥等轻量配置。
- `IndexedDB` 保存账号列表缓存和额度快照，用于页面刷新或重新加载账号列表后的自动回填。

设置面板中的“清空本地缓存”会清除以上 Web 端缓存。浏览器下载的账号配置 JSON 不归本项目管理。

本地优先级草稿只存在当前页面内存中。刷新页面后草稿会消失，已同步到 CPA 的远端优先级不受影响。

## CPA 接口边界

当前 Web 端依赖 CPA Management API 提供以下能力：

- 读取账号配置列表。
- 按账号读取 Codex 额度信息。
- 批量下载账号配置。
- 批量更新账号优先级。
- 设置账号启用/禁用状态。
- 删除无效或不可用账号。
- 通过 `api-call` 代理 OpenAI OAuth refresh，并上传更新后的账号配置。

额度信息中的下一次刷新时间取自响应 body 里的 `reset_at`，并格式化为界面中的 `下次刷新 MM-DD HH:mm`。

Keeper 维护逻辑参考 [CPACodexKeeper](https://github.com/5345asda/CPACodexKeeper)。当前 Web 端不会直接从浏览器请求 OAuth refresh，而是通过 CPA `api-call` 代理刷新并回写账号文件。

## 开发与验证

安装依赖：

```bash
cd web
npm install
```

运行前端测试：

```bash
cd web
npm test -- --run
```

运行类型检查和构建：

```bash
cd web
npm run web:build
```

检查 Compose 配置：

```bash
docker compose config
```

## 仓库结构

```text
.
├─ docker-compose.yml
├─ README.md
├─ CHANGELOG.md
├─ docs/
│  └─ readme/
└─ web/
   ├─ package.json
   ├─ package-lock.json
   ├─ web-server.config.ts
   ├─ index.html
   └─ src/
```

主要代码边界：

- `web/src/App.tsx` 负责主状态机、加载、查询、下载和同步流程。
- `web/src/lib/api.ts` 负责浏览器端 CPA 请求、数据归一化、下载、Keeper 维护和额度快照持久化。
- `web/src/components/` 放账号表格、工具条、设置面板、进度面板和优先级弹层。
- `docker-compose.yml` 提供本地 Web 开发和预览服务。

## 参考

- [CPA Codex Tools GitHub 仓库](https://github.com/RuidongWang/CPA_Codex_tools)
- [CPACodexKeeper](https://github.com/5345asda/CPACodexKeeper)
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI/)
