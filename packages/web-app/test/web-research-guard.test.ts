import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// DNS rebinding: the guard's lookup sees a public address, the socket's lookup gets loopback.
const REBIND_HOST = "rebind.confnote.test";
const PUBLIC_ADDRESS = "93.184.216.34";

vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  const lookup = async (hostname: string, options: unknown) =>
    hostname === REBIND_HOST ? [{ address: PUBLIC_ADDRESS, family: 4 }] : actual.lookup(hostname, options as never);
  return { ...actual, default: { ...actual, lookup }, lookup };
});
vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  const lookup = (hostname: string, options: unknown, callback: (...args: unknown[]) => void) =>
    hostname === REBIND_HOST
      ? callback(null, [{ address: "127.0.0.1", family: 4 }])
      : actual.lookup(hostname, options as never, callback as never);
  return { ...actual, default: { ...actual, lookup }, lookup };
});

const { fetchUrlRaw, fetchUrlText, isPrivateAddress } = await import("../lib/webResearch.js");

let server: http.Server;
let port = 0;
let hits = 0;

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    hits += 1;
    res.end("internal secret");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("fetch_url SSRF guard", () => {
  it("refuses a host that rebinds to loopback between the guard and the connection", async () => {
    const result = await fetchUrlText(`http://${REBIND_HOST}:${port}/`);
    expect(result).toMatchObject({ error: expect.stringContaining("private IP") });
    expect(hits).toBe(0);
  });

  it("treats IPv4-mapped, NAT64 and site-local IPv6 forms as private", () => {
    for (const address of ["::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "64:ff9b::7f00:1", "fec0::1", "::", "fd00::1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    expect(isPrivateAddress("2606:4700::1111")).toBe(false);
  });

  it("refuses bracketed private IPv6 literals with the private-address error", async () => {
    await expect(fetchUrlText(`http://[::1]:${port}/`)).resolves.toMatchObject({ error: expect.stringContaining("Private IP") });
    await expect(fetchUrlText(`http://[::ffff:127.0.0.1]:${port}/`)).resolves.toMatchObject({ error: expect.stringContaining("Private IP") });
    expect(hits).toBe(0);
  });
});

describe("fetch_url settles on odd replies", () => {
  it("a 101 upgrade or a reply-less close fails fast instead of hanging past the timeout", async () => {
    // A raw server answering 101, then one that closes without a reply; the public literal passes the guard and the
    // global agent's connection is pointed at it (no lookup runs for an IP literal).
    for (const reply of ["HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n", ""]) {
      const raw = net.createServer((socket) => socket.once("data", () => (reply ? socket.write(reply) : socket.end())));
      await new Promise<void>((resolve) => raw.listen(0, "127.0.0.1", resolve));
      const rawPort = (raw.address() as AddressInfo).port;
      const agent = new http.Agent();
      agent.createConnection = () => net.connect(rawPort, "127.0.0.1");
      const previous = http.globalAgent;
      http.globalAgent = agent;
      try {
        const started = Date.now();
        await expect(fetchUrlRaw(`http://${PUBLIC_ADDRESS}/`)).resolves.toMatchObject({ error: expect.any(String) });
        expect(Date.now() - started).toBeLessThan(2_000);
      } finally {
        http.globalAgent = previous;
        agent.destroy();
        await new Promise<void>((resolve) => raw.close(() => resolve()));
      }
    }
  });
});
