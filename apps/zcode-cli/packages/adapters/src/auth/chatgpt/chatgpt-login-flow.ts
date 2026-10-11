import { CHATGPT_OAUTH_CALLBACK_PATH } from "@zcode/shared";
import type { SharedZCodeCredentialStore } from "../shared-credentials.js";
import { openUrlInBrowser, type BrowserOpenResult } from "../browser.js";
import { createLocalhostOAuthCallbackServer } from "../localhost-callback.js";
import { computePkceCodeChallenge, createPkceVerifier, createRandomToken } from "./pkce.js";
import {
  assertChatGptTokenSharingScope,
  buildChatGptAuthorizeUrl,
  ChatGptOAuthError,
  exchangeChatGptAuthorizationCode,
  fetchChatGptModelList,
  parseChatGptCallbackUrl,
  resolveChatGptOAuthEndpoints,
  revokeChatGptSession,
  verifyChatGptIdToken,
  type ChatGptModelListEntry,
  type ChatGptOAuthFetch,
} from "./chatgpt-oauth-client.js";
import {
  clearChatGptTokens,
  readChatGptCachedModels,
  readChatGptClientId,
  readChatGptCredentialRecord,
  resolveChatGptHostId,
  toChatGptCredentialRecord,
  writeChatGptCachedModels,
  writeChatGptCredentialRecord,
} from "./chatgpt-credential-record.js";

/**
 * Sign in with ChatGPT 交互式登录流程（官方 token-sharing 实现）：
 *
 * 1. 读取/创建稳定 `ext_agent_host_id` 与已签发 client_id；
 * 2. 启动 127.0.0.1 loopback 监听（随机端口，路径精确 `/auth/callback`）；
 * 3. 打开系统浏览器完成授权（首次携带 `agent_name_hint` 动态注册）；
 * 4. 校验 state、回调 client_id 与已保存值一致；
 * 5. PKCE code 交换 → scope 检查 → JWKS/RS256 校验 id_token（含 nonce）；
 * 6. 拉取 /v1/models 缓存并持久化凭据。
 */

export interface ChatGptLoginOptions {
  readonly store: SharedZCodeCredentialStore;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl?: ChatGptOAuthFetch;
  readonly noBrowser?: boolean;
  readonly openBrowser?: (url: string) => Promise<BrowserOpenResult>;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly onAuthorizeUrl?: (url: string) => void;
}

export interface ChatGptLoginResult {
  readonly account: {
    readonly subject: string;
    readonly email?: string;
    readonly name?: string;
  };
  readonly clientId: string;
  readonly firstRegistration: boolean;
  readonly models: readonly ChatGptModelListEntry[];
  readonly credentialsPath: string;
  readonly browser?: BrowserOpenResult;
}

const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

