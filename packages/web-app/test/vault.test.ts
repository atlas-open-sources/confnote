import { expect, it } from "vitest";
import { exportVault, importVault, validateBundle } from "../lib/vault-transfer.js";
import type { StorageAdapter } from "../lib/storage.js";
it("round trips agenda and Markdown; excludes private configuration and refuses traversal or overwrite", async () => {
  const slug = "2099-01-01-fixture";
  const bundle = { schema_version: "confnote.vault.v1", files: { [`${slug}/agenda.json`]: JSON.stringify({ conference: { name: "Fixture", date: "2099-01-01" }, events: [] }), [`${slug}/notes/session-talk.md`]: "# Human note\n\nKeep exactly.\n" } };
  const files = new Map<string, string>();
  const storage: StorageAdapter = { readText: async (key) => files.has(key) ? { text: files.get(key) || "", mtime: 1 } : null, readBytes: async () => null, writeText: async (key, text) => { files.set(key, text); return { text, mtime: 1 }; }, writeBytes: async () => ({ text: "", mtime: 1 }), list: async (prefix) => [...files].filter(([key]) => key.startsWith(prefix)).map(([path, text]) => ({ path, size: text.length, mtime: 1 })) };
  await importVault(storage, "owned", bundle);
  files.set("owned/.env", "not-exported");
  expect(await exportVault(storage, "owned")).toEqual(bundle);
  await expect(importVault(storage, "owned", bundle)).rejects.toThrow("empty workspace");
  expect(() => validateBundle({ ...bundle, files: { ...bundle.files, [`${slug}/../secret.md`]: "bad" } })).toThrow("Unsafe");
});

it("refuses a vault agenda that aliases another session's note", () => {
  const agenda = { conference: { name: "Fixture", date: "2099-01-01" }, events: [{ id: "one", title: "One", start: "2099-01-01T09:00:00Z", end: "2099-01-01T10:00:00Z", note_file: "session-other.md" }] };
  expect(() => validateBundle({ schema_version: "confnote.vault.v1", files: { "2099-01-01-fixture/agenda.json": JSON.stringify(agenda) } })).toThrow("ownership");
});
it("preserves binary attachments and encrypted Private section bytes across workspaces", async () => {
  const fs = await import("node:fs/promises"); const os = await import("node:os"); const path = await import("node:path");
  const { createStorage } = await import("../lib/storage.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "confnote-vault-assets-"));
  const old = process.env.CONFNOTE_WEB_DATA_DIR; process.env.CONFNOTE_WEB_DATA_DIR = root;
  try {
    const storage = createStorage();
    const slug = "2099-01-01-fixture";
    const note = "# Notes\n\n## Private\n\nENC[v1:AAECAwQF:unchanged]\n";
    const bytes = Buffer.from([0, 255, 128, 13, 10, 42]);
    const asset = `${slug}/notes/assets/session-talk/slide.png`;
    await storage.writeText(`source/${slug}/agenda.json`, JSON.stringify({ conference: { name: "Fixture", date: "2099-01-01" }, events: [] }));
    await storage.writeText(`source/${slug}/notes/session-talk.md`, note);
    await storage.writeBytes(`source/${asset}`, bytes, "image/png");
    const bundle = await exportVault(storage, "source");
    expect(bundle.assets?.[asset]).toBe(bytes.toString("base64"));
    await importVault(storage, "destination", bundle);
    expect((await storage.readBytes(`destination/${asset}`))?.bytes).toEqual(bytes);
    expect((await storage.readText(`destination/${slug}/notes/session-talk.md`))?.text).toBe(note);
    expect(() => validateBundle({ ...bundle, assets: { [`${slug}/notes/assets/../../secret`]: "AA==" } })).toThrow("Unsafe");
  } finally { if (old === undefined) delete process.env.CONFNOTE_WEB_DATA_DIR; else process.env.CONFNOTE_WEB_DATA_DIR = old; await fs.rm(root, { recursive: true, force: true }); }
});
it("exports only non-secret encryption parameters so transferred Private notes remain decryptable", async () => {
  const fs = await import("node:fs/promises"); const os = await import("node:os"); const path = await import("node:path");
  const { createStorage } = await import("../lib/storage.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "confnote-private-transfer-"));
  const old = process.env.CONFNOTE_WEB_DATA_DIR; process.env.CONFNOTE_WEB_DATA_DIR = root;
  try {
    const storage = createStorage(); const slug = "2099-01-01-fixture";
    const salt = crypto.getRandomValues(new Uint8Array(16)); const iv = crypto.getRandomValues(new Uint8Array(12));
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode("synthetic passphrase"), "PBKDF2", false, ["deriveKey"]);
    const derive = (bytes: Uint8Array<ArrayBuffer>) => crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: bytes, iterations: 200000 }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const key = await derive(salt);
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode("Private fixture text"));
    const meta = { v: 1 as const, salt: Buffer.from(salt).toString("base64"), iterations: 200000, kdf: "PBKDF2-SHA256" as const, verifier_iv: Buffer.from(iv).toString("base64"), verifier_ct: Buffer.from(encrypted).toString("base64") };
    await storage.writeText(`source/${slug}/agenda.json`, JSON.stringify({ conference: { name: "Fixture", date: "2099-01-01" }, events: [] }));
    await storage.writeText("source/.confnote/private.json", JSON.stringify(meta));
    const bundle = await exportVault(storage, "source");
    expect(bundle.privateEncryption).toEqual(meta);
    await importVault(storage, "destination", bundle);
    const restored = JSON.parse((await storage.readText("destination/.confnote/private.json"))?.text || "{}");
    const restoredKey = await derive(new Uint8Array(Buffer.from(restored.salt, "base64")));
    const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(Buffer.from(restored.verifier_iv, "base64")) }, restoredKey, new Uint8Array(Buffer.from(restored.verifier_ct, "base64")));
    expect(new TextDecoder().decode(clear)).toBe("Private fixture text");
    expect(() => validateBundle({ ...bundle, privateEncryption: { ...meta, key: "must never export" } })).toThrow("parameters");
  } finally { if (old === undefined) delete process.env.CONFNOTE_WEB_DATA_DIR; else process.env.CONFNOTE_WEB_DATA_DIR = old; await fs.rm(root, { recursive: true, force: true }); }
});
