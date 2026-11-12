import type { CatBridge, CatBridgeReply } from "../src/cat-storage.js";

const MISSING = "File was not found inside the project-folder grant.";

/// The Cat's bridge over an in-memory grant, with the native side's answers: base64 bytes,
/// a JSON entry list for `file.list` (no dotfiles), a refusal for anything missing.
export class FakeCat implements CatBridge {
  readonly files = new Map<string, Uint8Array>();
  readonly operations: string[] = [];

  async request(message: Record<string, unknown>): Promise<CatBridgeReply> {
    const operation = String(message.operation);
    const path = typeof message.path === "string" ? message.path : "";
    this.operations.push(operation);
    switch (operation) {
      case "file.read": {
        const bytes = this.files.get(path);
        if (!bytes) throw new Error(MISSING);
        return { ok: true, data: Buffer.from(bytes).toString("base64") };
      }
      case "file.write":
        this.files.set(path, new Uint8Array(Buffer.from(String(message.data), "base64")));
        return { ok: true };
      case "file.list":
        return { ok: true, data: Buffer.from(JSON.stringify(this.entries(path))).toString("base64") };
      default:
        throw new Error(`Unsupported bridge operation: ${operation}`);
    }
  }

  text(path: string): string | undefined {
    const bytes = this.files.get(path);
    return bytes ? new TextDecoder().decode(bytes) : undefined;
  }

  private entries(dir: string): Array<{ name: string; kind: "file" | "directory" }> {
    const prefix = dir ? `${dir}/` : "";
    const names = new Map<string, "file" | "directory">();
    for (const path of this.files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const [name, ...rest] = path.slice(prefix.length).split("/");
      if (name.startsWith(".")) continue;
      names.set(name, rest.length ? "directory" : "file");
    }
    if (dir && names.size === 0) throw new Error(MISSING);
    return [...names].map(([name, kind]) => ({ name, kind }));
  }
}
