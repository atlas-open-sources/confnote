import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { CatBridgeStorage, contentVersion, useStorage } from "../src/cat-storage.js";
import { routes } from "../src/router.js";
import { catFetch } from "../src/transport.js";
import { FakeCat } from "./fake-cat.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const seed = JSON.parse(fs.readFileSync(path.join(repoRoot, "tests", "e2e", "seed-agenda.json"), "utf8"));
const vercelHandler = fs.readFileSync(path.join(repoRoot, "packages", "web-app", "api", "index.ts"), "utf8");

let cat: FakeCat;

async function call(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await catFetch(url, init);
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  cat = new FakeCat();
  useStorage(new CatBridgeStorage(cat));
});

describe("ConfNote's /api inside the Cat", () => {
  it("answers the shared vault routes, with explicit target capabilities", () => {
    const vercel = [...vercelHandler.matchAll(/route === "([^"]+)"/g)].map((match) => match[1]).sort();
    expect(vercel.length).toBeGreaterThan(10);
    for (const route of ["conferences", "conference", "conference/validate", "note", "actions", "conf-doc", "files"]) {
      expect(vercel).toContain(route);
      expect(routes).toHaveProperty(route);
    }
  });

  it("imports an agenda into the grant laid out like a vault, then lists it", async () => {
    const added = await call("/api/conferences", { method: "POST", body: JSON.stringify({ agenda: seed }) });
    expect(added.status).toBe(201);
    expect(added.body.ok).toBe(true);
    const slug = added.body.slug as string;
    expect(cat.text(`${slug}/agenda.json`)).toContain(seed.conference.name);
    expect([...cat.files.keys()].some((key) => key.startsWith(`${slug}/notes/`))).toBe(true);
    expect([...cat.files.keys()].every((key) => !key.startsWith("default/"))).toBe(true);

    const listed = await call("/api/conferences");
    expect(listed.body.map((item: { slug: string }) => item.slug)).toEqual([slug]);
    expect(cat.operations).toContain("file.list");
  });

  it("saves a note and refuses a save over a newer version", async () => {
    const { body: added } = await call("/api/conferences", { method: "POST", body: JSON.stringify({ agenda: seed }) });
    const conference = await call(`/api/conference?slug=${added.slug}`);
    const file = conference.body.events.find((event: { note?: string }) => event.note).note as string;
    const note = await call(`/api/note?slug=${added.slug}&file=${file}`);
    expect(note.status).toBe(200);

    const sections = { "Human notes": "Met the speaker after the talk." };
    const saved = await call(`/api/note?slug=${added.slug}&file=${file}`, {
      method: "PUT",
      body: JSON.stringify({ sections, mtime: note.body.mtime }),
    });
    expect(saved.status).toBe(200);
    expect(cat.text(`${added.slug}/notes/${file}`)).toContain("Met the speaker after the talk.");

    const stale = await call(`/api/note?slug=${added.slug}&file=${file}`, {
      method: "PUT",
      body: JSON.stringify({ sections: { "Human notes": "older edit" }, mtime: note.body.mtime }),
    });
    expect(stale.status).toBe(409);
    expect(cat.text(`${added.slug}/notes/${file}`)).not.toContain("older edit");
  });

  it("gives the two notes a 32-bit hash confused different versions", () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    const first = contentVersion(encode("# Note\n\n## Human notes\n\ne0054536\n"));
    const second = contentVersion(encode("# Note\n\n## Human notes\n\n4260550f\n"));
    expect(first).not.toBe(second);
    expect(Number.isSafeInteger(first)).toBe(true);
  });

  it("treats a missing file as missing, not as an error", async () => {
    expect((await call("/api/conferences")).body).toEqual([]);
    expect((await call("/api/conference?slug=2026-01-01-nothing")).status).toBe(404);
  });

  it("keeps the drawer dormant and refuses the network", async () => {
    expect((await call("/modules.config.json")).body.slots).toEqual([]);
    expect((await call("https://example.com/track")).status).toBe(404);
    expect((await call("/api/chat/session", { method: "POST" })).status).toBe(501);
  });
});

it("reads the same events-data index from the Cat grant without network or account", async () => {
  const index = { schema_version: "events.catalogue.v2", events: [{ id: "community", name: "Community day" }] };
  cat.files.set("catalogue/index.json", new TextEncoder().encode(JSON.stringify(index)));
  expect((await call("/api/catalogue")).body).toEqual(index);
  expect(cat.operations).toContain("file.read");
});
