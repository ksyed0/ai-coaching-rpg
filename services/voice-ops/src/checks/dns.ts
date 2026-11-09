import { isPrivateAddress, parseIPv4 } from "../text.js";
import type { CheckResult } from "./types.js";

/**
 * US-0072 (EPIC-0003 voice A1c, Task 8): what DNS says about the hostname. The DNS line comes from `dns.promises.Resolver`
 * `resolve4`/`resolve6` (the router's answer, what the participants' devices get); `dns.lookup` also reads the hosts file and would hide
 * a router that drops the answer (DNS-rebinding protection), so its answer is reported as a line of its own. Addresses and the hostname
 * are not secret; nothing else is printed.
 */
export const REBINDING_HINT = "some routers drop public DNS answers that point to a private address (DNS-rebinding protection): allow the hostname in the router, or add a local DNS entry";

/** fc00::/7 (unique local). */
function isLocalV6(a: string): boolean {
  const first = a.toLowerCase().split(":")[0] ?? "";
  if (first.length !== 4) return false;
  return first.startsWith("fc") || first.startsWith("fd");
}

const answers = async (f: (h: string) => Promise<string[]>, h: string): Promise<string[]> => { try { return await f(h); } catch { return []; } };

export async function dnsCheck(o: {
  hostname: string; nodeIp: string; resolve4: (h: string) => Promise<string[]>; resolve6: (h: string) => Promise<string[]>;
  lookup: (h: string) => Promise<{ address: string; family: number }[]>;
}): Promise<CheckResult[]> {
  const h = o.hostname;
  const [v4, v6] = await Promise.all([answers(o.resolve4, h), answers(o.resolve6, h)]);
  const out: CheckResult[] = [];
  const pub = v4.filter((a) => parseIPv4(a) === null || !isPrivateAddress(a));
  if (v4.length === 0) out.push({ name: "dns", level: "fail", line: `DNS: ${h} has no IPv4 (A) answer; ${REBINDING_HINT}` });
  else if (pub.length > 0) out.push({ name: "dns", level: "fail", line: `DNS: ${h} points to a public address (${pub.join(", ")}): point it to this machine's LAN address ${o.nodeIp}` });
  else if (!v4.includes(o.nodeIp)) out.push({ name: "dns", level: "warn", line: `DNS: ${h} points to ${v4.join(", ")}, not this machine's LAN address ${o.nodeIp}` });
  else out.push({ name: "dns", level: "ok", line: `DNS: ${h} points to this machine (${o.nodeIp})` });
  if (v6.some((a) => !isLocalV6(a))) out.push({ name: "dns-ipv6", level: "warn", line: `DNS: ${h} also has an IPv6 (AAAA) address that is not a local one: browsers may prefer it and miss this machine; remove the AAAA record` });
  let sys: string[] | null;
  try { sys = (await o.lookup(h)).map((x) => x.address); } catch { sys = null; }
  const norm = (l: string[]): string => [...new Set(l.map((a) => a.toLowerCase()))].sort().join(",");
  if (sys === null) out.push({ name: "dns-system", level: "warn", line: `this machine cannot resolve ${h}` });
  else if (norm(sys) !== norm([...v4, ...v6])) out.push({ name: "dns-system", level: "warn", line: `this machine resolves ${h} through its hosts file or another resolver; other devices use DNS` });
  else out.push({ name: "dns-system", level: "ok", line: `this machine resolves ${h} the same way` });
  return out;
}
