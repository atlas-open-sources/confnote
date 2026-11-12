// Write the gitignored license.local.js (0600) that the module loads before
// the Bryntum bundle.
//
//   node write-license.mjs [target]     default target: ../license.local.js
//
// The key comes from CONFNOTE_BRYNTUM_LICENSE_KEY (the web build's env name)
// or, on macOS, from the login keychain item bryntum-trial-license /
// license_key. It is never printed and never put on a command line.

import { execFileSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const target = resolve(process.argv[2] || resolve(HERE, "..", "license.local.js"));

function keyFromKeychain() {
  if (process.platform !== "darwin") return "";
  try {
    return execFileSync(
      "security",
      ["find-generic-password", "-s", "bryntum-trial-license", "-a", "license_key", "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return "";
  }
}

const key = (process.env.CONFNOTE_BRYNTUM_LICENSE_KEY || "").trim() || keyFromKeychain();
if (!key) {
  console.error("No Bryntum licence key found; the module will run in trial mode.");
  process.exit(1);
}
writeFileSync(target, `(globalThis.bryntum ??= {}).licenseKey = ${JSON.stringify(key)};\n`, {
  mode: 0o600,
});
chmodSync(target, 0o600);
console.log(`wrote ${target} (0600)`);
