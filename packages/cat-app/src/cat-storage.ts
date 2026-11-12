// The web app's storage seam (packages/web-app/lib/storage.ts), answered by the Cat's
// bridge inside ConfNote's project-folder grant. The build aliases `./storage.js` to this
// file, so service.ts runs unchanged in the page.
import type { StoredBytes, StoredObject, StoredText } from "../../web-app/lib/types.js";

export interface StorageAdapter {
  readText(pathname: string): Promise<StoredText | null>;
  readBytes(pathname: string): Promise<StoredBytes | null>;
  writeText(pathname: string, text: string): Promise<StoredText>;
  writeBytes(pathname: string, bytes: Uint8Array, contentType: string): Promise<StoredText>;
  list(prefix: string): Promise<StoredObject[]>;
}

export interface CatBridgeReply {
  ok: boolean;
  data?: string;
  text?: string;
}

export interface CatBridge {
  request(message: Record<string, unknown>): Promise<CatBridgeReply>;
}

interface CatDirectoryEntry {
  name: string;
  kind: "file" | "directory";
}

/// Every key the service builds starts with its workspace ("default"). The grant is the
/// vault itself, laid out like the local app's: `<slug>/agenda.json`, `<slug>/notes/…`.
const WORKSPACE = "default";

function cleanPathname(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || part.includes("\0"))) {
    throw new Error("invalid storage path");
  }
  return parts.join("/");
}

function grantPath(pathname: string): string {
  const parts = cleanPathname(pathname).split("/");
  if (parts[0] === WORKSPACE) parts.shift();
  return parts.join("/");
}

function contentTypeFor(pathname: string): string {
  const ext = pathname.slice(pathname.lastIndexOf(".")).toLowerCase();
  const map: Record<string, string> = {
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
  };
  return map[ext] || "application/octet-stream";
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let start = 0; start < bytes.length; start += chunk) {
    binary += String.fromCharCode(...bytes.subarray(start, start + chunk));
  }
  return btoa(binary);
}

/// The bridge has no modification times, so a file's version is a hash of its bytes. The
/// service only ever compares it for equality (the 409 on a stale save), which a content
/// hash answers: unchanged bytes keep their version, any write changes it. 53 bits (cyrb53,
/// two mixed 32-bit lanes) so two different notes practically never share one; a 32-bit
/// FNV collided on two 33-byte notes in review.
export function contentVersion(bytes: Uint8Array): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (const byte of bytes) {
    h1 = Math.imul(h1 ^ byte, 2654435761);
    h2 = Math.imul(h2 ^ byte, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && /not found/i.test(error.message);
}

export class CatBridgeStorage implements StorageAdapter {
  constructor(private readonly bridge: CatBridge) {}

  async readBytes(pathname: string): Promise<StoredBytes | null> {
    let reply: CatBridgeReply;
    try {
      reply = await this.bridge.request({ operation: "file.read", path: grantPath(pathname) });
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    const bytes = fromBase64(reply.data || "");
    return {
      bytes,
      contentType: contentTypeFor(pathname),
      mtime: contentVersion(bytes),
      size: bytes.length,
    };
  }

  async readText(pathname: string): Promise<StoredText | null> {
    const item = await this.readBytes(pathname);
    if (!item) return null;
    return { text: new TextDecoder().decode(item.bytes), mtime: item.mtime };
  }

  async writeBytes(pathname: string, bytes: Uint8Array, _contentType: string): Promise<StoredText> {
    await this.bridge.request({ operation: "file.write", path: grantPath(pathname), data: toBase64(bytes) });
    return { text: "", mtime: contentVersion(bytes) };
  }

  async writeText(pathname: string, text: string): Promise<StoredText> {
    const bytes = new TextEncoder().encode(text);
    await this.writeBytes(pathname, bytes, contentTypeFor(pathname));
    return { text, mtime: contentVersion(bytes) };
  }

  /// Every file beneath the prefix, keyed like the service's own paths (`default/…`). The
  /// version is 0: the service lists to find names, and reads a file before trusting it.
  async list(prefix: string): Promise<StoredObject[]> {
    const start = grantPath(prefix);
    const out: StoredObject[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: CatDirectoryEntry[];
      try {
        const reply = await this.bridge.request(dir ? { operation: "file.list", path: dir } : { operation: "file.list" });
        entries = JSON.parse(new TextDecoder().decode(fromBase64(reply.data || ""))) as CatDirectoryEntry[];
      } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
      for (const entry of entries) {
        const child = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.kind === "directory") {
          await walk(child);
        } else {
          out.push({ path: `${WORKSPACE}/${child}`, size: 0, mtime: 0 });
        }
      }
    };
    await walk(start);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }
}

let shared: StorageAdapter | null = null;

/// Set by the transport before the service runs.
export function useStorage(storage: StorageAdapter): void {
  shared = storage;
}

/// The service calls this once at module load; the adapter it gets forwards to whatever
/// storage the transport installed, so load order does not matter.
export function createStorage(): StorageAdapter {
  const current = (): StorageAdapter => {
    if (!shared) throw new Error("ConfNote storage is not configured");
    return shared;
  };
  return {
    readText: (pathname) => current().readText(pathname),
    readBytes: (pathname) => current().readBytes(pathname),
    writeText: (pathname, text) => current().writeText(pathname, text),
    writeBytes: (pathname, bytes, type) => current().writeBytes(pathname, bytes, type),
    list: (prefix) => current().list(prefix),
  };
}

export function storageKey(workspace: string, ...parts: string[]): string {
  return cleanPathname([workspace || WORKSPACE, ...parts].join("/"));
}
