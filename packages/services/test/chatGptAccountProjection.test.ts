import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAccountProviderConfigSnapshot,
  type AccountProviderConfigSnapshot,
  type ProviderSource,
} from "@zcode/provider";
import {
  NodeZCodeBuiltinProviderConfigSource,
} from "@zcode/provider-node";
import { CHATGPT_CREDENTIAL_KEYS, CHATGPT_PROVIDER_ID } from "@zcode/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createChatGptAwareAccountProviderSource,
  readChatGptAccountProviderOverlay,
} from "../src/model-provider/chatGptAccountProjection.js";
import { createProviderConfigRuntime } from "../src/model-provider/providerConfigRuntime.js";
import { createProviderRuntimeFromConfigRuntime } from "../src/model-provider/providerRuntime.js";

/**
 * Desktop Host 侧 ChatGPT（openai-oauth）投影：
 * 本机凭据（CLI `zcode login chatgpt` 写入的共享加密 store）→ Account Overlay
 * → Host Registry / 模型选择视图包含 ChatGPT 模型；未登录 fail-closed。
 */

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rmDir(dir)));
});

async function rmDir(dir: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(dir, { recursive: true, force: true });
}

function createCredentialMap(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial));
  return {
    loadCredential: vi.fn(async (key: string) => values.get(key) ?? null),
    replace(next: Record<string, string>): void {
      values.clear();
      for (const [key, value] of Object.entries(next)) values.set(key, value);
    },
  };
}

function fullChatGptCredentials(models?: readonly { slug: string; display_name: string }[]) {
  return {
    [CHATGPT_CREDENTIAL_KEYS.hostId]: "urn:uuid:11111111-2222-4333-8444-555555555555",
    [CHATGPT_CREDENTIAL_KEYS.clientId]: "oaiapp_test_client",
    [CHATGPT_CREDENTIAL_KEYS.accessToken]: "access-token-1",
    [CHATGPT_CREDENTIAL_KEYS.refreshToken]: "refresh-token-1",
    [CHATGPT_CREDENTIAL_KEYS.idToken]: "id-token-1",
    [CHATGPT_CREDENTIAL_KEYS.account]: JSON.stringify({
      subject: "user-subject-1",
      email: "user@example.com",
      scopes: ["chatgpt.tokens.use.direct"],
    }),
    [CHATGPT_CREDENTIAL_KEYS.expiresAt]: String(Date.now() + 3_600_000),
    ...(models
      ? { [CHATGPT_CREDENTIAL_KEYS.models]: JSON.stringify(models) }
      : {}),
  };
}

const CHATGPT_BUILTIN = {
  schemaVersion: 1,
  revision: 7,
  config: {
    providerConfigRules: {
      providerRules: [
        {
          providerId: "account:chatgpt",
          providerName: "ChatGPT",
          config: {
            group: "openai-family",
            builtinModelIds: ["gpt-6.1-sol", "gpt-6.1-sol-fast"],
            access: { type: "openai-oauth" },
            api: { type: "openai-responses", baseUrl: "https://api.openai.com/v1" },
          },
        },
      ],
      templateRules: [],
    },
    modelConfigRules: {
      modelRules: [
        {
          modelMatch: ".*",
          config: {
            enabled: true,
            properties: {
              contextWindow: 200000,
              inputFormat: {
                supportsText: true,
                supportsImage: false,
                supportsVideo: false,
                supportsAudio: false,
                supportsPdf: false,
              },
              outputFormat: { supportsText: true },
              supportsToolCall: true,
              supportsJsonSchemaOutput: false,
              supportsNativeWebSearch: false,
              supportsMidConversationSystem: false,
              requiresMfjsToolSchema: false,
            },
            optionSpecs: {
              maxOutputTokens: { max: 32000 },
              reasoningLevel: { values: ["disabled", "enabled"], map: "{}" },
            },
          },
        },
      ],
      modelApiRules: [
        {
          modelMatch: ".*",
          apiTypeMatch: "openai-responses",
          config: {
            optionSpecs: {
              reasoningLevel: {
                map: '{\n  "reasoning": {\n    "effort": reasoningLevel == "disabled" ? "none" : reasoningLevel == "enabled" ? "high" : reasoningLevel\n  }\n}',
              },
              maxOutputTokens: { map: "{'max_output_tokens': maxOutputTokens}" },
            },
          },
        },
      ],
      providerSiteRules: [],
      templateModelRules: [],
      builtinProviderModelRules: [
        { providerId: "account:chatgpt", modelId: "gpt-6.1-sol", config: { enabled: true } },
        { providerId: "account:chatgpt", modelId: "gpt-6.1-sol-fast", config: { enabled: true } },
      ],
    },
  },
};

