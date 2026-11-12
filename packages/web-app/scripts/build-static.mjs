import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");
const repoRoot = path.resolve(webRoot, "..", "..");
const dest = path.join(webRoot, "public");
const publicDemo = process.env.CONFNOTE_PUBLIC_DEMO !== "0";
const sourceCandidates = [
  process.env.CONFNOTE_CORE_STATIC_DIR,
  path.join(repoRoot, "packages", "core-ui", "static"),
].filter(Boolean);

async function firstExistingDirectory(paths) {
  for (const candidate of paths) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) {
        return candidate;
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  throw new Error(`No static source found. Checked: ${paths.join(", ")}`);
}

// Bryntum's bundle is never committed: build it from the public npm trial package into the copied module
// when the source has none (a clean clone, Vercel). `npm ci` installs exactly the committed lockfile (pinned
// versions and integrity hashes) with every install script off; our own esbuild step then runs explicitly.
async function buildBryntumBundle(moduleDir) {
  const manifest = await fs.stat(path.join(moduleDir, "manifest.json")).catch(() => null);
  if (!manifest) return;
  const bundle = await fs.stat(path.join(moduleDir, "vendor", "bryntum-island.bundle.js")).catch(() => null);
  if (bundle) return;
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const build = path.join(moduleDir, "build");
  execFileSync(npm, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: build, stdio: "inherit" });
  execFileSync(process.execPath, [path.join(build, "esbuild.mjs")], { cwd: build, stdio: "inherit" });
}

