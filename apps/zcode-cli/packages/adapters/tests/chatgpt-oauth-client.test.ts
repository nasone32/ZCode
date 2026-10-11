import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  assertChatGptTokenSharingScope,
  buildChatGptAuthorizeUrl,
  ChatGptOAuthError,
  exchangeChatGptAuthorizationCode,
  fetchChatGptModelList,
  isUnusableRefreshTokenError,
  parseChatGptCallbackUrl,
  parseEarliestRefreshAt,
  refreshChatGptAccessToken,
  resolveChatGptOAuthEndpoints,
  revokeChatGptSession,
} from "../src/auth/chatgpt/chatgpt-oauth-client.js";

const ISSUER = "https://auth.openai.com";
const ENDPOINTS = resolveChatGptOAuthEndpoints({});

describe("ChatGPT OAuth authorize URL", () => {
  it("builds the official first-time dynamic registration request", () => {
    const url = buildChatGptAuthorizeUrl(ENDPOINTS.authorizeUrl, {
      redirectUri: "http://127.0.0.1:45678/auth/callback",
      state: "state-1",
      nonce: "nonce-1",
      codeChallenge: "challenge-1",
      extAgentHostId: "urn:uuid:0f0e0d0c-1111-4222-8333-444455556666",
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://auth.openai.com/api/accounts/authorize",
    );
    const query = parsed.searchParams;
    expect(query.get("client_id")).toBe("dynamic_agent_client");
    expect(query.get("response_type")).toBe("code");
    expect(query.get("redirect_uri")).toBe("http://127.0.0.1:45678/auth/callback");
    expect(query.get("scope")).toBe(
      "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    );
    expect(query.get("resource")).toBe("https://api.openai.com/v1");
    expect(query.get("state")).toBe("state-1");
    expect(query.get("nonce")).toBe("nonce-1");
    expect(query.get("code_challenge")).toBe("challenge-1");
    expect(query.get("code_challenge_method")).toBe("S256");
    expect(query.get("ext_agent_host_id")).toBe(
      "urn:uuid:0f0e0d0c-1111-4222-8333-444455556666",
    );
    // 首次注册才携带 agent_name_hint；重授权禁止重复注册。
    expect(query.get("agent_name_hint")).toBe("ZCode");
    expect(query.get("id_token_hint")).toBeNull();
    expect(query.get("login_hint")).toBeNull();
  });

  it("reuses the issued client_id on re-authorization and skips agent_name_hint", () => {
    const url = buildChatGptAuthorizeUrl(ENDPOINTS.authorizeUrl, {
      clientId: "oaiapp_issued_client",
      redirectUri: "http://127.0.0.1:1/auth/callback",
      state: "s",
      nonce: "n",
      codeChallenge: "c",
      extAgentHostId: "urn:uuid:host",
      loginHint: "user@example.com",
      idTokenHint: "id-token-hint",
    });
    const query = new URL(url).searchParams;
    expect(query.get("client_id")).toBe("oaiapp_issued_client");
    expect(query.get("agent_name_hint")).toBeNull();
    expect(query.get("login_hint")).toBe("user@example.com");
    expect(query.get("id_token_hint")).toBe("id-token-hint");
  });

  it("honors issuer overrides for tests", () => {
    const endpoints = resolveChatGptOAuthEndpoints({ ZCODE_CHATGPT_OAUTH_ISSUER: "http://127.0.0.1:9" });
    expect(endpoints.authorizeUrl).toBe("http://127.0.0.1:9/api/accounts/authorize");
    expect(endpoints.tokenUrl).toBe("http://127.0.0.1:9/api/accounts/oauth/token");
    expect(endpoints.jwksUrl).toBe("http://127.0.0.1:9/.well-known/jwks.json");
  });
});

describe("ChatGPT callback parsing and scope checks", () => {
  it("extracts code, state and the issued client_id", () => {
    const query = parseChatGptCallbackUrl(
      "http://127.0.0.1:2/auth/callback?code=the-code&state=the-state&client_id=oaiapp_x",
    );
    expect(query).toMatchObject({ code: "the-code", state: "the-state", clientId: "oaiapp_x" });
    expect(query.oauthError).toBeUndefined();
  });

  it("extracts denial errors", () => {
    const query = parseChatGptCallbackUrl(
      "http://127.0.0.1:2/auth/callback?error=access_denied&error_description=nope",
    );
    expect(query).toMatchObject({ oauthError: "access_denied", oauthErrorDescription: "nope" });
  });

  it("requires the token sharing scope", () => {
    expect(() =>
      assertChatGptTokenSharingScope({
        access_token: "a",
        scope: "openid profile email offline_access resource.invoke",
      }),
    ).toThrow(ChatGptOAuthError);
    expect(
      assertChatGptTokenSharingScope({
        access_token: "a",
        scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      }),
    ).toContain("chatgpt.tokens.use.direct");
  });
});

describe("ChatGPT token endpoint client", () => {
  it("exchanges the authorization code with PKCE and the resource parameter", async () => {
    const bodies: string[] = [];
    const server = await listenJson(200, (request, body) => {
      if (request.url === "/api/accounts/oauth/token") {
        bodies.push(body);
        return {
          access_token: "access-1",
          refresh_token: "refresh-1",
          id_token: "id-1",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
          earliest_refresh_at: 1_700_000_000_000,
        };
      }
      return {};
    });
    try {
      const response = await exchangeChatGptAuthorizationCode(
        `http://127.0.0.1:${server.port}/api/accounts/oauth/token`,
        {
          clientId: "oaiapp_x",
          code: "code-1",
          codeVerifier: "verifier-1",
          redirectUri: "http://127.0.0.1:3/auth/callback",
        },
        globalThis.fetch,
      );
      expect(response.access_token).toBe("access-1");
      const params = new URLSearchParams(bodies[0]);
      expect(params.get("grant_type")).toBe("authorization_code");
      expect(params.get("client_id")).toBe("oaiapp_x");
      expect(params.get("code")).toBe("code-1");
      expect(params.get("code_verifier")).toBe("verifier-1");
      expect(params.get("redirect_uri")).toBe("http://127.0.0.1:3/auth/callback");
      expect(params.get("resource")).toBe("https://api.openai.com/v1");
      expect(params.get("client_secret")).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("refreshes without a scope parameter and surfaces oauth error codes", async () => {
    const bodies: string[] = [];
    const server = await listenJson(400, (request, body) => {
      bodies.push(body);
      return { error: "invalid_grant", error_description: "refresh token expired" };
    });
    try {
      const error = await refreshChatGptAccessToken(
        `http://127.0.0.1:${server.port}/api/accounts/oauth/token`,
        { clientId: "oaiapp_x", refreshToken: "rt-1" },
        globalThis.fetch,
      ).catch((caught: unknown) => caught as ChatGptOAuthError);
      expect(error).toBeInstanceOf(ChatGptOAuthError);
      expect(isUnusableRefreshTokenError(error)).toBe(true);
      const params = new URLSearchParams(bodies[0]);
      expect(params.get("grant_type")).toBe("refresh_token");
      expect(params.get("scope")).toBeNull();
      expect(params.get("resource")).toBe("https://api.openai.com/v1");
    } finally {
      await server.close();
    }
  });
});

describe("ChatGPT revocation", () => {
  it("revokes via the discovered revocation endpoint", async () => {
    const requests: { url: string; body: string }[] = [];
    const server = await listenJson(200, (request, body) => {
      requests.push({ url: request.url ?? "", body });
      if (request.url === "/.well-known/openid-configuration") {
        return { revocation_endpoint: `http://127.0.0.1:${server.port}/revoke` };
      }
      return {};
    });
    try {
      await revokeChatGptSession(
        `http://127.0.0.1:${server.port}/.well-known/openid-configuration`,
        { clientId: "oaiapp_x", refreshToken: "rt-1" },
        globalThis.fetch,
      );
      const revoke = requests.find(({ url }) => url === "/revoke");
      expect(revoke).toBeDefined();
      const params = new URLSearchParams(revoke!.body);
      expect(params.get("token")).toBe("rt-1");
      expect(params.get("token_type_hint")).toBe("refresh_token");
      expect(params.get("client_id")).toBe("oaiapp_x");
    } finally {
      await server.close();
    }
  });
});

describe("ChatGPT model list", () => {
  it("keeps only listable API-ready models", async () => {
    const server = await listenJson(200, () => ({
      models: [
        { slug: "gpt-6.1-sol", display_name: "GPT Sol", visibility: "list", supported_in_api: true },
        { slug: "hidden-model", display_name: "Hidden", visibility: "hidden", supported_in_api: true },
        { slug: "not-in-api", display_name: "Not API", visibility: "list", supported_in_api: false },
        { slug: "", display_name: "Empty slug", visibility: "list", supported_in_api: true },
        "garbage-entry",
      ],
    }));
    try {
      const result = await fetchChatGptModelList(
        `http://127.0.0.1:${server.port}/models`,
        "access-token",
        withAuthorizationCapture,
      );
      expect(result.models).toEqual([{ slug: "gpt-6.1-sol", display_name: "GPT Sol" }]);
      expect(authorizations).toEqual(["Bearer access-token"]);
    } finally {
      authorizations.length = 0;
      await server.close();
    }
  });

  it("fails when no listable model remains", async () => {
    const server = await listenJson(200, () => ({ models: [] }));
    try {
      await expect(
        fetchChatGptModelList(
          `http://127.0.0.1:${server.port}/models`,
          "access-token",
          globalThis.fetch,
        ),
      ).rejects.toMatchObject({ code: "chatgpt_models_empty" });
    } finally {
      await server.close();
    }
  });
});

describe("parseEarliestRefreshAt", () => {
  it("accepts epoch numbers and ISO strings", () => {
    expect(parseEarliestRefreshAt(123)).toBe(123);
    expect(parseEarliestRefreshAt("1970-01-01T00:00:01.000Z")).toBe(1000);
    expect(parseEarliestRefreshAt(undefined)).toBeUndefined();
  });
});

const authorizations: string[] = [];
const withAuthorizationCapture: typeof globalThis.fetch = async (input, init) => {
  authorizations.push(String(new Headers(init?.headers).get("authorization")));
  return globalThis.fetch(input, init);
};

async function listenJson(
  status: number,
  handle: (request: http.IncomingMessage, body: string) => unknown,
): Promise<{ close(): Promise<void>; port: number }> {
  const server: Server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      const payload = handle(request, body);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
    port,
  };
}