class StaticAccountSource implements ProviderSource<AccountProviderConfigSnapshot> {
  constructor(readonly snapshot: AccountProviderConfigSnapshot) {}
  async read(): Promise<AccountProviderConfigSnapshot> {
    return this.snapshot;
  }
  onDidChange(): () => void {
    return () => {};
  }
}

async function createFixture(builtin: unknown) {
  const root = await mkdtemp(join(tmpdir(), "zcode-chatgpt-projection-"));
  tempDirs.push(root);
  const zcodeBuiltinFilePath = join(root, "zcode-builtin.json");
  await writeFile(zcodeBuiltinFilePath, JSON.stringify(builtin));
  const configRuntime = createProviderConfigRuntime({
    zcodeBuiltinFilePath,
    personalFilePath: join(root, "personal.json"),
    watch: false,
  });
  const revision = await readBuiltinRevision(zcodeBuiltinFilePath);
  return { configRuntime, credentialFilePath: join(root, "credentials.json"), revision, root };
}

async function readBuiltinRevision(filePath: string): Promise<string> {
  const source = new NodeZCodeBuiltinProviderConfigSource({ bundledFilePath: filePath, watch: false });
  try {
    return (await source.read()).revision;
  } finally {
    source.dispose();
  }
}

describe("readChatGptAccountProviderOverlay", () => {
  it("is fail-closed without credentials", async () => {
    const credentials = createCredentialMap({});
    const overlay = await readChatGptAccountProviderOverlay(credentials);
    expect(overlay.toJSON()).toEqual({ access: { type: "openai-oauth", entitled: false } });
  });

  it("projects entitlement and cached model ids after login", async () => {
    const credentials = createCredentialMap(
      fullChatGptCredentials([
        { slug: "gpt-6.1-sol", display_name: "GPT Sol" },
        { slug: "gpt-6-astra", display_name: "GPT Astra" },
      ]),
    );
    const overlay = await readChatGptAccountProviderOverlay(credentials);
    expect(overlay.toJSON()).toEqual({
      access: { type: "openai-oauth", entitled: true },
      builtinModelIds: ["gpt-6.1-sol", "gpt-6-astra"],
    });
  });

  it("keeps the builtin seed when no model cache exists", async () => {
    const credentials = createCredentialMap(fullChatGptCredentials());
    const overlay = await readChatGptAccountProviderOverlay(credentials);
    expect(overlay.toJSON()).toEqual({ access: { type: "openai-oauth", entitled: true } });
    expect(overlay.builtinModelIds).toBeUndefined();
  });
});

