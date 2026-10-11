import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSharedZCodeCredentialStore } from "../src/auth/shared-credentials.js";
import {
  createChatGptRequestAuthSource,
  CHATGPT_REFRESH_THRESHOLD_MS,
} from "../src/auth/chatgpt/chatgpt-request-auth.js";
import {
  readChatGptCredentialRecord,
  resolveChatGptHostId,
  writeChatGptCredentialRecord,
} from "../src/auth/chatgpt/chatgpt-credential-record.js";
import { refreshChatGptAccessToken } from "../src/auth/chatgpt/chatgpt-oauth-client.js";
import { createMockAuthServer, RsaTestSigner } from "./chatgpt-test-auth-server.js";

const tempDirs: string[] = [];
let simulatedNow = Date.now();

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  simulatedNow = Date.now();
});

async function createTempCredentialStore() {
  const dir = await mkdtemp(join(tmpdir(), "zcode-chatgpt-auth-"));
  tempDirs.push(dir);
  return createSharedZCodeCredentialStore({ filePath: join(dir, "credentials.json") });
}

type TempStore = Awaited<ReturnType<typeof createTempCredentialStore>>;

function envFor(issuer: string): Record<string, string> {
  return {
    ZCODE_CHATGPT_OAUTH_ISSUER: issuer,
    ZCODE_CHATGPT_API_BASE_URL: `${issuer}/v1`,
  };
}

async function seedCredential(store: TempStore): Promise<void> {
  const hostId = await resolveChatGptHostId(store);
  await writeChatGptCredentialRecord(store, {
    hostId,
    clientId: "oaiapp_test_client",
    accessToken: "initial-access-1",
    refreshToken: "initial-refresh-1",
    idToken: "seed-id-token",
    account: { subject: "user-subject-1", scopes: ["chatgpt.tokens.use.direct"] },
    expiresAt: simulatedNow + 3_600_000,
  });
}

describe("ChatGPT request auth source", () => {
  it("returns the stored access token while it is fresh", async () => {
    const signer = new RsaTestSigner();
    const server = await createMockAuthServer({ signer });
    const store = await createTempCredentialStore();
    try {
      await seedCredential(store);
      const source = createChatGptRequestAuthSource({
        store,
        env: envFor(server.url),
        now: () => simulatedNow,
      });
      const auth = await source.resolve({
        attempt: 1,
        providerId: "account:chatgpt",
        modelId: "gpt-6.1-sol",
      });
      expect(auth).toEqual({ apiKey: "initial-access-1" });
      // token 有效期内不触发刷新。
      expect(server.accessTokenRequests.length).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("refreshes lazily with single-flight and rotates the stored refresh token", async () => {
    const signer = new RsaTestSigner();
    const server = await createMockAuthServer({ signer });
    const store = await createTempCredentialStore();
    try {
      await seedCredential(store);
      // 推进时间越过 5 分钟阈值（token 尚未完全过期）。
      simulatedNow += 3_600_000 - CHATGPT_REFRESH_THRESHOLD_MS + 1_000;
      const source = createChatGptRequestAuthSource({
        store,
        env: envFor(server.url),
        now: () => simulatedNow,
        sleep: async () => undefined,
      });
      const [first, second] = await Promise.all([
        source.resolve({ attempt: 1, providerId: "account:chatgpt", modelId: "m" }),
        source.resolve({ attempt: 2, providerId: "account:chatgpt", modelId: "m" }),
      ]);
      // single-flight：并发 resolve 只发起一次刷新。
      expect(server.accessTokenRequests.length).toBe(1);
      expect(server.accessTokenRequests[0]!.grantType).toBe("refresh_token");
      expect(first).toEqual({ apiKey: "refreshed-access-1" });
      expect(second).toEqual({ apiKey: "refreshed-access-1" });
      const record = await readChatGptCredentialRecord(store);
      expect(record?.refreshToken).toBe("rotated-refresh-1");
      expect(record?.accessToken).toBe("refreshed-access-1");
    } finally {
      await server.close();
    }
  });

  it("clears tokens and reports re-login when the refresh token is unusable", async () => {
    const signer = new RsaTestSigner();
    const server = await createMockAuthServer({
      signer,
      tokenResponseOverrides: () => ({ error: "invalid_grant" }) as never,
    });
    const store = await createTempCredentialStore();
    try {
      await seedCredential(store);
      simulatedNow += 3_600_000 + 1_000;
      const source = createChatGptRequestAuthSource({
        store,
        env: envFor(server.url),
        now: () => simulatedNow,
        sleep: async () => undefined,
      });
      await expect(
        source.resolve({ attempt: 1, providerId: "account:chatgpt", modelId: "m" }),
      ).rejects.toMatchObject({ code: "chatgpt_token_request_failed" });
      expect(await readChatGptCredentialRecord(store)).toBeNull();
      expect(await source.isLoggedIn()).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("resolves to undefined (fail-closed) when not signed in", async () => {
    const signer = new RsaTestSigner();
    const server = await createMockAuthServer({ signer });
    const store = await createTempCredentialStore();
    try {
      const source = createChatGptRequestAuthSource({
        store,
        env: envFor(server.url),
        now: () => simulatedNow,
      });
      expect(
        await source.resolve({ attempt: 1, providerId: "account:chatgpt", modelId: "m" }),
      ).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("keeps credentials of a parallel process that already rotated the token", async () => {
    const signer = new RsaTestSigner();
    const server = await createMockAuthServer({ signer });
    const store = await createTempCredentialStore();
    try {
      await seedCredential(store);
      simulatedNow += 3_600_000 - CHATGPT_REFRESH_THRESHOLD_MS + 1_000;
      // 模拟另一进程先完成轮换并写入新 token。
      const record = (await readChatGptCredentialRecord(store))!;
      const response = await refreshChatGptAccessToken(
        `${server.url}/api/accounts/oauth/token`,
        { clientId: record.clientId, refreshToken: record.refreshToken },
        globalThis.fetch,
      );
      await writeChatGptCredentialRecord(store, {
        ...record,
        accessToken: response.access_token,
        refreshToken: response.refresh_token ?? record.refreshToken,
        expiresAt: simulatedNow + 3_600_000,
      });

      const source = createChatGptRequestAuthSource({
        store,
        env: envFor(server.url),
        now: () => simulatedNow,
        sleep: async () => undefined,
      });
      const auth = await source.resolve({
        attempt: 1,
        providerId: "account:chatgpt",
        modelId: "m",
      });
      // 本进程旧 token 的刷新认领失败 → 返回另一进程的最新 access token。
      expect(auth).toEqual({ apiKey: response.access_token });
      const after = await readChatGptCredentialRecord(store);
      expect(after?.refreshToken).toBe(response.refresh_token);
    } finally {
      await server.close();
    }
  });
});
