# CPA Codex Tools

面向 CPA Management API 的 Codex 账号额度管理 Web 工具。项目只保留本地浏览器使用场景，用于查看账号额度、批量查询、批量下载账号配置、生成优先级草稿并同步到 CPA。

本仓库只包含客户端工具，不包含 CPA 服务端，也不包含任何账号配置文件。使用前需要先部署可用的 CPA，并在 CPA 中导入 Codex 账号。

## 目录

- [功能概览](#功能概览)
- [界面预览](#界面预览)
- [快速开始](#快速开始)
- [Web 端](#web-端)
- [登录与管理密钥](#登录与管理密钥)
- [Docker Compose](#docker-compose)
- [批量生成优先级](#批量生成优先级)
- [Codex OAuth登录](#codex-oauth登录)
- [数据与缓存](#数据与缓存)
- [CPA 接口边界](#cpa-接口边界)
- [开发与验证](#开发与验证)
- [仓库结构](#仓库结构)

## 功能概览

- 统一查看 Codex 账号分组、额度状态、5h / 7d 剩余额度、优先级和查询状态。
- 提供登录页，通过 CPA 管理地址和管理密钥验证后进入控制台。
- 支持批量查询、单账号查询、批量下载账号配置和批量同步优先级。
- 支持 Keeper 可视化监控，维护策略参考 [CPACodexKeeper](https://github.com/5345asda/CPACodexKeeper)，可按策略演练或执行维护，也可在账号列表中选中指定账号后直接设置禁用、刷新证书或删除证书。
- 支持 Codex OAuth 登录辅助页面，可为失效账号发起 CPA OAuth、导入 Hotmail 账号池、获取邮箱验证码、提交 OAuth 回调 URL 并检查登录状态；可选安装 Chrome/Edge 扩展辅助单账号自动登录。
- 支持大账号量列表虚拟滚动，移动端自动切换为账号卡片。
- 查询到的额度快照会持久化到 IndexedDB，再次加载账号列表时自动回填。
- 表格中的 `额度更新时间` 取自接口 body 中 `rate_limit.primary_window.reset_at` 对应的下一次刷新时间。
- 查询失败或超时时会保留上一次成功的额度快照，避免短暂故障把可用额度信息清空。
- 项目已移除 Python CLI、Tauri 桌面壳层、桌面 sidecar 和 portable exe 构建链路。

## 界面预览

下面截图来自 README 演示模式，使用的都是虚构账号和虚构额度数据。

### 主界面总览

![主界面总览](docs/readme/dashboard-overview.png)

主界面把操作台、分组筛选、状态总览和账号列表放在同一页，适合做日常巡检、排序、搜索和批量操作。

### 设置与缓存

![设置与缓存](docs/readme/settings-panel.png)

配置页面和设置入口用于管理 CPA 地址、管理密钥、查询并发数、本地缓存和浏览器端下载行为。

### 优先级设置

![优先级设置](docs/readme/priority-batch-panel.png)

优先级支持按当前列表批量生成本地草稿，推荐先调整账号列表排序并生成草稿，检查无误后再同步到 CPA 远端。

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

首次进入会看到登录页，输入 CPA 管理地址和管理密钥后连接。管理地址示例：

```text
http://localhost:8317/v0/management
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
- Keeper 页面支持策略配置、账号列表检索和选中账号直操作。维护策略支持禁用阈值、过期阈值、维护并发和维护时自动刷新临期证书。
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

## 登录与管理密钥

当前登录逻辑是前端登录态加 CPA Management API 管理配置，不包含独立的用户账号体系。

登录流程：

1. 页面启动时先读取本地运行配置。
2. 如果没有 CPA 管理地址或管理密钥，直接进入登录页，不展示本地缓存账号列表。
3. 如果本地已有地址和密钥，会自动调用账号列表接口验证。
4. 验证成功后进入控制台，并加载账号列表。
5. 验证失败会回到登录页，并展示自动登录失败原因。
6. 手动登录时，登录页只保存本次 CPA 管理地址和管理密钥并进入控制台，不自动拉取账号列表。
7. 进入控制台后，点击 `加载账号` 才会请求账号列表并验证当前管理配置是否可用。

登录页的“记住本次登录”默认开启：

- 开启时，会把 CPA 管理地址和管理密钥保存到当前浏览器本地配置中，下次打开页面会自动验证并进入控制台。
- 关闭时，只保留本次页面会话中的管理密钥；刷新页面或重新打开后需要重新输入管理密钥。

右上角“退出登录”会清空本地保存的管理密钥，重置页面状态并回到登录页。

所有 CPA Management API 请求都会携带管理密钥：

```http
Authorization: Bearer <managementKey>
X-Management-Key: <managementKey>
```

这样可以兼容不同版本或部署方式的 CLIProxyAPI 管理接口。管理密钥属于敏感信息，建议只在可信浏览器环境中使用；如果开启远程管理，也需要额外评估 CPA 服务端和反向代理的暴露范围。

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

## 批量生成优先级

批量生成优先级入口位于主界面工具条的“批量设置优先级”。它只生成本地草稿，不会直接写入 CPA；确认列表中的“未同步”结果无误后，再点击“同步到远端”提交。

生成规则：

- 以当前账号列表为输入，当前筛选、搜索和表头排序都会影响生成顺序。
- 弹层里的分组顺序决定默认优先级区间，越靠前的分组默认获得越高的优先级区间。
- 每个分组都可以单独调整最小/最大优先级区间；区间会随运行配置保存在浏览器本地，下次打开继续沿用。
- 同一分组内部按当前账号列表顺序从高到低生成优先级，也就是当前列表中排在前面的账号会获得更高优先级。
- 如果账号数多于区间档位数，会按档位平均分组。例如 200 个账号设置为 `1 - 20`，就是 20 个优先级档位、每档 10 个账号；前 10 个为 `20`，第 11 到 20 个为 `19`，依次递减。
- 如果不能整除，剩余账号会归到最后一个最低优先级档位。例如 205 个账号设置为 `1 - 20`，最后 15 个账号都会是 `1`。
- 如果账号数少于区间档位数，只使用最高的前几个档位。例如 5 个账号设置为 `1 - 20`，会生成 `20、19、18、17、16`。
- 如果最小值和最大值相同，则该分组内所有账号都会设置为同一个优先级。
- 只会改动弹层中勾选的分组；未勾选分组、当前筛选之外的账号和已有本地草稿会保留。取消勾选不会清空该分组已填写的区间。

推荐流程：

1. 通过左侧分组、状态筛选或搜索框收敛要调整的账号范围。
2. 点击账号表头设置排序，例如按优先级、额度、证书过期时间或邮箱排序。
3. 点击“批量设置优先级”，选择需要调整的分组，并按需要移动分组顺序。
4. 点击“生成本地草稿”，在账号列表中检查新优先级和“未同步”标记。
5. 如需落到 CPA，先下载备份，再点击“同步到远端”。

## Codex OAuth登录

左侧 `OAuth` 页面用于辅助失效账号重新完成 CPA Codex OAuth 登录。当前实现采用 API 辅助链路：生成 OAuth 链接、获取 Hotmail 验证码、提交 OAuth 回调 URL、检查 CPA 登录状态，并在登录成功后检测目标账号额度。未安装扩展时，OpenAI 登录页仍由浏览器打开并由用户完成验证码填写和授权确认。

失效账号来源只看已经产生的异常证据：

- 额度页查询过，并且查询状态为 `error` 的账号。
- Keeper 执行刷新证书后，刷新失败且未成功写回的账号。

未经过额度查询或 Keeper 刷新的账号，默认认为正常。账号被禁用、缺少 Refresh Token 或证书过期，不会单独作为 OAuth 失效账号判定条件。

使用流程：

1. 先在账号列表加载完成后进入左侧 `OAuth` 页面。
2. 在 `Hotmail 账号池` 中导入账号，格式兼容参考项目：

```text
账号----密码----ID----Token
alice@hotmail.com----password----client-id----refresh-token
```

3. 验证码收取使用 API 对接模式：页面通过 CPA `api-call` 代理 Microsoft token、Graph / Outlook 邮件接口读取验证码，不需要单独启动本地 Hotmail helper。
4. 选择要重新登录的失效账号，点击 `发起 OAuth登录`。页面会调用 CPA `codex-auth-url` 接口并在新标签页打开 OpenAI OAuth 登录链接。
5. 在 OpenAI 页面请求邮箱验证码后，回到本项目点击 `获取 Hotmail 验证码`，复制页面展示的验证码到 OpenAI 登录页。
6. OpenAI 页面完成授权后，把浏览器跳转得到的 OAuth 回调 URL 粘贴到页面里的 `OAuth 回调 URL` 输入框，并点击 `提交回调 URL`。
7. 点击 `检查登录状态`。如果 CPA 返回成功，页面会先刷新账号列表，再按同邮箱优先匹配最新账号执行一次额度查询。
8. 如果额度查询结果不是 `error`，该账号会从 `失效账号` 列表恢复为正常；如果仍是 `error`，会继续保留在失效账号列表中。

### Codex OAuth 批量恢复

`OAuth` 页面顶部的 `OAuth 批量队列` 用于把失效账号批量交给浏览器扩展恢复。队列来源仍然只取上述两类异常证据：额度查询后状态为 `error` 的账号，以及 Keeper 刷新证书失败的账号。

队列按钮含义：

- `全部失效账号生成队列`：把当前识别出的全部失效账号入队。
- `勾选账号生成队列`：只把账号表格中勾选的账号入队。
- `当前筛选结果生成队列`：按账号表格当前筛选结果入队。
- `清空队列`：清除本地 OAuth 批量队列。

队列统计里 `callback 已提交` 和 `OAuth success` 不是同一个状态。`callback 已提交` 只表示扩展已经捕获本地 OAuth callback URL，并把它提交给 CPA；这一步可能还在等待 CPA 后验检查，也可能随后失败。`OAuth success` 只统计 `job.oauthStatus === 'success'` 的任务，表示 CPA 的 OAuth 登录状态检查已经返回成功。

队列列表只展示邮箱、Hotmail 匹配邮箱、任务状态、尝试次数、最近错误、OAuth 后验状态和更新时间；不会展示 Hotmail 密码、refresh token 或验证码。

### Chrome/Edge 自动登录扩展

仓库提供可选扩展：`browser-extension/codex-oauth-auto-login/`。它用于在你已经打开本项目 `OAuth` 页面后，辅助完成单账号 OAuth 重登或处理页面顶部的批量恢复队列。

安装方式：

1. 打开 Chrome/Edge 扩展管理页。
2. 开启开发者模式。
3. 选择“加载已解压的扩展”。
4. 选择 `browser-extension/codex-oauth-auto-login` 目录。

使用方式：

1. 在本项目左侧进入 `OAuth` 页面。
2. 选择一个失效账号，并确认 `Hotmail 账号池` 中存在同邮箱账号。
3. 点击浏览器工具栏里的 `CPA Codex OAuth` 扩展，浏览器会打开侧边栏而不是浮动弹窗。
4. 点击 `读取账号池`，侧边栏会从当前本地项目页面读取全部失效账号，以及 Hotmail 账号池中的邮箱、密码、Client ID 和 Token 是否存在。
5. 按需调整侧边栏 `自动化参数`，其中 `任务间隔(秒)` 会在一个任务结束后、下一个任务开始前等待，用来放慢连续 OAuth state 创建。
6. 点击 `开始登录`。

扩展会通过页面桥接发起 OAuth、打开 OpenAI 授权页、填写邮箱并自动点击继续，然后按 OpenAI 页面实际填写的邮箱请求本项目获取 Hotmail 验证码、填写验证码、捕获本地 OAuth 回调 URL 并交回本项目提交。遇到 CAPTCHA、MFA、手机号验证、安全检查或无法识别的页面时，扩展会停止并提示你手动处理。

注意：

- 扩展需要能访问本地 CPA Web 页和 OpenAI 登录页。manifest 里声明了 `tabs`、`activeTab`、`scripting`、`webNavigation`、`storage`、`sidePanel`、`cookies`、`browsingData` 权限，以及 `http://127.0.0.1/*`、`http://localhost/*`、`https://auth.openai.com/*`、`https://auth0.openai.com/*`、`https://accounts.openai.com/*` 等 host 权限，用于打开/识别登录页、清理会话、读取本地页面桥接状态并提交 callback。
- 使用扩展前必须保留一个本地 CPA tab，地址应为 `http://127.0.0.1:*` 或 `http://localhost:*`，并停留在本项目 `OAuth` 页面。扩展侧边栏从这个 tab 读取失效账号、Hotmail 账号池、队列和本地桥接 API；只在 OpenAI 登录页或其它网站打开侧边栏无法读取本地队列。
- 侧边栏为调试和自动登录准备，会显示 Hotmail 密码；当前实现只按需读取并显示，不写入扩展存储。
- Hotmail 账号池默认不持久保存 `refreshToken`。只有勾选 `本地持久保存 Hotmail Token` 时，浏览器 `localStorage` 才会保存 Hotmail Token；只建议在可信本机启用。
- OAuth 登录成功后的恢复判断以额度查询结果为准，不只依赖 CPA 登录状态成功。
- 普通 Web 页面不能跨域控制 `auth.openai.com` DOM；自动填写验证码和点击授权按钮需要安装上述浏览器扩展。

## 数据与缓存

Web 端本地缓存使用两类浏览器存储：

- `localStorage` 保存 CPA 地址、查询设置、Keeper 设置、优先级分组顺序、每个分组的优先级区间和 Codex OAuth Hotmail 账号池等配置；只有登录页勾选“记住本次登录”时才会保存管理密钥。
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
- 通过 `api-call` 代理 Microsoft token 与 Graph / Outlook 邮件接口，用于 Hotmail API 对接收取验证码。
- 通过 `codex-auth-url` 生成 Codex OAuth 登录链接，通过 `oauth-callback` 提交 OAuth 回调 URL，并通过 `get-auth-status` 检查登录结果。

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
- `web/src/components/` 放账号表格、工具条、设置面板、进度面板、Keeper 面板、Codex OAuth 面板和优先级弹层。
- `docker-compose.yml` 提供本地 Web 开发和预览服务。

## 参考

- [CPA Codex Tools GitHub 仓库](https://github.com/RuidongWang/CPA_Codex_tools)
- [CPACodexKeeper](https://github.com/5345asda/CPACodexKeeper)
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI/)
