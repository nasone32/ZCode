import type { ModelRequestAuth, ModelRequestAuthSource } from "@zcode/contracts";
import { CHATGPT_CREDENTIAL_KEYS } from "@zcode/shared";
import type { SharedZCodeCredentialStore } from "../shared-credentials.js";
import {
  assertChatGptTokenSharingScope,
  isUnusableRefreshTokenError,
  refreshChatGptAccessToken,
  resolveChatGptOAuthEndpoints,
  type ChatGptOAuthFetch,
} from "./chatgpt-oauth-client.js";
import {
  clearChatGptTokens,
  readChatGptCredentialRecord,
  toChatGptCredentialRecord,
  type ChatGptCredentialRecord,
} from "./chatgpt-credential-record.js";

/**
 * ChatGPT 请求级鉴权 Source：把 OAuth access token 作为 `apiKey` 交付
 * （openai-responses SDK 路径将其发送为 `Authorization: Bearer …`）。
 *
 * 刷新策略（官方文档）：
 * - 距过期 > 5 分钟直接使用现 token；
 * - 到阈值后 `grant_type=refresh_token`（不带 scope 以保留授权），
 *   refresh token 轮换后原子替换存储；
 * - 跨进程竞态用 `deleteIfValue` 认领轮换：失败方重读最新凭据；
 * - 不可用 refresh 错误（invalid_grant/reused/expired…）只有在存储值
 *   仍是本次使用的 token 时才清空，避免误删并行进程刚轮换的新凭据。
 */

/** 提前刷新阈值：文档 access token 有效期 1h，留 5 分钟缓冲。 */
export const CHATGPT_REFRESH_THRESHOLD_MS = 5 * 60 * 1000;
/** earliest_refresh_at 之前的最大等待；防止刷新风暴。 */
const MAX_EARLIEST_REFRESH_WAIT_MS = 60 * 1000;

export class ChatGptReLoginRequiredError extends Error {
  readonly code = "chatgpt_relogin_required";
  constructor(message = "ChatGPT sign-in has expired. Run `zcode login chatgpt` to sign in again.") {
    super(message);
    this.name = "ChatGptReLoginRequiredError";
  }
}

