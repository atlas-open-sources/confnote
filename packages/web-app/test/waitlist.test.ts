import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addWaitlistSignup, removeWaitlistSignup } from "../lib/waitlist.js";
import type { RequestContext } from "../lib/types.js";

const dataRoot = path.resolve(import.meta.dirname, "..", ".data");

function workspace(prefix: string): RequestContext {
  return {
    workspace: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    origin: "https://preview.confnote.test",
    publicDemo: true,
  };
}

async function readJsonl(file: string): Promise<Array<Record<string, unknown>>> {
  const text = await fs.readFile(file, "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("waitlist signup", () => {
  it("records consent, logs a confirmation email, and accepts the unsubscribe token", async () => {
    const previousMode = process.env.CONFNOTE_EMAIL_MODE;
    const previousKey = process.env.RESEND_API_KEY;
    process.env.CONFNOTE_EMAIL_MODE = "log";
    delete process.env.RESEND_API_KEY;
    const ctx = workspace("waitlist");

    const result = await addWaitlistSignup(ctx, {
      email: "Ada+Confnote@Example.COM",
      name: "Ada",
      note: "Conference notes",
      source: "test",
      consent: "Email me confnote updates. I can unsubscribe any time.",
    });

    process.env.CONFNOTE_EMAIL_MODE = previousMode || "";
    if (!previousMode) delete process.env.CONFNOTE_EMAIL_MODE;
    if (previousKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousKey;

    expect(result).toMatchObject({ ok: true, email: { mode: "log" } });

    const waitlistPath = path.join(dataRoot, ctx.workspace, ".confnote", "waitlist.jsonl");
    const outboxPath = path.join(dataRoot, ctx.workspace, ".confnote", "outbox.jsonl");
    const waitlist = await readJsonl(waitlistPath);
    const outbox = await readJsonl(outboxPath);
    const signup = waitlist[0];
    const message = outbox[0].message as { to: string; text: string; html: string };

    expect(signup).toMatchObject({
      event: "signup",
      email: "ada+confnote@example.com",
      consent: "Email me confnote updates. I can unsubscribe any time.",
    });
    expect(signup.unsubscribe_token_hash).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(message.to).toBe("ada+confnote@example.com");
    expect(message.html).toContain("unsubscribe");

    const token = /token=([^ \n]+)/.exec(message.text)?.[1];
    expect(token).toBeTruthy();
    expect(JSON.stringify(signup)).not.toContain(token);

    await expect(removeWaitlistSignup(ctx, token || "")).resolves.toEqual({ ok: true });
    const updatedWaitlist = await readJsonl(waitlistPath);
    expect(updatedWaitlist[1]).toMatchObject({
      event: "removed",
      email: "ada+confnote@example.com",
      unsubscribe_token_hash: signup.unsubscribe_token_hash,
    });
    // Replaying the public link is idempotent: the log does not grow.
    await expect(removeWaitlistSignup(ctx, token || "")).resolves.toEqual({ ok: true });
    await expect(removeWaitlistSignup(ctx, token || "")).resolves.toEqual({ ok: true });
    expect(await readJsonl(waitlistPath)).toHaveLength(updatedWaitlist.length);
  });

  it("rejects invalid email addresses before writing", async () => {
    const ctx = workspace("waitlist-invalid");
    await expect(addWaitlistSignup(ctx, { email: "nope" })).resolves.toEqual({
      ok: false,
      error: "Enter a valid email address.",
    });
  });
});
