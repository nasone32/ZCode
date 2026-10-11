import { watch, type FSWatcher } from "node:fs";
import { dirname, basename } from "node:path";
import {
  CHATGPT_CREDENTIAL_KEYS,
  CHATGPT_CREDENTIAL_RECORD_KEYS,
  CHATGPT_PROVIDER_ID,
  parseChatGptCachedModelsJson,
  parseChatGptCredentialRecordData,
} from "@zcode/shared";
import {
  createAccountProviderConfigSnapshot,
  OpenAiOAuthAccessConfig,
  ProviderConfig,
  type AccountProviderConfigSnapshot,
  type AccountProviderServiceRefreshErrorEvent,
  type ProviderSource,
} from "@zcode/provider";
import type { ProviderConfigSnapshot } from "@zcode/provider";

/**
 * Desktop Host 侧的 ChatGPT（Sign in with ChatGPT / openai-oauth）账号投影。
 *
 * ChatGPT 凭据是本机事实（CLI `zcode login chatgpt` 写入共享加密 store），
 * 不是 Host 管理的 zhipu 账号态；这里把 entitlement + /v1/models 缓存投影为
 * 第三层 Account Overlay，让 Host Registry（即桌面 UI 的模型列表与默认选择），
 * 以及推送给 ZCode agent 的 Account 快照都包含 ChatGPT Provider。
 *
 * Token 本身绝不进入 Provider Config、日志或遥测；请求期 Bearer 由 agent 进程
 * 的 requestAuth Source（adapters/chatgpt）从同一 store 解析并按需刷新。
 */

export interface ChatGptAccountCredentialReader {
  loadCredential(key: string): Promise<string | null>;
}

/** 读取 ChatGPT 投影：未登录 → entitled=false（fail-closed）；登录 → entitled+模型缓存。 */
export async function readChatGptAccountProviderOverlay(
  reader: ChatGptAccountCredentialReader,
): Promise<ProviderConfig> {
  const values: Record<string, string | null> = {};
  await Promise.all(
    CHATGPT_CREDENTIAL_RECORD_KEYS.map(async (key) => {
      values[key] = await reader.loadCredential(key).catch(() => null);
    }),
  );
  const record = parseChatGptCredentialRecordData(values);
  if (!record) {
    return new ProviderConfig({
      access: new OpenAiOAuthAccessConfig({ entitled: false }),
    });
  }
  const modelsRaw = await reader
    .loadCredential(CHATGPT_CREDENTIAL_KEYS.models)
    .catch(() => null);
  const models = parseChatGptCachedModelsJson(modelsRaw);
  return new ProviderConfig({
    access: new OpenAiOAuthAccessConfig({ entitled: true }),
    ...(models ? { builtinModelIds: models.map((model) => model.slug) } : {}),
  });
}

export interface ChatGptAwareAccountProviderSource
  extends ProviderSource<AccountProviderConfigSnapshot> {
  refresh(reason?: string): Promise<AccountProviderConfigSnapshot>;
  onDidRefreshError(
    listener: (event: AccountProviderServiceRefreshErrorEvent) => void,
  ): () => void;
  dispose(): void;
}

export interface CreateChatGptAwareAccountProviderSourceOptions {
  /** zhipu 账号事实的既有 Source（createAccountProviderConfigSource 产物）。 */
  readonly source: ProviderSource<AccountProviderConfigSnapshot> & {
    refresh?(reason: string): Promise<AccountProviderConfigSnapshot>;
    onDidRefreshError?(
      listener: (event: AccountProviderServiceRefreshErrorEvent) => void,
    ): () => void;
    dispose?(): void;
  };
  readonly loadCredential: (key: string) => Promise<string | null>;
  /** 用于判断当前 Built-in 是否声明了 ChatGPT Provider；未声明时保持 Host 快照原样。 */
  readonly configSource: ProviderSource<ProviderConfigSnapshot>;
  /** 共享凭据文件路径；监听其变化以热更新（login/logout 后无需重启桌面）。 */
  readonly credentialFilePath: string;
  readonly watchCredentials?: boolean;
}

const CREDENTIAL_WATCH_DEBOUNCE_MS = 800;

export function createChatGptAwareAccountProviderSource(
  options: CreateChatGptAwareAccountProviderSourceOptions,
): ChatGptAwareAccountProviderSource {
  const listeners = new Set<(reason: string) => void>();
  let lastEmittedRevision: string | undefined;
  let watcher: FSWatcher | undefined;
  let watchTimer: NodeJS.Timeout | undefined;
  let disposed = false;

  const withChatGptOverlay = async (
    snapshot: AccountProviderConfigSnapshot,
  ): Promise<AccountProviderConfigSnapshot> => {
    let config: ProviderConfigSnapshot;
    try {
      config = await options.configSource.read();
    } catch {
      return snapshot;
    }
    if (!config.zcodeBuiltinProviders.has(CHATGPT_PROVIDER_ID)) return snapshot;
    const overlay = await readChatGptAccountProviderOverlay({
      loadCredential: options.loadCredential,
    });
    const providers = snapshot.providers.set(CHATGPT_PROVIDER_ID, overlay);
    return createAccountProviderConfigSnapshot(
      snapshot.basedOnZCodeBuiltinRevision,
      providers,
      snapshot.states,
    );
  };

  const emitIfChanged = (snapshot: AccountProviderConfigSnapshot, reason: string): boolean => {
    if (snapshot.revision === lastEmittedRevision) return false;
    lastEmittedRevision = snapshot.revision;
    for (const listener of listeners) listener(reason);
    return true;
  };

  const source: ChatGptAwareAccountProviderSource = {
    async read() {
      const snapshot = await withChatGptOverlay(await options.source.read());
      lastEmittedRevision ??= snapshot.revision;
      return snapshot;
    },
    async refresh(reason = "explicit") {
      const base = await (options.source.refresh?.(reason) ?? options.source.read());
      const snapshot = await withChatGptOverlay(base);
      emitIfChanged(snapshot, reason);
      return snapshot;
    },
    onDidChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onDidRefreshError(listener) {
      return options.source.onDidRefreshError?.(listener) ?? (() => undefined);
    },
    dispose() {
      disposed = true;
      if (watchTimer) clearTimeout(watchTimer);
      watcher?.close();
      watcher = undefined;
      listeners.clear();
      options.source.dispose?.();
    },
  };

  // Host 侧订阅 base 变化（settings/config 驱动的 zhipu 刷新）→ 重投影并按需广播。
  options.source.onDidChange((reason) => {
    if (disposed) return;
    void source
      .refresh(`chatgpt-overlay:${reason}`)
      .catch(() => undefined);
  });

  if (options.watchCredentials !== false) {
    // 凭据文件由 CLI 进程原子写（rename）；监听目录并过滤文件名，避免监听不存在文件。
    const directory = dirname(options.credentialFilePath);
    const fileName = basename(options.credentialFilePath);
    try {
      watcher = watch(directory, { persistent: false }, (_event, changedFile) => {
        if (disposed || (changedFile && changedFile !== fileName)) return;
        if (watchTimer) clearTimeout(watchTimer);
        watchTimer = setTimeout(() => {
          if (disposed) return;
          void source
            .refresh("chatgpt-credentials-changed")
            .catch(() => undefined);
        }, CREDENTIAL_WATCH_DEBOUNCE_MS);
        watchTimer.unref?.();
      });
      watcher.on("error", () => undefined);
      watcher.unref?.();
    } catch {
      // 监听不可用（权限/平台差异）时退化为无热更新；重启后仍然生效。
    }
  }

  return source;
}
