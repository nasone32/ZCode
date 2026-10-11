/**
 * Sign in with ChatGPT (OpenAI token sharing) 常量与凭据键。
 *
 * 依据 OpenAI 官方文档 https://developers.openai.com/siwc/token-sharing-open-source：
 * 授权 / 令牌端点、动态注册 client、PKCE、`ext_agent_host_id`、Responses API
 * (`store:false` + `stream:true`) 均为协议规定值，不得随意改写；仅允许通过
 * env 覆盖用于测试。
 */

/** Built-in ChatGPT (plan usage) Provider ID；与 config/provider/zcode-builtin.json 保持一致。 */
export const CHATGPT_PROVIDER_ID = "account:chatgpt";

export const CHATGPT_OAUTH_ISSUER = "https://auth.openai.com";
export const CHATGPT_OAUTH_AUTHORIZE_ENDPOINT = `${CHATGPT_OAUTH_ISSUER}/api/accounts/authorize`;
export const CHATGPT_OAUTH_TOKEN_ENDPOINT = `${CHATGPT_OAUTH_ISSUER}/api/accounts/oauth/token`;
export const CHATGPT_OAUTH_JWKS_URL = `${CHATGPT_OAUTH_ISSUER}/.well-known/jwks.json`;
export const CHATGPT_OAUTH_OPENID_CONFIGURATION_URL = `${CHATGPT_OAUTH_ISSUER}/.well-known/openid-configuration`;

/** 首次登录使用的动态注册入口 client；签发的 client_id 由回调返回并持久化。 */
export const CHATGPT_OAUTH_REGISTRATION_CLIENT_ID = "dynamic_agent_client";
/** 注册时展示给用户的 agent 名称；文档要求为应用真实名称。 */
export const CHATGPT_OAUTH_AGENT_NAME_HINT = "ZCode";

export const CHATGPT_OAUTH_RESOURCE = "https://api.openai.com/v1";
export const CHATGPT_OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "resource.invoke",
  "chatgpt.tokens.use.direct",
] as const;
/** ChatGPT 计划用量必需的 scope；缺失时按官方文档禁止推理调用。 */
export const CHATGPT_TOKEN_SHARING_SCOPE = "chatgpt.tokens.use.direct";

/** 回调路径必须精确匹配（`/callback` ≠ `/auth/callback`）；host 固定 127.0.0.1。 */
export const CHATGPT_OAUTH_CALLBACK_PATH = "/auth/callback";

/** OpenAI 官方 /v1/models（Bearer OAuth access token）与推理端点。 */
export const CHATGPT_API_BASE_URL = "https://api.openai.com/v1";
export const CHATGPT_MODELS_ENDPOINT = `${CHATGPT_API_BASE_URL}/models`;

/** env 覆盖（测试 / 自托管环境）。 */
export const CHATGPT_OAUTH_ISSUER_ENV = "ZCODE_CHATGPT_OAUTH_ISSUER";
export const CHATGPT_API_BASE_URL_ENV = "ZCODE_CHATGPT_API_BASE_URL";

export function resolveChatGptOAuthIssuer(env: Readonly<Record<string, string | undefined>>): string {
  return env[CHATGPT_OAUTH_ISSUER_ENV]?.trim() || CHATGPT_OAUTH_ISSUER;
}

export function resolveChatGptApiBaseUrl(env: Readonly<Record<string, string | undefined>>): string {
  return env[CHATGPT_API_BASE_URL_ENV]?.trim().replace(/\/+$/u, "") || CHATGPT_API_BASE_URL;
}

/** 加密凭据存储键（SharedZCodeCredentialStore）。Token 不得进入 Provider Config / 日志。 */
export const CHATGPT_CREDENTIAL_KEYS = {
  /** `urn:uuid:…` 稳定 host 标识；首次登录生成后永不重建。 */
  hostId: "oauth:chatgpt:ext_agent_host_id",
  clientId: "oauth:chatgpt:client_id",
  accessToken: "oauth:chatgpt:access_token",
  refreshToken: "oauth:chatgpt:refresh_token",
  idToken: "oauth:chatgpt:id_token",
  /** JSON：{ email?, subject, scopes, plan? }——仅展示元数据。 */
  account: "oauth:chatgpt:account",
  /** epoch ms；访问令牌过期时间。 */
  expiresAt: "oauth:chatgpt:expires_at",
  /** epoch ms；refresh_token 最早可刷新时间（官方 earliest_refresh_at）。 */
  earliestRefreshAt: "oauth:chatgpt:earliest_refresh_at",
  /** JSON：[{ slug, display_name }]——/v1/models 缓存。 */
  models: "oauth:chatgpt:models",
} as const;

