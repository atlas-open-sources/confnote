import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { del, get, list, put } from "@vercel/blob";
import type { StoredBytes, StoredObject, StoredText } from "./types.js";

export interface StorageAdapter {
  readText(pathname: string): Promise<StoredText | null>;
  readBytes(pathname: string): Promise<StoredBytes | null>;
  writeText(pathname: string, text: string): Promise<StoredText>;
  writeBytes(pathname: string, bytes: Uint8Array, contentType: string): Promise<StoredText>;
  list(prefix: string): Promise<StoredObject[]>;
  /** Deletes one object; a missing object is not an error. Absent where nothing may be deleted. */
  remove?(pathname: string): Promise<void>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");

function cleanPathname(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || part.includes("\0"))) {
    throw new Error("invalid storage path");
  }
  return parts.join("/");
}

function contentTypeFor(pathname: string): string {
  const ext = path.extname(pathname).toLowerCase();
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

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

class FsStorage implements StorageAdapter {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private file(pathname: string): string {
    const resolved = path.resolve(this.root, cleanPathname(pathname));
    const rel = path.relative(this.root, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("invalid storage path");
    return resolved;
  }

  async readText(pathname: string): Promise<StoredText | null> {
    const file = this.file(pathname);
    try {
      const [text, stat] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
      return { text, mtime: stat.mtimeMs / 1000 };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async readBytes(pathname: string): Promise<StoredBytes | null> {
    const file = this.file(pathname);
    try {
      const [bytes, stat] = await Promise.all([fs.readFile(file), fs.stat(file)]);
      return {
        bytes,
        contentType: contentTypeFor(pathname),
        mtime: stat.mtimeMs / 1000,
        size: stat.size,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async writeText(pathname: string, text: string): Promise<StoredText> {
    const file = this.file(pathname);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, text);
    await fs.rename(tmp, file);
    const stat = await fs.stat(file);
    return { text, mtime: stat.mtimeMs / 1000 };
  }

  async writeBytes(pathname: string, bytes: Uint8Array, _contentType: string): Promise<StoredText> {
    const file = this.file(pathname);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
    const stat = await fs.stat(file);
    return { text: "", mtime: stat.mtimeMs / 1000 };
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const clean = cleanPathname(prefix);
    const root = this.file(clean || ".");
    const out: StoredObject[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: Array<import("node:fs").Dirent>;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        const child = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(child);
          continue;
        }
        if (!entry.isFile()) continue;
        const stat = await fs.stat(child);
        out.push({
          path: path.relative(this.root, child).split(path.sep).join("/"),
          size: stat.size,
          mtime: stat.mtimeMs / 1000,
        });
      }
    };
    await walk(root);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async remove(pathname: string): Promise<void> {
    await fs.rm(this.file(pathname), { force: true });
  }
}

class BlobStorage implements StorageAdapter {
  async readText(pathname: string): Promise<StoredText | null> {
    const bytes = await this.readBytes(pathname);
    if (!bytes) return null;
    return {
      text: new TextDecoder().decode(bytes.bytes),
      mtime: bytes.mtime,
      etag: bytes.etag,
    };
  }

  async readBytes(pathname: string): Promise<StoredBytes | null> {
    const result = await get(cleanPathname(pathname), { access: "private", useCache: false });
    if (!result || result.statusCode !== 200) return null;
    const bytes = await streamToBytes(result.stream);
    return {
      bytes,
      contentType: result.blob.contentType,
      mtime: result.blob.uploadedAt.getTime() / 1000,
      size: result.blob.size,
      etag: result.blob.etag,
    };
  }

  async writeText(pathname: string, text: string): Promise<StoredText> {
    const blob = await put(cleanPathname(pathname), text, {
      access: "private",
      allowOverwrite: true,
      contentType: contentTypeFor(pathname),
    });
    return { text, mtime: Date.now() / 1000, etag: blob.etag };
  }

  async writeBytes(pathname: string, bytes: Uint8Array, contentType: string): Promise<StoredText> {
    const blob = await put(cleanPathname(pathname), Buffer.from(bytes), {
      access: "private",
      allowOverwrite: true,
      contentType,
    });
    return { text: "", mtime: Date.now() / 1000, etag: blob.etag };
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const out: StoredObject[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({
        prefix: cleanPathname(prefix),
        cursor,
        limit: 1000,
      });
      for (const blob of page.blobs) {
        out.push({
          path: blob.pathname,
          size: blob.size,
          mtime: blob.uploadedAt.getTime() / 1000,
          etag: blob.etag,
        });
      }
      cursor = page.cursor;
    } while (cursor);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async remove(pathname: string): Promise<void> {
    await del(cleanPathname(pathname));
  }
}

export const PUBLIC_DEMO_WORKSPACE = "public-demo";

/**
 * Read-only public demo: serves only the redacted `public-demo` workspace that
 * scripts/prepare-public-demo.mjs writes under `demo-data/`. Any other
 * workspace (another CONFNOTE_PUBLIC_DEMO_WORKSPACE, an x-user-id header, a
 * stray file) reads as missing, and every write is refused.
 */
export class PublicDemoStorage implements StorageAdapter {
  private readonly fs: FsStorage;

  constructor(demoRoot: string) {
    this.fs = new FsStorage(demoRoot);
  }

  private inWorkspace(pathname: string): boolean {
    return cleanPathname(pathname).split("/")[0] === PUBLIC_DEMO_WORKSPACE;
  }

  async readText(pathname: string): Promise<StoredText | null> {
    return this.inWorkspace(pathname) ? this.fs.readText(pathname) : null;
  }

  async readBytes(pathname: string): Promise<StoredBytes | null> {
    return this.inWorkspace(pathname) ? this.fs.readBytes(pathname) : null;
  }

  async writeText(): Promise<StoredText> {
    throw new Error("public demo is read-only");
  }

  async writeBytes(): Promise<StoredText> {
    throw new Error("public demo is read-only");
  }

  async list(prefix: string): Promise<StoredObject[]> {
    return this.inWorkspace(prefix) ? this.fs.list(prefix) : [];
  }
}

export function createStorage(): StorageAdapter {
  const mode = process.env.CONFNOTE_STORAGE || (process.env.BLOB_READ_WRITE_TOKEN ? "blob" : "fs");
  if (mode === "blob") return new BlobStorage();
  if (mode === "demo") return new PublicDemoStorage(path.join(webRoot, "demo-data"));
  const root = process.env.CONFNOTE_WEB_DATA_DIR || path.join(webRoot, ".data");
  return new FsStorage(root);
}

export function storageKey(workspace: string, ...parts: string[]): string {
  return cleanPathname([workspace || "default", ...parts].join("/"));
}
