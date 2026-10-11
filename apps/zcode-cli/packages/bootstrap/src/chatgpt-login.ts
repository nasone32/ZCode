import {
  createSharedZCodeCredentialStore,
  type BrowserOpenResult,
  type ChatGptLoginResult,
  type ChatGptLogoutResult,
  runChatGptLogin,
  runChatGptLogout,
} from "@zcode/adapters";
import type { EnvRecord } from "@zcode/adapters/model";

/**
 * Sign in with ChatGPT（OpenAI token sharing）CLI 登录入口。
 *
 * 与 zai/bigmodel 的服务端轮询登录不同：本流程是官方 SIWC OAuth
 * （动态注册 + PKCE + 127.0.0.1 loopback 回调），凭据只写入本机加密
 * Shared Credential Store；模型列表来自 /v1/models 缓存，Registry 侧
 * 通过账号 Overlay（openai-oauth entitlement）自动发现 provider。
 */

export interface LoginChatGptOptions {
  readonly env?: EnvRecord;
  readonly noBrowser?: boolean;
  readonly abortSignal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly onAuthorizeUrl?: (data: { authorize_url: string }) => void | Promise<void>;
  readonly onBrowserOpen?: (browser: { opened: boolean; reason?: string }) => void;
  readonly openBrowser?: (url: string) => Promise<BrowserOpenResult>;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly now?: () => number;
}

export interface LogoutChatGptOptions {
  readonly env?: EnvRecord;
  readonly fetchImpl?: typeof globalThis.fetch;
}

export async function loginChatGptCli(options: LoginChatGptOptions = {}): Promise<ChatGptLoginResult> {
  const env = options.env ?? process.env;
  const credentialStore = createSharedZCodeCredentialStore({ env });
  const result = await runChatGptLogin({
    store: credentialStore,
    env,
    noBrowser: options.noBrowser,
    timeoutMs: options.timeoutMs,
    now: options.now,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.openBrowser ? { openBrowser: options.openBrowser } : {}),
    onAuthorizeUrl: (authorizeUrl) => {
      void options.onAuthorizeUrl?.({ authorize_url: authorizeUrl });
    },
  });
  if (result.browser) {
    options.onBrowserOpen?.({
      opened: result.browser.opened,
      ...(result.browser.reason ? { reason: result.browser.reason } : {}),
    });
  }
  options.abortSignal?.throwIfAborted();
  return result;
}

export async function logoutChatGptCli(
  options: LogoutChatGptOptions = {},
): Promise<ChatGptLogoutResult> {
  const env = options.env ?? process.env;
  const credentialStore = createSharedZCodeCredentialStore({ env });
  return await runChatGptLogout({
    store: credentialStore,
    env,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
}
