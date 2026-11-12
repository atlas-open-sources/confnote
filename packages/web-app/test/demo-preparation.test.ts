import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "confnote-demo-test-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "scripts"));
  await fs.cp(path.resolve(import.meta.dirname, "../scripts/prepare-public-demo.mjs"), path.join(root, "scripts/prepare-public-demo.mjs"));
  await fs.cp(path.resolve(import.meta.dirname, "../demo-fixtures"), path.join(root, "demo-fixtures"), { recursive: true });
  return root;
}

describe("public demo preparation", () => {
  it("replaces generated output with only fictional fixture data", async () => {
    const root = await fixture();
    await fs.mkdir(path.join(root, "demo-data/public-demo/old-real-vault"), { recursive: true });
    await fs.writeFile(path.join(root, "demo-data/public-demo/old-real-vault/secret.md"), "private");
    execFileSync(process.execPath, [path.join(root, "scripts/prepare-public-demo.mjs")], { env: { PATH: process.env.PATH } });
    expect(await fs.readdir(path.join(root, "demo-data/public-demo"))).toEqual(["2099-06-01-demo-event"]);
    const agenda = JSON.parse(await fs.readFile(path.join(root, "demo-data/public-demo/2099-06-01-demo-event/agenda.json"), "utf8"));
    expect(agenda.conference.name).toBe("Demo event");
  });
  it("refuses a vault override before reading or deleting anything", async () => {
    const root = await fixture();
    await fs.mkdir(path.join(root, "demo-data/public-demo"), { recursive: true });
    await fs.writeFile(path.join(root, "demo-data/public-demo/sentinel"), "preserve");
    expect(() => execFileSync(process.execPath, [path.join(root, "scripts/prepare-public-demo.mjs")], { env: { PATH: process.env.PATH, CONFNOTE_PUBLIC_DEMO_SOURCE: "/forbidden-vault" }, stdio: "pipe" })).toThrow();
    expect(await fs.readFile(path.join(root, "demo-data/public-demo/sentinel"), "utf8")).toBe("preserve");
  });
});
