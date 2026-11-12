import { WorkOS } from "@workos-inc/node";
import type { AuthDriver, AuthMethod, ProviderSession } from "../../auth/src/index.js";
import { normalizeAuthEvent } from "../../auth/src/events.js";
import { authCookie, cookieValue, seal, unseal } from "./auth-cookie.js";

interface Config { apiKey: string; clientId: string; cookiePassword: string; origin: string; webhookSecret?: string }
interface LoginState { state: string; verifier: string; returnTo: string; expiresAt: number }
function authMethod(value: string | undefined): AuthMethod | null {
  if (value === "MagicAuth") return "email_code";
  if (value === "Passkey") return "passkey";
  if (value === "OAuth") return "oauth";
  if (value === "SSO") return "sso";
  return null; // Password and unknown methods fail closed.
}
export function workosDriver(config: Config, client = new WorkOS(config.apiKey, { clientId: config.clientId })): AuthDriver {
  const cookies: string[] = [];
  const secure = config.origin.startsWith("https:");
  const redirectUri = `${config.origin}/api/auth/callback`;
  function sessionCookie(value: string): void { cookies.push(authCookie("confnote-session", value, secure)); }
  function redirect(url: string): Response { return new Response(null, { status: 302, headers: { Location: url } }); }
  function localReturn(value: string): string {
    const url = new URL(value, config.origin);
    if (url.origin !== config.origin || !url.pathname.startsWith("/")) throw new Error("Invalid return URL");
    return url.href;
  }
  async function fromToken(token: string, method?: string): Promise<ProviderSession | null> {
    const claims = await client.userManagement.verifyAccessToken(token);
    if (!claims) return null;
    let verifiedMethod = method;
    if (!verifiedMethod) {
      const sessions = await client.userManagement.listSessions(claims.sub);
      const active = (await sessions.autoPagination()).find((session) => session.id === claims.sid && session.status === "active" && session.expiresAt.getTime() > Date.now());
      if (!active) return null;
      verifiedMethod = active.authMethod;
    }
    const auth = authMethod(verifiedMethod);
    if (!auth) return null;
    const user = await client.userManagement.getUser(claims.sub);
    return { provider: "workos", externalUserId: user.id, externalOrgId: claims.org_id || null, providerRoles: claims.roles || [], permissions: claims.permissions || [], email: user.email, emailVerified: user.emailVerified, sessionId: claims.sid, expiresAt: new Date(claims.exp * 1000), authMethod: auth };
  }
  async function load(req: Request) {
    const data = cookieValue(req, secure ? "__Host-confnote-session" : "confnote-session");
    return data ? client.userManagement.loadSealedSession({ sessionData: data, cookiePassword: config.cookiePassword }) : null;
  }
  return {
    async getSession(req) {
      const session = await load(req); if (!session) return null;
      const result = await session.authenticate();
      if (result.authenticated) return fromToken(result.accessToken, result.authenticationMethod);
      const refreshed = await session.refresh();
      if (!refreshed.authenticated || !refreshed.sealedSession || !refreshed.session) return null;
      sessionCookie(refreshed.sealedSession);
      return fromToken(refreshed.session.accessToken, refreshed.authenticationMethod);
    },
    verifyBearer(token) { return fromToken(token); },
    async signInUrl(opts) {
      const returnTo = localReturn(opts.returnTo);
      const result = await client.userManagement.getAuthorizationUrlWithPKCE({ clientId: config.clientId, provider: "authkit", redirectUri, loginHint: opts.loginHint, organizationId: opts.orgHint });
      cookies.push(authCookie("confnote-login", seal({ state: result.state, verifier: result.codeVerifier, returnTo, expiresAt: Date.now() + 600000 }, config.cookiePassword), secure, 600));
      return result.url;
    },
    async handleCallback(req) {
      cookies.push(authCookie("confnote-login", "", secure, 0));
      const url = new URL(req.url); const cookie = cookieValue(req, secure ? "__Host-confnote-login" : "confnote-login");
      if (!cookie) return new Response("Missing sign-in state", { status: 400 });
      let state: LoginState;
      try { state = unseal(cookie, config.cookiePassword) as LoginState; } catch { return new Response("Invalid sign-in state", { status: 400 }); }
      if (state.expiresAt <= Date.now() || state.state !== url.searchParams.get("state") || !url.searchParams.get("code")) return new Response("Invalid sign-in state", { status: 400 });
      try {
      const result = await client.userManagement.authenticateWithCode({ clientId: config.clientId, code: url.searchParams.get("code") || "", codeVerifier: state.verifier, session: { sealSession: true, cookiePassword: config.cookiePassword } });
      if (!result.sealedSession || !authMethod(result.authenticationMethod) || !result.user.emailVerified) return new Response("Passwordless verified sign-in required", { status: 403 });
      sessionCookie(result.sealedSession);
      return redirect(localReturn(state.returnTo));
      } catch { return new Response("Sign-in could not be completed. Please start again.", { status: 400 }); }
    },
    async signOut(req) {
      const session = await load(req); cookies.push(authCookie("confnote-session", "", secure, 0));
      return redirect(session ? await session.getLogoutUrl({ returnTo: config.origin }) : config.origin);
    },
    async switchOrg(req, externalOrgId) {
      const session = await load(req); if (!session) return new Response("Not signed in", { status: 401 });
      const result = await session.refresh({ organizationId: externalOrgId });
      if (!result.authenticated || !result.sealedSession) return new Response("Organization unavailable", { status: 403 });
      sessionCookie(result.sealedSession); return redirect(config.origin);
    },
    async parseWebhook(req) {
      if (!config.webhookSecret) throw new Error("Auth webhook is not configured");
      const event = await client.webhooks.constructEvent({ payload: await req.text(), sigHeader: req.headers.get("workos-signature") || "", secret: config.webhookSecret });
      return normalizeAuthEvent("workos", event);
    },
    orgs: {
      async create(name) { const org = await client.organizations.createOrganization({ name }); return { externalOrgId: org.id }; },
      async invite(organizationId, email, roleSlug) { await client.userManagement.sendInvitation({ organizationId, email, roleSlug }); },
      async removeMember(organizationId, userId) { const memberships = await client.userManagement.listOrganizationMemberships({ organizationId, userId }); for (const membership of memberships.data) await client.userManagement.deleteOrganizationMembership(membership.id); },
    },
    nativeConfig() { return { issuer: "https://api.workos.com", clientId: config.clientId, authorizeUrl: "https://api.workos.com/user_management/authorize", tokenUrl: "https://api.workos.com/user_management/authenticate", scopes: ["openid", "profile", "email"] }; },
    responseCookies() { return cookies.splice(0); },
  };
}
