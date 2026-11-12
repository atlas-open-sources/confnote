import { describe, expect, it, vi } from "vitest";
import { ClerkAuthProvider, WorkOSAuthProvider, resolvePrincipal, type AuthDriver, type ProviderSession, type Principal } from "../../auth/src/index.js";
import { authCookie, seal, unseal } from "../lib/auth-cookie.js";
import { workosDriver } from "../lib/workos-driver.js";
import { context } from "../lib/http.js";
const principal: Principal = { userId: "internal", workspaceId: "owned", role: "editor", email: "fixture@example.test", emailVerified: true, authMethod: "email_code", sessionId: "session" };
function driver(session: ProviderSession): AuthDriver {
  return { getSession: vi.fn(async () => session), verifyBearer: vi.fn(async () => session), signInUrl: vi.fn(async () => "https://identity.example.test/login"), handleCallback: vi.fn(async () => new Response(null, { status: 302 })), signOut: vi.fn(async () => new Response(null, { status: 302 })), switchOrg: vi.fn(async () => new Response(null, { status: 302 })), parseWebhook: vi.fn(async () => ({ id: "evt", type: "session.revoked" as const, sessionId: "session" })), orgs: { create: vi.fn(async () => ({ externalOrgId: "org" })), invite: vi.fn(async () => {}), removeMember: vi.fn(async () => {}) }, nativeConfig: () => ({ issuer: "https://identity.example.test", clientId: "public-client", authorizeUrl: "https://identity.example.test/authorize", tokenUrl: "https://identity.example.test/token", scopes: ["openid"] }), responseCookies: () => [] };
}
describe.each([WorkOSAuthProvider, ClerkAuthProvider])("portable auth contract %s", (Adapter) => {
  it("delegates verified cookie/bearer and routes only through application membership", async () => {
    const session: ProviderSession = { provider: Adapter === WorkOSAuthProvider ? "workos" : "clerk", externalUserId: "vendor", externalOrgId: null, providerRoles: ["admin"], permissions: ["all"], email: principal.email, emailVerified: true, sessionId: "session", expiresAt: new Date(Date.now() + 60000), authMethod: "email_code" };
    const fake = driver(session); const adapter = new Adapter(fake);
    const repository = { resolve: vi.fn(async (_session: ProviderSession, workspace?: string) => workspace === "other-user" ? null : principal) };
    expect(await resolvePrincipal(adapter, repository, new Request("https://app.test", { headers: { "x-user-id": "attacker" } }))).toEqual(principal);
    expect(await resolvePrincipal(adapter, repository, new Request("https://app.test", { headers: { authorization: "Bearer fixture", "x-workspace-id": "other-user" } }))).toBeNull();
    expect(fake.verifyBearer).toHaveBeenCalledWith("fixture");
    await adapter.signInUrl({ returnTo: "/" }); await adapter.handleCallback(new Request("https://app.test")); await adapter.signOut(new Request("https://app.test")); await adapter.switchOrg(new Request("https://app.test"), "org");
    await adapter.orgs.create("Fixture"); await adapter.orgs.invite("org", "fixture@example.test", "member"); await adapter.orgs.removeMember("org", "vendor");
    expect(await adapter.parseWebhook(new Request("https://app.test"))).toMatchObject({ type: "session.revoked" });
    expect(adapter.nativeConfig().clientId).toBe("public-client");
    session.emailVerified = false;
    expect(await resolvePrincipal(adapter, repository, new Request("https://app.test"))).toBeNull();
    session.emailVerified = true; session.expiresAt = new Date(0);
    expect(await resolvePrincipal(adapter, repository, new Request("https://app.test"))).toBeNull();
  });
});
it("ignores x-user-id and fails closed without a verified principal", () => {
  vi.stubEnv("CONFNOTE_PUBLIC_DEMO", "0");
  expect(context({ headers: { "x-user-id": "victim" } }).workspace).toBe("unauthenticated");
  expect(context({ headers: { "x-user-id": "victim" } }, principal).workspace).toBe("owned");
  vi.unstubAllEnvs();
});
it("seals PKCE state and rejects tampering; cookies are secure/HTTP-only", async () => {
  const password = "fixture-cookie-password-for-tests-only"; // pragma: allowlist secret (validation or synthetic fixture)
  const encoded = seal({ state: "fixture", verifier: "private" }, password);
  expect(unseal(encoded, password)).toEqual({ state: "fixture", verifier: "private" });
  expect(() => unseal(encoded.slice(0, -4) + "AAAA", password)).toThrow();
  expect(authCookie("test", "value", true)).toContain("HttpOnly; SameSite=Lax");
  expect(authCookie("test", "value", true)).toContain("Secure");
  const adapter = workosDriver({ apiKey: "fixture-only", clientId: "fixture", cookiePassword: password, origin: "https://app.example.test" });
  await expect(adapter.signInUrl({ returnTo: "https://attacker.test/" })).rejects.toThrow("return URL");
  expect((await adapter.handleCallback(new Request("https://app.example.test/api/auth/callback?state=x&code=y"))).status).toBe(400);
});
it("WorkOS concrete driver verifies sessions, refreshes cookies, and binds callback to encrypted PKCE state", async () => {
  type WorkOS = import("@workos-inc/node").WorkOS;
  const password = "fixture-only-cookie-encryption-password"; // pragma: allowlist secret
  const user = { id: "vendor", email: "fixture@example.test", emailVerified: true };
  const verifyAccessToken = vi.fn(async () => ({ sub: "vendor", sid: "session", exp: Math.floor(Date.now() / 1000) + 60 }));
  const authenticateWithCode = vi.fn(async () => ({ sealedSession: "sealed-fixture", authenticationMethod: "MagicAuth", user }));
  const fake = { userManagement: {
    verifyAccessToken, getUser: vi.fn(async () => user),
    listSessions: vi.fn(async () => ({ autoPagination: async () => [{ id: "session", status: "active", expiresAt: new Date(Date.now() + 60000), authMethod: "MagicAuth" }] })),
    getAuthorizationUrlWithPKCE: vi.fn(async () => ({ state: "state-fixture", codeVerifier: "pkce-fixture", url: "https://identity.example.test/authorize" })),
    authenticateWithCode,
    loadSealedSession: vi.fn(() => ({ authenticate: async () => ({ authenticated: false }), refresh: async () => ({ authenticated: true, sealedSession: "refreshed-fixture", session: { accessToken: "verified-token" }, authenticationMethod: "MagicAuth" }) })),
  } } as unknown as WorkOS;
  const adapter = workosDriver({ apiKey: "fixture-only", clientId: "fixture", cookiePassword: password, origin: "https://app.example.test" }, fake);
  expect((await adapter.verifyBearer("fixture-token"))?.externalUserId).toBe("vendor");
  expect(verifyAccessToken).toHaveBeenCalledWith("fixture-token");
  expect((await adapter.getSession(new Request("https://app.example.test", { headers: { cookie: "__Host-confnote-session=old-fixture" } })))?.authMethod).toBe("email_code");
  expect(adapter.responseCookies()[0]).toContain("confnote-session=refreshed-fixture");
  await adapter.signInUrl({ returnTo: "/catalogue/" });
  const loginCookie = adapter.responseCookies()[0].split(";")[0];
  expect((await adapter.handleCallback(new Request("https://app.example.test/api/auth/callback?state=wrong&code=fixture", { headers: { cookie: loginCookie } }))).status).toBe(400);
  expect(authenticateWithCode).not.toHaveBeenCalled();
  const result = await adapter.handleCallback(new Request("https://app.example.test/api/auth/callback?state=state-fixture&code=fixture", { headers: { cookie: loginCookie } }));
  expect(result.status).toBe(302); expect(result.headers.get("Location")).toBe("https://app.example.test/catalogue/");
  expect(authenticateWithCode).toHaveBeenCalledWith(expect.objectContaining({ codeVerifier: "pkce-fixture" }));
  authenticateWithCode.mockRejectedValueOnce(new Error("sensitive provider response"));
  const failure = await adapter.handleCallback(new Request("https://app.example.test/api/auth/callback?state=state-fixture&code=fixture", { headers: { cookie: loginCookie } }));
  expect(failure.status).toBe(400); expect(await failure.text()).not.toContain("sensitive");
  expect(adapter.responseCookies().some((cookie) => cookie.startsWith("__Host-confnote-login=") && cookie.includes("Max-Age=0"))).toBe(true);
});

it("a deactivated WorkOS membership revokes workspace access like a deleted one", async () => {
  const { normalizeAuthEvent } = await import("../../auth/src/events.js");
  const membership = { organization_id: "org_1", user_id: "user_1" };
  expect(normalizeAuthEvent("workos", { id: "evt_1", event: "organization_membership.updated", data: { ...membership, status: "inactive" } })).toMatchObject({ type: "membership.deleted", externalOrgId: "org_1", externalUserId: "user_1" });
  expect(normalizeAuthEvent("workos", { id: "evt_2", event: "organization_membership.updated", data: { ...membership, status: "active" } })).toMatchObject({ type: "membership.upserted" });
});
