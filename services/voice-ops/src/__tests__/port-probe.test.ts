import dgram from "node:dgram";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STT_PORT_MAX, STT_PORT_MIN } from "../env-file.js";
import { drawSttPort, portFree } from "../port-probe.js";

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

describe("drawSttPort (PR #135 CodeQL js/biased-cryptographic-random)", () => {
  /** A random source that hands out the given 16-bit values in order. */
  const source = (values: number[]) => { const left = [...values]; return (n: number): Buffer => { expect(n).toBe(2); const b = Buffer.alloc(2); b.writeUInt16BE(left.shift()!, 0); return b; }; };

  it("maps an accepted 16-bit draw onto 20000..32767 without modulo bias: values at or above the largest multiple of the range are redrawn", () => {
    const range = STT_PORT_MAX - STT_PORT_MIN + 1; // 12768
    const limit = 65536 - (65536 % range); // 63840: five whole copies of the range
    expect(drawSttPort(source([0]))).toBe(STT_PORT_MIN);
    expect(drawSttPort(source([4]))).toBe(STT_PORT_MIN);
    expect(drawSttPort(source([5]))).toBe(STT_PORT_MIN + 1);
    expect(drawSttPort(source([limit - 1]))).toBe(STT_PORT_MAX);
    expect(drawSttPort(source([limit, 65535, 5]))).toBe(STT_PORT_MIN + 1); // two rejected draws, then 5
  });

  it("every value of the range is hit equally often over all accepted draws", () => {
    const counts = new Map<number, number>();
    const range = STT_PORT_MAX - STT_PORT_MIN + 1;
    for (let v = 0; v < 65536; v++) {
      const b = Buffer.alloc(2); b.writeUInt16BE(v, 0);
      let first = true;
      const p = drawSttPort(() => { if (first) { first = false; return b; } const z = Buffer.alloc(2); return z; });
      if (v < 65536 - (65536 % range)) counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    expect(counts.size).toBe(range);
    expect(new Set(counts.values())).toEqual(new Set([5]));
  });
});
