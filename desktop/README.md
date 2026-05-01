# Desktop / Web Frontend

`desktop/` 是本项目的前端工程，同时承载两种运行方式：

- Web 端
- Tauri 桌面端

其中 `src/` 放共用界面逻辑，`src-tauri/` 放桌面端壳层，`scripts/` 放桌面端辅助脚本。

## 目录说明

```text
desktop/
├─ package.json
├─ package-lock.json
├─ requirements-portable-build.txt
├─ web-server.config.ts
├─ src/         # Web 与 Desktop 共用的 React / TS 逻辑
├─ src-tauri/   # Tauri / Rust 壳层
└─ scripts/     # 桌面端脚本与版本脚本
```

## 使用前准备

PowerShell 建议先切到 UTF-8：

```powershell
chcp 65001 > $null; [Console]::InputEncoding = [System.Text.UTF8Encoding]::new(); [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $OutputEncoding = [System.Text.UTF8Encoding]::new()
```

## Web 端

Web 端只依赖当前目录下的 Node 前端依赖。

安装与开发：

```powershell
npm install
npm run web:dev
```

构建与预览：

```powershell
npm run web:build
npm run web:open
```

也可以单独预览：

```powershell
npm run web:preview
```

Web 端端口配置文件：

```text
web-server.config.ts
```

Web 端本地缓存：

- 使用 `localStorage` 的 `cpa_codex_quota_cache.*` 命名空间。
- 本地优先级草稿只存在页面内存里。

## 桌面端

桌面端除了当前目录的前端依赖，还需要单独安装 `src-tauri/` 下的 Tauri CLI。

安装与开发：

```powershell
npm install
npm run tauri:install
npm run tauri:dev
```

portable 单 exe 构建：

```powershell
python -m pip install -r .\requirements-portable-build.txt
npm run portable:build
```

桌面端本地缓存：

- 统一写入固定目录 `cpa_codex_quota_cache/`。
- 开发态默认位于仓库根目录同级。
- release / portable 默认位于 exe 同级。

首页 GitHub 仓库链接会交给系统默认浏览器打开。

## 测试

前端测试：

```powershell
npm test -- --run
```

Node 脚本测试：

```powershell
npm run test:node
```

Rust 测试：

```powershell
cargo test --manifest-path .\src-tauri\Cargo.toml
```

## 版本管理

当前版本统一以 `package.json` 为主版本源。

发布前请执行：

```powershell
npm version <new-version> --no-git-tag-version
npm run version:sync
npm run version:check
```

然后回到仓库根目录更新 `CHANGELOG.md`。
