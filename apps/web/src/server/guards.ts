import { isIP } from "node:net";

// Request guards for state-changing routes. Origin plus a custom header is the main CSRF defence; Sec-Fetch-Site is defence in depth.

export function checkOrigin(req: Request, publicOrigin: string): boolean {
  return req.headers.get("Origin") === publicOrigin && req.headers.get("X-Requested-With") === "scenecoach";
}

/** Absent is allowed for older browsers; the Origin check carries the load there. */
export function checkFetchSite(req: Request): boolean {
  const site = req.headers.get("Sec-Fetch-Site");
  return site === null || site === "same-origin" || site === "none";
}

/**
 * One spelling per address, so a throttle or cap key cannot be dodged by writing the same address another way: IPv4 as is, IPv6 in
 * the WHATWG canonical form (lower case, compressed), and an IPv4-mapped IPv6 address (::ffff:a.b.c.d in any spelling) as its IPv4.
 * Null for anything that is not exactly one IP address (a host name, a port, a zone id, a list).
 */
export function normalizeAddress(raw: string): string | null {
  let a = raw.trim();
  if (a.startsWith("[") && a.endsWith("]")) a = a.slice(1, -1);
  const kind = isIP(a);
  if (kind === 4) return a;
  if (kind !== 6 || a.includes("%")) return null;
  let host: string;
  try { host = new URL(`http://[${a}]/`).hostname.slice(1, -1); } catch { return null; }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!mapped) return host;
  const hi = parseInt(mapped[1]!, 16);
  const lo = parseInt(mapped[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/**
 * The client address for throttle and cap keys, normalised. It reads exactly one X-Forwarded-For entry. `next start` itself fills an
 * ABSENT X-Forwarded-For with the socket's address before a route runs, so: behind a TLS proxy that replaces the header (the supported
 * deployment) it is the client's address; behind a proxy that does not set it, every client is the proxy's address (one shared key);
 * with no proxy it is each client's socket address, but a client can also send its own one-entry header and so choose its key here
 * and at the runtime (TRUST_PROXY=1): that lets it dodge the per-address stream cap and spread its join guesses over many keys, which
 * gains nothing against a 60-bit join code. A proxy that appends instead of replacing produces a list. An empty value, a list or a
 * non-address is not from a proxy we support: null (the routes answer a neutral 400). An absent header gives "unknown" (reachable only outside `next start`, as in unit tests).
 */
export function requestAddress(req: Request): string | null {
  const raw = req.headers.get("X-Forwarded-For");
  if (raw === null) return "unknown";
  if (raw.includes(",")) return null;
  return normalizeAddress(raw);
}
