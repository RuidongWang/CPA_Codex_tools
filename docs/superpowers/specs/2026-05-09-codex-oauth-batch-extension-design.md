# Codex OAuth 批量自动恢复插件设计

## 目标

将现有 `Codex OAuth登录` 单账号辅助流程升级为全自动批量恢复流程。系统批量处理失效账号，逐个调用 CPA Codex OAuth 登录，自动完成 OpenAI 登录页邮箱填写、Hotmail 验证码读取、授权确认和 callback 提交。

本设计面向 Chrome/Edge 扩展与本地 Web 页面协作。用户选择的方向是：

- 全自动批量恢复。
- 串行执行，一个账号完成后再处理下一个。
- 每个账号开始前清理所有 OpenAI 相关域名登录态。
- 遇到 CAPTCHA、MFA、手机号验证、风控页时，先结束当前 auth tab、重新清理 OpenAI 登录态并重跑当前 Job 1 次；仍失败则标记异常并跳过。
- 账号范围支持默认全部失效账号，也支持筛选/勾选账号。
- callback 提交成功即视为队列项成功，并立即进入下一个账号。
- callback 后只做 OAuth 状态复查，不做额度查询。

## 非目标

- 不做并发多账号恢复。
- 不自动破解 CAPTCHA、MFA、手机号验证、passkey 或其它安全验证。
- 不在插件中保存 CPA 管理密钥、Hotmail refresh token、验证码、账号真相数据。
- 不将“callback 已提交”描述为“额度已恢复”。
- 不默认引入 `debugger` 权限；可作为后续兜底增强。

## 总体架构

采用 `Web Job Controller + Extension Browser Executor`。

本地 Web 是任务真相源：

- 维护失效账号来源和筛选结果。
- 管理 Hotmail 账号池、refresh token、验证码读取。
- 创建、持久化、更新批量 Job 队列。
- 校验 OAuth `state` 并提交 callback。
- 后台复查 OAuth 状态。
- 展示 Job 明细、错误诊断和后验状态。

浏览器扩展只做浏览器执行器：

- 清理 OpenAI 相关域名登录态。
- 打开 Job 的 OAuth URL。
- 在 OpenAI/Auth0/Accounts 页面识别状态。
- 填写邮箱、点击继续、填写验证码、点击授权。
- 捕获 callback URL。
- 将阶段、错误、页面诊断、callback 结果回写给 Web。

## Job 队列

每个失效账号生成一个 Job。队列串行处理，插件一次只领取一个可运行 Job。

Job 需要保存以下字段：

- 身份字段：`jobId`、`authIndex`、`accountEmail`、`hotmailId`、`hotmailEmail`。
- 运行字段：`status`、`attempt`、`retryCount`、`startedAt`、`updatedAt`、`lockedByExtension`。
- OAuth 字段：`state`、`authUrl`、`callbackUrl`、`callbackSubmittedAt`、`oauthStatus`、`oauthCheckedAt`、`oauthError`。
- 诊断字段：`lastError`、`manualReason`、`lastPageSnapshot`、`lastCodeAt`、`rejectedCodes`。

核心状态：

- `queued`：等待执行。
- `session_clearing`：正在清理 OpenAI 登录态。
- `oauth_started`：已获取 OAuth URL。
- `email_submitting`：正在填写邮箱并点击继续。
- `code_polling`：正在轮询 Hotmail 验证码。
- `code_submitting`：正在填写验证码并提交。
- `consent_submitting`：正在点击授权确认。
- `callback_submitted`：callback 已提交，队列项成功。
- `manual_required`：需要人工处理，跳过后续账号继续执行。
- `failed`：重试后仍失败，跳过后续账号继续执行。

状态规则：

- callback 提交成功后立即标记 `callback_submitted`，队列继续下一个账号。
- OAuth 状态复查独立进行，Job 的 `status` 保持 `callback_submitted`，只更新 `oauthStatus`、`oauthCheckedAt` 和 `oauthError`，不阻塞队列。
- 每个 Job 默认最多运行 2 轮：首次执行 + 1 次整 Job 重试。整 Job 重试会关闭当前 auth tab、重新清理 OpenAI 登录态、重新请求 OAuth URL。
- `manual_required` 与 `failed` 都不会阻塞队列。

Job 锁规则：

- `CLAIM_JOB` 成功后，Web 将 Job 标记为 `lockedByExtension` 并写入 `leaseExpiresAt`。
- 默认 lease TTL 为 2 分钟；插件每 30 秒通过 `UPDATE_JOB` heartbeat 延长 lease。
- 如果插件崩溃或 service worker 被回收，Web 在 lease 过期后执行确定性恢复：
  - 清空 `lockedByExtension` 和 `leaseExpiresAt`。
  - 如果当前 `attempt` 为 0，将 `attempt` 设为 1，`retryCount` 设为 1，`status` 回到 `queued`。
  - 如果当前 `attempt` 已经为 1，将 `status` 设为 `failed`，`lastError` 设为 `lease_expired_after_retry`。
