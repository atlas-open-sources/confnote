import type { AuthEvent, AuthProviderId } from "./index.js";
export function normalizeAuthEvent(provider: AuthProviderId, value: unknown): AuthEvent {
  const event = value as { id?: string; event?: string; type?: string; data?: Record<string, unknown> };
  if (!event || typeof event !== "object" || typeof event.id !== "string") throw new Error("Invalid verified auth event");
  const kind = String(event.event || event.type || "");
  const data = event.data || {};
  const id = event.id;
  const externalId = String(data.id || "");
  if (["user.created", "user.updated"].includes(kind)) {
    let email = String(data.email || ""); let emailVerified = data.emailVerified === true || data.email_verified === true;
    if (provider === "clerk" && Array.isArray(data.email_addresses)) {
      const primary = data.email_addresses.find((item) => item.id === data.primary_email_address_id);
      email = String(primary?.email_address || ""); emailVerified = primary?.verification?.status === "verified";
    }
    return { id, type: "user.upserted", externalUserId: externalId, email, emailVerified };
  }
  if (kind === "user.deleted") return { id, type: "user.deleted", externalUserId: externalId };
  if (["organization.created", "organization.updated", "organization.deleted"].includes(kind)) return { id, type: kind.endsWith("deleted") ? "org.deleted" : "org.upserted", externalOrgId: externalId, name: String(data.name || "") };
  if (/^organization_membership\.|^organizationMembership\./.test(kind)) {
    const organization = data.organization as { id?: string } | undefined;
    const user = data.public_user_data as { user_id?: string } | undefined;
    // A deactivated membership is updated, not deleted, in WorkOS; it must revoke access all the same.
    const revoked = kind.endsWith("deleted") || data.status === "inactive";
    return { id, type: revoked ? "membership.deleted" : "membership.upserted", externalOrgId: String(data.organizationId || data.organization_id || organization?.id || ""), externalUserId: String(data.userId || data.user_id || user?.user_id || ""), roles: [] };
  }
  if (["session.revoked", "session.ended"].includes(kind)) return { id, type: "session.revoked", sessionId: externalId };
  return { id, type: "ignored", raw: kind };
}
