import { WalletError, type Reservation, type Usage, type Wallet } from "./index.js";
export type SettlementReason = "finish" | "cancel" | "error" | "timeout" | "unknown";
export interface SettlementRuntime {
  retain?: (promise: Promise<unknown>) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  reportFailure?: (error: unknown) => void;
}
const RETRY_DELAYS = [250, 1000];
export function knownPreAcceptanceRejection(error: unknown): boolean {
  // A transport error or an abort after sending is ambiguous and must capture.
  if (!error || typeof error !== "object" || !("statusCode" in error)) return false;
  return [400, 401, 402, 403, 404, 413, 422, 429].includes(Number(error.statusCode));
}
async function retry<T>(action: () => Promise<T>, runtime: SettlementRuntime): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await action(); }
    catch (error) {
      if (attempt >= RETRY_DELAYS.length || (error instanceof WalletError && error.status < 500 && error.status !== 429)) throw error;
      await (runtime.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(RETRY_DELAYS[attempt]);
    }
  }
}
export interface ModelCallReservation {
  hold: Reservation;
  settle(reason: SettlementReason, usage?: Usage): Promise<void>;
  release(): Promise<void>;
}
export async function reserveModelCall(wallet: Wallet, input: Parameters<Wallet["reserve"]>[0], runtime: SettlementRuntime = {}): Promise<ModelCallReservation> {
  const hold = await wallet.reserve(input);
  let terminal: Promise<void> | undefined;
  function retain(action: () => Promise<unknown>): Promise<void> {
    if (terminal) return terminal;
    terminal = retry(action, runtime).then(() => undefined);
    // Register immediately, before the response can close or the model stream aborts.
    const background = terminal.catch((error) => { runtime.reportFailure?.(error); });
    runtime.retain?.(background);
    return terminal;
  }
  const call: ModelCallReservation = {
    hold,
    settle(reason, usage) {
      const payload: Parameters<Wallet["settle"]>[0] = {
        userId: input.userId, holdId: hold.holdId, idempotencyKey: `${input.idempotencyKey}:settle`,
        usage: usage || input.usage, settlementKind: usage ? "actual" : "estimated", reason,
      };
      return retain(() => wallet.settle(payload));
    },
    release() { return retain(() => wallet.release({ userId: input.userId, holdId: hold.holdId, idempotencyKey: `${input.idempotencyKey}:release` })); },
  };
  if (hold.expiryPolicy !== "capture") {
    await call.release();
    throw new WalletError(503, { error: "capture_policy_required" });
  }
  return call;
}
