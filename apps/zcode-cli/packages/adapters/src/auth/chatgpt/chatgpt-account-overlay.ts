import { CHATGPT_PROVIDER_ID } from "@zcode/shared";
import { OpenAiOAuthAccessConfig, ProviderConfig } from "@zcode/provider";
import type { ChatGptCredentialReader } from "./chatgpt-credential-record.js";
import { readChatGptCachedModels, readChatGptCredentialRecord } from "./chatgpt-credential-record.js";

/**
 * ChatGPT 账号 Overlay：把本机加密凭据状态投影为 Registry 第三层 Account Config。
 *
 * - 已登录（完整 token 记录）→ `entitled: true`；
 * - /v1/models 缓存存在时以缓存覆盖内置模型种子（登录后热更新模型列表）；
 * - 未登录 → `entitled: false`（fail-closed，Built-in 种子不进入 Registry）。
 * Token 本身绝不写入 Provider Config。
 */
export async function readChatGptAccountProviderOverlay(
  reader: ChatGptCredentialReader,
): Promise<ProviderConfig | null> {
  const record = await readChatGptCredentialRecord(reader);
  if (!record) {
    return new ProviderConfig({
      access: new OpenAiOAuthAccessConfig({ entitled: false }),
    });
  }
  const cachedModels = await readChatGptCachedModels(reader);
  return new ProviderConfig({
    access: new OpenAiOAuthAccessConfig({ entitled: true }),
    ...(cachedModels
      ? { builtinModelIds: cachedModels.map((model) => model.slug) }
      : {}),
  });
}

export function isChatGptProviderId(providerId: string): boolean {
  return providerId === CHATGPT_PROVIDER_ID;
}
