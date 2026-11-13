import type os from "node:os";
import type { CheckResult } from "./types.js";

/**
 * US-0072 (EPIC-0003 voice A1c, Task 8): the web app binds loopback only (Task 6). `127.0.0.1:<webPort>` should answer; every
 * NON-INTERNAL IPv4 address of `os.networkInterfaces()` (`lanAddressesOf`) should refuse. Never the node address: in local mode it is
 * 127.0.0.1, where the web app must answer. No such address is a skip; in lan mode, the proxy route to the web app is reported too.
 */
export function lanAddressesOf(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces)) for (const i of list ?? []) {
    const v4 = i.family === "IPv4" || (i.family as unknown) === 4;
    if (v4 && !i.internal && !out.includes(i.address)) out.push(i.address);
  }
  return out;
}

export async function webCheck(o: {
  webPort: number; lanAddresses: string[]; connect: (host: string, port: number) => Promise<"open" | "refused" | "timeout">; viaProxy?: () => Promise<number | null>;
}): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  out.push((await o.connect("127.0.0.1", o.webPort)) === "open"
    ? { name: "web", level: "ok", line: `the web app answers on 127.0.0.1:${o.webPort}` }
    : { name: "web", level: "warn", line: `the web app is not running on 127.0.0.1:${o.webPort}: start it with pnpm --filter @acr/web start` });
  if (o.lanAddresses.length === 0) out.push({ name: "web-lan", level: "skip", line: "no LAN address on this machine" });
  else {
    const open: string[] = [];
    for (const a of o.lanAddresses) if ((await o.connect(a, o.webPort)) === "open") open.push(`${a}:${o.webPort}`);
    out.push(open.length > 0
      ? { name: "web-lan", level: "fail", line: `the web app listens on the LAN (${open.join(", ")}): start it with pnpm --filter @acr/web start` }
      : { name: "web-lan", level: "ok", line: "the web app does not listen on this machine's LAN addresses" });
  }
  if (o.viaProxy) {
    out.push((await o.viaProxy()) !== null
      ? { name: "web-proxy", level: "ok", line: "the web app answers through the proxy" }
      : { name: "web-proxy", level: "fail", line: "the web app does not answer through the proxy with a trusted certificate" });
  }
  return out;
}
