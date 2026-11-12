import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

// Hosted transcription is locked (musa, 2026-11-11): the page shows the Transcript tab locked, explains that it runs on
// device in the confnote Mac app with Local AI Cat, and takes pasted transcripts through the note API. The server says
// so and never takes audio. tests/e2e/test_browser_transcribe.py answers the page with these same payloads.
afterEach(() => vi.unstubAllEnvs());

async function call(method: string, route: string, body?: unknown) {
  const { createHandler } = await import("../api/index.js");
  const handler = createHandler({ principal: async () => ({ userId: "u", workspaceId: "transcribe-fixture", email: "fixture@example.test", emailVerified: true, role: "owner", authMethod: "email_code", sessionId: "s" }) });
  let status = 0;
  let payload: unknown;
  const req = Object.assign(new EventEmitter(), { method, url: `/api/${route}`, query: {}, headers: { origin: "https://fixture.test", "content-type": "application/json" }, body });
  const res = Object.assign(new EventEmitter(), {
    status(code: number) { status = code; return this; },
    setHeader() { return this; },
    json(value: unknown) { payload = value; return this; },
    send() { return this; }, end() { return this; },
  });
  await handler(req as unknown as Parameters<typeof handler>[0], res as unknown as Parameters<typeof handler>[1]);
  return { status, payload: payload as Record<string, unknown> };
}

async function withServer(run: () => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "confnote-transcribe-"));
  vi.stubEnv("CONFNOTE_STORAGE", "fs"); vi.stubEnv("CONFNOTE_WEB_DATA_DIR", root); vi.stubEnv("CONFNOTE_PUBLIC_DEMO", "0");
  vi.stubEnv("CONFNOTE_PUBLIC_BASE_URL", "https://fixture.test"); vi.stubEnv("CONFNOTE_DATABASE_URL", "");
  vi.resetModules();
  try { await run(); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

it("tells the page that hosted transcription is locked, with no provider, key or Local AI Cat", async () => {
  await withServer(async () => {
    const status = await call("GET", "transcription/status");
    expect(status.status).toBe(200);
    expect(status.payload).toMatchObject({ browser: true, locked: true, available: false, can_record: false });
    expect(String(status.payload.detail)).toContain("confnote Mac app");
    const settings = await call("GET", "settings");
    expect(settings.status).toBe(200);
    expect(settings.payload).toMatchObject({
      web: true,
      transcription: { browser: true, locked: true, provider: "none", has_api_key: false },
    });
    // Neither a Local AI Cat address nor OpenAI: nothing on the hosted page transcribes.
    expect(JSON.stringify(settings.payload)).not.toContain("11434");
    expect(JSON.stringify(settings.payload)).not.toContain("openai");
    const test = await call("POST", "settings/test", {});
    expect(test.status).toBe(200);
    expect(test.payload).toMatchObject({ ok: false, browser: true, locked: true });
  });
});

it.each(["transcription/file", "transcription/record/start", "transcription/record/stop"])("refuses audio at %s: it never reaches confnote's servers", async (route) => {
  await withServer(async () => {
    const result = await call("POST", route, { filename: "talk.webm", mime: "audio/webm", data: "data:audio/webm;base64,ZmFrZQ==" });
    expect(result.status).toBe(404);
    expect(String(result.payload.error)).toContain("never goes to confnote's servers");
  });
});
