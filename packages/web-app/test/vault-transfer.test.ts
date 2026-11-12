import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PublicDemoStorage } from "../lib/storage.js";
import { MAX_BYTES, exportConference, validateBundle } from "../lib/vault-transfer.js";

const SLUG = "2026-11-05-demo-conf";
const agenda = {
  conference: { name: "Demo", date: "2026-11-05" },
  events: [
    { id: "keynote", title: "Keynote", start: "2026-11-05T09:00:00+08:00", end: "2026-11-05T09:30:00+08:00" },
    { id: "lunch", title: "Lunch", start: "2026-11-05T12:00:00+08:00", end: "2026-11-05T13:00:00+08:00" },
  ],
};

function bundle(files: Record<string, string>, extra: Record<string, unknown> = {}) {
  return {
    schema_version: "confnote.vault.v1",
    files: { [`${SLUG}/agenda.json`]: JSON.stringify(agenda), ...files },
    ...extra,
  };
}

describe("validateBundle", () => {
  it("accepts agenda, docs and notes", () => {
    const ok = bundle({
      [`${SLUG}/README.md`]: "# Demo\n",
      [`${SLUG}/notes/0900-keynote.md`]: "# Keynote\n",
    });
    expect(validateBundle(ok).files[`${SLUG}/notes/0900-keynote.md`]).toBe("# Keynote\n");
  });

  it.each([
    `${SLUG}/../evil.md`,
    `${SLUG}/notes/../../evil.md`,
    `${SLUG}/notes/sub/0900-keynote.md`,
    `../${SLUG}/README.md`,
    `/${SLUG}/README.md`,
    `${SLUG}/notes/0900-keynote.md.bak`,
    `${SLUG}/notes/.hidden.md`,
    `${SLUG}/secrets.env`,
    `${SLUG}/.confnote/private.json`,
    "not-a-slug/README.md",
  ])("refuses the unsafe path %s", (name) => {
    expect(() => validateBundle(bundle({ [name]: "x" }))).toThrow();
  });

  it("refuses a wrong schema, non-string content and a missing agenda", () => {
    expect(() => validateBundle({ schema_version: "confnote.vault.v2", files: {} })).toThrow("Invalid vault bundle");
    expect(() => validateBundle(bundle({ [`${SLUG}/README.md`]: 42 as unknown as string }))).toThrow("Unsafe");
    expect(() =>
      validateBundle({ schema_version: "confnote.vault.v1", files: { [`${SLUG}/README.md`]: "x" } }),
    ).toThrow("Every conference needs an agenda");
  });

  it("refuses an invalid agenda and two events owning one note", () => {
    const bad = { conference: { name: "Demo" }, events: [] };
    expect(() =>
      validateBundle({ schema_version: "confnote.vault.v1", files: { [`${SLUG}/agenda.json`]: JSON.stringify(bad) } }),
    ).toThrow("Invalid vault agenda");
    // A duplicated event id is now an agenda error before ownership is checked.
    const twice = { ...agenda, events: [agenda.events[0], agenda.events[0]] };
    expect(() =>
      validateBundle({ schema_version: "confnote.vault.v1", files: { [`${SLUG}/agenda.json`]: JSON.stringify(twice) } }),
    ).toThrow("Invalid vault agenda");
    const stolen = { ...agenda, events: [agenda.events[0], { ...agenda.events[1], note_file: "0900-keynote.md" }] };
    expect(() =>
      validateBundle({ schema_version: "confnote.vault.v1", files: { [`${SLUG}/agenda.json`]: JSON.stringify(stolen) } }),
    ).toThrow("Invalid vault note ownership");
  });

  it("refuses a bundle over the size cap", () => {
    expect(() => validateBundle(bundle({ [`${SLUG}/README.md`]: "x".repeat(MAX_BYTES) }))).toThrow("import limit");
  });

  it("refuses unsafe assets", () => {
    const asset = (name: string) => bundle({}, { assets: { [name]: Buffer.from("png").toString("base64") } });
    expect(validateBundle(asset(`${SLUG}/notes/assets/0900-keynote/slide.png`)).assets).toBeDefined();
    expect(() => validateBundle(asset(`${SLUG}/notes/assets/0900-keynote/../x.png`))).toThrow("Unsafe vault asset");
    expect(() => validateBundle(asset(`${SLUG}/notes/assets/0900-keynote/.x.png`))).toThrow("Unsafe vault asset");
  });
});

describe("exportConference", () => {
  it("bundles only the conference's text files from the read-only demo", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "confnote-export-"));
    const files: Record<string, string> = {
      [`public-demo/${SLUG}/agenda.json`]: JSON.stringify(agenda),
      [`public-demo/${SLUG}/BRIEF.md`]: "brief\n",
      [`public-demo/${SLUG}/notes/0900-keynote.md`]: "# Keynote\n",
      [`public-demo/${SLUG}/notes/assets/0900-keynote/slide.png`]: "png",
      [`public-demo/${SLUG}/.confnote/modules/tldraw.json`]: "{}",
      [`public-demo/2026-01-01-other/agenda.json`]: JSON.stringify(agenda),
    };
    for (const [rel, text] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await fs.writeFile(path.join(root, rel), text);
    }
    const storage = new PublicDemoStorage(root);
    const out = await exportConference(storage, "public-demo", SLUG);
    expect(Object.keys(out?.files || {}).sort()).toEqual([
      `${SLUG}/BRIEF.md`,
      `${SLUG}/agenda.json`,
      `${SLUG}/notes/0900-keynote.md`,
    ]);
    expect(out?.assets).toBeUndefined();
    expect(await exportConference(storage, "public-demo", "2026-02-02-missing")).toBeNull();
    expect(await exportConference(storage, "public-demo", "../etc")).toBeNull();
  });
});
