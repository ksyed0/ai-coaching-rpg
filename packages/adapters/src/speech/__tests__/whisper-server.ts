import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * US-0070 (tests only): a stand-in whisper-server on 127.0.0.1:0. `handle` answers each request; the request body is collected first
 * (so a test can read the multipart form). Never reaches beyond loopback.
 */
export type Req = { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer };
export async function startFakeWhisper(handle: (req: Req, res: http.ServerResponse) => void) {
  const requests: Req[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const r = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) };
      requests.push(r);
      handle(r, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port, requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

export const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};
