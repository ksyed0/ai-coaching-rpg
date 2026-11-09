import http from "node:http";

/**
 * US-0072 (EPIC-0003 voice A1c, Task 8): one HTTP request to 127.0.0.1 or [::1] through `node:http` with a fresh agent (`agent: false`),
 * never `fetch` or the global agent: with NODE_USE_ENV_PROXY both send the full URL, the STT request path or the admin token included,
 * to HTTP_PROXY (batch 1 review A F10). Bounded by `timeoutMs`; the body is read up to `limit` bytes. Never throws, never logs.
 */
export type LoopbackAnswer = { status: number; headers: http.IncomingHttpHeaders; body: string } | null;

export function loopbackRequest(url: URL, o: { method: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; limit?: number }): Promise<LoopbackAnswer> {
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "http:" || !loopback || url.username !== "" || url.password !== "") return Promise.resolve(null);
  const limit = o.limit ?? 64 * 1024;
  return new Promise((resolve) => {
    let done = false;
    const finish = (a: LoopbackAnswer): void => { if (!done) { done = true; resolve(a); } };
    try {
      const req = http.request(url, { method: o.method, agent: false, signal: AbortSignal.timeout(o.timeoutMs ?? 2_000), headers: { connection: "close", ...o.headers } }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const end = (): void => finish({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
        res.on("data", (c: Buffer) => { size += c.length; if (size <= limit) chunks.push(c); else res.destroy(); });
        res.on("end", end);
        res.on("close", end);
        res.on("error", () => finish(null));
      });
      req.on("error", () => finish(null));
      req.end(o.body);
    } catch { finish(null); }
  });
}