- `暂停` 不中断当前正在执行的 Job，只阻止领取下一个 Job。
- `停止` 中断当前 Job，关闭 auth tab，调用 `RELEASE_JOB`，默认将当前 Job 保留为 `queued`；如果用户选择“停止并标记失败”，则设为 `failed`。

## Bridge 合约

现有 bridge 应扩展为全局、版本化 RPC，不依赖 `CodexOAuthPanel` 是否正在渲染。

建议动作：

- `GET_CAPABILITIES`：返回 bridge 版本和支持的动作。
- `BUILD_QUEUE`：按全部失效账号、勾选账号或筛选结果构建 Job 队列。
- `GET_QUEUE`：返回队列摘要和 Job 明细。
- `CLAIM_JOB`：插件领取下一个可运行 Job。
- `UPDATE_JOB`：插件回写阶段、错误、页面诊断和重试状态。
- `START_JOB_OAUTH`：Web 为指定 Job 获取 OAuth URL 和 `state`。
- `FETCH_CODE`：Web 为指定邮箱、Job 和时间戳读取 Hotmail 验证码。
- `SUBMIT_CALLBACK`：Web 校验并提交 callback URL；校验通过后必须先原子写入 `callbackUrl`、`callbackSubmittedAt`、`status=callback_submitted`，再向插件返回成功。
- `CHECK_OAUTH_STATUS`：Web 查询 callback 后的 OAuth 后验状态。
- `RELEASE_JOB`：插件停止或崩溃恢复时释放锁。

所有动作都必须显式携带 `jobId`。涉及账号的动作还应携带 `authIndex` 和目标邮箱，用于 Web 侧校验。

RPC 返回统一结构：

- 成功：`{ ok: true, result: ... }`
- 可重试失败：`{ ok: false, errorType: "retryable", code, message, retryAfterMs? }`
- 需人工：`{ ok: false, errorType: "manual", code, message, manualReason }`
- 致命失败：`{ ok: false, errorType: "fatal", code, message }`

最小请求/响应要求：

- `CLAIM_JOB` 返回 `jobId`、`authIndex`、`accountEmail`、`hotmailEmail`、`attempt`、`leaseExpiresAt`。
- `START_JOB_OAUTH` 返回 `authUrl`、`state`、`startedAt`。
- `FETCH_CODE` 返回 `code`、`codeAt`、`sourceEmail`；未找到验证码时返回 retryable `code_not_found`。
- `SUBMIT_CALLBACK` 返回 `callbackSubmittedAt`、`status`、`message`。同一个 Job 的同一个 callback URL 重复提交时必须幂等返回成功；不同 callback URL 或 `state` 不匹配必须返回 fatal。
- `CHECK_OAUTH_STATUS` 返回 `oauthStatus`、`message`。

## 插件执行策略

每个 Job 的执行步骤：

1. 清理所有 OpenAI 相关域名登录态，包括 OAuth 域名和 ChatGPT/OpenAI 站点域名。
2. 请求 Web 为 Job 创建 OAuth URL。
3. 打开 OAuth URL 到 OpenAI auth tab。
4. 识别页面状态：`email`、`verification`、`consent`、`manual_required`、`unknown`。
5. 邮箱页：填写目标邮箱，点击继续。
6. 验证码页：以点击继续时间作为 `filterAfterTimestamp`，请求 Web 读取 Hotmail 验证码。
7. 填写验证码，提交验证码页。
8. 授权页：点击授权或继续。
9. 捕获 callback URL，交给 Web 提交。
10. callback 提交成功后领取下一个 Job。

每个执行轮的总超时时间默认为 5 分钟。执行轮指同一个 Job 的一次 `attempt`，包含页面识别、邮箱提交、验证码轮询、授权确认、callback 捕获和 callback 提交。验证码轮询间隔默认为 3.5 秒，不做指数退避；未取到验证码时继续轮询，直到当前执行轮 5 分钟超时或页面进入其它状态。

执行轮超时会消耗整 Job 的唯一一次重试机会：`attempt=0` 超时时，插件关闭 auth tab、清理 OpenAI 登录态，将 Job 重新放回 `queued` 并以 `attempt=1` 重跑；`attempt=1` 再次超时时，Job 标记为 `failed`，`lastError=job_timeout_after_retry`。

点击策略：

- 点击前等待按钮可用。
- 执行 `scrollIntoView` 和 `focus`。
- 依次尝试 `form.requestSubmit`、原生 `click`、派发 click 事件。
- 点击后重新 classify 页面，确认页面状态前进。
- 如果页面短暂 unknown 或按钮暂不可点，按 retryable 错误处理。

账号安全校验：

- 授权前如果页面显示邮箱与 `accountEmail` 不一致，插件不得点击授权。
- 插件应先清 session 并重试当前 Job。
- 重试后仍不一致时，标记 `failed`，`lastError=account_email_mismatch`，并跳过。

## 验证码策略

验证码读取由 Web 执行，插件只发起请求。

`FETCH_CODE` 应支持：

- `jobId`
- `expectedEmail`
- `state`
- `filterAfterTimestamp`
- `excludeCodes`

