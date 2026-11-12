import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { AuthProvider, Principal } from "../../auth/src/index.js";
import { authProvider, authenticatedPrincipal, identityRepository } from "./auth-runtime.js";
import { publicOrigin } from "./public-origin.js";
import { json, one } from "./http.js";

export async function webRequest(req: VercelRequest, rawOnly = false): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) { if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value); }
  let body: string | undefined;
  if (!["GET", "HEAD"].includes(req.method || "GET")) {
    if (!rawOnly && req.body !== undefined) body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    else {
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; if (length > 2_000_000) throw new Error("Request too large"); chunks.push(Buffer.from(chunk)); }
      body = Buffer.concat(chunks).toString("utf8");
      if (body && !rawOnly) req.body = JSON.parse(body);
      if (rawOnly && !body) throw new Error("Raw webhook body unavailable");
    }
  }
  if (body && Buffer.byteLength(body) > 2_000_000) throw new Error("Request too large");
  const origin = publicOrigin() || "http://127.0.0.1";
  return new Request(new URL(req.url || "/", origin), { method: req.method, headers, body });
}
export function sameOrigin(request: Request): boolean {
  const origin = publicOrigin();
  return Boolean(origin && request.headers.get("origin") === origin);
}
async function sendResponse(res: VercelResponse, response: Response, provider: AuthProvider): Promise<void> {
  res.status(response.status);
  response.headers.forEach((value, name) => res.setHeader(name, value));
  const cookies = provider.responseCookies(); if (cookies.length) res.setHeader("Set-Cookie", cookies);
  res.send(await response.text());
}
export async function authRoute(req: VercelRequest, res: VercelResponse, route: string, request: Request): Promise<boolean> {
  if (!route.startsWith("auth/")) return false;
  const provider = authProvider();
  if (!provider) { json(res, 503, { error: "Authentication is not configured." }); return true; }
  if (route === "auth/discovery" && req.method === "GET") { json(res, 200, provider.nativeConfig()); return true; }
  if (route === "auth/signin" && req.method === "GET") {
    const url = await provider.signInUrl({ returnTo: one(req.query.returnTo) || "/catalogue/" });
    const cookies = provider.responseCookies(); if (cookies.length) res.setHeader("Set-Cookie", cookies);
    res.status(302).setHeader("Location", url).end(); return true;
  }
  if (route === "auth/callback" && req.method === "GET") { await sendResponse(res, await provider.handleCallback(request), provider); return true; }
  if (route === "auth/webhook" && req.method === "POST") {
    const repository = identityRepository(); if (!repository) { json(res, 503, { error: "Identity store is not configured." }); return true; }
    try { await repository.ingest(provider.id, await provider.parseWebhook(request)); json(res, 200, { ok: true }); } catch { json(res, 401, { error: "Invalid auth webhook" }); }
    return true;
  }
  if (!sameOrigin(request)) { json(res, 403, { error: "Same-origin request required." }); return true; }
  if (route === "auth/signout" && req.method === "POST") {
    const response = await provider.signOut(request);
    const cookies = provider.responseCookies(); if (cookies.length) res.setHeader("Set-Cookie", cookies);
    json(res, 200, { logoutUrl: response.headers.get("Location") || "/" }); return true;
  }
  if (route === "auth/switch-org" && req.method === "POST") {
    const principal = await authenticatedPrincipal(provider, request);
    if (!principal) { json(res, 401, { error: "Sign in required." }); return true; }
    const externalOrgId = (req.body as { externalOrgId?: unknown })?.externalOrgId;
    if (typeof externalOrgId !== "string" || externalOrgId.length > 200) { json(res, 400, { error: "Invalid organization" }); return true; }
    await sendResponse(res, await provider.switchOrg(request, externalOrgId), provider); return true;
  }
  json(res, 405, { error: "Method not allowed" }); return true;
}
export async function requestPrincipal(request: Request, res: VercelResponse): Promise<Principal | null> {
  const provider = authProvider();
  if (!provider) return null;
  const principal = await authenticatedPrincipal(provider, request);
  const cookies = provider.responseCookies(); if (cookies.length) res.setHeader("Set-Cookie", cookies);
  return principal;
}
