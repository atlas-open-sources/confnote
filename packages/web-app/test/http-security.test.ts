import { afterEach, describe, expect, it, vi } from "vitest";
import { publicOrigin } from "../lib/public-origin.js";
import { context } from "../lib/http.js";
import { sendWaitlistConfirmation } from "../lib/email.js";

afterEach(() => vi.unstubAllEnvs());
describe("public URL trust", () => {
  it("never derives email origins from forwarding headers", () => {
    vi.stubEnv("CONFNOTE_PUBLIC_BASE_URL", "");
    const req = { headers: { host: "attacker.test", "x-forwarded-host": "attacker.test", "x-forwarded-proto": "https" } };
    expect(context(req).origin).toBeUndefined();
    vi.stubEnv("CONFNOTE_PUBLIC_BASE_URL", "https://events.example.test");
    expect(context(req).origin).toBe("https://events.example.test");
  });
  it("rejects non-origin, credential-bearing and insecure public URLs", () => {
    for (const url of ["http://example.test", "https://user:pass@example.test", "https://example.test/path", "javascript:alert(1)"]) expect(() => publicOrigin(url)).toThrow();
    expect(publicOrigin("http://127.0.0.1:8790")).toBe("http://127.0.0.1:8790");
  });
  it("keeps confirmation content free of caller-supplied prose", async () => {
    vi.stubEnv("CONFNOTE_EMAIL_MODE", "log");
    const result = await sendWaitlistConfirmation({ email: "fixture@example.test", name: "BUY THIS ATTACKER LINK", unsubscribeUrl: "https://events.example.test/remove?token=fixture" });
    expect(result.message?.text).not.toContain("ATTACKER");
    expect(result.message?.html).not.toContain("ATTACKER");
  });
});
it("deduplicates concurrent waitlist sends per recipient before email delivery", async () => {
  const { localWaitlistLimit } = await import("../lib/waitlist-limit.js");
  vi.stubEnv("RESEND_API_KEY", ""); vi.stubEnv("CONFNOTE_EMAIL_MODE", "log");
  const results = await Promise.all(Array.from({ length: 10 }, () => localWaitlistLimit("fixture-concurrent-recipient", 1, 60)));
  expect(results.filter(Boolean)).toHaveLength(1);
});
