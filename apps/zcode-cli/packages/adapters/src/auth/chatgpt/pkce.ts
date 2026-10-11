import { createHash, randomBytes } from "node:crypto";

/** RFC 7636 §4.1 unreserved characters；verifier 长度区间 43-128。 */
const PKCE_VERIFIER_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

export const PKCE_VERIFIER_LENGTH = 64;

/** 生成 PKCE code_verifier（仅内存持有，绝不落盘 / 日志）。 */
export function createPkceVerifier(length = PKCE_VERIFIER_LENGTH): string {
  if (length < 43 || length > 128) {
    throw new Error("PKCE verifier length must be between 43 and 128");
  }
  const bytes = randomBytes(length);
  let verifier = "";
  for (let index = 0; index < length; index += 1) {
    verifier += PKCE_VERIFIER_ALPHABET[bytes[index]! % PKCE_VERIFIER_ALPHABET.length];
  }
  return verifier;
}

/** S256 code_challenge：base64url(SHA-256(verifier))，去填充。 */
export function computePkceCodeChallenge(verifier: string): string {
  return base64UrlEncode(createHash("sha256").update(verifier, "utf8").digest());
}

/** 32 字节随机值的 base64url 表示；用于 OAuth state 与 OIDC nonce。 */
export function createRandomToken(): string {
  return base64UrlEncode(randomBytes(32));
}

export function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString("base64url");
}
