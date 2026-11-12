import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PublicDemoStorage } from "../lib/storage.js";

async function demoRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "confnote-demo-"));
  for (const [rel, text] of [
    ["public-demo/conf/agenda.json", "{}"],
    ["private-ws/conf/agenda.json", "{\"secret\": true}"],
    ["stray.md", "stray"],
  ]) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), text);
  }
  return root;
}

describe("public demo storage", () => {
  it("serves only the public-demo workspace", async () => {
    const storage = new PublicDemoStorage(await demoRoot());
    expect((await storage.readText("public-demo/conf/agenda.json"))?.text).toBe("{}");
    expect(await storage.readText("private-ws/conf/agenda.json")).toBeNull();
    expect(await storage.readBytes("private-ws/conf/agenda.json")).toBeNull();
    expect(await storage.readText("stray.md")).toBeNull();
    expect(await storage.list("private-ws")).toEqual([]);
    expect(await storage.list("")).toEqual([]);
    expect((await storage.list("public-demo")).map((item) => item.path)).toEqual([
      "public-demo/conf/agenda.json",
    ]);
  });

  it("refuses writes", async () => {
    const storage = new PublicDemoStorage(await demoRoot());
    await expect(storage.writeText()).rejects.toThrow("read-only");
    await expect(storage.writeBytes()).rejects.toThrow("read-only");
  });
});