export interface ChatGptRequestAuthSourceOptions {
  readonly store: SharedZCodeCredentialStore;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl?: ChatGptOAuthFetch;
  readonly now?: () => number;
  /** 供测试注入的睡眠实现。 */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ChatGptRequestAuthSource extends ModelRequestAuthSource {
  /** 立即刷新（登录后预热 / 测试）。 */
  refreshNow(input?: { abortSignal?: AbortSignal }): Promise<ModelRequestAuth | undefined>;
  /** 是否已登录（存在完整凭据记录）。 */
  isLoggedIn(): Promise<boolean>;
}

export function createChatGptRequestAuthSource(
  options: ChatGptRequestAuthSourceOptions,
): ChatGptRequestAuthSource {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const endpoints = resolveChatGptOAuthEndpoints(options.env);
  // 进程内 single-flight：并发 attempt 共享同一次刷新。
  let refreshInFlight: Promise<ChatGptCredentialRecord | null> | null = null;

  const resolve: ChatGptRequestAuthSource["resolve"] = async (input) => {
    input?.abortSignal?.throwIfAborted();
    const record = await readChatGptCredentialRecord(options.store);
    if (!record) return undefined;
    if (now() + CHATGPT_REFRESH_THRESHOLD_MS < record.expiresAt) {
      return { apiKey: record.accessToken };
    }
    const refreshed = await refreshWithSingleFlight(record, input?.abortSignal);
    return refreshed ? { apiKey: refreshed.accessToken } : undefined;
  };

  async function refreshWithSingleFlight(
    record: ChatGptCredentialRecord,
    abortSignal?: AbortSignal,
  ): Promise<ChatGptCredentialRecord | null> {
    refreshInFlight ??= performRefresh(record, abortSignal).finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  }

  async function performRefresh(
    record: ChatGptCredentialRecord,
    abortSignal?: AbortSignal,
  ): Promise<ChatGptCredentialRecord | null> {
    abortSignal?.throwIfAborted();
    await respectEarliestRefreshAt(record, abortSignal);

    let tokenResponse;
    try {
      tokenResponse = await refreshChatGptAccessToken(
        endpoints.tokenUrl,
        { clientId: record.clientId, refreshToken: record.refreshToken },
        fetchImpl,
      );
    } catch (error) {
      if (isUnusableRefreshTokenError(error)) {
        await handleUnusableRefreshToken(record);
      }
      throw error;
    }
    if (tokenResponse.scope) {
      assertChatGptTokenSharingScope(tokenResponse);
    }

    // 认领轮换：只有当存储的 refresh token 仍是本次使用的那个，才允许写入新凭据。
    const claimed = await options.store.deleteIfValue(
      CHATGPT_CREDENTIAL_KEYS.refreshToken,
      record.refreshToken,
    );
    if (!claimed) {
      // 另一进程已完成轮换；丢弃本次响应，读最新凭据。
      return await readChatGptCredentialRecord(options.store);
    }
    const nextRecord = toChatGptCredentialRecord({
      hostId: record.hostId,
      clientId: record.clientId,
      previousIdToken: record.idToken,
      tokenResponse,
      scopes: tokenResponse.scope
        ? tokenResponse.scope.split(/\s+/u).filter((scope) => scope.length > 0)
        : record.account.scopes,
      accountClaims: {
        subject: record.account.subject,
        ...(record.account.email ? { email: record.account.email } : {}),
        ...(record.account.name ? { name: record.account.name } : {}),
        ...(record.account.plan ? { plan: record.account.plan } : {}),
      },
      now,
    });
    await saveRefreshedRecord(nextRecord);
    return nextRecord;
  }

  async function saveRefreshedRecord(record: ChatGptCredentialRecord): Promise<void> {
    await options.store.saveMany({
      [CHATGPT_CREDENTIAL_KEYS.accessToken]: record.accessToken,
      ...(record.refreshToken
        ? { [CHATGPT_CREDENTIAL_KEYS.refreshToken]: record.refreshToken }
        : {}),
      ...(record.idToken ? { [CHATGPT_CREDENTIAL_KEYS.idToken]: record.idToken } : {}),
      [CHATGPT_CREDENTIAL_KEYS.account]: JSON.stringify(record.account),
      [CHATGPT_CREDENTIAL_KEYS.expiresAt]: String(record.expiresAt),
      ...(record.earliestRefreshAt !== undefined
        ? { [CHATGPT_CREDENTIAL_KEYS.earliestRefreshAt]: String(record.earliestRefreshAt) }
        : {}),
    });
  }

  async function handleUnusableRefreshToken(record: ChatGptCredentialRecord): Promise<void> {
    const current = await readChatGptCredentialRecord(options.store);
    // 只有存储值仍等于本次使用的 token 才清空；并行进程的新凭据不受影响。
    if (!current || current.refreshToken !== record.refreshToken) return;
    await clearChatGptTokens(options.store);
  }

  async function respectEarliestRefreshAt(
    record: ChatGptCredentialRecord,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    if (record.earliestRefreshAt === undefined) return;
    const waitMs = record.earliestRefreshAt - now();
    if (waitMs <= 0) return;
    // token 仍有效时先用完当前窗口；已过期才等待（有上限）。
    if (record.expiresAt > now()) return;
    await sleep(Math.min(waitMs, MAX_EARLIEST_REFRESH_WAIT_MS));
    abortSignal?.throwIfAborted();
  }

  return {
    resolve,
    async refreshNow(input) {
      const record = await readChatGptCredentialRecord(options.store);
      if (!record) return undefined;
      const refreshed = await refreshWithSingleFlight(record, input?.abortSignal);
      return refreshed ? { apiKey: refreshed.accessToken } : undefined;
    },
    async isLoggedIn() {
      return (await readChatGptCredentialRecord(options.store)) !== null;
    },
  };
}
