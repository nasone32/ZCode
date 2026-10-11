import { createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";
import {
  CHATGPT_OAUTH_AGENT_NAME_HINT,
  CHATGPT_TOKEN_SHARING_SCOPE,
  resolveChatGptApiBaseUrl,
  resolveChatGptOAuthIssuer,
} from "@zcode/shared";

/**
 * Sign in with ChatGPT OAuth client.
 *
 * 实现官方 token-sharing 流程：动态注册（`client_id=dynamic_agent_client`）、
 * PKCE S256、loopback 回调换取 code、JWT (RS256/JWKS) 校验、refresh 轮换、
 * 会话撤销与 /v1/models 列表。凭据持久化由 chatgpt-credential-record 负责，
 * 本模块不落盘；错误信息只含结构化 code / 被打码的字段，不回显 token。
 */

export type ChatGptOAuthFetch = typeof globalThis.fetch;

export interface ChatGptOAuthEndpoints {
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly jwksUrl: string;
  readonly openidConfigurationUrl: string;
  readonly apiBaseUrl: string;
}

export function resolveChatGptOAuthEndpoints(
  env: Readonly<Record<string, string | undefined>>,
): ChatGptOAuthEndpoints {
  const issuer = resolveChatGptOAuthIssuer(env);
  return {
    authorizeUrl: `${issuer}/api/accounts/authorize`,
    tokenUrl: `${issuer}/api/accounts/oauth/token`,
    jwksUrl: `${issuer}/.well-known/jwks.json`,
    openidConfigurationUrl: `${issuer}/.well-known/openid-configuration`,
    apiBaseUrl: resolveChatGptApiBaseUrl(env),
  };
}

/** 官方要求 scope；顺序保持文档写法。 */
export const CHATGPT_OAUTH_SCOPE_STRING =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

export class ChatGptOAuthError extends Error {
  readonly code: string;
  readonly oauthError?: string;
  readonly oauthErrorDescription?: string;
  readonly httpStatus?: number;

  constructor(
    code: string,
    message: string,
    options: {
      oauthError?: string;
      oauthErrorDescription?: string;
      httpStatus?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChatGptOAuthError";
    this.code = code;
    this.oauthError = options.oauthError;
    this.oauthErrorDescription = options.oauthErrorDescription;
    this.httpStatus = options.httpStatus;
  }
}

/** 文档定义的“refresh token 不可用”错误码：清空令牌并用已保存 client_id 重走 OAuth。 */
const UNUSABLE_REFRESH_TOKEN_OAUTH_ERRORS = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

export function isUnusableRefreshTokenError(error: unknown): error is ChatGptOAuthError {
  if (!(error instanceof ChatGptOAuthError)) return false;
  if (error.code === "chatgpt_refresh_token_unusable") return true;
  return error.oauthError !== undefined && UNUSABLE_REFRESH_TOKEN_OAUTH_ERRORS.has(error.oauthError);
}

export interface ChatGptAuthorizeUrlInput {
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
  readonly extAgentHostId: string;
  /** 已签发 client_id；缺省表示首次动态注册。 */
  readonly clientId?: string;
  /** 已保存账号 email；作为 login_hint 提示登录服务器。 */
  readonly loginHint?: string;
  /** 重登时携带已保留 id_token，跳过会话选择器。 */
  readonly idTokenHint?: string;
  readonly agentNameHint?: string;
}

export function buildChatGptAuthorizeUrl(
  authorizeEndpoint: string,
  input: ChatGptAuthorizeUrlInput,
): string {
  const isFirstRegistration = !input.clientId;
  const url = new URL(authorizeEndpoint);
  url.searchParams.set("client_id", input.clientId ?? "dynamic_agent_client");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", CHATGPT_OAUTH_SCOPE_STRING);
  url.searchParams.set("resource", "https://api.openai.com/v1");
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("ext_agent_host_id", input.extAgentHostId);
  if (isFirstRegistration) {
    url.searchParams.set("agent_name_hint", input.agentNameHint ?? CHATGPT_OAUTH_AGENT_NAME_HINT);
  }
  if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
  if (input.idTokenHint) url.searchParams.set("id_token_hint", input.idTokenHint);
  return url.toString();
}

export interface ChatGptTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  earliest_refresh_at?: number | string;
}

export interface ChatGptCallbackQuery {
  readonly code?: string;
  readonly state?: string;
  readonly clientId?: string;
  readonly oauthError?: string;
  readonly oauthErrorDescription?: string;
}

export function parseChatGptCallbackUrl(callbackUrl: string): ChatGptCallbackQuery {
  const url = new URL(callbackUrl);
  return {
    code: url.searchParams.get("code") ?? undefined,
    state: url.searchParams.get("state") ?? undefined,
    clientId: url.searchParams.get("client_id") ?? undefined,
    oauthError: url.searchParams.get("error") ?? undefined,
    oauthErrorDescription: url.searchParams.get("error_description") ?? undefined,
  };
}

async function postFormTokenRequest(
  tokenEndpoint: string,
  params: Record<string, string>,
  fetchImpl: ChatGptOAuthFetch,
): Promise<ChatGptTokenResponse> {
  let response: Response;
  try {
    response = await fetchImpl(tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams(params).toString(),
    });
  } catch (error) {
    throw new ChatGptOAuthError(
      "chatgpt_token_network_error",
      "Unable to reach the OpenAI token endpoint.",
      { cause: error },
    );
  }
  const text = await response.text();
  let body: unknown = undefined;
  try {
    body = text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    body = undefined;
  }
  if (!response.ok || !isRecord(body)) {
    const oauthError = isRecord(body) ? readString(body.error) : undefined;
    const oauthErrorDescription = isRecord(body)
      ? readString(body.error_description) ?? readString(body.error_message)
      : undefined;
    throw new ChatGptOAuthError(
      "chatgpt_token_request_failed",
      `OpenAI token endpoint returned ${response.status}.`,
      { oauthError, oauthErrorDescription, httpStatus: response.status },
    );
  }
  return body as unknown as ChatGptTokenResponse;
}

