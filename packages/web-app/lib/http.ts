import type { Principal } from "../../auth/src/index.js";
import { publicOrigin } from "./public-origin.js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { RequestContext } from "./types.js";

export function context(_req: Pick<VercelRequest, "headers">, principal?: Principal | null): RequestContext {
  const publicDemo = process.env.CONFNOTE_PUBLIC_DEMO !== "0";
  return {
    workspace: publicDemo ? "public-demo" : principal?.workspaceId || "unauthenticated",
    publicDemo,
    origin: publicOrigin(),
    principal: principal || undefined,
  };
}

export function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

export function json(res: VercelResponse, status: number, payload: unknown): void {
  res.status(status).setHeader("Cache-Control", "no-store").json(payload);
}

// A note's attachment is user content (an upload, a shared vault, a workspace co-member). Opened on its own it must
// not run script on the app's origin. PDFs are left out: a sandboxed PDF does not render in Chrome or WebKit.
const ASSET_SANDBOX_CSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";
export function assetHeaders(contentType: string): Record<string, string> {
  const headers: Record<string, string> = { "X-Content-Type-Options": "nosniff" };
  if (contentType !== "application/pdf") headers["Content-Security-Policy"] = ASSET_SANDBOX_CSP;
  return headers;
}

export function method(res: VercelResponse): void {
  json(res, 405, { error: "method not allowed" });
}

export function disabled(res: VercelResponse, feature: string): void {
  json(res, 501, { error: "disabled", feature });
}

export function textEventStream(res: VercelResponse, message: string): void {
  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.write(`${JSON.stringify({ text: message })}\n`);
  res.write(`${JSON.stringify({ done: true })}\n`);
  res.end();
}
