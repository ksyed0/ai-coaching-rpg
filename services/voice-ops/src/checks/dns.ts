import { isPrivateAddress, parseIPv4 } from "../text.js";
import type { CheckResult } from "./types.js";

/**
 * US-0072 (EPIC-0003 voice A1c, Task 8): what DNS says about the hostname. The DNS line comes from `dns.promises.Resolver`
 * `resolve4`/`resolve6` (the router's answer, what the participants' devices get); `dns.lookup` also reads the hosts file and would hide
 * a router that drops the answer (DNS-rebinding protection), so its answer is reported as a line of its own. Addresses and the hostname
 * are not secret; nothing else is printed.
 */
export const REBINDING_HINT = "some routers drop public DNS answers that point to a private address (DNS-rebinding protection): allow the hostname in the router, or add a local DNS entry";

/** An IPv6 address in one spelling (WHATWG URL serialisation: lower case, zeros compressed), without a zone; null when it is not one. */
function canonicalV6(a: string): string | null {
  const bare = a.split("%")[0] ?? "";
  try { return new URL(`http://[${bare}]/`).hostname; } catch { return null; }
}

/** 127.0.0.0/8, 169.254.0.0/16 and 0.0.0.0/8: never a LAN address a participant's device can reach this machine on. */
function isLoopbackOrLinkLocal(a: string): boolean {
  const v4 = parseIPv4(a);
  return v4 !== null && (v4[0] === 127 || v4[0] === 0 || (v4[0] === 169 && v4[1] === 254));
}

const answers = async (f: (h: string) => Promise<string[]>, h: string): Promise<string[]> => { try { return await f(h); } catch { return []; } };

export async function dnsCheck(o: {
  hostname: string; nodeIp: string; resolve4: (h: string) => Promise<string[]>; resolve6: (h: string) => Promise<string[]>;
  /** Every address of this machine's interfaces (both families; `os.networkInterfaces()`). */
  ownAddresses: string[];
  lookup: (h: string) => Promise<{ address: string; family: number }[]>;
}): Promise<CheckResult[]> {
  const h = o.hostname;
  const [v4, v6] = await Promise.all([answers(o.resolve4, h), answers(o.resolve6, h)]);
  const out: CheckResult[] = [];
  const special = v4.filter(isLoopbackOrLinkLocal);
  const pub = v4.filter((a) => !isLoopbackOrLinkLocal(a) && (parseIPv4(a) === null || !isPrivateAddress(a)));
  if (v4.length === 0) out.push({ name: "dns", level: "fail", line: `DNS: ${h} has no IPv4 (A) answer; ${REBINDING_HINT}` });
  else if (special.length > 0) out.push({ name: "dns", level: "fail", line: `DNS: ${h} points to a loopback or link-local address (${special.join(", ")}): point it to this machine's LAN address ${o.nodeIp}` });
  else if (pub.length > 0) out.push({ name: "dns", level: "fail", line: `DNS: ${h} points to a public address (${pub.join(", ")}): point it to this machine's LAN address ${o.nodeIp}` });
  else if (!v4.includes(o.nodeIp)) out.push({ name: "dns", level: "warn", line: `DNS: ${h} points to ${v4.join(", ")}, not this machine's LAN address ${o.nodeIp}` });
  else out.push({ name: "dns", level: "ok", line: `DNS: ${h} points to this machine (${o.nodeIp})` });
  // Review B2 F8: an AAAA elsewhere (a unique-local one too) is where a browser may go first and fail TLS; only this machine's own
  // IPv6 address is a warning (Caddy binds IPv4 only, Happy Eyeballs falls back to the A record).
  const own = new Set(o.ownAddresses.map(canonicalV6).filter((x): x is string => x !== null));
  const elsewhere = v6.filter((a) => { const c = canonicalV6(a); return c === null || !own.has(c); });
  if (elsewhere.length > 0) out.push({ name: "dns-ipv6", level: "fail", line: `DNS: ${h} has an IPv6 (AAAA) address that is not this machine (${elsewhere.join(", ")}): browsers may use it and fail; remove the AAAA record` });
  else if (v6.length > 0) out.push({ name: "dns-ipv6", level: "warn", line: `DNS: ${h} also has an IPv6 (AAAA) address of this machine: the proxy listens on IPv4 only; browsers fall back to IPv4, but remove the AAAA record if connecting is slow` });
  let sys: string[] | null;
  try { sys = (await o.lookup(h)).map((x) => x.address); } catch { sys = null; }
  const norm = (l: string[]): string => [...new Set(l.map((a) => a.toLowerCase()))].sort().join(",");
  if (sys === null) out.push({ name: "dns-system", level: "warn", line: `this machine cannot resolve ${h}` });
  else if (norm(sys) !== norm([...v4, ...v6])) out.push({ name: "dns-system", level: "warn", line: `this machine resolves ${h} through its hosts file or another resolver; other devices use DNS` });
  else out.push({ name: "dns-system", level: "ok", line: `this machine resolves ${h} the same way` });
  return out;
}
