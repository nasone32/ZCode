type ProviderFetch = typeof globalThis.fetch;

/**
 * ChatGPT 计划用量（Sign in with ChatGPT token sharing）的 Responses 请求合规层。
 *
 * 官方 preview-limitations 要求：
 * - 每个推理请求必须 `store: false` 且 `stream: true`；
 * - 不支持的字段必须从 body 移除（temperature、top_p、max_output_tokens、
 *   previous_response_id、metadata、truncation、user 等）；
 * - 无服务端会话存储 → `include` 需要补 `reasoning.encrypted_content` 以便
 *   在 store:false 下回放推理状态。
 *
 * 该 wrapper 必须位于 option-map fetch 之外层（先于它运行），确保能清理
 * option map 注入的 `max_output_tokens` 等字段。
 */

/** 文档列出的不支持顶层字段；出现即删除，不能原样发送。 */
const UNSUPPORTED_RESPONSES_BODY_FIELDS: ReadonlySet<string> = new Set([
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  "previous_response_id",
  "service_tier",
]);

const ENCRYPTED_REASONING_INCLUDE = "reasoning.encrypted_content";

export function createChatGptResponsesCompatFetch(baseFetch: ProviderFetch): ProviderFetch {
  return async (input, init) => {
    const patchedInit = patchResponsesRequestInit(input, init);
    return baseFetch(input, patchedInit);
  };
}

export function patchResponsesRequestInit(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): RequestInit | undefined {
  const method = init?.method ?? (typeof input !== "string" && "method" in input ? input.method : "GET");
  if (method.toUpperCase() !== "POST") {
    return init;
  }
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!isResponsesEndpointUrl(url)) {
    return init;
  }
  const body = readJsonBody(init?.body);
  if (!body) {
    return init;
  }
  const patched = sanitizeChatGptResponsesBody(body);
  return {
    ...init,
    headers: withJsonContentType(init?.headers),
    body: JSON.stringify(patched),
  };
}

/** 判定 /responses 推理端点（base 可能带 /v1 前缀或代理路径）。 */
export function isResponsesEndpointUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const pathname = new URL(url, "https://api.openai.invalid").pathname;
    return /\/responses\/?$/u.test(pathname);
  } catch {
    return false;
  }
}

export function sanitizeChatGptResponsesBody(body: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (UNSUPPORTED_RESPONSES_BODY_FIELDS.has(key)) continue;
    result[key] = value;
  }
  result.store = false;
  result.stream = true;
  result.include = mergeEncryptedReasoningInclude(result.include);
  moveSystemInputItemsToInstructions(result);
  return result;
}

/**
 * SIWC 要求 system 提示走 `instructions`（或 developer message），
 * 顶层 `{role:"system"}` input item 会被 ChatGPT 计划用量拒绝。
 * AI SDK 会把 messages 数组中的 system 消息放入 input，这里统一搬移。
 */
function moveSystemInputItemsToInstructions(body: Record<string, unknown>): void {
  if (!Array.isArray(body.input)) return;
  const systemTexts: string[] = [];
  const input: unknown[] = [];
  for (const item of body.input) {
    if (!isRecord(item) || item.role !== "system") {
      input.push(item);
      continue;
    }
    const text = readInputItemText(item.content);
    if (text) systemTexts.push(text);
  }
  if (systemTexts.length === 0) return;
  const existingInstructions =
    typeof body.instructions === "string" && body.instructions.trim().length > 0
      ? body.instructions
      : undefined;
  body.input = input;
  body.instructions = [...(existingInstructions ? [existingInstructions] : []), ...systemTexts]
    .join("\n\n");
}

function readInputItemText(content: unknown): string | undefined {
  if (typeof content === "string") return content.length > 0 ? content : undefined;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .filter(isRecord)
    .filter((part) => part.type === "input_text" || part.type === "output_text")
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .filter((text) => text.length > 0);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function mergeEncryptedReasoningInclude(value: unknown): string[] {
  const existing = Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
  if (existing.includes(ENCRYPTED_REASONING_INCLUDE)) return existing;
  return [...existing, ENCRYPTED_REASONING_INCLUDE];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonBody(body: BodyInit | null | undefined): Record<string, unknown> | undefined {
  if (typeof body !== "string") return undefined;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function withJsonContentType(headers: HeadersInit | undefined): HeadersInit {
  const result = new Headers(headers);
  if (!result.has("content-type")) {
    result.set("content-type", "application/json");
  }
  return result;
}
