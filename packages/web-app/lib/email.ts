import { Resend } from "resend";

export interface OutboundEmail {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
  tags?: Array<{ name: string; value: string }>;
}

export interface EmailResult {
  ok: boolean;
  mode: "log" | "resend" | "disabled";
  id?: string;
  error?: string;
  message?: OutboundEmail;
}

function emailMode(): EmailResult["mode"] {
  const configured = (process.env.CONFNOTE_EMAIL_MODE || "").toLowerCase();
  if (configured === "disabled" || configured === "log" || configured === "resend") return configured;
  return process.env.RESEND_API_KEY ? "resend" : "log";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function sendWaitlistConfirmation(input: {
  email: string;
  name?: string;
  unsubscribeUrl: string;
}): Promise<EmailResult> {
  const from = process.env.CONFNOTE_WAITLIST_FROM || process.env.SENDER_EMAIL_ADDRESS || "onboarding@resend.dev";
  const appName = process.env.CONFNOTE_APP_NAME || "confnote";
  const name = ""; // Confirmation content is fixed; user-provided names/notes never enter mail.
  const subject = `You're on the ${appName} list`;
  const html = [
    `<p>Hi${escapeHtml(name)},</p>`,
    `<p>Thanks for registering interest in <strong>${escapeHtml(appName)}</strong>. I will only use this address for ${escapeHtml(appName)} updates.</p>`,
    `<p>You can leave the list any time: <a href="${escapeHtml(input.unsubscribeUrl)}">unsubscribe</a>.</p>`,
  ].join("\n");
  const text = [
    `Hi${name},`,
    "",
    `Thanks for registering interest in ${appName}. I will only use this address for ${appName} updates.`,
    "",
    `Unsubscribe: ${input.unsubscribeUrl}`,
  ].join("\n");
  const message: OutboundEmail = {
    to: input.email,
    from,
    subject,
    html,
    text,
    tags: [{ name: "source", value: "confnote-waitlist" }],
  };
  const mode = emailMode();
  if (mode === "disabled" || mode === "log") return { ok: true, mode, message };

  if (!process.env.RESEND_API_KEY) {
    return { ok: false, mode, error: "RESEND_API_KEY is not configured." };
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  try {
    const result = await resend.emails.send(message);
    if (result.error) return { ok: false, mode, error: result.error.message };
    return { ok: true, mode, id: result.data?.id, message };
  } catch (error) {
    return { ok: false, mode, error: error instanceof Error ? error.message : "Email send failed." };
  }
}
