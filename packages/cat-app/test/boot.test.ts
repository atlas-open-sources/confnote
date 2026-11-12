import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const boot = fs.readFileSync(path.join(here, "..", "static", "cat-boot.js"), "utf8");

/// A window like the Cat's sandboxed page: an opaque origin, where reading localStorage throws.
function sandboxedWindow(): Record<string, any> {
  const window: Record<string, any> = { document: { documentElement: { dataset: {} } } };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get() {
      throw new Error("SecurityError: The operation is insecure.");
    },
  });
  window.window = window;
  return window;
}

describe("cat-boot.js", () => {
  it("gives the opaque origin a working localStorage", () => {
    const window = sandboxedWindow();
    vm.runInNewContext(boot, window);
    window.localStorage.setItem("confnote-theme", "dark");
    expect(window.localStorage.getItem("confnote-theme")).toBe("dark");
  });

  it("suppresses the Concierge button before app.js runs", () => {
    const window = sandboxedWindow();
    vm.runInNewContext(boot, window);
    expect(window.confnote.fab.suppressed).toBe(true);
    expect(window.confnote.catMode).toBe(true);
  });
});
