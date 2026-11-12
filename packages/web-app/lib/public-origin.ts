export function publicOrigin(value = process.env.CONFNOTE_PUBLIC_BASE_URL): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("CONFNOTE_PUBLIC_BASE_URL must be an HTTPS origin (or loopback HTTP for local tests).");
  }
  return url.origin;
}
