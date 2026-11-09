import dgram from "node:dgram";
import { afterAll, describe, expect, it, vi } from "vitest";
import { makeResolver, DNS_RESOLVER_OPTIONS } from "../checks/dns.js";
import { installSignals, lastLine } from "../signals.js";

// US-0072 (review B2 F6): the CLI's signal handling with injected seams (no real signal is sent here), and the DNS resolver's bound
// against a real loopback UDP socket that never answers.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

function fakeProcess() {
  const handlers = new Map<string, () => void>();
  const exits: number[] = [];
  return { handlers, exits, on: (sig: NodeJS.Signals, fn: () => void) => { handlers.set(sig, fn); }, exit: (code: number) => { exits.push(code); } };
}

describe("installSignals", () => {
  it("up: the first SIGINT or SIGTERM fires the interrupt once, later ones are ignored, nothing exits early", () => {
    const p = fakeProcess();
    const hub = installSignals({ cmd: "up", on: p.on, exit: p.exit });
    const fired: string[] = [];
    hub.onInterrupt(() => fired.push("a"));
    p.handlers.get("SIGTERM")!();
    p.handlers.get("SIGINT")!();
    p.handlers.get("SIGTERM")!();
    expect(fired).toEqual(["a"]);
    expect(hub.signal()).toBe("SIGTERM");
    expect(p.exits).toEqual([]);
  });

  it("up: a handler added after the signal still runs (on a microtask), and the unhook removes it", async () => {
    const p = fakeProcess();
    const hub = installSignals({ cmd: "up", on: p.on, exit: p.exit });
    const fired: string[] = [];
    const off = hub.onInterrupt(() => fired.push("early"));
    off();
    p.handlers.get("SIGINT")!();
    hub.onInterrupt(() => fired.push("late"));
    await Promise.resolve();
    expect(fired).toEqual(["late"]);
  });

  it.each([["down"], ["check"], ["timings"], [undefined]])("%s exits at the first signal: 130 for SIGINT, 143 for SIGTERM", (cmd) => {
    for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
      const p = fakeProcess();
      const hub = installSignals({ cmd, on: p.on, exit: p.exit });
      p.handlers.get(sig)!();
      expect(p.exits).toEqual([code]);
      expect(hub.signal()).toBe(sig);
    }
  });
});

// Review B2 F3: "rolled back" only after a rollback that completed, and only for voice:up.
describe("lastLine", () => {
  it("names what really happened", () => {
    expect(lastLine("up", null, "complete")).toBeNull();
    expect(lastLine("up", "SIGINT", "complete")).toBe("voice-ops: interrupted by SIGINT: what this run started has been rolled back");
    expect(lastLine("up", "SIGTERM", "incomplete")).toBe("voice-ops: interrupted by SIGTERM: the rollback is incomplete: run pnpm voice:down");
    expect(lastLine("up", "SIGINT", "none")).toBe("voice-ops: interrupted by SIGINT: this run started nothing");
    for (const cmd of ["down", "check", "timings", undefined]) expect(lastLine(cmd, "SIGINT", "none")).toBeNull();
  });
});

describe("the DNS resolver of voice:check", () => {
  const socks: dgram.Socket[] = [];
  afterAll(() => { for (const s of socks) s.close(); });

  it("is bounded: a DNS server that never answers is given up on (timeout 3 s, 2 tries) instead of the default minute and more", async () => {
    expect(DNS_RESOLVER_OPTIONS).toEqual({ timeout: 3_000, tries: 2 });
    const seen: unknown[] = [];
    class Spy { constructor(o: unknown) { seen.push(o); } }
    makeResolver(Spy as unknown as Parameters<typeof makeResolver>[0]);
    expect(seen).toEqual([{ timeout: 3_000, tries: 2 }]);
    const sock = dgram.createSocket("udp4");
    socks.push(sock);
    await new Promise<void>((r) => sock.bind(0, "127.0.0.1", () => r()));
    const port = sock.address().port;
    const resolver = makeResolver();
    resolver.setServers([`127.0.0.1:${port}`]);
    await expect(resolver.resolve4("voice.pilot.example")).rejects.toMatchObject({ code: "ETIMEOUT" });
  });
});
