import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(webRoot, "..", "..");

// Only this checked-in synthetic fixture may enter a public demo. No vault path is accepted.
if (process.env.CONFNOTE_PUBLIC_DEMO_SOURCE) {
  throw new Error("Demo preparation accepts only the checked-in demo fixture, never a vault.");
}
const fixture = JSON.parse(await fs.readFile(path.join(webRoot, "demo-fixtures", "agenda.json"), "utf8"));
const demoRoot = path.join(webRoot, "demo-data", "public-demo");
await fs.rm(demoRoot, { recursive: true, force: true });
const dest = path.join(demoRoot, "2099-06-01-demo-event");
await fs.mkdir(dest, { recursive: true });
await fs.writeFile(path.join(dest, "agenda.json"), JSON.stringify(fixture, null, 2) + "\n");
await fs.writeFile(path.join(dest, "README.md"), "# Demo event\n\nFictional seed data for trying confnote.\n");
console.log(`Prepared synthetic public demo from ${path.relative(repoRoot, webRoot)}/demo-fixtures/agenda.json`);
