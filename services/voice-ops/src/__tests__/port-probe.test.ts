import dgram from "node:dgram";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { portFree } from "../port-probe.js";

// US-0072 (review B2 F10): the port probe of voice:up and voice:check against REAL loopback listeners. libuv sets SO_REUSEADDR on TCP
// listeners, and on macOS (BSD rules) that lets a probe bind 127.0.0.1:<p> while ANOTHER socket listens on the wildcard 0.0.0.0:<p> or
// [::]:<p>: the bind alone said "free" for a port that is taken. A connect to the target catches any listener that accepts there.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const open: { close: () => void }[] = [];
afterEach(() => { for (const s of open.splice(0)) s.close(); });

function listen(host: string): Promise<number | null> {
  return new Promise((resolve) => {
    const s = net.createServer((c) => c.destroy());
    s.once("error", () => resolve(null));
    s.listen({ host, port: 0 }, () => { open.push(s); resolve((s.address() as net.AddressInfo).port); });
  });
}

describe("portFree", () => {
  it("a port nobody holds is free", async () => {
    const p = await listen("127.0.0.1");
    open.splice(0).forEach((s) => s.close());
    await new Promise((r) => setImmediate(r));
    expect(await portFree("127.0.0.1", p!, "tcp")).toBe("free");
  });

  it("a listener on the same address is taken", async () => {
    const p = await listen("127.0.0.1");
    expect(await portFree("127.0.0.1", p!, "tcp")).toBe("taken");
  });

  it("a listener on the IPv4 wildcard 0.0.0.0 is taken for 127.0.0.1", async () => {
    const p = await listen("0.0.0.0");
    expect(await portFree("127.0.0.1", p!, "tcp")).toBe("taken");
  });

  it("a listener on the IPv6 wildcard [::] (dual stack) is taken for 127.0.0.1", async (ctx) => {
    const p = await listen("::");
    if (p === null) { ctx.skip(); return; } // this machine has no IPv6 loopback stack: nothing to test
    expect(await portFree("127.0.0.1", p, "tcp")).toBe("taken");
  });

  it("a UDP socket on the wildcard is taken for 127.0.0.1", async () => {
    const sock = dgram.createSocket("udp4");
    await new Promise<void>((r) => sock.bind(0, "0.0.0.0", () => r()));
    open.push(sock);
    expect(await portFree("127.0.0.1", sock.address().port, "udp")).toBe("taken");
  });
});
