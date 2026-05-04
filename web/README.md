# Web Frontend

`web/` 是 CPA Codex Tools 的唯一前端工程，使用 React、TypeScript 和 Vite。项目已移除 CLI、Tauri 壳层和桌面端构建脚本。

## 目录说明

```text
web/
├─ package.json
├─ package-lock.json
├─ web-server.config.ts
├─ index.html
├─ vite.config.ts
├─ tsconfig.json
└─ src/
```

## 开发

安装依赖：

```bash
npm install
```

启动开发服务：

```bash
npm run web:dev
```

构建：

```bash
npm run web:build
```

预览构建产物：

```bash
npm run web:preview
```

端口配置位于：

```text
web-server.config.ts
```

## 本地缓存

- `localStorage` 保存 CPA 地址、管理密钥和账号列表缓存。
- `IndexedDB` 保存额度快照，页面重新加载后会自动回填最近一次成功查询结果。
- “清空本地缓存”会清理当前浏览器内保存的 Web 端缓存。
- 账号配置通过浏览器下载 JSON 文件，不需要配置本地路径。

## Keeper

Keeper 监控区提供账号维护演练和执行入口，策略在设置面板中配置：

- 禁用阈值百分比
- 过期阈值天数
- 维护并发数
- 自动刷新开关

维护逻辑参考 [CPACodexKeeper](https://github.com/5345asda/CPACodexKeeper)。当前 Web 端支持删除、禁用、启用和刷新：执行维护时会通过 CPA `api-call` 代理 OAuth refresh，再把更新后的账号 JSON 上传回 CPA。

## 测试

```bash
npm test -- --run
```

构建验证：

```bash
npm run web:build
```