// Preserve original notice paths. Catalogue notices travel with the published snapshot.
async function copyNotices(dest) {
  for (const name of ["LICENSE", "NOTICE", "licenses", "packages/events-model/LICENSE"]) {
    await fs.mkdir(path.dirname(path.join(dest, name)), { recursive: true });
    await fs.cp(path.join(repoRoot, name), path.join(dest, name), { recursive: true });
  }
  if (!process.env.CONFNOTE_CATALOGUE_DIR) return;
  const directory = path.resolve(process.env.CONFNOTE_CATALOGUE_DIR);
  const sources = [directory];
  // Compatibility with events-data's original dist layout; never search arbitrary ancestors.
  if (path.basename(directory) === "dist") sources.push(path.dirname(directory));
  for (const name of ["ATTRIBUTION.md", "LICENSE", "confs-tech-LICENSE", "geonames-sources.json"]) {
    for (const source of sources) {
      try {
        await fs.mkdir(path.join(dest, "catalogue"), { recursive: true });
        await fs.copyFile(path.join(source, name), path.join(dest, "catalogue", name));
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
}

// Hosted builds bundle the published catalogue snapshot so the function can read it (lib/catalogue.ts).
async function bundleCatalogue() {
  const bundled = path.join(webRoot, "catalogue-data");
  await fs.rm(bundled, { recursive: true, force: true });
  if (!process.env.CONFNOTE_CATALOGUE_DIR) return;
  const index = path.join(path.resolve(process.env.CONFNOTE_CATALOGUE_DIR), "index.json");
  if (!(await fs.stat(index).catch(() => null))) return;
  await fs.mkdir(bundled, { recursive: true });
  await fs.copyFile(index, path.join(bundled, "index.json"));
}

await fs.rm(dest, { recursive: true, force: true });
await bundleCatalogue();
const source = await firstExistingDirectory(sourceCandidates);
await fs.cp(source, dest, { recursive: true });
// Site-only pages (the /download page) live beside the web app, never in the Mac app.
const site = await firstExistingDirectory([path.join(webRoot, "site")]).catch(() => null);
if (site) await fs.cp(site, dest, { recursive: true });
// Vendor modules ship on the web only by explicit allowlist. AG Grid Community is MIT and always ships;
// Bryntum ships built from its public npm trial package (licensed when the key is set). tldraw needs a
// licence key in production and shows its watermark without one, so it ships only when a deploy asks for it
// with CONFNOTE_TLDRAW=1; the OSS export never sets it. scripts/deploy-web.sh sets CONFNOTE_TLDRAW=1 and
// CONFNOTE_BRYNTUM=1 for both hosts during the PayPal AI Hackathon judging period (musa, 2026-11-13);
// CONFNOTE_BRYNTUM=0 still leaves Bryntum out of a build.
const VENDOR_MODULES = ["tldraw", "ag-grid", "aggrid", "bryntum"];
const webVendorModules = ["aggrid"];
if (process.env.CONFNOTE_BRYNTUM !== "0") webVendorModules.push("bryntum");
if (process.env.CONFNOTE_TLDRAW === "1") webVendorModules.push("tldraw");
if (webVendorModules.includes("bryntum")) await buildBryntumBundle(path.join(dest, "modules", "bryntum"));
for (const vendor of VENDOR_MODULES) {
  if (webVendorModules.includes(vendor)) continue;
  await fs.rm(path.join(dest, "modules", vendor), { recursive: true, force: true });
}
const shippedVendorSlots = [];
for (const vendor of webVendorModules) {
  const present = await fs.stat(path.join(dest, "modules", vendor, "manifest.json")).catch(() => null);
  if (present) shippedVendorSlots.push(vendor);
}
if (shippedVendorSlots.includes("bryntum")) {
  const bryntum = path.join(dest, "modules", "bryntum");
  if (process.env.CONFNOTE_BRYNTUM_LICENSE_KEY) {
    // The licence key ships in browser JS by design; the module's own script writes it and never prints it.
    const writer = path.join(source, "modules", "bryntum", "build", "write-license.mjs");
    execFileSync(process.execPath, [writer, path.join(bryntum, "license.local.js")], { stdio: "inherit" });
  } else {
    // A source checkout may hold a developer's local key file; without the env the web build runs in trial mode.
    await fs.rm(path.join(bryntum, "license.local.js"), { force: true });
  }
  // Bundle sources and build scripts stay out of the public site.
  await fs.rm(path.join(bryntum, "build"), { recursive: true, force: true });
}
if (shippedVendorSlots.includes("tldraw")) {
  // The prebuilt island ships; its React sources and build script stay out of the public site.
  await fs.rm(path.join(dest, "modules", "tldraw", "build"), { recursive: true, force: true });
}

const indexPath = path.join(dest, "index.html");
let index = await fs.readFile(indexPath, "utf8");
// The flags go before product-shell.js in <head>, so the shell knows it is the hosted site before app.js loads.
index = index.replace(
  '<script src="/product-shell.js"></script>',
  `<script>window.confnote = window.confnote || {}; window.confnote.webMode = true; window.confnote.publicDemo = ${JSON.stringify(publicDemo)};</script>\n  <script src="/product-shell.js"></script>`,
);
// The site shows the Mac app link from the first paint; unhiding it from app.js made the top bar jump.
index = index.replace('<a id="getMacApp" class="get-mac-app" href="/download" hidden>', '<a id="getMacApp" class="get-mac-app" href="/download">');
await fs.writeFile(indexPath, index);

await fs.writeFile(
  path.join(dest, "modules.config.json"),
  JSON.stringify(
    {
      _comment:
        "Web build ships the allowlisted vendor modules and the Concierge. Note editing remains read-only in public-demo mode.",
      slots: [...shippedVendorSlots, "chat"],
      primitive_override: {},
    },
    null,
    2,
  ) + "\n",
);

// Public catalogue assets read the same generated events-data dist contract.
await fs.cp(path.join(repoRoot, "packages", "catalogue-web", "static"), path.join(dest, "catalogue"), { recursive: true });

await copyNotices(dest);

// The unlisted /demo page plays a recorded video that stays out of git; a deploy names the folder holding it.
if (process.env.CONFNOTE_DEMO_MEDIA_DIR) {
  await fs.cp(path.resolve(process.env.CONFNOTE_DEMO_MEDIA_DIR), path.join(dest, "media"), { recursive: true });
}
