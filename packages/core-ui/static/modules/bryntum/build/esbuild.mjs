// Build script for the confnote Bryntum island.
//
// Run `npm ci --ignore-scripts && npm run build` here (or `make bryntum`).
// Bryntum comes from its public npm trial package, pinned with its integrity
// hash in the committed package-lock.json, so no login is needed and no
// dependency install script runs. Outputs:
//   ../vendor/bryntum-island.bundle.js   (IIFE: Scheduler + Calendar)
//   ../vendor/bryntum-island.bundle.css  (structural CSS + dark theme)
//   ../vendor/*.woff2                    (Font Awesome glyphs)
//
// The bundle is Bryntum's commercial trial code, so it is built locally
// and never committed (vendor/ is gitignored) or put in the OSS export.
// The local .app build drops the whole module (packages/local-app/build-macos.sh).

import { build } from "esbuild";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTDIR = resolve(HERE, "..", "vendor");

rmSync(OUTDIR, { recursive: true, force: true });
mkdirSync(OUTDIR, { recursive: true });

await build({
  entryPoints: {
    "bryntum-island.bundle": resolve(HERE, "src", "island.js"),
  },
  bundle: true,
  format: "iife",
  outdir: OUTDIR,
  minify: true,
  sourcemap: false,
  target: ["es2022"],
  legalComments: "none",
  logLevel: "info",
});

await build({
  entryPoints: {
    "bryntum-island.bundle": resolve(HERE, "src", "island.css"),
  },
  bundle: true,
  outdir: OUTDIR,
  loader: { ".woff2": "file", ".woff": "file", ".ttf": "file", ".svg": "file" },
  assetNames: "[name]",
  minify: true,
  legalComments: "none",
  logLevel: "info",
});

// The planner follows confnote's theme toggle: svalbard-light is the default and svalbard-dark applies when
// the app is dark, pinned (data-theme="dark") or following a dark OS (no data-theme="light").
const DARK_PINNED = ':root[data-theme="dark"]';
const DARK_AUTO = ':root:not([data-theme="light"])';
function scopeDark(css, root) {
  const rules = css.replace(/@charset[^;]*;/, "").replace(/\/\*[\s\S]*?\*\//g, "");
  return rules.replace(/([^{}]+)\{([^{}]*)\}/g, (_, selectors, body) => {
    const scoped = selectors
      .split(",")
      .map((s) => s.trim())
      .filter((s) => !s.startsWith(":host"))
      .map((s) => (s.startsWith(":root") ? root + s.slice(":root".length) : `${root} ${s}`));
    return `${scoped.join(",")}{${body}}`;
  });
}
const darkTheme = readFileSync(resolve(HERE, "node_modules/@bryntum/calendar/svalbard-dark.css"), "utf8");
const bundleCss = resolve(OUTDIR, "bryntum-island.bundle.css");
writeFileSync(
  bundleCss,
  readFileSync(bundleCss, "utf8") +
    scopeDark(darkTheme, DARK_PINNED) +
    `@media (prefers-color-scheme: dark){${scopeDark(darkTheme, DARK_AUTO)}}`,
);

// Bryntum's trial install script (skipped by --ignore-scripts) stamps a
// per-install id over the %LICENSE% placeholder; do the same here.
const bundleJs = resolve(OUTDIR, "bryntum-island.bundle.js");
writeFileSync(bundleJs, readFileSync(bundleJs, "utf8").replace(/%LICENSE%/g, randomUUID()));

console.log("built bryntum island bundle ->", OUTDIR);
