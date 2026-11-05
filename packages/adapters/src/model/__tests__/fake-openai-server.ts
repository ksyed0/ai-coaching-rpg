import http from "node:http";
import type { AddressInfo } from "node:net";

export type Mode =
  | { kind: "stream" } // OpenAI-style SSE; long reply (500 numbers, slow) when max_tokens >= 1000, else "OK"
  | { kind: "json"; content: string; contentType?: string }
  | { kind: "error"; status: number; body: string; contentType?: string; headers?: Record<string, string> }
  | { kind: "reset" } // destroy the socket without answering (connection reset)
  | { kind: "raw"; chunks: (string | Buffer)[]; contentType?: string; delayMs?: number; end?: boolean } // exact bytes, fragment by fragment
  | { kind: "redirect"; location: string }
  | { kind: "hang" }; // headers + one chunk, then silence until the client leaves

export type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };

export const delta = (content: string | null | undefined) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: content === undefined ? {} : { content } }] })}\n\n`;

/** An SSE delta from a reasoning model: the thinking arrives in `reasoning_content` (or `reasoning`), the answer in `content`. */
export const reasoningDelta = (text: string, field: "reasoning_content" | "reasoning" = "reasoning_content", finish?: string) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { [field]: text }, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`;

export type FakeServer = {
  url: string; // http://127.0.0.1:<port>/v1
  host: string; // 127.0.0.1:<port>
  requests: Seen[];
  mode: Mode;
  /** Modes consumed first, one per request (then `mode` applies): script "fail twice, then succeed". */
  queue: Mode[];
  closedConnections(): number;
  waitForClose(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startFakeServer(initial: Mode = { kind: "stream" }): Promise<FakeServer> {
  const requests: Seen[] = [];
  let closed = 0;
  const waiters: (() => void)[] = [];
  const srv: FakeServer = {
    url: "", host: "", requests, mode: initial, queue: [],
    closedConnections: () => closed,
    waitForClose: (timeoutMs = 2_000) => new Promise((resolve, reject) => {
      if (closed > 0) return resolve();
      const t = setTimeout(() => reject(new Error("server never saw the client connection close")), timeoutMs);
      waiters.push(() => { clearTimeout(t); resolve(); });
    }),
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => void respond(Buffer.concat(chunks).toString("utf8")));
    // Count only responses cut off by the client (not ones we finished ourselves).
    res.on("close", () => { if (!res.writableFinished) { closed++; for (const w of waiters.splice(0)) w(); } });
    async function respond(body: string): Promise<void> {
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      const m = srv.queue.shift() ?? srv.mode;
      const alive = () => !res.destroyed && !res.writableEnded;
      switch (m.kind) {
        case "error":
          res.writeHead(m.status, { "Content-Type": m.contentType ?? "application/json", ...m.headers }); res.end(m.body); return;
        case "reset":
          req.socket.destroy(); return;
        case "json":
          res.writeHead(200, { "Content-Type": m.contentType ?? "application/json" }); res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: m.content } }] })); return;
        case "redirect":
          res.writeHead(302, { Location: m.location }); res.end(); return;
        case "hang":
          res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(delta("first")); return;
        case "raw":
          res.writeHead(200, { "Content-Type": m.contentType ?? "text/event-stream" });
          for (const c of m.chunks) { if (!alive()) return; res.write(c); await sleep(m.delayMs ?? 1); }
          if (m.end !== false) res.end();
          return;
        case "stream": {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          const long = JSON.parse(body).max_tokens >= 1000;
          const words = long ? Array.from({ length: 500 }, (_, i) => `${i + 1} `) : ["OK"];
          for (const w of words) { if (!alive()) return; res.write(delta(w)); if (long) await sleep(2); }
          res.write("data: [DONE]\n\n"); res.end();
        }
      }
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  srv.url = `http://127.0.0.1:${port}/v1`;
  srv.host = `127.0.0.1:${port}`;
  return srv;
}
