import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSharedZCodeCredentialStore } from "../src/auth/shared-credentials.js";
import { runChatGptLogin, runChatGptLogout } from "../src/auth/chatgpt/chatgpt-login-flow.js";
import {
  readChatGptCachedModels,
  readChatGptCredentialRecord,
} from "../src/auth/chatgpt/chatgpt-credential-record.js";
import { createMockAuthServer, RsaTestSigner } from "./chatgpt-test-auth-server.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempCredentialStore() {
  const dir = await mkdtemp(join(tmpdir(), "zcode-chatgpt-login-"));
  tempDirs.push(dir);
  return createSharedZCodeCredentialStore({ filePath: join(dir, "credentials.json") });
}

/** 模拟浏览器：请求 authorize URL 并跟随 302 到 loopback 回调。 */
async function simulateBrowser(authorizeUrl: string): Promise<void> {
  const response = await fetch(authorizeUrl, { redirect: "manual" });
  const location = response.headers.get("location");
  if (!location) throw new Error("mock authorize did not redirect");
  const callback = await fetch(location, { redirect: "manual" });
  if (callback.status !== 200) {
    throw new Error(`callback failed: ${callback.status}`);
  }
}

describe("runChatGptLogin (official SIWC flow against a mock authorization server)", () => {
  it("registers dynamically, exchanges PKCE code, verifies the id_token, caches models", async () => {
    const signer = new RsaTestSigner();
    const server = await createMockAuthServer({ signer });
    const store = await createTempCredentialStore();
    try {
      const authorizeUrls: string[] = [];
      const result = await runChatGptLogin({
        store,
        env: {
          ZCODE_CHATGPT_OAUTH_ISSUER: server.url,
          ZCODE_CHATGPT_API_BASE_URL: `${server.url}/v1`,
        },
        openBrowser: async (url) => {
          await simulateBrowser(url);
          return { command: "test", opened: true };
        },
        onAuthorizeUrl: (url) => authorizeUrls.push(url),
        timeoutMs: 10_000,
      });

      expect(result.account.email).toBe("user@example.com");
      expect(result.account.subject).toBe("user-subject-1");
      expect(result.clientId).toBe("oaiapp_test_client");
      expect(result.firstRegistration).toBe(true);
      expect(result.models.map((model) => model.slug)).toEqual(["gpt-6.1-sol", "gpt-6.1-sol-fast"]);

      // 首次注册请求必须携带 dynamic_agent_client + agent_name_hint + host 标识。
      const authorizeQuery = server.authorizeRequests[0]!.searchParams;
      expect(authorizeQuery.get("client_id")).toBe("dynamic_agent_client");
      expect(authorizeQuery.get("agent_name_hint")).toBe("ZCode");
      expect(authorizeQuery.get("ext_agent_host_id")).toMatch(/^urn:uuid:/u);
      expect(authorizeQuery.get("code_challenge_method")).toBe("S256");
      const exchange = server.accessTokenRequests[0]!;
      expect(exchange.grantType).toBe("authorization_code");
      expect(exchange.clientId).toBe("oaiapp_test_client");
      expect(exchange.codeVerifier).toMatch(/^[A-Za-z0-9\-._~]{43,}$/u);

      // 凭据已加密落盘且完整。
      const record = await readChatGptCredentialRecord(store);
      expect(record).not.toBeNull();
      expect(record!.accessToken).toBe("initial-access-1");
      expect(record!.refreshToken).toBe("initial-refresh-1");
      expect(record!.clientId).toBe("oaiapp_test_client");
      expect(record!.expiresAt).toBeGreaterThan(Date.now());

      const cached = await readChatGptCachedModels(store);
      expect(cached?.map((model) => model.slug)).toContain("gpt-6.1-sol");

      // 文件内容不包含明文 token。
      const raw = await readFile(store.filePath, "utf8");
      expect(raw).not.toContain("initial-access-1");
      expect(raw).not.toContain("initial-refresh-1");

      // 二次登录：复用已签发 client_id，不再携带 agent_name_hint。
      await runChatGptLogin({
        store,
        env: {
          ZCODE_CHATGPT_OAUTH_ISSUER: server.url,
          ZCODE_CHATGPT_API_BASE_URL: `${server.url}/v1`,
        },
        openBrowser: async (url) => {
          await simulateBrowser(url);
          return { command: "test", opened: true };
        },
        timeoutMs: 10_000,
      });
      const secondAuthorize = server.authorizeRequests.at(-1)!.searchParams;
      expect(secondAuthorize.get("client_id")).toBe("oaiapp_test_client");
      expect(secondAuthorize.get("agent_name_hint")).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("fails closed when the token sharing scope is not granted", async () => {
    const signer = new RsaTestSigner();
    const server = await createMockAuthServer({
      signer,
      tokenResponseOverrides: () => ({ scope: "openid profile email" }),
    });
    const store = await createTempCredentialStore();
    try {
      const error = await runChatGptLogin({
        store,
        env: {
          ZCODE_CHATGPT_OAUTH_ISSUER: server.url,
          ZCODE_CHATGPT_API_BASE_URL: `${server.url}/v1`,
        },
        openBrowser: async (url) => {
          await simulateBrowser(url);
          return { command: "test", opened: true };
        },
        timeoutMs: 10_000,
      }).catch((caught: unknown) => caught as Error);
      expect(error).toMatchObject({ code: "chatgpt_token_sharing_scope_missing" });
      expect(await readChatGptCredentialRecord(store)).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("revokes the renewable session on logout and clears local tokens", async () => {
    const signer = new RsaTestSigner();
    const server = await createMockAuthServer({ signer });
    const store = await createTempCredentialStore();
    const env = {
      ZCODE_CHATGPT_OAUTH_ISSUER: server.url,
      ZCODE_CHATGPT_API_BASE_URL: `${server.url}/v1`,
    };
    try {
      await runChatGptLogin({
        store,
        env,
        openBrowser: async (url) => {
          await simulateBrowser(url);
          return { command: "test", opened: true };
        },
        timeoutMs: 10_000,
      });
      const logout = await runChatGptLogout({ store, env });
      expect(logout.revoked).toBe(true);
      expect(await readChatGptCredentialRecord(store)).toBeNull();
    } finally {
      await server.close();
    }
  });
});