describe("createChatGptAwareAccountProviderSource (desktop host)", () => {
  it("exposes ChatGPT models in the model selection view once signed in", async () => {
    const { configRuntime, credentialFilePath, revision } = await createFixture(CHATGPT_BUILTIN);
    const credentials = createCredentialMap(
      fullChatGptCredentials([{ slug: "gpt-6.1-sol", display_name: "GPT Sol" }]),
    );
    const accountSource = createChatGptAwareAccountProviderSource({
      source: new StaticAccountSource(
        createAccountProviderConfigSnapshot(revision, await emptyProviders(), {}),
      ),
      loadCredential: credentials.loadCredential,
      configSource: configRuntime.configService,
      credentialFilePath,
      watchCredentials: false,
    });
    const runtime = createProviderRuntimeFromConfigRuntime({
      configRuntime,
      accountSource,
      disposeAccountSource: () => accountSource.dispose(),
    });
    await runtime.start();

    const view = await runtime.modelSelection.getView();
    const chatgpt = view.providers.find(
      (provider) => provider.providerId === CHATGPT_PROVIDER_ID,
    );
    expect(chatgpt).toBeDefined();
    expect(chatgpt!.models.map((model) => model.modelId)).toContain("gpt-6.1-sol");

    runtime.dispose();
  });

  it("keeps ChatGPT out of the registry when not signed in (fail-closed)", async () => {
    const { configRuntime, credentialFilePath, revision } = await createFixture(CHATGPT_BUILTIN);
    const credentials = createCredentialMap({});
    const accountSource = createChatGptAwareAccountProviderSource({
      source: new StaticAccountSource(
        createAccountProviderConfigSnapshot(revision, await emptyProviders(), {}),
      ),
      loadCredential: credentials.loadCredential,
      configSource: configRuntime.configService,
      credentialFilePath,
      watchCredentials: false,
    });
    const runtime = createProviderRuntimeFromConfigRuntime({
      configRuntime,
      accountSource,
      disposeAccountSource: () => accountSource.dispose(),
    });
    await runtime.start();

    const view = await runtime.modelSelection.getView();
    expect(
      view.providers.find((provider) => provider.providerId === CHATGPT_PROVIDER_ID),
    ).toBeUndefined();

    runtime.dispose();
  });

  it("emits change and updates the view after credentials appear (CLI login)", async () => {
    const { configRuntime, credentialFilePath, revision } = await createFixture(CHATGPT_BUILTIN);
    const credentials = createCredentialMap({});
    const accountSource = createChatGptAwareAccountProviderSource({
      source: new StaticAccountSource(
        createAccountProviderConfigSnapshot(revision, await emptyProviders(), {}),
      ),
      loadCredential: credentials.loadCredential,
      configSource: configRuntime.configService,
      credentialFilePath,
      watchCredentials: false,
    });
    const runtime = createProviderRuntimeFromConfigRuntime({
      configRuntime,
      accountSource,
      disposeAccountSource: () => accountSource.dispose(),
    });
    await runtime.start();

    const before = await runtime.modelSelection.getView();
    expect(before.providers.some((provider) => provider.providerId === CHATGPT_PROVIDER_ID)).toBe(
      false,
    );

    const changed = new Promise<string>((resolve) => {
      const dispose = accountSource.onDidChange((reason) => {
        dispose();
        resolve(reason);
      });
    });
    credentials.replace(fullChatGptCredentials([{ slug: "gpt-6.1-sol", display_name: "GPT Sol" }]));
    await accountSource.refresh("chatgpt-credentials-changed");
    await expect(changed).resolves.toBe("chatgpt-credentials-changed");

    // 视图在 change 事件后异步重建；轮询等待 ChatGPT Provider 出现。
    let appeared = false;
    for (let attempt = 0; attempt < 40 && !appeared; attempt += 1) {
      const after = await runtime.modelSelection.getView();
      appeared = after.providers.some(
        (provider) => provider.providerId === CHATGPT_PROVIDER_ID,
      );
      if (!appeared) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(appeared).toBe(true);

    runtime.dispose();
  });

  it("passes the host snapshot through untouched when the builtin has no ChatGPT provider", async () => {
    const builtinWithoutChatgpt = {
      ...CHATGPT_BUILTIN,
      config: {
        ...CHATGPT_BUILTIN.config,
        providerConfigRules: { providerRules: [], templateRules: [] },
      },
    };
    const { configRuntime, credentialFilePath, revision } = await createFixture(
      builtinWithoutChatgpt,
    );
    const credentials = createCredentialMap(fullChatGptCredentials());
    const base = createAccountProviderConfigSnapshot(revision, await emptyProviders(), {});
    const accountSource = createChatGptAwareAccountProviderSource({
      source: new StaticAccountSource(base),
      loadCredential: credentials.loadCredential,
      configSource: configRuntime.configService,
      credentialFilePath,
      watchCredentials: false,
    });
    expect((await accountSource.read()).revision).toBe(base.revision);
    accountSource.dispose();
  });
});

async function emptyProviders() {
  const { ProviderConfigMap } = await import("@zcode/provider");
  return ProviderConfigMap.empty();
}
