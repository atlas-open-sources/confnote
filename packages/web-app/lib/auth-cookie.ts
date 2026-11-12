import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
export function cookieValue(req: Request, name: string): string | undefined {
  return (req.headers.get("cookie") || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}
export function authCookie(name: string, value: string, secure: boolean, maxAge = 604800): string {
  const pinnedName = secure && !name.startsWith("__Host-") ? `__Host-${name}` : name;
  return `${pinnedName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
export function seal(value: unknown, password: string): string {
  if (password.length < 32) throw new Error("Auth cookie password must contain at least 32 characters.");
  const iv = randomBytes(12); const key = createHash("sha256").update(password).digest();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}
export function unseal(value: string, password: string): unknown {
  const data = Buffer.from(value, "base64url");
  if (data.length < 29) throw new Error("Invalid auth cookie");
  const decipher = createDecipheriv("aes-256-gcm", createHash("sha256").update(password).digest(), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8"));
}
