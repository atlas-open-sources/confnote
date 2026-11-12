import { randomUUID } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import type {
  LanguageModelV3,
  LanguageModelV3Usage,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { RouterWallet, WalletError, type Usage, type Wallet } from "../../billing/src/index.js";
import {
  reserveModelCall,
  knownPreAcceptanceRejection,
  type SettlementReason,
  type SettlementRuntime,
} from "../../billing/src/model-call.js";
export function configuredWallet(): RouterWallet | undefined {
  const url = process.env.CONFNOTE_ROUTER_URL;
  const token = process.env.CONFNOTE_ROUTER_SERVICE_TOKEN;
  return url && token ? new RouterWallet(url, token) : undefined;
}
export function actualUsage(usage: LanguageModelV3Usage): Usage {
  const input = usage.inputTokens.total;
  const output = usage.outputTokens.total;
  if (
    input === undefined ||
    output === undefined ||
    !Number.isSafeInteger(input) ||
    !Number.isSafeInteger(output) ||
    input < 0 ||
    output < 0
  ) {
    throw new Error("Provider did not report billable usage");
  }
  const cachedInputTokens = usage.inputTokens.cacheRead || 0;
  const cacheWriteTokens = usage.inputTokens.cacheWrite || 0;
  if (
    ![cachedInputTokens, cacheWriteTokens].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    cachedInputTokens + cacheWriteTokens > input
  ) {
    throw new Error("Provider reported invalid cache usage");
  }
  return { inputTokens: input, outputTokens: output, cachedInputTokens, cacheWriteTokens };
}
function reportedUsage(value: unknown): Usage | undefined {
  try {
    return actualUsage(value as LanguageModelV3Usage);
  } catch {
    return undefined;
  }
}
function maximumUsage(params: LanguageModelV3CallOptions): Usage {
  if (
    params.prompt.some(
      (message) =>
        Array.isArray(message.content) && message.content.some((part) => part.type === "file"),
    )
  ) {
    throw new Error("Use BYOK for media requests");
  }
  const bytes = new TextEncoder().encode(
    JSON.stringify({ prompt: params.prompt, tools: params.tools }),
  ).length;
  return {
    inputTokens: bytes + 4096,
    outputTokens: Math.min(params.maxOutputTokens || 1400, 1400),
  };
}
function terminalReason(signal?: AbortSignal): SettlementReason {
  if (signal?.aborted) {
    return signal.reason?.name === "TimeoutError" ? "timeout" : "cancel";
  }
  return "error";
}
function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("Model call aborted", "AbortError");
}
async function providerResult<T>(
  promise: PromiseLike<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(abortError(signal));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
    }
    timer = setTimeout(
      () => reject(new DOMException("Model call timed out", "TimeoutError")),
      timeoutMs,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, interrupted]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (abort) {
      signal?.removeEventListener("abort", abort);
    }
  }
}
const defaultRuntime: SettlementRuntime = {
  retain: waitUntil,
  reportFailure(error) {
    console.warn("wallet_settlement_failed", {
      status: error instanceof WalletError ? error.status : "transport_error",
    });
  },
};
export interface WalletMiddlewareOptions extends SettlementRuntime {
  timeoutMs?: number;
}
export function walletMiddleware(
  wallet: Wallet,
  userId: string,
  modelId: string,
  options: WalletMiddlewareOptions = {},
): LanguageModelMiddleware {
  const runtime = { ...defaultRuntime, ...options };
  const reserve = (params: LanguageModelV3CallOptions) =>
    reserveModelCall(
      wallet,
      { userId, modelId, idempotencyKey: randomUUID(), usage: maximumUsage(params) },
      runtime,
    );
  return {
    specificationVersion: "v3",
    async wrapGenerate({ doGenerate, params }) {
      const call = await reserve(params);
      if (params.abortSignal?.aborted) {
        await call.release();
        throw abortError(params.abortSignal);
      }
      let usage: Usage | undefined;
      let rejected = false;
      let reason: SettlementReason = "error";
      try {
        const result = await providerResult(
          doGenerate(),
          params.abortSignal,
          options.timeoutMs ?? 25000,
        );
        usage = reportedUsage(result.usage);
        reason = "finish";
        return result;
      } catch (error) {
        rejected = knownPreAcceptanceRejection(error);
        reason =
          error instanceof Error && error.name === "TimeoutError"
            ? "timeout"
            : terminalReason(params.abortSignal);
        throw error;
      } finally {
        if (rejected) {
          await call.release();
        } else {
          await call.settle(reason, usage);
        }
      }
    },
    async wrapStream({ doStream, params }) {
      const call = await reserve(params);
      if (params.abortSignal?.aborted) {
        await call.release();
        throw abortError(params.abortSignal);
      }
      let result: Awaited<ReturnType<typeof doStream>>;
      try {
        result = await providerResult(doStream(), params.abortSignal, options.timeoutMs ?? 25000);
      } catch (error) {
        if (knownPreAcceptanceRejection(error)) {
          await call.release();
        } else {
          await call.settle(
            error instanceof Error && error.name === "TimeoutError"
              ? "timeout"
              : terminalReason(params.abortSignal),
          );
        }
        throw error;
      }
      const reader = result.stream.getReader();
      let usage: Usage | undefined;
      let closed = false;
      let controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>;
      let timer: ReturnType<typeof setTimeout> | undefined;
      function cleanup(): void {
        if (timer) {
          clearTimeout(timer);
        }
        params.abortSignal?.removeEventListener("abort", onAbort);
      }
      function terminate(reason: SettlementReason, error: Error): void {
        if (closed) {
          return;
        }
        closed = true;
        cleanup();
        const settlement = call.settle(reason, usage);
        void reader.cancel(error).catch(() => {});
        controller.error(error);
        void settlement.catch(() => {}); // waitUntil owns retries and redacted failure reporting.
      }
      function onAbort(): void {
        terminate(terminalReason(params.abortSignal), abortError(params.abortSignal));
      }
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(value) {
          controller = value;
          timer = setTimeout(
            () => terminate("timeout", new DOMException("Model call timed out", "TimeoutError")),
            options.timeoutMs ?? 25000,
          );
          timer.unref?.();
          params.abortSignal?.addEventListener("abort", onAbort, { once: true });
          if (params.abortSignal?.aborted) {
            onAbort();
          }
        },
        async pull(value) {
          if (closed) {
            return;
          }
          try {
            const chunk = await reader.read();
            if (closed) {
              return;
            }
            if (chunk.done) {
              closed = true;
              cleanup();
              await call.settle("unknown", usage);
              value.close();
              return;
            }
            if ("usage" in chunk.value) {
              usage = reportedUsage(chunk.value.usage) || usage;
            }
            if (chunk.value.type === "finish" || chunk.value.type === "error") {
              cleanup();
              await call.settle(chunk.value.type === "finish" ? "finish" : "error", usage);
            }
            value.enqueue(chunk.value);
            if (chunk.value.type === "error" || chunk.value.type === "finish") {
              closed = true;
              void reader.cancel().catch(() => {});
              value.close();
            }
          } catch (error) {
            if (closed) {
              return;
            }
            closed = true;
            cleanup();
            void reader.cancel(error).catch(() => {});
            try {
              await call.settle(terminalReason(params.abortSignal), usage);
            } finally {
              value.error(error);
            }
          }
        },
        async cancel(reason) {
          if (closed) {
            return;
          }
          closed = true;
          cleanup();
          const settlement = call.settle("cancel", usage);
          void reader.cancel(reason).catch(() => {});
          await settlement;
        },
      });
      return { ...result, stream };
    },
  };
}
export function meteredModel(
  model: LanguageModelV3,
  userId: string | undefined,
  modelId: string,
): LanguageModelV3 {
  const wallet = configuredWallet();
  if (!wallet || !userId) {
    throw new Error("Platform credits are unavailable. Add your own provider key.");
  }
  return wrapLanguageModel({ model, middleware: walletMiddleware(wallet, userId, modelId) });
}
