export type AuthProviderId = "workos" | "clerk" | "local";
export type WorkspaceRole = "owner" | "editor" | "viewer";
export type AuthMethod = "email_code" | "oauth_google" | "oauth_apple" | "oauth" | "passkey" | "sso";
export interface ProviderSession {
  provider: AuthProviderId; externalUserId: string; externalOrgId: string | null;
  providerRoles: string[]; permissions: string[]; email: string; emailVerified: boolean;
  sessionId: string; expiresAt: Date; authMethod: AuthMethod;
}
export interface Principal {
  userId: string; email: string; emailVerified: boolean; workspaceId: string;
  role: WorkspaceRole; authMethod: AuthMethod; sessionId: string;
}
export interface NativeConfig {
  issuer: string; clientId: string; authorizeUrl: string; tokenUrl: string;
  deviceAuthorizationUrl?: string; scopes: string[];
}
export type AuthEvent =
  | { id: string; type: "user.upserted"; externalUserId: string; email: string; emailVerified: boolean }
  | { id: string; type: "user.deleted"; externalUserId: string }
  | { id: string; type: "org.upserted" | "org.deleted"; externalOrgId: string; name?: string }
  | { id: string; type: "membership.upserted" | "membership.deleted"; externalOrgId: string; externalUserId: string; roles?: string[] }
  | { id: string; type: "session.revoked"; sessionId: string; externalUserId?: string }
  | { id: string; type: "ignored"; raw: string };
export interface AuthProvider {
  readonly id: AuthProviderId;
  getSession(req: Request): Promise<ProviderSession | null>;
  verifyBearer(token: string): Promise<ProviderSession | null>;
  signInUrl(opts: { returnTo: string; loginHint?: string; orgHint?: string }): Promise<string>;
  handleCallback(req: Request): Promise<Response>;
  signOut(req: Request): Promise<Response>;
  switchOrg(req: Request, externalOrgId: string): Promise<Response>;
  parseWebhook(req: Request): Promise<AuthEvent>;
  orgs: {
    create(name: string): Promise<{ externalOrgId: string }>;
    invite(externalOrgId: string, email: string, role: string): Promise<void>;
    removeMember(externalOrgId: string, externalUserId: string): Promise<void>;
    enterpriseSetupLink?(externalOrgId: string, intent: "sso" | "directory_sync"): Promise<string>;
  };
  nativeConfig(): NativeConfig;
  /** Per-request adapter instance: response cookies from refresh or sign-in. */
  responseCookies(): string[];
}
export interface IdentityRepository {
  resolve(session: ProviderSession, requestedWorkspace?: string): Promise<Principal | null>;
}
export async function resolvePrincipal(provider: AuthProvider, repository: IdentityRepository, request: Request): Promise<Principal | null> {
  const authorization = request.headers.get("authorization");
  const session = authorization?.startsWith("Bearer ") ? await provider.verifyBearer(authorization.slice(7)) : await provider.getSession(request);
  if (!session || !session.emailVerified || session.expiresAt.getTime() <= Date.now()) return null;
  return repository.resolve(session, request.headers.get("x-workspace-id") || undefined);
}

/** Vendor drivers verify signatures/tokens; adapters expose one application contract. */
export type AuthDriver = Omit<AuthProvider, "id">;
export class WorkOSAuthProvider implements AuthProvider {
  readonly id: AuthProviderId = "workos";
  constructor(private readonly driver: AuthDriver) {}
  get orgs(): AuthProvider["orgs"] { return this.driver.orgs; }
  getSession(req: Request): Promise<ProviderSession | null> { return this.driver.getSession(req); }
  verifyBearer(token: string): Promise<ProviderSession | null> { return this.driver.verifyBearer(token); }
  signInUrl(opts: Parameters<AuthProvider["signInUrl"]>[0]): Promise<string> { return this.driver.signInUrl(opts); }
  handleCallback(req: Request): Promise<Response> { return this.driver.handleCallback(req); }
  signOut(req: Request): Promise<Response> { return this.driver.signOut(req); }
  switchOrg(req: Request, org: string): Promise<Response> { return this.driver.switchOrg(req, org); }
  parseWebhook(req: Request): Promise<AuthEvent> { return this.driver.parseWebhook(req); }
  nativeConfig(): NativeConfig { return this.driver.nativeConfig(); }
  responseCookies(): string[] { return this.driver.responseCookies(); }
}
export class ClerkAuthProvider extends WorkOSAuthProvider {
  // Same application contract; the injected Clerk driver owns token/session semantics.
  readonly id: AuthProviderId = "clerk";
}
