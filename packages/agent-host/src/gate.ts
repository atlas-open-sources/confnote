import { createHash } from "node:crypto";

// Who may start a turn. Tonight there is no host-specific secret (that needs musa's auth script), so the gate asks
// the Router whether the caller's bearer is real with one cheap authenticated call (GET /v1/wallet/packs: no user,
// no spend) and caches the answer. Nothing is spawned and no turn slot is taken until the bearer passes.

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number }>;

const CHECK_PATH = "/v1/wallet/packs";
const CHECK_TIMEOUT_MS = 5_000;
const MAX_CACHED = 1_000;

export interface BearerGate {
  allows(token: string): Promise<boolean>;
}

export function bearerGate(options: { routerBase: string; fetcher?: Fetcher; ttlMs?: number; now?: () => number }): BearerGate {
  const fetcher: Fetcher = options.fetcher || ((url, init) => fetch(url, init));
  const ttlMs = options.ttlMs ?? 60_000;
  const now = options.now || Date.now;
  // Keyed by a hash so the cache never holds a token; failures are cached too, so a guesser costs one Router call a minute.
  const cache = new Map<string, { ok: boolean; until: number }>();
  const inFlight = new Map<string, Promise<boolean>>();

  async function check(token: string): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    try {
      const response = await fetcher(`${options.routerBase}${CHECK_PATH}`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      return response.status >= 200 && response.status < 300;
    } catch {
      return false; // Router unreachable: fail closed.
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async allows(token) {
      const key = createHash("sha256").update(token).digest("hex");
      const hit = cache.get(key);
      if (hit && hit.until > now()) return hit.ok;
      const running = inFlight.get(key);
      if (running) return running;
      const pending = check(token).then((ok) => {
        if (cache.size >= MAX_CACHED) cache.clear();
        cache.set(key, { ok, until: now() + ttlMs });
        inFlight.delete(key);
        return ok;
      });
      inFlight.set(key, pending);
      return pending;
    },
  };
}

/** Open sockets per client address; the ingress puts the client first in x-forwarded-for. */
export class AddressCap {
  private readonly open = new Map<string, number>();
  constructor(private readonly max: number) {}

  take(address: string): boolean {
    const count = this.open.get(address) || 0;
    if (count >= this.max) return false;
    this.open.set(address, count + 1);
    return true;
  }

  give(address: string): void {
    const count = (this.open.get(address) || 1) - 1;
    if (count <= 0) this.open.delete(address);
    else this.open.set(address, count);
  }
}

export function clientAddress(forwardedFor: string | string[] | undefined, remote: string | undefined): string {
  const header = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  const first = (header || "").split(",")[0].trim();
  return first || remote || "unknown";
}
