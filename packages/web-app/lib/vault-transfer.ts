import { CONF_RE, NOTE_RE, validateAgenda, notable, noteFileForEvent } from "./agenda.js";
import type { AgendaData } from "./types.js";
import type { StorageAdapter } from "./storage.js";

// The `.confnote` file: one or more conferences as plain files, keyed by
// `<slug>/<path>`. packages/local-app/vault_transfer.py ports validateBundle
// rule for rule; change both together.
export interface PrivateEncryption { v: 1; salt: string; iterations: number; kdf: "PBKDF2-SHA256"; verifier_iv: string; verifier_ct: string }
export interface VaultBundle { schema_version: "confnote.vault.v1"; files: Record<string, string>; assets?: Record<string, string>; privateEncryption?: PrivateEncryption }
export const MAX_BYTES = 2_000_000;
export const MAX_FILES = 2000;
export const CONF_DOCS = ["agenda.json", "README.md", "speakers.md", "BRIEF.md", "DEBRIEF.md", "INBOX.md"];
function allowed(name: string): boolean {
  const [slug, section, file, extra] = name.split("/");
  if (!CONF_RE.test(slug) || extra !== undefined) return false;
  if (file === undefined) return CONF_DOCS.includes(section);
  return section === "notes" && NOTE_RE.test(file);
}
function allowedAsset(name: string): boolean {
  const [slug, notes, assets, stem, filename, extra] = name.split("/");
  return CONF_RE.test(slug) && notes === "notes" && assets === "assets" && NOTE_RE.test(`${stem}.md`) && typeof filename === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename) && !filename.includes("..") && extra === undefined;
}
function validateEncryption(value: unknown): PrivateEncryption {
  const meta = value as PrivateEncryption;
  if (!meta || typeof meta !== "object" || Object.keys(meta).some((key) => !["v", "salt", "iterations", "kdf", "verifier_iv", "verifier_ct"].includes(key)) || meta.v !== 1 || meta.kdf !== "PBKDF2-SHA256" || !Number.isInteger(meta.iterations) || meta.iterations < 100000 || meta.iterations > 2000000) throw new Error("Invalid private encryption parameters");
  for (const [field, size] of [["salt", 16], ["verifier_iv", 12], ["verifier_ct", 0]] as const) {
    const encoded = meta[field];
    if (typeof encoded !== "string" || Buffer.from(encoded, "base64").toString("base64") !== encoded) throw new Error("Invalid private encryption encoding");
    const length = Buffer.from(encoded, "base64").length;
    if (size ? length !== size : length < 16 || length > 256) throw new Error("Invalid private encryption length");
  }
  return meta;
}
function assetContentType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf", mp3: "audio/mpeg", wav: "audio/wav", mp4: "video/mp4" } as Record<string, string>)[ext] || "application/octet-stream";
}
export function validateBundle(value: unknown): VaultBundle {
  const bundle = value as VaultBundle;
  if (bundle?.schema_version !== "confnote.vault.v1" || !bundle.files || typeof bundle.files !== "object" || Array.isArray(bundle.files)) throw new Error("Invalid vault bundle");
  if (Object.keys(bundle.files).length > MAX_FILES || Buffer.byteLength(JSON.stringify(bundle)) > MAX_BYTES) throw new Error("Vault bundle exceeds the import limit");
  for (const [name, content] of Object.entries(bundle.files)) {
    if (!allowed(name) || typeof content !== "string") throw new Error("Unsafe vault path or content");
    if (name.endsWith("/agenda.json")) {
      const agenda = JSON.parse(content) as AgendaData;
      if (validateAgenda(agenda).errors.length) throw new Error("Invalid vault agenda");
      const targets = new Set<string>();
      for (const event of agenda.events.filter(notable)) {
        const target = noteFileForEvent(event);
        const id = String(event.id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (targets.has(target) || (target !== `session-${event.id}.md` && !new RegExp(`^\\d{4}-${id}\\.md$`).test(target))) throw new Error("Invalid vault note ownership");
        targets.add(target);
      }
    }
    const slug = name.split("/")[0];
    if (!bundle.files[`${slug}/agenda.json`]) throw new Error("Every conference needs an agenda");
  }
  if (bundle.assets !== undefined) {
    if (!bundle.assets || typeof bundle.assets !== "object" || Array.isArray(bundle.assets) || Object.keys(bundle.assets).length > MAX_FILES) throw new Error("Invalid vault assets");
    for (const [name, encoded] of Object.entries(bundle.assets)) {
      if (!allowedAsset(name) || typeof encoded !== "string" || Buffer.from(encoded, "base64").toString("base64") !== encoded || !bundle.files[`${name.split("/")[0]}/agenda.json`]) throw new Error("Unsafe vault asset");
    }
  }
  if (bundle.privateEncryption !== undefined) validateEncryption(bundle.privateEncryption);
  return bundle;
}
export async function exportVault(storage: StorageAdapter, workspace: string): Promise<VaultBundle> {
  const files: Record<string, string> = {};
  const assets: Record<string, string> = {};
  let bytes = 0;
  for (const item of await storage.list(`${workspace}/`)) {
    if (!item.path.startsWith(`${workspace}/`)) continue;
    const name = item.path.slice(workspace.length + 1);
    if (allowedAsset(name)) {
      bytes += Math.ceil(item.size * 4 / 3);
      if (bytes > MAX_BYTES) throw new Error("Vault bundle exceeds the export limit");
      const content = await storage.readBytes(item.path); if (content) assets[name] = Buffer.from(content.bytes).toString("base64");
      continue;
    }
    if (!allowed(name)) continue;
    bytes += item.size;
    if (bytes > MAX_BYTES) throw new Error("Vault bundle exceeds the export limit");
    const content = await storage.readText(item.path); if (content) files[name] = content.text;
  }
  const encryption = await storage.readText(`${workspace}/.confnote/private.json`);
  const privateEncryption = encryption ? validateEncryption(JSON.parse(encryption.text)) : undefined;
  return validateBundle({ schema_version: "confnote.vault.v1", files, ...(Object.keys(assets).length ? { assets } : {}), ...(privateEncryption ? { privateEncryption } : {}) });
}
/**
 * One conference's text files (agenda, docs, notes) as a bundle. No assets and
 * no encryption parameters: this is what the public site hands a visitor, who
 * merges their browser notes in before saving it as `<slug>.confnote`.
 */
export async function exportConference(storage: StorageAdapter, workspace: string, slug: string): Promise<VaultBundle | null> {
  if (!CONF_RE.test(slug)) return null;
  const prefix = `${workspace}/${slug}/`;
  const files: Record<string, string> = {};
  let bytes = 0;
  for (const item of await storage.list(prefix)) {
    if (!item.path.startsWith(prefix)) continue;
    const name = item.path.slice(workspace.length + 1);
    if (!allowed(name)) continue;
    bytes += item.size;
    if (bytes > MAX_BYTES) throw new Error("Vault bundle exceeds the export limit");
    const content = await storage.readText(item.path); if (content) files[name] = content.text;
  }
  if (!files[`${slug}/agenda.json`]) return null;
  return validateBundle({ schema_version: "confnote.vault.v1", files });
}
/** Import only into a fresh workspace; never overwrite an existing note. */
export async function importVault(storage: StorageAdapter, workspace: string, value: unknown): Promise<number> {
  const bundle = validateBundle(value);
  if ((await storage.list(`${workspace}/`)).length) throw new Error("Import requires an empty workspace");
  for (const [name, content] of Object.entries(bundle.files)) await storage.writeText(`${workspace}/${name}`, content);
  for (const [name, encoded] of Object.entries(bundle.assets || {})) await storage.writeBytes(`${workspace}/${name}`, Buffer.from(encoded, "base64"), assetContentType(name));
  if (bundle.privateEncryption) await storage.writeText(`${workspace}/.confnote/private.json`, JSON.stringify(bundle.privateEncryption));
  return Object.keys(bundle.files).length + Object.keys(bundle.assets || {}).length;
}