export interface ChatGptCodeExchangeInput {
  readonly clientId: string;
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}

export async function exchangeChatGptAuthorizationCode(
  tokenEndpoint: string,
  input: ChatGptCodeExchangeInput,
  fetchImpl: ChatGptOAuthFetch,
): Promise<ChatGptTokenResponse> {
  return postFormTokenRequest(
    tokenEndpoint,
    {
      grant_type: "authorization_code",
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      resource: "https://api.openai.com/v1",
    },
    fetchImpl,
  );
}

export interface ChatGptRefreshInput {
  readonly clientId: string;
  readonly refreshToken: string;
}

export async function refreshChatGptAccessToken(
  tokenEndpoint: string,
  input: ChatGptRefreshInput,
  fetchImpl: ChatGptOAuthFetch,
): Promise<ChatGptTokenResponse> {
  return postFormTokenRequest(
    tokenEndpoint,
    {
      grant_type: "refresh_token",
      client_id: input.clientId,
      refresh_token: input.refreshToken,
      resource: "https://api.openai.com/v1",
    },
    fetchImpl,
  );
}

/** 撤销可续期会话；空 200 视为成功（对已失效 token 同样返回 200）。 */
export async function revokeChatGptSession(
  openidConfigurationUrl: string,
  input: { clientId: string; refreshToken: string },
  fetchImpl: ChatGptOAuthFetch,
): Promise<void> {
  const configurationResponse = await fetchImpl(openidConfigurationUrl, {
    headers: { accept: "application/json" },
  });
  if (!configurationResponse.ok) {
    throw new ChatGptOAuthError(
      "chatgpt_discovery_failed",
      `OpenID configuration request failed: ${configurationResponse.status}`,
      { httpStatus: configurationResponse.status },
    );
  }
  const configuration = (await configurationResponse.json()) as Record<string, unknown>;
  const revocationEndpoint = readString(configuration.revocation_endpoint);
  if (!revocationEndpoint) {
    throw new ChatGptOAuthError(
      "chatgpt_revocation_endpoint_missing",
      "OpenID configuration has no revocation_endpoint.",
    );
  }
  const response = await fetchImpl(revocationEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      token: input.refreshToken,
      token_type_hint: "refresh_token",
      client_id: input.clientId,
    }).toString(),
  });
  if (!response.ok) {
    throw new ChatGptOAuthError(
      "chatgpt_revocation_failed",
      `Session revocation failed: ${response.status}`,
      { httpStatus: response.status },
    );
  }
}