export async function runChatGptLogin(
  options: ChatGptLoginOptions,
): Promise<ChatGptLoginResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const endpoints = resolveChatGptOAuthEndpoints(options.env);
  const issuer = new URL(endpoints.authorizeUrl).origin;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;

  const [hostId, savedClientId, previousRecord] = await Promise.all([
    resolveChatGptHostId(options.store),
    readChatGptClientId(options.store),
    readChatGptCredentialRecord(options.store),
  ]);
  const firstRegistration = !savedClientId;

  const state = createRandomToken();
  const nonce = createRandomToken();
  const codeVerifier = createPkceVerifier();
  const codeChallenge = computePkceCodeChallenge(codeVerifier);

  const callbackServer = await createLocalhostOAuthCallbackServer({
    callbackPath: CHATGPT_OAUTH_CALLBACK_PATH,
    state,
  });
  try {
    const authorizeUrl = buildChatGptAuthorizeUrl(endpoints.authorizeUrl, {
      redirectUri: callbackServer.callbackUrl,
      state,
      nonce,
      codeChallenge,
      extAgentHostId: hostId,
      ...(savedClientId ? { clientId: savedClientId } : {}),
      ...(previousRecord?.account.email ? { loginHint: previousRecord.account.email } : {}),
      ...(previousRecord?.idToken ? { idTokenHint: previousRecord.idToken } : {}),
    });
    options.onAuthorizeUrl?.(authorizeUrl);

    let browser: BrowserOpenResult | undefined;
    if (!options.noBrowser) {
      const openBrowser = options.openBrowser ?? ((url: string) => openUrlInBrowser(url));
      browser = await openBrowser(authorizeUrl);
    }

    const callback = await withTimeout(callbackServer.waitForCallback(), timeoutMs);

    const query = parseChatGptCallbackUrl(callback.url);
    if (query.state !== state) {
      throw new ChatGptOAuthError(
        "chatgpt_callback_state_mismatch",
        "Invalid OAuth state returned by the authorization server.",
      );
    }
    const issuedClientId = query.clientId?.trim();
    if (!issuedClientId) {
      if (firstRegistration) {
        // 官方要求：新注册必须在回调返回 client_id，否则视为注册未完成。
        throw new ChatGptOAuthError(
          "chatgpt_registration_incomplete",
          "ChatGPT sign-in did not return an issued client_id; registration is incomplete.",
        );
      }
    } else if (savedClientId && issuedClientId !== savedClientId) {
      throw new ChatGptOAuthError(
        "chatgpt_client_mismatch",
        "ChatGPT returned a different client_id than the one saved on this host.",
      );
    }
    const clientId = issuedClientId ?? savedClientId;
    if (!clientId || !query.code) {
      throw new ChatGptOAuthError(
        "chatgpt_callback_missing_code",
        "Authorization callback is missing a code.",
      );
    }

    const tokenResponse = await exchangeChatGptAuthorizationCode(
      endpoints.tokenUrl,
      {
        clientId,
        code: query.code,
        codeVerifier,
        redirectUri: callbackServer.callbackUrl,
      },
      fetchImpl,
    );
    const scopes = assertChatGptTokenSharingScope(tokenResponse);
    if (!tokenResponse.id_token) {
      throw new ChatGptOAuthError("chatgpt_id_token_missing", "The token response has no id_token.");
    }
    const verified = await verifyChatGptIdToken({
      idToken: tokenResponse.id_token,
      issuer,
      audience: clientId,
      nonce,
      now,
      fetchImpl,
      jwksUrl: endpoints.jwksUrl,
    });

    const record = toChatGptCredentialRecord({
      hostId,
      clientId,
      ...(previousRecord?.idToken ? { previousIdToken: previousRecord.idToken } : {}),
      tokenResponse,
      scopes,
      accountClaims: {
        subject: String(verified.claims.sub),
        ...(typeof verified.claims.email === "string" && verified.claims.email
          ? { email: verified.claims.email }
          : {}),
        ...(typeof verified.claims.name === "string" && verified.claims.name
          ? { name: verified.claims.name }
          : {}),
      },
      now,
    });
    await writeChatGptCredentialRecord(options.store, record);

    const models = await fetchAndCacheModels({
      endpoints,
      accessToken: record.accessToken,
      store: options.store,
      fetchImpl,
      fallback: await readChatGptCachedModels(options.store),
    });

    return {
      account: {
        subject: record.account.subject,
        ...(record.account.email ? { email: record.account.email } : {}),
        ...(record.account.name ? { name: record.account.name } : {}),
      },
      clientId,
      firstRegistration,
      models,
      credentialsPath: options.store.filePath,
      ...(browser ? { browser } : {}),
    };
  } finally {
    await callbackServer.close().catch(() => undefined);
  }
}

export interface ChatGptLogoutOptions {
  readonly store: SharedZCodeCredentialStore;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl?: ChatGptOAuthFetch;
}

export interface ChatGptLogoutResult {
  readonly revoked: boolean;
  readonly credentialsPath: string;
}

/** 撤销可续期会话并清空本机令牌；撤销端点来自 OpenID discovery。 */
export async function runChatGptLogout(options: ChatGptLogoutOptions): Promise<ChatGptLogoutResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const endpoints = resolveChatGptOAuthEndpoints(options.env);
  const record = await readChatGptCredentialRecord(options.store);
  let revoked = false;
  if (record?.refreshToken) {
    try {
      await revokeChatGptSession(
        endpoints.openidConfigurationUrl,
        { clientId: record.clientId, refreshToken: record.refreshToken },
        fetchImpl,
      );
      revoked = true;
    } catch {
      // 官方文档：撤销失败不阻止本地登出；提示用户可在 ChatGPT 设置断开应用。
    }
  }
  await clearChatGptTokens(options.store);
  return { revoked, credentialsPath: options.store.filePath };
}

async function fetchAndCacheModels(input: {
  readonly endpoints: ReturnType<typeof resolveChatGptOAuthEndpoints>;
  readonly accessToken: string;
  readonly store: SharedZCodeCredentialStore;
  readonly fetchImpl: ChatGptOAuthFetch;
  readonly fallback: readonly ChatGptModelListEntry[] | null;
}): Promise<readonly ChatGptModelListEntry[]> {
  try {
    const result = await fetchChatGptModelList(
      `${input.endpoints.apiBaseUrl}/models`,
      input.accessToken,
      input.fetchImpl,
    );
    await writeChatGptCachedModels(input.store, result.models);
    return result.models;
  } catch {
    // 模型列表拉取失败不阻断登录；使用既有缓存，Registry 侧回落到内置种子。
    return input.fallback ?? [];
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(
        "ChatGPT sign-in timed out waiting for the authorization callback.",
      ) as Error & { code: string };
      error.code = "chatgpt_login_timeout";
      reject(error);
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
