import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { build, rewriteIndex } from "../build.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const coreStatic = path.resolve(here, "..", "..", "core-ui", "static");
let dest: string;

beforeAll(async () => {
  dest = await build(path.join(await fs.mkdtemp(path.join(os.tmpdir(), "confnote-cat-")), "confnote"));
}, 60_000);

describe("the Cat build", () => {
  it("keeps ConfNote's own UI files byte for byte", async () => {
    for (const name of ["app.js", "style.css", "settings.js", "drawer.js", "vendor/easymde.min.js"]) {
      const built = await fs.readFile(path.join(dest, name));
      expect(built.equals(await fs.readFile(path.join(coreStatic, name))), name).toBe(true);
    }
  });

  it("has no inline script, no root path and no chat bundle in its page", async () => {
    const html = await fs.readFile(path.join(dest, "index.html"), "utf8");
    expect(html).not.toMatch(/<script>/);
    expect(html).not.toMatch(/\b(?:src|href)="\/(?!\/)/);
    expect(html).not.toContain("deep-chat");
    expect(html.indexOf("cat-boot.js")).toBeLessThan(html.indexOf("inline-1.js"));
    expect(html.indexOf("transport.js")).toBeLessThan(html.indexOf("app.js"));
    expect(html).toContain('href="../theme.css"');
    await expect(fs.stat(path.join(dest, "vendor", "deep-chat.bundle.js"))).rejects.toThrow();
  });

  it("writes a manifest whose entry, original and Cat stylesheets exist", async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(dest, "cat-app.json"), "utf8"));
    expect(manifest.id).toBe("confnote");
    for (const file of [manifest.entry, manifest.theme.original, manifest.theme.cat, "transport.js"]) {
      await expect(fs.stat(path.join(dest, file))).resolves.toBeTruthy();
    }
    // The Cat paints its window chrome from these; a re-vendor must not drop them.
    expect(manifest.theme.chrome).toEqual({ light: "#ffffff", dark: "#000000" });
    const provenance = JSON.parse(await fs.readFile(path.join(dest, "confnote-build.json"), "utf8"));
    expect(provenance.commit).toMatch(/^[0-9a-f]{40}$|^unknown$/);
  });

  it("retains application, model and vendor license notices", async () => {
    const root = path.resolve(here, "../../..");
    for (const name of ["LICENSE", "NOTICE", "packages/events-model/LICENSE", "licenses/CC-BY-4.0.txt", "licenses/vendor/EasyMDE-MIT.txt", "licenses/VENDOR-NOTICES.md"]) {
      expect(await fs.readFile(path.join(dest, name), "utf8")).toBe(await fs.readFile(path.join(root, name), "utf8"));
    }
    await expect(fs.stat(path.join(dest, "modules", "tldraw"))).rejects.toThrow();
  });

  it("moves inline scripts out in order", () => {
    const { html, scripts } = rewriteIndex('<head><meta charset="UTF-8"><script>a()</script><script>b()</script></head>');
    expect(scripts).toEqual(["a()\n", "b()\n"]);
    expect(html).toContain('<script src="inline-1.js"></script><script src="inline-2.js"></script>');
  });
});

it.each([false, true])("embeds the catalogue with attribution (parent layout: %s)", async (parentLayout) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "confnote-cat-catalogue-"));
  const source = path.join(directory, "dist");
  await fs.mkdir(source);
  const previous = process.env.CONFNOTE_CATALOGUE_DIR;
  try {
    await fs.writeFile(path.join(source, "index.json"), JSON.stringify({ schema_version: "events.catalogue.v2", events: [{ id: "snapshot-proof", name: "Build snapshot proof" }] }));
    for (const name of ["ATTRIBUTION.md", "LICENSE", "confs-tech-LICENSE", "geonames-sources.json"]) {
      await fs.writeFile(path.join(parentLayout ? directory : source, name), `Catalogue notice: ${name}`);
    }
    process.env.CONFNOTE_CATALOGUE_DIR = source;
    const built = await build(path.join(directory, "built"));
    const transport = await fs.readFile(path.join(built, "transport.js"), "utf8");
    expect(transport).toContain("Build snapshot proof");
    expect(transport).toContain("catalogue_updated_at");
    for (const name of ["ATTRIBUTION.md", "LICENSE", "confs-tech-LICENSE", "geonames-sources.json"]) {
      expect(await fs.readFile(path.join(built, "catalogue", name), "utf8")).toBe(`Catalogue notice: ${name}`);
    }
  } finally {
    if (previous === undefined) delete process.env.CONFNOTE_CATALOGUE_DIR;
    else process.env.CONFNOTE_CATALOGUE_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
