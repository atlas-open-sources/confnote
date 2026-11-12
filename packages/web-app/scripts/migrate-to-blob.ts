import fs from "node:fs/promises";
import path from "node:path";
import { put } from "@vercel/blob";

const SKIP = new Set([".DS_Store"]);

function usage(): never {
  console.error("Usage: npm --prefix packages/web-app run migrate -- <vault-dir> [workspace]");
  process.exit(2);
}

function contentTypeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
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

function cleanWorkspace(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "default";
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(child);
    } else if (entry.isFile()) {
      yield child;
    }
  }
}

const vaultArg = process.argv[2];
if (!vaultArg) usage();
if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("BLOB_READ_WRITE_TOKEN is required for Blob migration.");
  process.exit(2);
}

const vault = path.resolve(vaultArg);
const workspace = cleanWorkspace(process.argv[3] || process.env.CONFNOTE_WORKSPACE || "default");
let uploaded = 0;

for await (const file of walk(vault)) {
  const rel = path.relative(vault, file).split(path.sep).join("/");
  if (!/^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\//.test(rel) && !rel.startsWith(".confnote/")) {
    continue;
  }
  const pathname = `${workspace}/${rel}`;
  await put(pathname, await fs.readFile(file), {
    access: "private",
    allowOverwrite: true,
    contentType: contentTypeFor(file),
  });
  uploaded += 1;
  console.log(`uploaded ${pathname}`);
}

console.log(`Migration complete: ${uploaded} files uploaded to workspace '${workspace}'.`);
