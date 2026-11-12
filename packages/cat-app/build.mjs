#!/usr/bin/env node
// Builds ConfNote as a Local AI Cat app: core-ui/static as it is, plus only what the Cat's
// sandbox forces (see README.md). Usage: node build.mjs [--out <dir>]
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const coreStatic = path.join(repoRoot, "packages", "core-ui", "static");
const webLib = path.join(repoRoot, "packages", "web-app", "lib");

/// Left out of the Cat build: the Concierge's chat bundle and drawer modules (no network or
/// agent in v1; the drawer stays dormant on an empty module list), the macOS app icons, and
/// the local app's module list (the transport answers it).
const EXCLUDED = new Set(["vendor/deep-chat.bundle.js", "modules", "modules.config.json", "icon.icns", "icon-dev.icns"]);

function outDir() {
  const flag = process.argv.indexOf("--out");
  return path.resolve(flag >= 0 ? process.argv[flag + 1] : path.join(here, "dist", "confnote"));
}

async function copyStatic(source, dest, rel = "") {
  for (const entry of await fs.readdir(path.join(source, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (EXCLUDED.has(child) || entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      await copyStatic(source, dest, child);
    } else {
      await fs.mkdir(path.dirname(path.join(dest, child)), { recursive: true });
      await fs.copyFile(path.join(source, child), path.join(dest, child));
    }
  }
}

/// The page CSP is `script-src 'self'`: each inline script becomes a file of its own, in
/// order. Root paths become relative, since the app lives under /v1/local/apps/confnote/assets/.
export function rewriteIndex(html) {
  const scripts = [];
  let page = html.replace(/<script>([\s\S]*?)<\/script>/g, (_match, body) => {
    scripts.push(body.trim() + "\n");
    return `<script src="inline-${scripts.length}.js"></script>`;
  });
  page = page.replace(/\s*<script type="module" src="\/vendor\/deep-chat\.bundle\.js"><\/script>/, "");
  page = page.replace(/\b(src|href)="\/(?!\/)/g, '$1="');
  page = page.replace(
    /(<meta charset="UTF-8">)/i,
    '$1\n  <script src="cat-boot.js"></script>\n  <script src="transport.js"></script>',
  );
  page = page.replace(
    "</head>",
    '  <!-- The Cat theme (empty when the app\'s settings say "Original"). -->\n  <link rel="stylesheet" href="../theme.css">\n</head>',
  );
  return { html: page, scripts };
}

function sourceCommit() {
  try {
    return execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const catStorage = {
  name: "cat-storage",
  setup(build) {
    build.onResolve({ filter: /^\.\/storage\.js$/ }, (args) =>
      args.importer.startsWith(webLib) ? { path: path.join(here, "src", "cat-storage.ts") } : undefined,
    );
  },
};

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

export async function build(dest = outDir()) {
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(dest, { recursive: true });
  await copyStatic(coreStatic, dest);
  await copyNotices(dest);
  for (const name of ["cat-boot.js", "cat-theme.css"]) {
    await fs.copyFile(path.join(here, "static", name), path.join(dest, name));
  }
  const pkg = JSON.parse(await fs.readFile(path.join(here, "package.json"), "utf8"));
  const manifest = JSON.parse(await fs.readFile(path.join(here, "static", "cat-app.json"), "utf8"));
  manifest.version = pkg.version;
  await fs.writeFile(path.join(dest, "cat-app.json"), JSON.stringify(manifest, null, 2) + "\n");

  const index = rewriteIndex(await fs.readFile(path.join(coreStatic, "index.html"), "utf8"));
  await fs.writeFile(path.join(dest, "index.html"), index.html);
  for (const [offset, body] of index.scripts.entries()) {
    await fs.writeFile(path.join(dest, `inline-${offset + 1}.js`), body);
  }

  let catalogue = { schema_version: "events.catalogue.v2", events: [] };
  if (process.env.CONFNOTE_CATALOGUE_DIR) {
    catalogue = JSON.parse(await fs.readFile(path.join(process.env.CONFNOTE_CATALOGUE_DIR, "index.json"), "utf8"));
    catalogue.catalogue_updated_at = (await fs.stat(path.join(process.env.CONFNOTE_CATALOGUE_DIR, "index.json"))).mtime.toISOString();
    if (catalogue.schema_version !== "events.catalogue.v2" || !Array.isArray(catalogue.events)) throw new Error("Invalid catalogue index");
  }
  await esbuild.build({
    define: { __CONFNOTE_CATALOGUE__: JSON.stringify(catalogue) },
    entryPoints: [path.join(here, "src", "transport.ts")],
    outfile: path.join(dest, "transport.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "safari17",
    legalComments: "eof",
    plugins: [catStorage],
    logLevel: "warning",
  });

  await fs.writeFile(
    path.join(dest, "confnote-build.json"),
    JSON.stringify({ source: "atlascodesai/conferences", commit: sourceCommit(), version: pkg.version }, null, 2) + "\n",
  );
  return dest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dest = await build();
  console.log(dest);
}