export interface ChatGptIdTokenClaims {
  iss?: unknown;
  sub?: unknown;
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
  nonce?: unknown;
  email?: unknown;
  name?: unknown;
  [claim: string]: unknown;
}

export interface ChatGptVerifiedIdToken {
  readonly claims: ChatGptIdTokenClaims;
}

export interface ChatGptIdTokenVerificationInput {
  readonly idToken: string;
  readonly issuer: string;
  readonly audience: string;
  readonly nonce: string;
  readonly now?: () => number;
  readonly jwks?: Readonly<Record<string, unknown>>;
  readonly fetchImpl: ChatGptOAuthFetch;
  readonly jwksUrl: string;
}

interface JsonWebKey {
  readonly kid?: string;
  readonly kty?: string;
  readonly n?: string;
  readonly e?: string;
  readonly alg?: string;
}

/** RS256 + JWKS 校验：签名、iss、aud（签发 client_id）、exp/nbf、nonce、sub 非空。 */
export async function verifyChatGptIdToken(
  input: ChatGptIdTokenVerificationInput,
): Promise<ChatGptVerifiedIdToken> {
  const now = (input.now ?? Date.now)() / 1000;
  const parts = input.idToken.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new ChatGptOAuthError("chatgpt_id_token_malformed", "id_token is not a JWS compact serialization.");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

  let header: Record<string, unknown>;
  let claims: ChatGptIdTokenClaims;
  let signature: Buffer;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    claims = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    signature = Buffer.from(encodedSignature, "base64url");
  } catch {
    throw new ChatGptOAuthError("chatgpt_id_token_malformed", "id_token header or payload is not valid base64url JSON.");
  }
  if (header.alg !== "RS256") {
    throw new ChatGptOAuthError(
      "chatgpt_id_token_algorithm",
      `id_token algorithm must be RS256 (received ${String(header.alg)}).`,
    );
  }

  const jwks = input.jwks ?? (await loadJwks(input.jwksUrl, input.fetchImpl));
  const keys = Array.isArray(jwks.keys) ? (jwks.keys as unknown[]) : [];
  const kid = readString(header.kid);
  const rsaKeys = keys.filter(
    (key): key is JsonWebKey =>
      isRecord(key) && readString(key.kty) === "RSA" && !!readString(key.n) && !!readString(key.e),
  );
  const candidates = kid
    ? rsaKeys.filter((key) => key.kid === kid)
    : // 无 kid 的 JWT 只能按唯一 RSA key 尝试；多 key 且无 kid 时拒绝猜测。
      rsaKeys.length === 1
      ? rsaKeys
      : [];
  const jwk = candidates[0];
  if (!jwk) {
    throw new ChatGptOAuthError(
      "chatgpt_id_token_unknown_key",
      "No matching RSA JWK found for id_token.",
    );
  }

  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: jwk as unknown as import("node:crypto").JsonWebKey, format: "jwk" });
  } catch {
    throw new ChatGptOAuthError("chatgpt_id_token_invalid_key", "Matching JWK could not be imported.");
  }
  const signed = Buffer.from(`${encodedHeader}.${encodedPayload}`, "utf8");
  const valid = verifySignature("RSA-SHA256", signed, publicKey, signature);
  if (!valid) {
    throw new ChatGptOAuthError("chatgpt_id_token_invalid_signature", "id_token signature verification failed.");
  }

  if (claims.iss !== input.issuer) {
    throw new ChatGptOAuthError(
      "chatgpt_id_token_invalid_issuer",
      `id_token issuer mismatch (received ${String(claims.iss)}).`,
    );
  }
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(input.audience)) {
    throw new ChatGptOAuthError("chatgpt_id_token_invalid_audience", "id_token audience does not match the issued client_id.");
  }
  if (typeof claims.exp !== "number" || now >= claims.exp) {
    throw new ChatGptOAuthError("chatgpt_id_token_expired", "id_token has expired.");
  }
  if (typeof claims.nbf === "number" && now < claims.nbf - 60) {
    throw new ChatGptOAuthError("chatgpt_id_token_not_yet_valid", "id_token nbf is in the future.");
  }
  if (typeof claims.sub !== "string" || claims.sub.trim().length === 0) {
    throw new ChatGptOAuthError("chatgpt_id_token_missing_subject", "id_token has no usable sub claim.");
  }
  if (claims.nonce !== input.nonce) {
    throw new ChatGptOAuthError("chatgpt_id_token_nonce_mismatch", "id_token nonce does not match this attempt.");
  }
  return { claims };
}

