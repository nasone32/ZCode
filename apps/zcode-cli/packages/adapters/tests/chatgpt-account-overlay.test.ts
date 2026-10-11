import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSharedZCodeCredentialStore } from "../src/auth/shared-credentials.js";
import { readChatGptAccountProviderOverlay } from "../src/auth/chatgpt/chatgpt-account-overlay.js";
import {
  resolveChatGptHostId,
  writeChatGptCachedModels,
  writeChatGptCredentialRecord,
} from "../src/auth/chatgpt/chatgpt-credential-record.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempCredentialStore() {
  const dir = await mkdtemp(join(tmpdir(), "zcode-chatgpt-overlay-"));
  tempDirs.push(dir);
  return createSharedZCodeCredentialStore({ filePath: join(dir, "credentials.json") });
}

describe("readChatGptAccountProviderOverlay", () => {
  it("is fail-closed (entitled=false, no models) without credentials", async () => {
    const store = await createTempCredentialStore();
    const overlay = await readChatGptAccountProviderOverlay(store);
    expect(overlay?.toJSON()).toEqual({
      access: { type: "openai-oauth", entitled: false },
    });
  });

  it("is entitled with cached /v1/models slugs after login", async () => {
    const store = await createTempCredentialStore();
    const hostId = await resolveChatGptHostId(store);
    await writeChatGptCredentialRecord(store, {
      hostId,
      clientId: "oaiapp_x",
      accessToken: "a",
      refreshToken: "r",
      idToken: "i",
      account: { subject: "s", scopes: ["chatgpt.tokens.use.direct"] },
      expiresAt: Date.now() + 3_600_000,
    });
    await writeChatGptCachedModels(store, [
      { slug: "gpt-6.1-sol", display_name: "GPT Sol" },
      { slug: "gpt-6-astra", display_name: "GPT Astra" },
    ]);
    const overlay = await readChatGptAccountProviderOverlay(store);
    expect(overlay?.toJSON()).toEqual({
      access: { type: "openai-oauth", entitled: true },
      builtinModelIds: ["gpt-6.1-sol", "gpt-6-astra"],
    });
  });

  it("falls back to the builtin seed when no model cache exists", async () => {
    const store = await createTempCredentialStore();
    const hostId = await resolveChatGptHostId(store);
    await writeChatGptCredentialRecord(store, {
      hostId,
      clientId: "oaiapp_x",
      accessToken: "a",
      refreshToken: "r",
      idToken: "i",
      account: { subject: "s", scopes: ["chatgpt.tokens.use.direct"] },
      expiresAt: Date.now() + 3_600_000,
    });
    const overlay = await readChatGptAccountProviderOverlay(store);
    expect(overlay?.toJSON()).toEqual({
      access: { type: "openai-oauth", entitled: true },
    });
    // 无 builtinModelIds → Registry 使用 Built-in 种子（overlay 不覆盖成员）。
    expect(overlay?.builtinModelIds).toBeUndefined();
  });
});
