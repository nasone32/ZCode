import {
  ModelErrorCode,
  ModelFailureReason as ModelFailureReasonValue,
  ModelRetryReason as ModelRetryReasonValue,
  type ModelErrorCode as ModelErrorCodeType,
  type ModelFailureReason,
  type ModelRetryReason,
} from "@zcode/contracts";
import {
  getApiCallResponseBody,
  getErrorCode,
  getResponseHeaders,
  getStatusCode,
  isAbortFailure,
  isContextExceededFailure,
  isNetworkFailure,
  isProviderMarkedRetryable,
  isProxyFailure,
  isTimeoutFailure,
  parseRetryAfterMs,
  unwrapRetryError,
} from "./failure-inspection.js";
import { readMappedAiSdkProviderBusinessError } from "./failure-ai-sdk-provider-error.js";
import { isTlsFailure } from "./failure-tls.js";
import {
  isProviderBusinessError,
  readProviderBusinessFailureFromBody,
  ProviderBusinessError,
} from "./model-execution.js";
import {
  getProviderBusinessCodeMapping,
  isRetryableProviderBusinessNetworkFailure,
  isRetryableProviderBusinessTimeoutFailure,
} from "./failure-provider-business-codes.js";
import { isModelStreamIdleTimeoutError } from "./stream-idle-timeout.js";

const PROVIDER_BUSINESS_ERROR_WRAPPER_CODE = "PROVIDER_BUSINESS_ERROR";

export interface ClassifiedModelFailure {
  code: ModelErrorCodeType;
  message: string;
  reason: ModelFailureReason;
  retryReason: ModelRetryReason;
  retryable: boolean;
  retryAfterMs?: number;
  statusCode?: number;
}

export interface ProviderFailureDetails {
  providerErrorCode?: string;
  providerErrorMessage?: string;
  providerRequestId?: string;
}

export function inspectProviderFailure(error: unknown): ProviderFailureDetails {
  const unwrapped = unwrapRetryError(error);
  // 分类链路能读取 AI SDK parsed error，但观测链路只认识 ProviderBusinessError，
  // 导致同一次失败在 status event 与最终 error context 中丢失 provider 诊断字段。
  const businessError =
    findProviderBusinessError(unwrapped) ?? readMappedAiSdkProviderBusinessError(unwrapped);
  if (businessError) {
    return {
      providerErrorCode: resolveProviderBusinessCode(businessError),
      providerErrorMessage: providerBusinessMessage(businessError),
      providerRequestId: businessError.providerRequestId,
    };
  }
  const detected = readProviderBusinessFailureFromBody(getApiCallResponseBody(unwrapped));
  return detected
    ? {
        providerErrorCode:
          typeof detected.providerCode === "number"
            ? String(detected.providerCode)
            : detected.providerCode,
        providerErrorMessage: detected.providerMessage,
        providerRequestId: detected.providerRequestId,
      }
    : {};
}

