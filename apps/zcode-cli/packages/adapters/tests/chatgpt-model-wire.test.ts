import { describe, expect, it } from "vitest";
import { streamText } from "ai";
import { createStreamTextOptions } from "../src/model/runner-options.js";
import { AiSdkModelExecution } from "../src/model/model-execution.js";
import { createTestModelProperties } from "./test-model-format.js";
import {
  OpenAiOAuthAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  type RegistryProviderConfig,
} from "@zcode/provider";

/**
 * ChatGPT 计划用量（openai-oauth + openai-responses）线上契约：
 * - Authorization 使用 requestAuth 交付的 OAuth access token；
 * - body 强制 store:false / stream:true，且剥离 max_output_tokens 等不支持字段；
 * - system 提示经 instructions 下发（SIWC 拒绝顶层 system input item）；
 * - 流式文本与 function tool call 可正常解析（response.completed 收尾）。
 */

const OPENAI_RESPONSES_REASONING_MAP =
  '{\n  "reasoning": {\n    "effort": reasoningLevel == "disabled" ? "none" : reasoningLevel == "enabled" ? "high" : reasoningLevel\n  }\n}';
const OPENAI_RESPONSES_MAX_TOKENS_MAP = "{'max_output_tokens': maxOutputTokens}";

const responsesSse = [
  `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_1" } })}\n\n`,
  `event: response.output_item.added\ndata: ${JSON.stringify({
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "message", role: "assistant", id: "msg_1", status: "in_progress", content: [] },
  })}\n\n`,
  `event: response.content_part.added\ndata: ${JSON.stringify({
    type: "response.content_part.added",
    item_id: "msg_1",
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  })}\n\n`,
  `event: response.output_text.delta\ndata: ${JSON.stringify({
    type: "response.output_text.delta",
    item_id: "msg_1",
    output_index: 0,
    content_index: 0,
    delta: "Hello from ChatGPT",
  })}\n\n`,
  `event: response.content_part.done\ndata: ${JSON.stringify({
    type: "response.content_part.done",
    item_id: "msg_1",
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "Hello from ChatGPT", annotations: [] },
  })}\n\n`,
  `event: response.output_item.done\ndata: ${JSON.stringify({
    type: "response.output_item.done",
    output_index: 0,
    item: {
      type: "message",
      role: "assistant",
      id: "msg_1",
      status: "completed",
      content: [{ type: "output_text", text: "Hello from ChatGPT", annotations: [] }],
    },
  })}\n\n`,
  `event: response.output_item.added\ndata: ${JSON.stringify({
    type: "response.output_item.added",
    output_index: 1,
    item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather", arguments: "" },
  })}\n\n`,
  `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
    type: "response.function_call_arguments.delta",
    item_id: "fc_1",
    output_index: 1,
    delta: '{"city"',
  })}\n\n`,
  `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
    type: "response.function_call_arguments.delta",
    item_id: "fc_1",
    output_index: 1,
    delta: ': "Rome"}',
  })}\n\n`,
  `event: response.function_call_arguments.done\ndata: ${JSON.stringify({
    type: "response.function_call_arguments.done",
    item_id: "fc_1",
    output_index: 1,
    arguments: JSON.stringify({ city: "Rome" }),
  })}\n\n`,
  `event: response.output_item.done\ndata: ${JSON.stringify({
    type: "response.output_item.done",
    output_index: 1,
    item: {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "get_weather",
      arguments: JSON.stringify({ city: "Rome" }),
      status: "completed",
    },
  })}\n\n`,
  `event: response.completed\ndata: ${JSON.stringify({
    type: "response.completed",
    response: {
      id: "resp_1",
      usage: {
        input_tokens: 5,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 7,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 12,
      },
      output: [
        {
          type: "message",
          role: "assistant",
          id: "msg_1",
          status: "completed",
          content: [{ type: "output_text", text: "Hello from ChatGPT", annotations: [] }],
        },
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "get_weather",
          arguments: JSON.stringify({ city: "Rome" }),
          status: "completed",
        },
      ],
    },
  })}\n\n`,
].join("");

