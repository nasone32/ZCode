import {
  CHATGPT_CREDENTIAL_KEYS,
  CHATGPT_CREDENTIAL_RECORD_KEYS,
  parseChatGptCachedModelsJson,
  parseChatGptCredentialRecordData,
  type ChatGptAccountSummary,
} from "@zcode/shared";
import { randomUUID } from "node:crypto";
import type { SharedZCodeCredentialStore } from "../shared-credentials.js";
import {
  parseEarliestRefreshAt,
  type ChatGptModelListEntry,
  type ChatGptTokenResponse,
} from "./chatgpt-oauth-client.js";

/**
 * ChatGPT OAuth 凭据记录：仅存在于加密 SharedZCodeCredentialStore
 * （~/.zcode/v2/credentials.json，AES-256-GCM，0600 原子写）。
 * 不得进入 Provider Config、日志、遥测或仓库。
 * 记录/模型缓存的结构化解析在 @zcode/shared（与 Desktop host 共用）。
 */

export type ChatGptCredentialRecord = import("@zcode/shared").ChatGptCredentialRecordData;

export interface ChatGptCredentialReader {
  loadMany(keys: readonly string[]): Promise<Record<string, string | null>>;
}

const ALL_CREDENTIAL_KEYS: readonly string[] = Object.values(CHATGPT_CREDENTIAL_KEYS);

export function isChatGptCredentialKey(key: string): boolean {
  return (ALL_CREDENTIAL_KEYS as readonly string[]).includes(key);
}

/** 读取完整凭据记录；任一必需成员缺失即视为未登录。 */
export async function readChatGptCredentialRecord(
  reader: ChatGptCredentialReader,
): Promise<ChatGptCredentialRecord | null> {
  const values = await reader.loadMany(CHATGPT_CREDENTIAL_RECORD_KEYS);
  return parseChatGptCredentialRecordData(values);
}

/** 稳定 ext_agent_host_id：首次生成 `urn:uuid:…`，此后跨登录复用。 */
export async function resolveChatGptHostId(
  store: Pick<SharedZCodeCredentialStore, "load" | "save" | "loadMany">,
): Promise<string> {
  const existing = (await store.load(CHATGPT_CREDENTIAL_KEYS.hostId))?.trim();
  if (existing) return existing;
  const hostId = `urn:uuid:${randomUUID()}`;
  await store.save(CHATGPT_CREDENTIAL_KEYS.hostId, hostId);
  return hostId;
}

export async function readChatGptClientId(
  reader: ChatGptCredentialReader,
): Promise<string | undefined> {
  const [clientId] = Object.values(await reader.loadMany([CHATGPT_CREDENTIAL_KEYS.clientId]));
  return clientId?.trim() || undefined;
}

/** token 端点响应 + 校验产物 → 完整凭据记录（不落盘，由调用方原子写入）。 */
export function toChatGptCredentialRecord(input: {
  readonly hostId: string;
  readonly clientId: string;
  readonly previousIdToken?: string;
  readonly tokenResponse: ChatGptTokenResponse;
  readonly scopes: readonly string[];
  readonly accountClaims: {
    readonly subject: string;
    readonly email?: string;
    readonly name?: string;
    readonly plan?: string;
  };
  readonly now?: () => number;
}): ChatGptCredentialRecord {
  const now = input.now ?? Date.now;
  return {
    hostId: input.hostId,
    clientId: input.clientId,
    accessToken: input.tokenResponse.access_token,
    refreshToken: input.tokenResponse.refresh_token ?? "",
    idToken: input.tokenResponse.id_token ?? input.previousIdToken ?? "",
    account: {
      subject: input.accountClaims.subject,
      ...(input.accountClaims.email ? { email: input.accountClaims.email } : {}),
      ...(input.accountClaims.name ? { name: input.accountClaims.name } : {}),
      ...(input.accountClaims.plan ? { plan: input.accountClaims.plan } : {}),
      scopes: [...input.scopes],
    },
    expiresAt: now() + (input.tokenResponse.expires_in ?? 3600) * 1000,
    earliestRefreshAt: parseEarliestRefreshAt(input.tokenResponse.earliest_refresh_at),
  };
}

/** 全量写入凭据记录。 */
export async function writeChatGptCredentialRecord(
  store: Pick<SharedZCodeCredentialStore, "saveMany" | "saveReplacing">,
  record: ChatGptCredentialRecord,
): Promise<void> {
  if (!record.refreshToken) {
    throw new Error("ChatGPT credential record requires a refresh token.");
  }
  await store.saveMany({
    [CHATGPT_CREDENTIAL_KEYS.clientId]: record.clientId,
    [CHATGPT_CREDENTIAL_KEYS.accessToken]: record.accessToken,
    [CHATGPT_CREDENTIAL_KEYS.refreshToken]: record.refreshToken,
    [CHATGPT_CREDENTIAL_KEYS.idToken]: record.idToken,
    [CHATGPT_CREDENTIAL_KEYS.account]: JSON.stringify(record.account),
    [CHATGPT_CREDENTIAL_KEYS.expiresAt]: String(record.expiresAt),
    ...(record.earliestRefreshAt !== undefined
      ? { [CHATGPT_CREDENTIAL_KEYS.earliestRefreshAt]: String(record.earliestRefreshAt) }
      : {}),
  });
}

/** 清空 ChatGPT 令牌（保留 host/client 标识以便按官方文档复用重登录）。 */
export async function clearChatGptTokens(
  store: Pick<SharedZCodeCredentialStore, "delete">,
): Promise<void> {
  await store.delete(CHATGPT_CREDENTIAL_KEYS.accessToken);
  await store.delete(CHATGPT_CREDENTIAL_KEYS.refreshToken);
  await store.delete(CHATGPT_CREDENTIAL_KEYS.idToken);
  await store.delete(CHATGPT_CREDENTIAL_KEYS.account);
  await store.delete(CHATGPT_CREDENTIAL_KEYS.expiresAt);
  await store.delete(CHATGPT_CREDENTIAL_KEYS.earliestRefreshAt);
}

export async function readChatGptCachedModels(
  reader: ChatGptCredentialReader,
): Promise<readonly ChatGptModelListEntry[] | null> {
  const [raw] = Object.values(await reader.loadMany([CHATGPT_CREDENTIAL_KEYS.models]));
  return parseChatGptCachedModelsJson(raw);
}

export async function writeChatGptCachedModels(
  store: Pick<SharedZCodeCredentialStore, "save">,
  models: readonly ChatGptModelListEntry[],
): Promise<void> {
  await store.save(
    CHATGPT_CREDENTIAL_KEYS.models,
    JSON.stringify(
      models.map((model) => ({ slug: model.slug, display_name: model.display_name })),
    ),
  );
}

export async function deleteChatGptCachedModels(
  store: Pick<SharedZCodeCredentialStore, "delete">,
): Promise<void> {
  await store.delete(CHATGPT_CREDENTIAL_KEYS.models);
}
