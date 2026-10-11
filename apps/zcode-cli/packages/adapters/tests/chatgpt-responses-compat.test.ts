import { describe, expect, it } from "vitest";
import {
  createChatGptResponsesCompatFetch,
  isResponsesEndpointUrl,
  patchResponsesRequestInit,
  sanitizeChatGptResponsesBody,
} from "../src/model/chatgpt-responses-compat.js";

describe("ChatGPT Responses body compliance", () => {
  it("forces store:false / stream:true and keeps supported fields", () => {
    const body = sanitizeChatGptResponsesBody({
      model: "gpt-6.1-sol",
      input: [{ type: "message", role: "user", content: "hi" }],
      instructions: "system prompt",
      reasoning: { effort: "high" },
    });
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.model).toBe("gpt-6.1-sol");
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
  });

  it("strips documented-unsupported fields", () => {
    const body = sanitizeChatGptResponsesBody({
      model: "m",
      input: [],
      temperature: 0.7,
      top_p: 0.9,
      max_output_tokens: 4096,
      metadata: { session: "x" },
      truncation: "auto",
      user: "u",
      previous_response_id: "resp_1",
      service_tier: "flex",
    });
    for (const field of [
      "temperature",
      "top_p",
      "max_output_tokens",
      "metadata",
      "truncation",
      "user",
      "previous_response_id",
      "service_tier",
    ]) {
      expect(body).not.toHaveProperty(field);
    }
  });

  it("preserves existing include entries and merges the encrypted reasoning include", () => {
    const body = sanitizeChatGptResponsesBody({ include: ["other.include"] });
    expect(body.include).toEqual(["other.include", "reasoning.encrypted_content"]);
  });

  it("overwrites non-compliant store/stream values", () => {
    const body = sanitizeChatGptResponsesBody({ store: true, stream: false });
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
  });

  it("moves system input items into instructions (SIWC rejects them in input)", () => {
    const body = sanitizeChatGptResponsesBody({
      input: [
        { role: "system", content: "You are ZCode." },
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
    });
    expect(body.instructions).toBe("You are ZCode.");
    expect(body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
    ]);
  });

  it("merges multiple system items and preserves existing instructions", () => {
    const body = sanitizeChatGptResponsesBody({
      instructions: "base",
      input: [
        { role: "system", content: "first" },
        { role: "system", content: [{ type: "input_text", text: "second" }] },
        { role: "user", content: "hi" },
      ],
    });
    expect(body.instructions).toBe("base\n\nfirst\n\nsecond");
  });

  it("leaves string input and non-system arrays untouched", () => {
    const body = sanitizeChatGptResponsesBody({
      input: [{ role: "developer", content: "dev" }],
    });
    expect(body.input).toEqual([{ role: "developer", content: "dev" }]);
    expect(body.instructions).toBeUndefined();
    const stringInput = sanitizeChatGptResponsesBody({ input: "plain prompt" });
    expect(stringInput.input).toBe("plain prompt");
  });
});

describe("ChatGPT Responses fetch wrapper", () => {
  it("patches only POST requests to /responses endpoints", () => {
    const patched = patchResponsesRequestInit("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "m", input: [], max_output_tokens: 10 }),
    });
    const body = JSON.parse(patched!.body as string) as Record<string, unknown>;
    expect(body.max_output_tokens).toBeUndefined();
    expect(body.store).toBe(false);

    const getRequest = { method: "GET" } as RequestInit;
    const untouched = patchResponsesRequestInit("https://api.openai.com/v1/models", getRequest);
    // 非 /responses POST 不打补丁：原样返回同一 init 引用。
    expect(untouched).toBe(getRequest);

    const postNoBody = { method: "POST" } as RequestInit;
    const noBody = patchResponsesRequestInit("https://api.openai.com/v1/responses", postNoBody);
    expect(noBody).toBe(postNoBody);
  });

  it("recognizes /responses URLs across base paths", () => {
    expect(isResponsesEndpointUrl("https://api.openai.com/v1/responses")).toBe(true);
    expect(isResponsesEndpointUrl("https://api.openai.com/v1/responses/")).toBe(true);
    expect(isResponsesEndpointUrl("https://api.openai.com/v1/chat/completions")).toBe(false);
    expect(isResponsesEndpointUrl(undefined)).toBe(false);
  });

  it("passes the patched body to the inner fetch", async () => {
    const seen: { url: string; body: string }[] = [];
    const inner: typeof globalThis.fetch = async (input, init) => {
      seen.push({
        url: typeof input === "string" ? input : String(input),
        body: String(init?.body ?? ""),
      });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    };
    const wrapped = createChatGptResponsesCompatFetch(inner);
    await wrapped("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-6.1-sol", input: [], temperature: 1 }),
    });
    const body = JSON.parse(seen[0]!.body) as Record<string, unknown>;
    expect(body.temperature).toBeUndefined();
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
  });
});
