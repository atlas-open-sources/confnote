import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import fs from "node:fs/promises";
import path from "node:path";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import defaultHandler, { createHandler } from "../api/index.js";
import type { Principal } from "../../auth/src/index.js";
import { identityRepository } from "../lib/auth-runtime.js";

// Local sign-in for this loopback server only (CONFNOTE_DEV_LOCAL_AUTH=1): any email typed on the form becomes a
// provider "local" identity in the real identity repository. Vercel runs api/index.ts, never this file.
const LOCAL_AUTH = process.env.CONFNOTE_DEV_LOCAL_AUTH === "1";
if (LOCAL_AUTH && process.env.VERCEL) throw new Error("CONFNOTE_DEV_LOCAL_AUTH is for the loopback dev server only.");
const DEV_COOKIE = "confnote_dev_user";
const EMAIL_RE = /^[^\s@<>"';=]{1,64}@[^\s@<>"';=]{1,190}$/;
const SESSION_MS = 60 * 60 * 1000;

function cookieValue(header: string | null, name: string): string | undefined {
  for (const part of (header || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}
async function localPrincipal(request: Request): Promise<Principal | null> {
  const repo = identityRepository();
  const email = cookieValue(request.headers.get("cookie"), DEV_COOKIE);
  if (!repo || !email || !EMAIL_RE.test(email)) return null;
  return repo.resolve({
    provider: "local", externalUserId: email, externalOrgId: null, providerRoles: [], permissions: [], email,
    emailVerified: true, sessionId: `local:${email}`, expiresAt: new Date(Date.now() + SESSION_MS), authMethod: "email_code",
  }, request.headers.get("x-workspace-id") || undefined);
}
function safeReturnTo(value: string | null): string {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/";
}
async function formBody(incoming: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8").slice(0, 4000));
}
/** Serves the local sign-in form, sign-in and sign-out; returns false for every other path. */
async function localAuthRoute(incoming: IncomingMessage, outgoing: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname === "/api/auth/signin" && incoming.method === "GET") {
    const returnTo = safeReturnTo(url.searchParams.get("returnTo")).replace(/"/g, "&quot;");
    outgoing.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(`<!doctype html>
<html><head><meta charset="utf-8"><title>Sign in · confnote (local)</title><style>
body{font:16px system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0}
form{display:grid;gap:12px;width:320px}input,button{font:inherit;padding:10px;border-radius:8px;border:1px solid #444;background:#1b1b1b;color:#eee}
button{background:#3a6df0;border:0;cursor:pointer}small{color:#999}</style></head>
<body><form method="post" action="/api/auth/local"><h2>Sign in to confnote</h2><small>Local development sign-in</small>
<input name="email" type="email" required autofocus placeholder="you@example.com"><input type="hidden" name="returnTo" value="${returnTo}">
<button type="submit">Continue</button></form></body></html>`);
    return true;
  }
  if (url.pathname === "/api/auth/local" && incoming.method === "POST") {
    const body = await formBody(incoming);
    const email = (body.get("email") || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) { outgoing.writeHead(400, { "Content-Type": "text/plain" }).end("Invalid email"); return true; }
    outgoing.writeHead(302, {
      "Set-Cookie": `${DEV_COOKIE}=${encodeURIComponent(email)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}`,
      Location: safeReturnTo(body.get("returnTo")),
    }).end();
    return true;
  }
  if (url.pathname === "/api/auth/signout" && incoming.method === "POST") {
    outgoing.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": `${DEV_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` })
      .end(JSON.stringify({ logoutUrl: "/" }));
    return true;
  }
  return false;
}

const handler = LOCAL_AUTH ? createHandler({ principal: localPrincipal }) : defaultHandler;
const root = path.resolve(import.meta.dirname, "../public");
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
// Optional TLS (CONFNOTE_DEV_TLS_KEY/CERT file paths): the Router's checkout only accepts https return URLs.
const tlsKey = process.env.CONFNOTE_DEV_TLS_KEY;
const tlsCert = process.env.CONFNOTE_DEV_TLS_CERT;
const tls = tlsKey && tlsCert ? { key: await fs.readFile(tlsKey), cert: await fs.readFile(tlsCert) } : undefined;
const listener = async (incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> => {
  const url = new URL(incoming.url || "/", "http://127.0.0.1");
  try {
    if (LOCAL_AUTH && await localAuthRoute(incoming, outgoing, url)) return;
    if (url.pathname.startsWith("/api/") || url.pathname === "/llms.txt" || url.pathname === "/.well-known/confnote-auth") {
      const req = incoming as VercelRequest;
      req.query = Object.fromEntries(url.searchParams);
      if (url.pathname === "/llms.txt") req.query.route = "catalogue/llms.txt";
      if (url.pathname === "/.well-known/confnote-auth") req.query.route = "auth/discovery";
      const res = outgoing as VercelResponse;
      res.status = function status(code) { outgoing.statusCode = code; return res; };
      res.json = function json(body) { outgoing.setHeader("Content-Type", "application/json"); outgoing.end(JSON.stringify(body)); return res; };
      res.send = function send(body) { outgoing.end(body); return res; };
      await handler(req, res);
      return;
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const file = path.resolve(root, relative.endsWith("/") || !relative ? `${relative}index.html` : relative);
    if (!file.startsWith(`${root}${path.sep}`)) { outgoing.writeHead(403).end(); return; }
    const body = await fs.readFile(file);
    outgoing.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" }).end(body);
  } catch {
    outgoing.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Not found" }));
  }
};
const server = tls ? createHttpsServer(tls, listener) : createServer(listener);
server.listen(Number(process.env.PORT || 8790), "127.0.0.1", () => { console.log(`confnote fixture server ${JSON.stringify(server.address())}${LOCAL_AUTH ? " (local sign-in)" : ""}`); });
