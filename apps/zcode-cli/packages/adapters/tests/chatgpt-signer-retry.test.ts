import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import {
  classifyModelFailure,
  isClientSigningLifecycleError,
} from "../src/model/failure-classifier.js";
import { ModelErrorCode } from "@zcode/contracts";
import { AiSdkModelAdapterError } from "../src/model/errors.js";

/**
 * 回归：客户端签名器（V4 signer）生命周期错误（"Client request signer has been
 * disposed."）此前落入 fallback 被判 retryable=false，直接杀死 subagent 的整轮工作。
 * 现在必须：可重试（retryable=true）、归因 runtime、且不改变 auth/cancel/未知语义。
 */

class ClientRequestSigningV4ErrorSimulato extends Error {
  constructor(message = "Client request signer has been disposed.") {
    super(message);
    this.name = "ClientRequestSigningV4Error";
  }
}

describe("isClientSigningLifecycleError", () => {
  it("detects the bare signer error by name", () => {
    expect(isClientSigningLifecycleError(new ClientRequestSigningV4ErrorSimulato())).toBe(true);
  });

  it("detects message-form variants of the same closed-source module", () => {
    const error = new Error("Request signer was released during streaming.");
    error.name = "SomeOtherError";
    expect(isClientSigningLifecycleError(error)).toBe(true);
  });

  it("traverses wrapped causes like the production chain", () => {
    const signer = new ClientRequestSigningV4ErrorSimulato();
    const inner = new Error("Model request failed.", { cause: signer });
    const outer = new AiSdkModelAdapterError(
      ModelErrorCode.ModelRequestFailed,
      "Model request failed.",
      { cause: inner },
    );
    expect(isClientSigningLifecycleError(outer)).toBe(true);
  });

  it("survives cause cycles without looping", () => {
    const a = new Error("a");
    const b = new ClientRequestSigningV4ErrorSimulato();
    a.cause = b;
    b.cause = a;
    expect(isClientSigningLifecycleError(a)).toBe(true);
    expect(isClientSigningLifecycleError(b)).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isClientSigningLifecycleError(new Error("Provider authentication failed."))).toBe(false);
    expect(isClientSigningLifecycleError(undefined)).toBe(false);
    expect(isClientSigningLifecycleError("string-error")).toBe(false);
  });
});

describe("classifyModelFailure signer lifecycle errors", () => {
  it("classifies the bare signer error as retryable", () => {
    expect(classifyModelFailure(new ClientRequestSigningV4ErrorSimulato())).toMatchObject({
      code: "model_request_failed",
      reason: "server_error",
      retryable: true,
    });
  });

  it("classifies the production-wrapped chain as retryable regardless of stream phase", () => {
    const signer = new ClientRequestSigningV4ErrorSimulato();
    const wrapped = new AiSdkModelAdapterError(
      ModelErrorCode.ModelRequestFailed,
      "Model request failed.",
      { cause: signer },
    );
    const failure = classifyModelFailure(wrapped);
    expect(failure).toMatchObject({
      code: "model_request_failed",
      retryable: true,
    });
    expect(failure.message).toContain("signer has been disposed");
  });

  it("keeps 401 auth failures non-retryable (regression guard)", () => {
    const failure = classifyModelFailure(
      new APICallError({ message: "Unauthorized", statusCode: 401, responseBody: "", url: "" }),
    );
    expect(failure.retryable).toBe(false);
    expect(failure.reason).toBe("auth_failed");
  });

  it("keeps generic unknown failures on the existing fallback behavior (regression guard)", () => {
    const failure = classifyModelFailure(new Error("something else entirely"));
    expect(failure).toMatchObject({
      code: "model_request_failed",
      reason: "unknown",
      retryable: false,
    });
  });
});
