# ChatGPT OAuth（Sign in with ChatGPT / OpenAI token sharing）

ZCode 支持用 ChatGPT Plus/Pro 订阅直接推理，无需 OpenAI API key。实现严格遵循
OpenAI 官方文档 <https://developers.openai.com/siwc/token-sharing-open-source>（下称 SIWC），
不使用任何 ChatGPT 私有端点，也不模拟其他客户端身份。

## 登录

```bash
zcode login chatgpt        # CLI；或 TUI 内 /login → "Continue with ChatGPT"
zcode logout chatgpt       # 撤销会话并清除本机令牌
```

流程（`apps/zcode-cli/packages/adapters/src/auth/chatgpt/`）：

1. **动态注册**：首次登录向 `https://auth.openai.com/api/accounts/authorize` 发送
   `client_id=dynamic_agent_client` + `agent_name_hint=ZCode`；签发的 `client_id`
   （`oaiapp_…`）从回调返回并持久化，此后登录复用（回调 client_id 不一致即报错）。
2. **PKCE + loopback**：随机端口监听 `http://127.0.0.1:<port>/auth/callback`
   （路径精确匹配，不使用 localhost）；`code_challenge_method=S256`；`state`/`nonce`
   每次登录新生成；稳定 `ext_agent_host_id`（`urn:uuid:…`，一次生成永不重建）。
3. **Token 交换**：`POST /api/accounts/oauth/token`，form-encoded
   `grant_type=authorization_code` + `code_verifier` + `resource=https://api.openai.com/v1`，
   无 client secret。
4. **校验**：scope 必须包含 `chatgpt.tokens.use.direct`（缺失则拒绝推理授权）；
   `id_token` 以 `https://auth.openai.com/.well-known/jwks.json` 的 RS256 公钥验签，
   并校验 `iss` / `aud`（= 签发 client_id）/ `exp` / `nonce` / `sub`。
5. **模型发现**：`GET https://api.openai.com/v1/models`（Bearer access token），
   过滤 `visibility == "list"`，取 `{slug, display_name}` 缓存到本机。
6. **登出**：从 `/.well-known/openid-configuration` 读取 `revocation_endpoint` 撤销
   可续期会话（空 200 = 成功），然后清除本机令牌，保留 client/host 标识供复用。

## 凭据与安全

- Token（access / refresh / id_token）只存于加密 Shared Credential Store
  （`~/.zcode/v2/credentials.json`，AES-256-GCM，原子写 + 文件锁，键 `oauth:chatgpt:*`）。
  绝不进入 Provider Config、日志、遥测或仓库。
- **刷新**：access token 1 小时有效；到期前 5 分钟阈值触发
  `grant_type=refresh_token`（不带 `scope`，保留授权）。refresh token 30 天滚动轮换，
  响应中的新 refresh token 原子替换；`earliest_refresh_at` 被尊重（有界等待）。
  进程内 single-flight；跨进程轮换用 `deleteIfValue` 认领——失败方回读最新凭据，
  不会误删并行进程刚轮换的新 token。`invalid_grant`/`refresh_token_reused` 等
  不可用错误只在存储值仍是本次使用的 token 时清空凭据（提示重新 `zcode login chatgpt`）。

## Provider / 模型

- Built-in Provider `account:chatgpt`（`config/provider/zcode-builtin.json`），
  `access.type = "openai-oauth"`，`api.type = "openai-responses"`，
  `baseUrl = https://api.openai.com/v1`。种子模型包含 `gpt-6.1-sol`（GPT Sol）、
  `gpt-6.1-sol-fast`、`gpt-6-astra`、`gpt-6-sol`、`gpt-6-luna`、`gpt-5.6-sol/terra/luna`、
  `gpt-5.5(-fast)`；登录后由 `/v1/models` 实际返回值热更新（Registry Account Overlay）。
- 未登录时 fail-closed：`entitled=false`，Provider 不进入 Registry，`/model` 不显示。
- 请求鉴权：`ModelRequestAuthSource` 逐请求交付 access token
  （`Authorization: Bearer …`，经 `requestAuth.apiKey` → AI SDK openai 路径），
  与 zhipu 账号的动态鉴权门禁（`model_request_auth_missing`）同一条 fail-closed 链路，
  agent / subagent / sidecar / workflow actor 全部复用同一 ModelFactory 注入。

## Responses API 合规（ChatGPT 计划用量）

`apps/zcode-cli/packages/adapters/src/model/chatgpt-responses-compat.ts` 在 option-map
之后清理请求体：

- 强制 `store: false`、`stream: true`（成功只认 `response.completed`）；
- 剥离 SIWC preview-limitations 列出的不支持字段：`max_output_tokens`、`temperature`、
  `top_p`、`top_logprobs`、`metadata`、`truncation`、`user`、`previous_response_id`、
  `service_tier` 等（含 option map 注入的输出预算）；