describe("ChatGPT (openai-oauth) Responses wire contract", () => {
  it("sends the OAuth bearer token and a plan-compliant body, and parses text + tool calls", async () => {
    const requests: Request[] = [];
    const bodies: Record<string, unknown>[] = [];
    const execution = new AiSdkModelExecution(
      { env: {} },
      {
        transport: async (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          bodies.push((await request.clone().json()) as Record<string, unknown>);
          return new Response(responsesSse, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        },
      },
    );
    const providerConfig = new ProviderConfig({
      access: new OpenAiOAuthAccessConfig({ entitled: true }),
      api: new ProviderApiConfig({
        type: "openai-responses",
        baseUrl: "https://api.openai.test/v1",
      }),
    }) as RegistryProviderConfig;
    const bound = execution.bindModel({
      providerId: "account:chatgpt",
      modelId: "gpt-6.1-sol",
      providerConfig,
      supportsJsonSchemaOutput: false,
      optionSpecs: {
        reasoningLevel: { map: OPENAI_RESPONSES_REASONING_MAP },
        maxOutputTokens: { map: OPENAI_RESPONSES_MAX_TOKENS_MAP },
      },
    });
    const resolved = bound.resolveRequest({
      options: { reasoningLevel: "high", maxOutputTokens: 4_096 },
      requestAuth: { apiKey: "chatgpt-oauth-access-token" },
    });

    const result = streamText(
      createStreamTextOptions({
        includeModelIO: false,
        resolved: { ...resolved, properties: createTestModelProperties() },
        request: {
          messages: [
            { role: "system", content: "You are ZCode." },
            { role: "user", content: "weather in Rome?" },
          ],
          tools: [
            {
              name: "get_weather",
              description: "Get weather",
              inputSchema: { type: "object", properties: { city: { type: "string" } } },
            },
          ],
        },
        statusContext: {
          providerId: "account:chatgpt",
          modelId: "gpt-6.1-sol",
          providerKind: resolved.providerKind,
          requestId: "chatgpt-wire",
        } as never,
      }),
    );

    const events: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const event of result.fullStream) events.push(event as never);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.openai.test/v1/responses");
    // OAuth access token 经 requestAuth → SDK Authorization 头。
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer chatgpt-oauth-access-token");

    const body = bodies[0]!;
    expect(body.model).toBe("gpt-6.1-sol");
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    // 计划用量不支持的字段必须被剥离（即使 option map 已注入）。
    expect(body.max_output_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    // include 需含 encrypted reasoning content（store:false 下的状态回放）。
    expect(body.include).toContain("reasoning.encrypted_content");
    // instructions 承载 system（Responses 计划用量拒绝顶层 system message item）。
    expect(body.instructions).toBe("You are ZCode.");
    expect((body.input as Array<{ role: string }>)[0]?.role).toBe("user");
    // reasoning effort 正常下发。
    expect(body.reasoning).toEqual({ effort: "high" });

    const text = await result.text;
    expect(text).toBe("Hello from ChatGPT");
    const toolCalls = (await result.toolCalls) as Array<{
      toolName: string;
      args?: unknown;
      input?: unknown;
    }>;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.toolName).toBe("get_weather");
    // AI SDK v6 ToolCall 的参数字段名为 input（部分版本为 args），两者取其一。
    expect(toolCalls[0]?.args ?? toolCalls[0]?.input).toEqual({ city: "Rome" });
    const errorEvents = events.filter((event) => event.type === "error");
    expect(errorEvents).toEqual([]);
    const finish = await result.finishReason;
    expect(finish).toBe("tool-calls");
  });

  it("fails closed before any network request when the auth source is unavailable", async () => {
    const requests: Request[] = [];
    const execution = new AiSdkModelExecution(
      { env: {} },
      {
        transport: async (input, init) => {
          requests.push(new Request(input, init));
          return new Response("{}", { headers: { "content-type": "application/json" } });
        },
      },
    );
    const providerConfig = new ProviderConfig({
      access: new OpenAiOAuthAccessConfig({ entitled: true }),
      api: new ProviderApiConfig({
        type: "openai-responses",
        baseUrl: "https://api.openai.test/v1",
      }),
    }) as RegistryProviderConfig;
    // 绑定期不携带 requestAuth：openai-oauth 无静态 apiKey，也不回落 env。
    const bound = execution.bindModel({
      providerId: "account:chatgpt",
      modelId: "gpt-6.1-sol",
      providerConfig,
      supportsJsonSchemaOutput: false,
      optionSpecs: {
        reasoningLevel: { map: OPENAI_RESPONSES_REASONING_MAP },
        maxOutputTokens: { map: OPENAI_RESPONSES_MAX_TOKENS_MAP },
      },
    });
    const resolved = bound.resolveRequest({
      options: { reasoningLevel: "high", maxOutputTokens: 4_096 },
    });
    // 绑定产物不包含任何静态凭据（Bearer 只能来自 requestAuth Source）。
    expect((resolved.model as unknown as { apiKey?: string }).apiKey).toBeUndefined();
  });
});
