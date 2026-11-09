import dgram from "node:dgram";
import net from "node:net";
import { STT_PORT_MAX, STT_PORT_MIN } from "./env-file.js";
import type { PortProbe } from "./ops.js";

/**
 * US-0072 (EPIC-0003 voice A1c, Task 7; review B2 F10): whether voice:up can use host:port. TCP: bind a server there (EADDRINUSE =
 * taken, EACCES = denied: an unprivileged probe of a low port), then, when the bind succeeded, CONNECT to host:port: libuv sets
 * SO_REUSEADDR on TCP listeners, and on macOS (BSD rules) the bind succeeds while another program listens on the wildcard 0.0.0.0:<p>
 * or [::]:<p> (verified on macOS 26 with real listeners); a connect that is accepted means a listener answers there. UDP: bind only
 * (dgram sets no SO_REUSEADDR, so a wildcard holder makes the bind fail).
 */
export const CONNECT_PROBE_MS = 1_000;

function accepts(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const finish = (v: boolean): void => { sock.destroy(); resolve(v); };
    sock.setTimeout(CONNECT_PROBE_MS, () => finish(false));
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
  });
}

function bindProbe(host: string, port: number, proto: "tcp" | "udp"): Promise<PortProbe> {
  const mapErr = (err: NodeJS.ErrnoException): PortProbe => (err.code === "EACCES" ? "denied" : "taken");
  return new Promise((resolve) => {
    if (proto === "tcp") {
      const srv = net.createServer();
      srv.once("error", (err) => resolve(mapErr(err)));
      srv.listen({ host, port, exclusive: true }, () => srv.close(() => resolve("free")));
    } else {
      const sock = dgram.createSocket("udp4");
      sock.once("error", (err) => { sock.close(); resolve(mapErr(err)); });
      sock.bind(port, host, () => sock.close(() => resolve("free")));
    }
  });
}

export async function portFree(host: string, port: number, proto: "tcp" | "udp"): Promise<PortProbe> {
  const bound = await bindProbe(host, port, proto);
  if (bound !== "free" || proto === "udp") return bound;
  return (await accepts(host, port)) ? "taken" : "free";
}

/**
 * PR #135 (CodeQL js/biased-cryptographic-random): one STT port, uniform over STT_PORT_MIN..STT_PORT_MAX, from 16-bit draws of `random`
 * (crypto.randomBytes in the CLI). A draw at or above the largest multiple of the range is redrawn (rejection sampling), so no port
 * is likelier than another; a draw is rejected with probability under 3%.
 */
export function drawSttPort(random: (n: number) => Buffer): number {
  const range = STT_PORT_MAX - STT_PORT_MIN + 1; // 12768
  const copies = Math.floor(65536 / range); // 5 whole copies of the range fit in 16 bits
  const limit = copies * range; // 63840
  for (;;) {
    const v = random(2).readUInt16BE(0);
    if (v < limit) return STT_PORT_MIN + Math.floor(v / copies); // each port has exactly `copies` accepted draws
  }
}
