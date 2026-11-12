import { describe, expect, it } from "vitest";
import { AddressCap, bearerGate, clientAddress } from "../src/gate.js";

describe("bearerGate", () => {
  it("asks the Router once per token per minute and caches both answers", async () => {
    const calls: string[] = [];
    let clock = 0;
    const gate = bearerGate({
      routerBase: "https://router.test",
      now: () => clock,
      fetcher: async (url, init) => {
        calls.push(`${url} ${init.headers.authorization}`);
        return { status: init.headers.authorization === "Bearer good" ? 200 : 401 };
      },
    });
    expect(await gate.allows("good")).toBe(true);
    expect(await gate.allows("good")).toBe(true);
    expect(await gate.allows("bad")).toBe(false);
    expect(await gate.allows("bad")).toBe(false);
    expect(calls).toEqual(["https://router.test/v1/wallet/packs Bearer good", "https://router.test/v1/wallet/packs Bearer bad"]);
    clock = 61_000;
    expect(await gate.allows("good")).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it("fails closed when the Router cannot be reached", async () => {
    const gate = bearerGate({ routerBase: "https://router.test", fetcher: async () => { throw new Error("down"); } });
    expect(await gate.allows("any")).toBe(false);
  });

  it("shares one Router call between concurrent checks of the same token", async () => {
    let calls = 0;
    const gate = bearerGate({ routerBase: "https://router.test", fetcher: async () => { calls += 1; return { status: 200 }; } });
    await Promise.all([gate.allows("t"), gate.allows("t"), gate.allows("t")]);
    expect(calls).toBe(1);
  });
});

describe("AddressCap", () => {
  it("caps open sockets per address and frees a slot on close", () => {
    const cap = new AddressCap(2);
    expect(cap.take("1.2.3.4")).toBe(true);
    expect(cap.take("1.2.3.4")).toBe(true);
    expect(cap.take("1.2.3.4")).toBe(false);
    expect(cap.take("5.6.7.8")).toBe(true);
    cap.give("1.2.3.4");
    expect(cap.take("1.2.3.4")).toBe(true);
  });

  it("reads the client from x-forwarded-for, else the socket", () => {
    expect(clientAddress("9.9.9.9, 10.0.0.1", "10.0.0.2")).toBe("9.9.9.9");
    expect(clientAddress(undefined, "10.0.0.2")).toBe("10.0.0.2");
  });
});
