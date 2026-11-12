import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { runHttpConformance } from "../../contracts/http/http-conformance.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));

it("passes the shared HTTP contract through the Python local server", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "confnote-contract-"));
  const python = process.env.CONFNOTE_PYTHON || path.join(repo, "packages/local-app/.venv/bin/python");
  const proc = spawn(python, ["-u", "-c", 'import server; s=server.LocalHTTPServer(("127.0.0.1",0),server.Handler); print(s.server_address[1],flush=True); s.serve_forever()'], {
    cwd: repo,
    env: { ...process.env, PYTHONPATH: path.join(repo, "packages/local-app"), CONF_NOTES_DIR: vault, CONF_NOTES_NO_KEYCHAIN: "1", CONF_NOTES_NOOPEN: "1", CONF_NOTES_NO_NATIVE_NOTIFY: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  proc.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const port = await new Promise<string>((resolve, reject) => {
      const lines = createInterface({ input: proc.stdout });
      lines.once("line", resolve);
      proc.once("error", reject);
      proc.once("exit", (code) => reject(new Error(`Python exited ${code}: ${stderr}`)));
    });
    const origin = `http://127.0.0.1:${port}`;
    const agenda = JSON.parse(await fs.readFile(path.join(repo, "tests/e2e/seed-agenda.json"), "utf8"));
    await runHttpConformance((url, init) => fetch(origin + url, { ...init, headers: { ...init?.headers, Origin: origin, "X-Confnote-Request": "1" } }), agenda);
  } finally {
    proc.kill("SIGTERM");
    await new Promise<void>((resolve) => { if (proc.exitCode !== null) resolve(); else proc.once("exit", () => resolve()); });
    await fs.rm(vault, { recursive: true, force: true });
  }
}, 15000);

it("passes the shared HTTP contract through the web handler with verified fixture identity", async () => {
  const { vi } = await import("vitest");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "confnote-web-contract-"));
  vi.stubEnv("CONFNOTE_STORAGE", "fs");
  vi.stubEnv("CONFNOTE_WEB_DATA_DIR", root);
  vi.stubEnv("CONFNOTE_PUBLIC_DEMO", "0");
  vi.stubEnv("CONFNOTE_PUBLIC_BASE_URL", "https://contract.example");
  vi.stubEnv("CONFNOTE_DATABASE_URL", "");
  vi.resetModules();
  try {
    const { createHandler } = await import("../api/index.js");
    const handler = createHandler({ principal: async () => ({ userId: "contract-user", email: "fixture@example.invalid", emailVerified: true, workspaceId: "contract", role: "owner", authMethod: "email_code", sessionId: "contract-session" }) });
    const agenda = JSON.parse(await fs.readFile(path.join(repo, "tests/e2e/seed-agenda.json"), "utf8"));
    await runHttpConformance(async (url, init) => {
      const parsed = new URL(url, "https://contract.example");
      let code = 200;
      let output: unknown;
      const headers = new Headers();
      const response = {
        status(value: number) { code = value; return this; },
        setHeader(name: string, value: string) { headers.set(name, value); return this; },
        json(value: unknown) { output = value; return this; },
        send(value: unknown) { output = value; return this; },
        end() { return this; },
      };
      const request = {
        method: init?.method || "GET", url, query: Object.fromEntries(parsed.searchParams),
        headers: { host: "contract.example", origin: "https://contract.example", "content-type": "application/json" },
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      await handler(request as Parameters<typeof handler>[0], response as unknown as Parameters<typeof handler>[1]);
      return new Response(JSON.stringify(output), { status: code, headers });
    }, agenda);
  } finally {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 15000);
