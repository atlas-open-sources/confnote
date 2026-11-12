import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { uploadAsset } from "../lib/service.js";
import type { StorageAdapter } from "../lib/storage.js";

afterEach(() => { vi.unstubAllEnvs(); });

function recordingStorage(types: string[]): StorageAdapter {
  return {
    async writeBytes(_pathname: string, _bytes: Uint8Array, contentType: string) { types.push(contentType); return { text: "", mtime: 0 }; },
  } as unknown as StorageAdapter;
}

it("stores only media and PDF upload types; HTML and SVG become plain bytes", async () => {
  const types: string[] = [];
  const ctx = { workspace: "asset-fixture", storage: recordingStorage(types) };
  const slug = "2099-01-01-fixture";
  for (const type of ["text/html", "image/svg+xml", "IMAGE/PNG", "application/pdf"]) {
    await uploadAsset(ctx, slug, "0900-keynote.md", { filename: "x.bin", data: `data:${type};base64,PGI+` });
  }
  expect(types).toEqual(["application/octet-stream", "application/octet-stream", "image/png", "application/pdf"]);
});

it("serves a note attachment with a sandbox CSP so it cannot script the app origin", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "confnote-asset-"));
  vi.stubEnv("CONFNOTE_STORAGE", "fs"); vi.stubEnv("CONFNOTE_WEB_DATA_DIR", root); vi.stubEnv("CONFNOTE_PUBLIC_DEMO", "0");
  vi.stubEnv("CONFNOTE_PUBLIC_BASE_URL", "https://fixture.test"); vi.stubEnv("CONFNOTE_DATABASE_URL", "");
  vi.resetModules();
  try {
    const { createHandler } = await import("../api/index.js");
    const workspace = "asset-fixture";
    const slug = "2099-01-01-fixture";
    const file = path.join(root, workspace, slug, "notes", "assets", "0900-keynote", "x.svg");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
    const handler = createHandler({ principal: async () => ({ userId: "u", workspaceId: workspace, email: "fixture@example.test", emailVerified: true, role: "owner", authMethod: "email_code", sessionId: "s" }) });
    const headers: Record<string, string> = {};
    let status = 0;
    const req = Object.assign(new EventEmitter(), { method: "GET", url: `/api/asset?slug=${slug}&path=assets/0900-keynote/x.svg`, query: { slug, path: "assets/0900-keynote/x.svg" }, headers: {} });
    const res = Object.assign(new EventEmitter(), {
      status(code: number) { status = code; return this; },
      setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; return this; },
      send() { return this; }, json() { return this; }, end() { return this; },
    });
    await handler(req as unknown as Parameters<typeof handler>[0], res as unknown as Parameters<typeof handler>[1]);
    expect(status).toBe(200);
    expect(headers["content-type"]).toBe("image/svg+xml");
    expect(headers["content-security-policy"]).toMatch(/^sandbox;/);
    expect(headers["x-content-type-options"]).toBe("nosniff");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("refuses to be framed (clickjacking of the notebook and the wallet controls)", async () => {
  const config = JSON.parse(await fs.readFile(path.join(import.meta.dirname, "..", "vercel.json"), "utf8")) as { headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }> };
  const everything = config.headers.find((rule) => rule.source === "/(.*)");
  expect(everything?.headers).toContainEqual({ key: "X-Frame-Options", value: "DENY" });
});
