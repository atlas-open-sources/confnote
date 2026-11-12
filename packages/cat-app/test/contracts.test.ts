import fs from "node:fs";
import { it } from "vitest";
import { runHttpConformance } from "../../contracts/http/http-conformance.js";
import { CatBridgeStorage, useStorage } from "../src/cat-storage.js";
import { catFetch } from "../src/transport.js";
import { FakeCat } from "./fake-cat.js";

it("passes the shared HTTP contract through the mocked Cat bridge", async () => {
  useStorage(new CatBridgeStorage(new FakeCat()));
  const agenda = JSON.parse(fs.readFileSync(new URL("../../../tests/e2e/seed-agenda.json", import.meta.url), "utf8"));
  await runHttpConformance(catFetch, agenda);
});