验证码未到应返回 retryable 语义，不应直接终止整个队列。插件按 3.5 秒固定间隔重试，直到当前执行轮 5 分钟超时或页面进入其它状态。

如果验证码被页面拒绝，插件将该验证码加入 `rejectedCodes`，后续取码请求排除该 code。

## 错误分类

`retryable`：

- 验证码暂未到达。
- 页面短暂 unknown。
- 按钮暂不可点击。
- content script 通道短暂失败。
- 页面加载或跳转中。

`manual_required`：

- CAPTCHA。
- MFA。
- 手机号验证。
- passkey。
- suspicious login。
- 其它明确安全验证页。

`fatal`：

- 缺 Hotmail 账号。
- Hotmail token 无效且无法刷新。
- callback URL 无效。
- OAuth `state` 不匹配。
- Web bridge 不支持所需能力。

处理规则：

- retryable 错误优先在当前执行轮内等待或重试，直到阶段前进或执行轮 5 分钟超时。
- 执行轮超时时，如果 `attempt=0`，关闭 auth tab、清理 OpenAI 登录态、重新运行当前 Job；如果 `attempt=1`，记录为 `failed`。
- manual 错误代表安全验证或人工验证页；如果 `attempt=0`，关闭 auth tab、清理 OpenAI 登录态、重新运行当前 Job；如果 `attempt=1`，记录为 `manual_required`。
- fatal 错误代表当前 Job 无法通过重跑修复，必须立即记录为 `failed`，不消耗也不触发整 Job 重试。
- 队列继续处理下一个账号。

## UI 设计

插件侧边栏显示执行控制和实时进度：

- `开始全部`
- `暂停`
- `继续`
- `停止`
- 当前 Job 邮箱、阶段、尝试次数、最近错误。
- 队列统计：待处理、运行中、callback 已提交、失败、需人工。
- 不默认展示 Hotmail 密码或 refresh token。

Web OAuth 页面显示队列真相和诊断：

- 队列构建入口：全部失效账号、勾选账号、筛选结果。
- Job 列表和明细。
- Hotmail 匹配状态。
- callback 提交结果。
- OAuth 后验状态：`success`、`pending`、`error`。
- 页面诊断 snapshot、frameId、按钮状态、错误原因。

UI 文案必须区分：

- `callback 已提交`：队列项成功。
- `OAuth success`：后验状态成功。
- 不显示 `额度已恢复`，因为本流程不做额度查询。

## 权限与安全

扩展权限应继续保持收敛。

OpenAI 相关域名清理范围和 host permissions：

- `https://auth.openai.com/*`
- `https://auth0.openai.com/*`
- `https://accounts.openai.com/*`
- `https://chatgpt.com/*`
- `https://chat.openai.com/*`
- `https://platform.openai.com/*`
- `https://openai.com/*`

本地 Web host permissions：

- `http://localhost/*`
- `http://127.0.0.1/*`

权限：

- `tabs`
- `activeTab`
- `scripting`
- `webNavigation`
- `storage`
- `sidePanel`
- `cookies`
- `browsingData`

不使用 `<all_urls>` 作为默认策略。

敏感数据原则：

- Hotmail refresh token、CPA key、验证码不写入扩展持久存储。
- 插件状态可放 `chrome.storage.session`，用于侧边栏展示和短期恢复。
- Job 真相和持久化由 Web 管理。

## 测试策略

新增测试覆盖：

- 队列状态机纯函数：状态流转、重试次数、跳过规则。
- 错误分类：retryable、manual、fatal。
- Bridge 合约：`BUILD_QUEUE`、`CLAIM_JOB`、`UPDATE_JOB`、`START_JOB_OAUTH`、`FETCH_CODE`、`SUBMIT_CALLBACK`、`CHECK_OAUTH_STATUS`。
- `SUBMIT_CALLBACK`：同 callback URL 幂等成功，不同 callback URL 或 `state` 不匹配 fatal。
- OpenAI content helper：邮箱页、验证码页、授权页、manual 页、unknown 页。
- session 清理域名列表：只覆盖 OpenAI 相关域名。
- callback 成功后不阻塞队列、OAuth 状态后台复查。
- 执行轮超时：首次超时重跑一次，二次超时标记 `failed`。
- fatal 错误：立即 `failed`，不触发整 Job 重试。
- lease 过期：`attempt=0` 回到 `queued` 并变为 `attempt=1`，`attempt=1` 标记 `failed`。

验收标准：

- 用户可以构建全部失效账号队列或勾选账号队列。
- 用户可以基于当前搜索/筛选结果构建队列。
- 插件可以串行处理队列。
- 每个账号开始前清理 OpenAI 登录态。
- callback 提交成功后立即进入下一个账号。
- OAuth 后验状态可以更新到 Web。
- CAPTCHA/MFA/手机号验证等异常账号会重试 1 次后跳过。
- callback 提交接口重复收到相同 callback URL 时不会重复推进队列或重复提交远端。
- 插件崩溃或关闭后，Web 能在 lease 过期后释放当前 Job。
- 队列运行中断后，Web 能显示已完成、失败、需人工和待处理 Job。
