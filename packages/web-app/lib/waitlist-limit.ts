import { createHash } from "node:crypto";
export type ConsumeLimit = (bucket: string, limit: number, seconds: number) => Promise<boolean>;
const local = new Map<string, number>();
export async function localWaitlistLimit(bucket: string, _limit: number, seconds: number): Promise<boolean> {
  // Only a development fallback. HTTP composition requires the atomic Postgres limiter.
  if (process.env.CONFNOTE_EMAIL_MODE === "resend" || process.env.RESEND_API_KEY) return false;
  const now = Date.now();
  if ((local.get(bucket) || 0) > now) return false;
  local.set(bucket, now + seconds * 1000);
  return true;
}
export function emailBucket(email: string): string { return `waitlist:email:${createHash("sha256").update(email).digest("hex")}`; }
