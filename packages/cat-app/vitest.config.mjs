import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

// The web app's service imports its storage as "./storage.js"; here, as in build.mjs, that
// is the Cat bridge adapter, so the tests run the same code the Cat page runs.
export default defineConfig({
  resolve: {
    alias: [{ find: /^\.\/storage\.js$/, replacement: path.join(here, "src", "cat-storage.ts") }],
  },
  test: { include: ["test/**/*.test.ts"] },
});
