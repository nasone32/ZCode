import { describe, expect, it } from "vitest";
import { verifyChatGptIdToken } from "../src/auth/chatgpt/chatgpt-oauth-client.js";
import { RsaTestSigner } from "./chatgpt-test-auth-server.js";

const ISSUER = "http://127.0.0.1:9";
const AUDIENCE = "oaiapp_test_client";
const NONCE = "nonce-123";

function baseInput(signer: RsaTestSigner, idToken: string) {
  return {
    idToken,
    issuer: ISSUER,
    audience: AUDIENCE,
    nonce: NONCE,
    jwks: { keys: [signer.jwk] },
    jwksUrl: "http://127.0.0.1:9/.well-known/jwks.json",
    fetchImpl: globalThis.fetch,
  };
}

describe("verifyChatGptIdToken", () => {
  it("accepts a correctly signed token and returns its claims", async () => {
    const signer = new RsaTestSigner();
    const idToken = signer.signIdToken({
      audience: AUDIENCE,
      issuer: ISSUER,
      nonce: NONCE,
      email: "user@example.com",
      name: "Test User",
    });
    const result = await verifyChatGptIdToken(baseInput(signer, idToken));
    expect(result.claims.sub).toBe("user-subject-1");
    expect(result.claims.email).toBe("user@example.com");
    expect(result.claims["https://api.openai.com/auth"]).toMatchObject({
      chatgpt_plan_type: "plus",
    });
  });

  it("rejects a tampered payload even with a valid-looking structure", async () => {
    const signer = new RsaTestSigner();
    const idToken = signer.signIdToken({
      audience: AUDIENCE,
      issuer: ISSUER,
      nonce: NONCE,
      tamperPayload: true,
    });
    await expect(verifyChatGptIdToken(baseInput(signer, idToken))).rejects.toMatchObject({
      code: "chatgpt_id_token_invalid_signature",
    });
  });

  it("rejects a signature made with different keys", async () => {
    const signingKey = new RsaTestSigner();
    const jwksKey = new RsaTestSigner();
    const idToken = signingKey.signIdToken({ audience: AUDIENCE, issuer: ISSUER, nonce: NONCE });
    const input = baseInput(jwksKey, idToken);
    // kid 不同时必须报 unknown_key，而不是退回任何其他 RSA key。
    await expect(verifyChatGptIdToken(input)).rejects.toMatchObject({
      code: "chatgpt_id_token_unknown_key",
    });
  });

  it("rejects nonce mismatches", async () => {
    const signer = new RsaTestSigner();
    const idToken = signer.signIdToken({
      audience: AUDIENCE,
      issuer: ISSUER,
      nonce: "other-nonce",
    });
    await expect(verifyChatGptIdToken(baseInput(signer, idToken))).rejects.toMatchObject({
      code: "chatgpt_id_token_nonce_mismatch",
    });
  });

  it("rejects audience mismatches", async () => {
    const signer = new RsaTestSigner();
    const idToken = signer.signIdToken({
      audience: "oaiapp_somebody_else",
      issuer: ISSUER,
      nonce: NONCE,
    });
    await expect(verifyChatGptIdToken(baseInput(signer, idToken))).rejects.toMatchObject({
      code: "chatgpt_id_token_invalid_audience",
    });
  });

  it("rejects wrong issuers", async () => {
    const signer = new RsaTestSigner();
    const idToken = signer.signIdToken({
      audience: AUDIENCE,
      issuer: "https://evil.example",
      nonce: NONCE,
    });
    await expect(verifyChatGptIdToken(baseInput(signer, idToken))).rejects.toMatchObject({
      code: "chatgpt_id_token_invalid_issuer",
    });
  });

  it("rejects expired tokens", async () => {
    const signer = new RsaTestSigner();
    const idToken = signer.signIdToken({
      audience: AUDIENCE,
      issuer: ISSUER,
      nonce: NONCE,
      expiresInSeconds: -60,
    });
    await expect(verifyChatGptIdToken(baseInput(signer, idToken))).rejects.toMatchObject({
      code: "chatgpt_id_token_expired",
    });
  });

  it("rejects non-RS256 algorithms", async () => {
    const signer = new RsaTestSigner();
    const idToken = signer.signIdToken({
      audience: AUDIENCE,
      issuer: ISSUER,
      nonce: NONCE,
      headerOverrides: { alg: "HS256" },
    });
    await expect(verifyChatGptIdToken(baseInput(signer, idToken))).rejects.toMatchObject({
      code: "chatgpt_id_token_algorithm",
    });
  });

  it("loads JWKS over HTTP when not provided inline", async () => {
    const { createMockAuthServer, RsaTestSigner: Signer } = await import(
      "./chatgpt-test-auth-server.js"
    );
    const signer = new Signer();
    const server = await createMockAuthServer({ signer });
    try {
      const idToken = signer.signIdToken({
        audience: "oaiapp_test_client",
        issuer: server.url,
        nonce: "n-1",
      });
      const result = await verifyChatGptIdToken({
        idToken,
        issuer: server.url,
        audience: "oaiapp_test_client",
        nonce: "n-1",
        fetchImpl: globalThis.fetch,
        jwksUrl: `${server.url}/.well-known/jwks.json`,
      });
      expect(result.claims.sub).toBe("user-subject-1");
    } finally {
      await server.close();
    }
  });
});
