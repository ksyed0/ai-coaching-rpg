import type { PortProbe } from "../ops.js";
import type { CheckResult } from "./types.js";

/**
 * US-0072 (EPIC-0003 voice A1c, Task 8): the ports voice:up uses. When the stack is not running, a taken port is a warning (voice:up will
 * refuse it); when it is running, a free port is a failure (the service that should hold it is not there). EACCES (an unprivileged probe
 * of a low port) is a skip.
 */
export async function portsCheck(o: {
  running: boolean; wanted: { host: string; port: number; proto: "tcp" | "udp"; label: string }[];
  portFree: (host: string, port: number, proto: "tcp" | "udp") => Promise<PortProbe>;
}): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const w of o.wanted) {
    const p = await o.portFree(w.host, w.port, w.proto);
    const at = `port ${w.port} (${w.label})`;
    if (p === "denied") out.push({ name: "ports", level: "skip", line: `cannot test ${at} without privileges` });
    else if (o.running) out.push(p === "taken" ? { name: "ports", level: "ok", line: `${at} is in use` } : { name: "ports", level: "fail", line: `${at} is not in use: the service is not running; run pnpm voice:up` });
    else out.push(p === "taken" ? { name: "ports", level: "warn", line: `${at} is taken by another program: voice:up will refuse it` } : { name: "ports", level: "ok", line: `${at} is free` });
  }
  return out;
}
