import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVEKIT_PROBE_TIMEOUT_MS, livekitProbe } from "../../voice/livekit-probe.js";

/**
 * US-0072 (EPIC-0003 voice A1c, Task 11): control's probe of LIVEKIT_HOST: any HTTP answer within 2 s is "LiveKit answers". Real
 * loopback stand-in servers (httpAnswers has no fetch seam, review A F10); the timeout is injected, so nothing waits in real time.
 */
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
const servers: http.Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>((r) => s.close(() => r())); } });

async function serve(handler: http.RequestListener): Promise<number> {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return (s.address() as AddressInfo).port;
}

describe("livekitProbe (US-0072, A1c Task 11)", () => {
  it("is true for any HTTP answer, a 404 included, and asks GET / of the host's origin", async () => {
    const seen: string[] = [];
    const port = await serve((req, res) => { seen.push(`${req.method} ${req.url}`); res.statusCode = 404; res.end("no"); });
    expect(await livekitProbe(new URL(`http://127.0.0.1:${port}`))()).toBe(true);
    expect(seen).toEqual(["GET /"]);
  });

  it("is false when nothing listens", async () => {
    const port = await serve((_req, res) => { res.end(); });
    const s = servers.pop()!;
    await new Promise<void>((r) => s.close(() => r()));
    expect(await livekitProbe(new URL(`http://127.0.0.1:${port}`))()).toBe(false);
  });

  it("waits LIVEKIT_PROBE_TIMEOUT_MS (2 s) at most: a server that never answers is false once the timeout fires", async () => {
    expect(LIVEKIT_PROBE_TIMEOUT_MS).toBe(2000);
    const port = await serve(() => { /* never answers */ });
    const asked: number[] = [];
    const ac = new AbortController();
    const probe = livekitProbe(new URL(`http://127.0.0.1:${port}`), { timeout: (ms) => { asked.push(ms); return ac.signal; } });
    const answer = probe();
    ac.abort();
    expect(await answer).toBe(false);
    expect(asked).toEqual([2000]);
  });

  it("each call is a new probe (a later call sees a server that came back)", async () => {
    let up = false;
    const port = await serve((_req, res) => { if (up) res.end(); else res.socket?.destroy(); });
    const probe = livekitProbe(new URL(`http://127.0.0.1:${port}`));
    expect(await probe()).toBe(false);
    up = true;
    expect(await probe()).toBe(true);
  });
});
