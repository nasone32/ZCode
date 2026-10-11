import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFailClosedAccountProviderConfigSnapshot,
  OpenAiOAuthAccessConfig,
  ProviderConfig,
  ProviderConfigMap,
} from "@zcode/provider";
import { NodeProviderRegistryRuntime, NodeZCodeBuiltinProviderConfigSource } from "../src/index.js";
import { CHATGPT_PROVIDER_ID } from "@zcode/shared";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("built-in ChatGPT (openai-oauth) provider", () => {
  it("declares the account:chatgpt provider with the official Responses endpoint and seed models", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatgpt-builtin-"));
    tempDirs.push(root);
    // 指向仓库内置文件，避免依赖已物化的运行时目录。
    const bundledFile = new URL("../../../config/provider/zcode-builtin.json", import.meta.url);
    const fs = await import("node:fs/promises");
    const release = JSON.parse(await fs.readFile(bundledFile, "utf8"));
    const bundled = join(root, "bundled.json");
    await fs.writeFile(bundled, JSON.stringify(release));

    const layered = await new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: bundled,
      watch: false,
    }).read();

    const chatgpt = layered.providers.get(CHATGPT_PROVIDER_ID);
    expect(chatgpt).toBeDefined();
    expect(chatgpt?.access?.type).toBe("openai-oauth");
    expect(chatgpt?.api?.type).toBe("openai-responses");
    expect(chatgpt?.api?.baseUrl).toBe("https://api.openai.com/v1");
    expect(chatgpt?.builtinModelIds).toContain("gpt-6.1-sol");
    expect(chatgpt?.builtinModelIds).toContain("gpt-6.1-sol-fast");

    // 既有 Provider 不受影响。
    expect(layered.providers.get("account:zai-individual-coding-plan")).toBeDefined();
  });

  it("enters the registry only when entitled and exposes gpt-6.1-sol with model rules", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatgpt-registry-"));
    tempDirs.push(root);
    const fs = await import("node:fs/promises");
    const release = JSON.parse(
      await fs.readFile(
        new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
        "utf8",
      ),
    );
    const bundled = join(root, "bundled.json");
    await fs.writeFile(bundled, JSON.stringify(release));
    const layered = await new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: bundled,
      watch: false,
    }).read();

    const { ProviderConfigResolver } = await import("@zcode/provider");
    const resolver = new ProviderConfigResolver();
    const emptyPersonal = ProviderConfigMap.empty();
    const base = {
      personalProviders: emptyPersonal,
      personalModels: layered.models,
      zcodeBuiltinProviders: layered.providers,
      zcodeBuiltinModelRules: layered.models,
      ...(layered.providerTemplates ? { zcodeBuiltinProviderTemplates: layered.providerTemplates } : {}),
    };

    // fail-closed（未登录）：chatgpt 不进入 Registry。
    const failClosed = createFailClosedAccountProviderConfigSnapshot({
      revision: layered.revision,
      zcodeBuiltinRevision: layered.revision,
      personalRevision: "personal",
      zcodeBuiltinProviders: layered.providers,
      zcodeBuiltinProviderTemplates: layered.providerTemplates,
      personalProviders: emptyPersonal,
      zcodeBuiltinModelRules: layered.models,
      personalModels: layered.models,
    });
    const anonymous = resolver.resolve({ ...base, accountProviders: failClosed.providers });
    expect(
      anonymous.registryProviders.find((provider) => provider.providerId === CHATGPT_PROVIDER_ID),
    ).toBeUndefined();

    // entitled：模型进入 Registry，gpt-6.1-sol 可选。
    const entitled = resolver.resolve({
      ...base,
      accountProviders: new ProviderConfigMap([
        [
          CHATGPT_PROVIDER_ID,
          new ProviderConfig({
            access: new OpenAiOAuthAccessConfig({ entitled: true }),
          }),
        ],
      ]),
    });
    const provider = entitled.registryProviders.find(
      (candidate) => candidate.providerId === CHATGPT_PROVIDER_ID,
    );
    expect(provider).toBeDefined();
    const modelIds = provider!.models.map((model) => model.modelId);
    expect(modelIds).toContain("gpt-6.1-sol");
    expect(modelIds).toContain("gpt-6-astra");
    const sol = provider!.models.find((model) => model.modelId === "gpt-6.1-sol")!;
    expect(sol.config.properties.contextWindow).toBe(1_050_000);
    expect(sol.config.optionSpecs.reasoningLevel.values).toContain("high");
    // fast 变体窗口更小（后置规则覆盖）。
    const solFast = provider!.models.find((model) => model.modelId === "gpt-6.1-sol-fast")!;
    expect(solFast.config.properties.contextWindow).toBe(400_000);
  });

  it("keeps the NodeProviderRegistryRuntime wiring intact for existing providers", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatgpt-runtime-"));
    tempDirs.push(root);
    const fs = await import("node:fs/promises");
    const release = JSON.parse(
      await fs.readFile(
        new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
        "utf8",
      ),
    );
    const bundled = join(root, "bundled.json");
    const active = join(root, "active.json");
    const personal = join(root, "personal.json");
    await fs.writeFile(bundled, JSON.stringify(release));
    const { MutableAccountProviderConfigSource } = await import("@zcode/provider");
    const runtime = new NodeProviderRegistryRuntime({
      zcodeBuiltinFilePath: bundled,
      zcodeBuiltinActiveFilePath: active,
      personalFilePath: personal,
      personalPollingIntervalMs: false,
      accountSource: new MutableAccountProviderConfigSource(),
    });
    try {
      await runtime.start();
      // 账号 Provider（含 chatgpt）默认 fail-closed，不向 Registry 发布模型。
      expect(
        runtime.registryService
          .listProviders()
          .some((provider) => provider.providerId === CHATGPT_PROVIDER_ID),
      ).toBe(false);
      expect(
        runtime.registryService
          .listProviders()
          .some((provider) => provider.providerId === "account:zai-individual-coding-plan"),
      ).toBe(false);
    } finally {
      runtime.dispose();
    }
  });
});
