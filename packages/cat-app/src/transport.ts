// ConfNote's page asks `fetch("/api/…")`; inside the Cat there is no server and no network
// (connect-src 'none'). This answers those requests in the page through the router, and the
// drawer's module list with an empty one (no Concierge in v1). Anything else is refused.
import { type CatBridge, CatBridgeStorage, useStorage } from "./cat-storage.js";
import { handle } from "./router.js";

const EMPTY_MODULES = { slots: [], primitive_override: {} };

function requestURL(input: RequestInfo | URL): URL {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return new URL(raw, "https://confnote.cat/");
}

async function requestBody(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined);
  if (raw === undefined || raw === null || raw === "") return undefined;
  const text = typeof raw === "string" ? raw : await new Response(raw as BodyInit).text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/// The page's fetch, answered without a network. `path` is the request's path with any
/// `/api/` prefix and trailing slash removed, like the Vercel handler's `routePath`.
export async function catFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = requestURL(input);
  const path = url.pathname.replace(/^\/+/, "");
  if (path === "modules.config.json") return json(200, EMPTY_MODULES);
  if (!path.startsWith("api/")) return json(404, { error: "ConfNote in the Cat has no network" });
  const method = init?.method || (input instanceof Request ? input.method : "GET");
  try {
    const response = await handle({
      method,
      route: path.slice("api/".length).replace(/\/+$/, ""),
      query: url.searchParams,
      body: await requestBody(input, init),
    });
    return json(response.status, response.body);
  } catch (error) {
    return json(500, { error: error instanceof Error ? error.message : String(error) });
  }
}

declare global {
  interface Window {
    cat?: CatBridge;
    confnote?: Record<string, unknown>;
  }
}

/// Installs the transport. Outside the Cat (no `window.cat`) it does nothing, so the
/// bundle is inert in a browser tab.
export function install(target: Window = window): boolean {
  if (!target.cat) return false;
  useStorage(new CatBridgeStorage(target.cat));
  target.fetch = catFetch;
  return true;
}

if (typeof window !== "undefined") install();