export interface ChatGptCachedModel {
  readonly slug: string;
  readonly display_name: string;
}

export interface ChatGptAccountSummary {
  readonly subject: string;
  readonly email?: string;
  readonly name?: string;
  readonly plan?: string;
  readonly scopes: readonly string[];
}

/** 解密后的 ChatGPT 凭据记录（CLI 与 Desktop host 共用同一解析逻辑）。 */
export interface ChatGptCredentialRecordData {
  readonly hostId: string;
  readonly clientId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly idToken: string;
  readonly account: ChatGptAccountSummary;
  readonly expiresAt: number;
  readonly earliestRefreshAt?: number;
}

/** 完整记录所需的全部键；供 loadMany 批量读取。 */
export const CHATGPT_CREDENTIAL_RECORD_KEYS: readonly string[] = [
  CHATGPT_CREDENTIAL_KEYS.hostId,
  CHATGPT_CREDENTIAL_KEYS.clientId,
  CHATGPT_CREDENTIAL_KEYS.accessToken,
  CHATGPT_CREDENTIAL_KEYS.refreshToken,
  CHATGPT_CREDENTIAL_KEYS.idToken,
  CHATGPT_CREDENTIAL_KEYS.account,
  CHATGPT_CREDENTIAL_KEYS.expiresAt,
  CHATGPT_CREDENTIAL_KEYS.earliestRefreshAt,
];

/**
 * 解析完整凭据记录；任一必需成员缺失或损坏即返回 null（视为未登录，
 * Registry 侧 fail-closed）。values 为解密后的明文。
 */
export function parseChatGptCredentialRecordData(
  values: Readonly<Record<string, string | null | undefined>>,
): ChatGptCredentialRecordData | null {
  const hostId = values[CHATGPT_CREDENTIAL_KEYS.hostId]?.trim();
  const clientId = values[CHATGPT_CREDENTIAL_KEYS.clientId]?.trim();
  const accessToken = values[CHATGPT_CREDENTIAL_KEYS.accessToken]?.trim();
  const refreshToken = values[CHATGPT_CREDENTIAL_KEYS.refreshToken]?.trim();
  const idToken = values[CHATGPT_CREDENTIAL_KEYS.idToken]?.trim();
  const accountRaw = values[CHATGPT_CREDENTIAL_KEYS.account];
  const expiresAt = Number(values[CHATGPT_CREDENTIAL_KEYS.expiresAt]);
  if (
    !hostId ||
    !clientId ||
    !accessToken ||
    !refreshToken ||
    !idToken ||
    !accountRaw ||
    !Number.isFinite(expiresAt)
  ) {
    return null;
  }
  let account: ChatGptAccountSummary;
  try {
    account = JSON.parse(accountRaw) as ChatGptAccountSummary;
  } catch {
    return null;
  }
  if (typeof account?.subject !== "string" || account.subject.trim().length === 0) {
    return null;
  }
  const earliestRefreshAt = Number(values[CHATGPT_CREDENTIAL_KEYS.earliestRefreshAt]);
  return {
    hostId,
    clientId,
    accessToken,
    refreshToken,
    idToken,
    account,
    expiresAt,
    ...(Number.isFinite(earliestRefreshAt) ? { earliestRefreshAt } : {}),
  };
}

/** 解析 /v1/models 缓存 JSON；损坏或为空返回 null。 */
export function parseChatGptCachedModelsJson(
  raw: string | null | undefined,
): readonly ChatGptCachedModel[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const models = parsed.filter(
      (entry): entry is ChatGptCachedModel =>
        typeof entry?.slug === "string" &&
        entry.slug.trim().length > 0 &&
        typeof entry?.display_name === "string" &&
        entry.display_name.trim().length > 0,
    );
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}
