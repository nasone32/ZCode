import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computePkceCodeChallenge, createPkceVerifier, createRandomToken } from "../src/auth/chatgpt/pkce.js";

describe("ChatGPT OAuth PKCE helpers", () => {
  it("derives the RFC 7636 appendix B test vector with S256", () => {
    // RFC 7636 Appendix B: verifier "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    expect(computePkceCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("verifies the challenge formula directly", () => {
    const verifier = createPkceVerifier();
    const expected = createHash("sha256").update(verifier).digest("base64url");
    expect(computePkceCodeChallenge(verifier)).toBe(expected);
  });

  it("creates verifiers within the RFC length bounds using the unreserved alphabet", () => {
    for (let index = 0; index < 20; index += 1) {
      const verifier = createPkceVerifier();
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(verifier.length).toBeLessThanOrEqual(128);
      expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/u);
    }
  });

  it("rejects invalid verifier lengths", () => {
    expect(() => createPkceVerifier(10)).toThrow(/between 43 and 128/i);
    expect(() => createPkceVerifier(200)).toThrow(/between 43 and 128/i);
  });

  it("creates url-safe state/nonce tokens with entropy", () => {
    const token = createRandomToken();
    expect(token).toMatch(/^[A-Za-z0-9\-_]+$/u);
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(createRandomToken()).not.toBe(token);
  });
});