- `include` 合并 `reasoning.encrypted_content`（store:false 下的推理状态回放）；
- system 提示经 `instructions` 下发（顶层 system message item 会被官方拒绝）。

## 错误处理（官方 errors-and-recovery）

`subscription_sharing_*` / `chatpass_v2_*` 业务码映射见
`adapters/src/model/failure-provider-business-codes.ts`：

| code | 处置 |
| --- | --- |
| `subscription_sharing_usage_limit_exceeded` (429) | 终止 + 提示 chatgpt.com/settings/usage，不自动换路径 |
| `subscription_sharing_user_not_eligible` (403) | 终止并解释资格限制 |
| `subscription_sharing_unsupported_capability` (400) | 终止，提示移除不支持的输入/工具/模型 |
| `subscription_sharing_route_not_supported` (403) | 终止（仅支持 POST /v1/responses） |
| `subscription_sharing_invalid_user` (401) | 提示重新 `zcode login chatgpt` |
| `subscription_sharing_usage_unavailable` / `user_unavailable` (503) | 保留凭据，有界退避重试 |

## 测试

- `adapters/tests/chatgpt-pkce.test.ts` — RFC 7636 向量、verifier 约束。
- `adapters/tests/chatgpt-oauth-client.test.ts` — authorize URL（首注册/重登）、
  code 交换表单、refresh（无 scope）、撤销、模型列表过滤、scope 门禁。
- `adapters/tests/chatgpt-id-token.test.ts` — RS256/JWKS 验签、iss/aud/nonce/exp/alg。
- `adapters/tests/chatgpt-login-flow.test.ts` — 真实 loopback + mock 授权服务器全流程、
  二次登录复用 client_id、scope 拒绝、登出撤销。
- `adapters/tests/chatgpt-request-auth.test.ts` — 阈值刷新、single-flight、轮换持久化、
  并行进程竞态、不可用 refresh 清理、未登录 fail-closed。
- `adapters/tests/chatgpt-responses-compat.test.ts` — body 合规补丁。
- `adapters/tests/chatgpt-model-wire.test.ts` — Bearer 注入 + 合规 body + 流式文本与
  function tool call 解析（SSE）。
- `adapters/tests/chatgpt-account-overlay.test.ts` — entitlement/models 投影。
- `packages/provider-node/test/chatgpt-builtin-provider.test.ts` — builtin 声明、
  resolver fail-closed/entitled 门禁、既有 Provider 不受影响。

## Desktop App（Host 侧投影）

桌面不新增任何登录按钮：ChatGPT 凭据是本机事实，由 CLI 侧 `zcode login chatgpt`
写入共享加密 store（`~/.zcode/v2/credentials.json`），Desktop Host 读取同一份。

- `packages/services/src/model-provider/chatGptAccountProjection.ts`：Host Account
  Source 包装器（`createChatGptAwareAccountProviderSource`，装配于 `node.ts`）把
  entitlement + `/v1/models` 缓存投影进 Host Registry——桌面模型选择器、默认选择、
  推送给 agent 的 Account 快照都由此生效；凭据文件 watcher 监听 CLI 落盘，
  login/logout 后热刷新，无需重启桌面。
- 记录/模型缓存的结构化解析在 `@zcode/shared`（`chatgpt.ts`），CLI 与 Desktop
  共用同一实现；Token 绝不进入 Provider Config。
- Agent 进程（`dist/zcode.cjs app-server --stdio`）侧另有兜底投影与 requestAuth
  Source（Bearer 注入 + 惰性刷新），与 Host 推送幂等叠加。
- **Builtin revision 已提升到 932**：防止 Host 的 CDN 远端刷新用官方 release
  （无 ChatGPT Provider）覆盖本地配置。fork 升级官方配置时需要重新合并并保持
  本地 revision 高于 CDN。

## 已知限制

- Plus 账户的五小时用量额度在所有使用 ChatGPT 计划的 App 之间共享（官方行为）；
  Pro 无五小时限制。
- 不支持 SIWC preview-limitations 列出的能力：图片生成、file search、Code Interpreter、
  原生 computer use、hosted MCP、`tool_search`、`programmatic_tool_calling`、
  audio/video 输入、Batch/微调等。这些请求会得到
  `subscription_sharing_unsupported_capability`。
- Desktop 登录仍走 CLI（`zcode login chatgpt` 或 TUI `/login chatgpt`）：官方要求
  127.0.0.1 loopback 回调，与桌面 deep-link OAuth 栈不兼容（按需求不新增
  "Continue with ChatGPT" 按钮）。
- `store:false` 下无服务端会话：每次请求都携带完整上下文（ZCode 本就如此）；
  `previous_response_id` 不可用。
