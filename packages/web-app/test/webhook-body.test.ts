import { Readable } from "node:stream";
import type { VercelRequest } from "@vercel/node";
import { expect, it } from "vitest";
import { webRequest } from "../lib/web-auth.js";
import { webSearch } from "../lib/webResearch.js";
it("preserves raw signed webhook whitespace even when a helper body property exists", async () => {
  const raw = '{  "id": "evt-fixture",\n "data": { "x": 1 } }\n';
  const req = Object.assign(Readable.from([Buffer.from(raw)]), { method: "POST", url: "/api/auth/webhook", headers: { "content-type": "application/json" }, body: { id: "reserialized-wrong" } });
  expect(await (await webRequest(req as unknown as VercelRequest, true)).text()).toBe(raw);
});
it("refuses verification when raw bytes have already been consumed", async () => {
  const req = Object.assign(Readable.from([]), { method: "POST", url: "/api/auth/webhook", headers: {}, body: { id: "fixture" } });
  await expect(webRequest(req as unknown as VercelRequest, true)).rejects.toThrow("Raw webhook body unavailable");
});
it("paid search is disabled without explicit operator opt-in", async () => {
  const { vi } = await import("vitest"); vi.stubEnv("CONFNOTE_PAID_SEARCH_ENABLED", "");
  const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
  try { expect(await webSearch("fixture")).toMatchObject({ error: expect.stringContaining("disabled") }); expect(fetcher).not.toHaveBeenCalled(); }
  finally { fetcher.mockRestore(); vi.unstubAllEnvs(); }
});