async function loadJwks(
  jwksUrl: string,
  fetchImpl: ChatGptOAuthFetch,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(jwksUrl, { headers: { accept: "application/json" } });
  } catch (error) {
    throw new ChatGptOAuthError("chatgpt_jwks_network_error", "Unable to load OpenAI JWKS.", {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new ChatGptOAuthError("chatgpt_jwks_unavailable", `JWKS request failed: ${response.status}`, {
      httpStatus: response.status,
    });
  }
  const body = (await response.json()) as unknown;
  if (!isRecord(body)) {
    throw new ChatGptOAuthError("chatgpt_jwks_malformed", "JWKS response is not a JSON object.");
  }
  return body;
}

export interface ChatGptModelListEntry {
  readonly slug: string;
  readonly display_name: string;
}

export interface ChatGptModelListResult {
  readonly models: readonly ChatGptModelListEntry[];
}

/** GET /v1/models（Bearer OAuth token）；按文档过滤 visibility == "list"。 */
export async function fetchChatGptModelList(
  modelsEndpoint: string,
  accessToken: string,
  fetchImpl: ChatGptOAuthFetch,
): Promise<ChatGptModelListResult> {
  let response: Response;
  try {
    response = await fetchImpl(modelsEndpoint, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    });
  } catch (error) {
    throw new ChatGptOAuthError("chatgpt_models_network_error", "Unable to load the ChatGPT model list.", {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new ChatGptOAuthError(
      "chatgpt_models_request_failed",
      `Model list request failed: ${response.status}`,
      { httpStatus: response.status },
    );
  }
  const body = (await response.json()) as unknown;
  const models = isRecord(body) && Array.isArray(body.models) ? body.models : [];
  const entries: ChatGptModelListEntry[] = [];
  for (const entry of models) {
    if (!isRecord(entry)) continue;
    const slug = readString(entry.slug);
    const displayName = readString(entry.display_name);
    if (!slug || !displayName) continue;
    // 文档：只暴露 visibility == "list" 且可在 API 使用的模型。
    if (readString(entry.visibility) !== "list") continue;
    if (entry.supported_in_api === false) continue;
    entries.push({ slug, display_name: displayName });
  }
  if (entries.length === 0) {
    throw new ChatGptOAuthError("chatgpt_models_empty", "The account exposes no listable models.");
  }
  return { models: entries };
}

/** 官方 scope 检查：缺失 token-sharing scope 时禁止推理调用。 */
export function assertChatGptTokenSharingScope(tokenResponse: ChatGptTokenResponse): readonly string[] {
  const scopes = (tokenResponse.scope ?? "").split(/\s+/u).filter((scope) => scope.length > 0);
  if (!scopes.includes(CHATGPT_TOKEN_SHARING_SCOPE)) {
    throw new ChatGptOAuthError(
      "chatgpt_token_sharing_scope_missing",
      "The ChatGPT account did not grant token sharing. Sign in again and allow it, or use an OpenAI API key.",
    );
  }
  return scopes;
}

export function parseEarliestRefreshAt(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Number(value) || undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