export function classifyModelFailure(
  error: unknown,
  abortSignal?: AbortSignal,
): ClassifiedModelFailure {
  const unwrapped = unwrapRetryError(error);
  const statusCode = getStatusCode(unwrapped);
  const code = getErrorCode(unwrapped);
  const headers = getResponseHeaders(unwrapped);
  const retryAfterMs = parseRetryAfterMs(headers);

  if (code === ModelErrorCode.InvalidModelResponse) {
    return {
      code: ModelErrorCode.InvalidModelResponse,
      message:
        unwrapped instanceof Error ? unwrapped.message : "Model returned an invalid response.",
      reason: ModelFailureReasonValue.InvalidRequest,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      statusCode,
    };
  }

  if (code === ModelErrorCode.InvalidModelRequest) {
    return {
      code: ModelErrorCode.InvalidModelRequest,
      message:
        unwrapped instanceof Error ? unwrapped.message : "Model request configuration is invalid.",
      reason: ModelFailureReasonValue.InvalidRequest,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      statusCode,
    };
  }

  if (isAbortFailure(unwrapped, abortSignal)) {
    return {
      code: ModelErrorCode.ModelRequestCancelled,
      message: "Model request was cancelled.",
      reason: ModelFailureReasonValue.Cancelled,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      statusCode,
    };
  }

  if (isModelStreamIdleTimeoutError(unwrapped)) {
    return {
      code: ModelErrorCode.ModelRequestTimeout,
      message: unwrapped.message,
      reason: ModelFailureReasonValue.StreamIdleTimeout,
      retryReason: ModelRetryReasonValue.StreamIdleTimeout,
      retryable: true,
      retryAfterMs,
      statusCode,
    };
  }

  // fetch 层提前抛出的 ProviderBusinessError 不走 APICallError，
  // retry-after 必须在业务错误归一化时继续传下去。
  const providerBusinessFailure = classifyProviderBusinessFailure(
    findProviderBusinessError(unwrapped) ?? unwrapped,
    statusCode,
    retryAfterMs,
  );
  if (providerBusinessFailure) {
    return providerBusinessFailure;
  }

  // AI SDK 的请求错误保留在 APICallError.data.error，流式 SSE 错误则直接提供
  // 已解析的 error 对象；这里统一消费这两种 AI SDK 输出，不新增 provider 原始响应旁路。
  const aiSdkErrorFailure = classifyProviderBusinessFailure(
    readMappedAiSdkProviderBusinessError(unwrapped),
    statusCode,
    retryAfterMs,
  );
  if (aiSdkErrorFailure) {
    return aiSdkErrorFailure;
  }

  // AI SDK 有时把 403 JSON（如 3007）包成 APICallError，不走 ProviderBusinessError；
  // 若在通用 403 鉴权分支之前不解析 responseBody，会误显示 “Provider authentication failed.”。
  const apiCallBodyFailure = classifyProviderBusinessFailureFromApiCallBody(
    unwrapped,
    statusCode,
    retryAfterMs,
  );
  if (apiCallBodyFailure) {
    return apiCallBodyFailure;
  }

  if (isTimeoutFailure(unwrapped, code, statusCode)) {
    return {
      code: ModelErrorCode.ModelRequestTimeout,
      message: "Model request timed out.",
      reason: ModelFailureReasonValue.Timeout,
      retryReason: ModelRetryReasonValue.Timeout,
      retryable: true,
      retryAfterMs,
      statusCode,
    };
  }

  // 客户端签名器生命周期错误（如 "Client request signer has been disposed"）：
  // 本地 runtime 组件的瞬态竞态，无 HTTP status / provider code，此前落入最终
  // fallback 被判 retryable=false，直接杀死 subagent。按定义客户端可重试。
  if (isClientSigningLifecycleError(unwrapped)) {
    return {
      code: ModelErrorCode.ModelRequestFailed,
      message: readErrorMessage(unwrapped) ?? "Model request failed.",
      reason: ModelFailureReasonValue.ServerError,
      retryReason: ModelRetryReasonValue.ServerError,
      retryable: true,
      retryAfterMs,
      statusCode,
    };
  }

  if (statusCode === 429) {
    return {
      code: ModelErrorCode.ModelRateLimited,
      message: "Provider rate limited the model request.",
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: true,
      retryAfterMs,
      statusCode,
    };
  }

  if (statusCode === 529) {
    return {
      code: ModelErrorCode.ModelRequestFailed,
      message: "Provider is overloaded.",
      reason: ModelFailureReasonValue.ProviderOverloaded,
      retryReason: ModelRetryReasonValue.ProviderOverloaded,
      retryable: true,
      retryAfterMs,
      statusCode,
    };
  }

  if (statusCode === 401 || statusCode === 403) {
    return {
      code: ModelErrorCode.ProviderNotConfigured,
      message: "Provider authentication failed.",
      reason: ModelFailureReasonValue.AuthFailed,
      retryReason: ModelRetryReasonValue.AuthRefresh,
      retryable: false,
      statusCode,
    };
  }

  if (statusCode === 400 || statusCode === 422) {
    const contextExceeded = isContextExceededFailure(unwrapped);
    return {
      code: contextExceeded
        ? ModelErrorCode.ModelContextExceeded
        : ModelErrorCode.InvalidModelRequest,
      message: contextExceeded
        ? "Model request exceeded the provider context window."
        : "Provider rejected the model request.",
      reason: contextExceeded
        ? ModelFailureReasonValue.ContextExceeded
        : ModelFailureReasonValue.InvalidRequest,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      statusCode,
    };
  }

  if (isContextExceededFailure(unwrapped)) {
    return {
      code: ModelErrorCode.ModelContextExceeded,
      message: "Model request exceeded the provider context window.",
      reason: ModelFailureReasonValue.ContextExceeded,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      statusCode,
    };
  }

  if (statusCode !== undefined && statusCode >= 500) {
    return {
      code: ModelErrorCode.ModelRequestFailed,
      message: "Provider returned a server error.",
      reason: ModelFailureReasonValue.ServerError,
      retryReason: ModelRetryReasonValue.ServerError,
      retryable: true,
      retryAfterMs,
      statusCode,
    };
  }

  if (isTlsFailure(code)) {
    return {
      code: ModelErrorCode.ModelRequestFailed,
      message: "TLS validation failed for the provider request.",
      reason: ModelFailureReasonValue.TlsError,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      statusCode,
    };
  }

  if (isProxyFailure(code)) {
    return {
      code: ModelErrorCode.ModelRequestFailed,
      message: "Proxy connection failed for the provider request.",
      reason: ModelFailureReasonValue.ProxyError,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: true,
      retryAfterMs,
      statusCode,
    };
  }

  if (isNetworkFailure(code)) {
    return {
      code: ModelErrorCode.ModelRequestFailed,
      message: "Network connection failed for the provider request.",
      reason: ModelFailureReasonValue.NetworkError,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: true,
      retryAfterMs,
      statusCode,
    };
  }

  const retryable = isProviderMarkedRetryable(unwrapped);
  return {
    code: ModelErrorCode.ModelRequestFailed,
    message: retryable
      ? "Provider marked the model request as retryable."
      : "Model request failed.",
    reason: retryable ? ModelFailureReasonValue.ServerError : ModelFailureReasonValue.Unknown,
    retryReason: retryable ? ModelRetryReasonValue.ServerError : ModelRetryReasonValue.NetworkError,
    retryable,
    retryAfterMs,
    statusCode,
  };
}

