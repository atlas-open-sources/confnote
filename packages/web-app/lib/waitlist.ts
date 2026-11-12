import { emailBucket, localWaitlistLimit, type ConsumeLimit } from "./waitlist-limit.js";
import { createHash, randomBytes } from "node:crypto";
import { sendWaitlistConfirmation } from "./email.js";
import { createStorage, storageKey } from "./storage.js";
import type { RequestContext } from "./types.js";
const storage = createStorage();
const WAITLIST_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function key(ctx: RequestContext, ...parts: string[]): string { return storageKey(ctx.workspace, ...parts); }
function cleanWaitlistString(value: unknown, max: number): string {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function waitlistTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function waitlistUnsubscribeUrl(ctx: RequestContext, token: string): string {
  if (!ctx.origin) throw new Error("CONFNOTE_PUBLIC_BASE_URL is required for confirmation emails.");
  const base = ctx.origin;
  const url = new URL("/api/waitlist/remove", base);
  url.searchParams.set("token", token);
  return url.toString();
}

async function appendWaitlistEvent(ctx: RequestContext, entry: Record<string, unknown>) {
  const pathname = key(ctx, ".confnote", "waitlist.jsonl");
  const current = (await storage.readText(pathname))?.text || "";
  await storage.writeText(pathname, `${current}${JSON.stringify(entry)}\n`);
}

async function appendOutboxEmail(ctx: RequestContext, entry: Record<string, unknown>) {
  const pathname = key(ctx, ".confnote", "outbox.jsonl");
  const current = (await storage.readText(pathname))?.text || "";
  await storage.writeText(pathname, `${current}${JSON.stringify(entry)}\n`);
}

export async function addWaitlistSignup(ctx: RequestContext, payload: unknown, consume: ConsumeLimit = localWaitlistLimit) {
  const body = payload as { email?: unknown; name?: unknown; note?: unknown; source?: unknown; consent?: unknown };
  const email = cleanWaitlistString(body.email, 254).toLowerCase();
  if (!WAITLIST_EMAIL_RE.test(email)) {
    return { ok: false, error: "Enter a valid email address." };
  }
  if (!ctx.origin) return { ok: false, error: "Confirmation emails are not configured." };
  if (!await consume(emailBucket(email), 1, 86400)) return { ok: true, email: { mode: "suppressed" } };
  const token = randomBytes(32).toString("base64url");
  const unsubscribeUrl = waitlistUnsubscribeUrl(ctx, token);
  const entry = {
    event: "signup",
    email,
    name: cleanWaitlistString(body.name, 120),
    note: cleanWaitlistString(body.note, 500),
    source: cleanWaitlistString(body.source, 120) || "web-demo",
    consent: cleanWaitlistString(body.consent, 300) || "requested confnote product updates; can unsubscribe any time",
    unsubscribe_token_hash: waitlistTokenHash(token),
    created_at: new Date().toISOString(),
  };
  await appendWaitlistEvent(ctx, entry);
  const emailResult = await sendWaitlistConfirmation({
    email,
    name: entry.name,
    unsubscribeUrl,
  });
  if (emailResult.message && (emailResult.mode === "log" || emailResult.mode === "disabled")) {
    await appendOutboxEmail(ctx, {
      event: "email",
      kind: "waitlist-confirmation",
      mode: emailResult.mode,
      message: emailResult.message,
      created_at: new Date().toISOString(),
    });
  }
  if (!emailResult.ok) {
    return { ok: false, error: emailResult.error || "Could not send confirmation email." };
  }
  return { ok: true, email: { mode: emailResult.mode, id: emailResult.id } };
}

export async function removeWaitlistSignup(ctx: RequestContext, token: string) {
  const cleanToken = cleanWaitlistString(token, 160);
  if (!cleanToken) return { ok: false, error: "Missing unsubscribe token." };
  const wantedHash = waitlistTokenHash(cleanToken);
  const pathname = key(ctx, ".confnote", "waitlist.jsonl");
  const current = (await storage.readText(pathname))?.text || "";
  let email = "";
  let removed = false;
  for (const line of current.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { event?: string; email?: string; unsubscribe_token_hash?: string };
      if (event.event === "signup" && event.unsubscribe_token_hash === wantedHash) email = event.email || "";
      if (event.event === "removed" && event.unsubscribe_token_hash === wantedHash) removed = true;
    } catch {
      continue;
    }
  }
  if (!email) return { ok: false, error: "Unsubscribe link was not found." };
  // The link is public and replayable: a second click confirms without growing the log.
  if (removed) return { ok: true };
  await appendWaitlistEvent(ctx, {
    event: "removed",
    email,
    unsubscribe_token_hash: wantedHash,
    created_at: new Date().toISOString(),
  });
  return { ok: true };
}