export function isRetryableFailure(failure: ClassifiedModelFailure): boolean {
  return failure.retryable && failure.reason !== ModelFailureReasonValue.Cancelled;
}

function classifyProviderBusinessFailureFromApiCallBody(
  error: unknown,
  statusCode?: number,
  retryAfterMs?: number,
): ClassifiedModelFailure | undefined {
  const body = getApiCallResponseBody(error);
  const detected = readProviderBusinessFailureFromBody(body);
  if (!detected) {
    return undefined;
  }

  return classifyProviderBusinessFailure(
    new ProviderBusinessError({
      providerCode: detected.providerCode,
      providerId: "unknown",
      providerKind: "openai-compatible",
      providerMessage: detected.providerMessage,
      providerRequestId: detected.providerRequestId,
      responseBodySummary: detected.responseBodySummary,
      responseStatus: statusCode ?? detected.statusCode,
      statusCode: statusCode ?? detected.statusCode,
    }),
    statusCode ?? detected.statusCode,
    retryAfterMs,
  );
}

function classifyProviderBusinessFailure(
  error: unknown,
  statusCode?: number,
  retryAfterMs?: number,
): ClassifiedModelFailure | undefined {
  if (!isProviderBusinessError(error)) {
    return undefined;
  }

  const message = providerBusinessMessage(error);
  const providerCode = resolveProviderBusinessCode(error);
  const effectiveStatusCode = resolveProviderBusinessStatusCode(error, statusCode);
  const mappedFailure = providerCode ? getProviderBusinessCodeMapping(providerCode) : undefined;
  if (mappedFailure) {
    return {
      code: mappedFailure.code,
      message: mappedFailure.message ?? message,
      reason: mappedFailure.reason,
      retryReason: mappedFailure.retryReason,
      retryable: mappedFailure.retryable,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }

  if (isContextExceededFailure(error)) {
    return {
      code: ModelErrorCode.ModelContextExceeded,
      message: "Model request exceeded the provider context window.",
      reason: ModelFailureReasonValue.ContextExceeded,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }
  if (isRetryableProviderBusinessTimeoutFailure(error, providerCode, effectiveStatusCode)) {
    return {
      code: ModelErrorCode.ModelRequestTimeout,
      message,
      reason: ModelFailureReasonValue.Timeout,
      retryReason: ModelRetryReasonValue.Timeout,
      retryable: true,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }
  const retryReason =
    effectiveStatusCode !== undefined && effectiveStatusCode >= 500
      ? ModelRetryReasonValue.ServerError
      : ModelRetryReasonValue.NetworkError;

  if (effectiveStatusCode === 401 || effectiveStatusCode === 403) {
    return {
      code: ModelErrorCode.ProviderNotConfigured,
      message,
      reason: ModelFailureReasonValue.AuthFailed,
      retryReason: ModelRetryReasonValue.AuthRefresh,
      retryable: false,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }

  if (effectiveStatusCode === 404) {
    return {
      code: ModelErrorCode.ModelNotFound,
      message,
      reason: ModelFailureReasonValue.InvalidRequest,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }

  if (effectiveStatusCode === 400 || effectiveStatusCode === 422) {
    return {
      code: ModelErrorCode.InvalidModelRequest,
      message,
      reason: ModelFailureReasonValue.InvalidRequest,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }

  if (effectiveStatusCode === 429) {
    return {
      code: ModelErrorCode.ModelRateLimited,
      message,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: true,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }

  if (isRetryableProviderBusinessNetworkFailure(error, providerCode)) {
    return {
      code: ModelErrorCode.ModelRequestFailed,
      message,
      reason: ModelFailureReasonValue.NetworkError,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: true,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }

  if (effectiveStatusCode !== undefined && effectiveStatusCode >= 500) {
    return {
      code: ModelErrorCode.ModelRequestFailed,
      message,
      reason: ModelFailureReasonValue.ServerError,
      retryReason,
      retryable: true,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }

  return {
    code: ModelErrorCode.ModelRequestFailed,
    message,
    reason: ModelFailureReasonValue.Unknown,
    retryReason,
    retryable: false,
    retryAfterMs,
    statusCode: effectiveStatusCode,
  };
}

export function findProviderBusinessError(
  error: unknown,
  seen = new WeakSet<object>(),
): ProviderBusinessError | undefined {
  if (isProviderBusinessError(error)) {
    return error;
  }
  if (error === null || typeof error !== "object" || seen.has(error)) {
    return undefined;
  }
  seen.add(error);

  // AI SDK 可能把 fetch 层抛出的 ProviderBusinessError 包在 cause 里；
  // 若只看外层 APICallError，会丢掉 providerCode/message/responseHeaders。
  const cause = (error as { cause?: unknown }).cause;
  return cause && cause !== error ? findProviderBusinessError(cause, seen) : undefined;
}

/** 客户端请求签名器（V4 signer）生命周期错误的稳定 name。 */
const CLIENT_SIGNING_ERROR_NAME = "ClientRequestSigningV4Error";
const SIGNER_LIFECYCLE_MESSAGE_PATTERN = /request signer/i;
const SIGNER_LIFECYCLE_STATE_PATTERN = /disposed|released|closed/i;

/**
 * 识别“本地请求签名器已被销毁/关闭”家族的错误（闭源 signer 的瞬态竞态）。
 *
 * 生产链路里它被包在 AiSdkModelAdapterError 的 cause 深处，无 HTTP status；
 * 沿 cause 递归（WeakSet 防环），匹配 error.name 或消息形态
 * （`request signer` + `disposed|released|closed`）。
 */
export function isClientSigningLifecycleError(error: unknown): boolean {
  return findClientSigningLifecycleError(error) !== undefined;
}

function findClientSigningLifecycleError(
  error: unknown,
  seen = new WeakSet<object>(),
): Error | undefined {
  if (error === null || typeof error !== "object" || seen.has(error)) {
    return undefined;
  }
  seen.add(error);

  if (error instanceof Error) {
    if (error.name === CLIENT_SIGNING_ERROR_NAME) return error;
    if (
      SIGNER_LIFECYCLE_MESSAGE_PATTERN.test(error.message) &&
      SIGNER_LIFECYCLE_STATE_PATTERN.test(error.message)
    ) {
      return error;
    }
  }

  const cause = (error as { cause?: unknown }).cause;
  return cause && cause !== error ? findClientSigningLifecycleError(cause, seen) : undefined;
}

function readErrorMessage(error: unknown): string | undefined {
  const signer = findClientSigningLifecycleError(error);
  return signer?.message;
}

function normalizeProviderCode(value: ProviderBusinessError["providerCode"]): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  return normalized.toUpperCase() === PROVIDER_BUSINESS_ERROR_WRAPPER_CODE ? undefined : normalized;
}

function providerBusinessMessage(error: ProviderBusinessError): string {
  return error.providerMessage ?? error.message ?? "Provider returned a business error.";
}

function resolveProviderBusinessCode(error: ProviderBusinessError): string | undefined {
  const direct = normalizeProviderCode(error.providerCode);
  if (direct) {
    return direct;
  }

  // ProviderBusinessError 可能被 AI SDK/adapter 二次包装，外层 code 是包装类型，
  // 真实 BigModel 码（如 1234/1261）只保留在 responseBodySummary 的深层结构里。
  return readNestedProviderCode(error.responseBodySummary);
}

function resolveProviderBusinessStatusCode(
  error: ProviderBusinessError,
  statusCode: number | undefined,
): number | undefined {
  return (
    normalizeHttpFailureStatus(statusCode) ??
    normalizeHttpFailureStatus(error.statusCode) ??
    normalizeHttpFailureStatus(error.responseStatus) ??
    readNestedStatusCode(error.responseBodySummary)
  );
}

function readNestedProviderCode(value: unknown): string | undefined {
  const records = collectNestedRecords(value);
  const providerCode = firstNormalizedRecordValue(records, "providerCode");
  if (providerCode) return providerCode;

  const errorCode = firstNormalizedRecordValue(records, "error_code");
  if (errorCode) return errorCode;

  const code = firstNormalizedRecordValue(records, "code");
  if (code) return code;

  return firstBracketedProviderCode(records);
}

function readNestedStatusCode(value: unknown): number | undefined {
  const records = collectNestedRecords(value);
  for (const key of ["statusCode", "status", "responseStatus"] as const) {
    for (const record of records) {
      const statusCode = numberProperty(record, key);
      if (normalizeHttpFailureStatus(statusCode) !== undefined) {
        return statusCode;
      }
    }
  }
  return undefined;
}

function firstNormalizedRecordValue(
  records: readonly Record<string, unknown>[],
  key: string,
): string | undefined {
  for (const record of records) {
    const code = normalizeProviderCode(record[key] as ProviderBusinessError["providerCode"]);
    if (code) {
      return code;
    }
  }
  return undefined;
}

function firstBracketedProviderCode(
  records: readonly Record<string, unknown>[],
): string | undefined {
  for (const record of records) {
    const code =
      readBigModelBracketedProviderCode(record.message) ??
      readBigModelBracketedProviderCode(record.providerMessage);
    if (code) {
      return code;
    }
  }
  return undefined;
}

function collectNestedRecords(value: unknown): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const seen = new WeakSet<object>();
  const queue: unknown[] = [value];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object") {
      continue;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }

    const record = current as Record<string, unknown>;
    result.push(record);
    for (const nested of Object.values(record)) {
      if (nested && typeof nested === "object") {
        queue.push(nested);
      }
    }
  }

  return result;
}

function numberProperty(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeHttpFailureStatus(value: number | undefined): number | undefined {
  return value !== undefined && value >= 400 && value <= 599 ? value : undefined;
}

function readBigModelBracketedProviderCode(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = value.trim().match(/^\[(\d{4})\](?=\[)/);
  return match?.[1];
}
