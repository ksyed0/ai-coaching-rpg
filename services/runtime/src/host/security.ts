import { createHash, timingSafeEqual } from "node:crypto";
import net from "node:net";

/** US-0017: the facilitator token, the connection and message limits, and their environment parsing. */

export const MIN_TOKEN_CHARS = 16;
export const MAX_TOKEN_CHARS = 256;

/** Constant-time comparison. Both sides are hashed first, so the lengths are equal and a length difference leaks nothing. */
export function secretsMatch(a: string, b: string): boolean {
  const x = createHash("sha256").update(a, "utf8").digest();
  const y = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(x, y);
}

/** A token is 16 to 256 printable ASCII characters (0x21 to 0x7e): no whitespace, no control characters. */
export function isValidToken(t: string): boolean {
  return t.length >= MIN_TOKEN_CHARS && t.length <= MAX_TOKEN_CHARS && /^[\x21-\x7e]+$/.test(t);
}
export const TOKEN_RULE = `${MIN_TOKEN_CHARS} to ${MAX_TOKEN_CHARS} printable ASCII characters with no spaces`;

export type Limits = {
  /** All WebSocket connections together. */
  maxConnections: number;
  maxConnectionsPerIp: number;
  /** Sustained messages per second per connection, and the burst a connection may spend at once. */
  msgRate: number;
  msgBurst: number;
  /** A connection that has not joined within this many ms is closed. */
  joinTimeoutMs: number;
  /** Messages waiting for the handler on one connection; more closes the connection. */
  maxQueue: number;
  /** This many rate-limit drops within `dropWindowMs` close the connection. */
  maxDrops: number;
  dropWindowMs: number;
  /** More than this many failed facilitator joins from one IP within `authWindowMs` blocks that IP's handshakes for `authBlockMs`. */
  maxAuthFailures: number;
  authWindowMs: number;
  authBlockMs: number;
};

export const DEFAULT_LIMITS: Limits = {
  maxConnections: 32, maxConnectionsPerIp: 8, msgRate: 5, msgBurst: 20, joinTimeoutMs: 10_000, maxQueue: 64,
  maxDrops: 3, dropWindowMs: 10_000, maxAuthFailures: 5, authWindowMs: 60_000, authBlockMs: 60_000,
};

export type SecurityConfig = {
  facilitatorToken: string | undefined;
  host: string;
  allowedOrigins: string[];
  trustProxy: boolean;
  limits: Limits;
};
export type SecurityParse = { ok: true; config: SecurityConfig } | { ok: false; errors: string[] };

const quote = (raw: string) => JSON.stringify(raw.slice(0, 40));

function intVar(env: NodeJS.ProcessEnv, name: string, min: number, max: number, fallback: number, errors: string[]): number {
  const text = (env[name] ?? "").trim();
  if (text === "") return fallback;
  const range = `a whole number from ${min} to ${max}`;
  if (!/^[0-9]+$/.test(text)) { errors.push(`${name} ${quote(text)} is invalid: use ${range} (digits only)`); return fallback; }
  const v = Number(text);
  if (!Number.isSafeInteger(v) || v < min || v > max) { errors.push(`${name} ${quote(text)} is out of range: use ${range}`); return fallback; }
  return v;
}

/** An origin as a browser sends it: scheme://host[:port], no path. Returns the normalised form or null. */
export function normalizeOrigin(raw: string): string | null {
  try {
    const u = new URL(raw);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname || u.username || u.password) return null;
    if (u.pathname !== "/" || u.search || u.hash || raw.endsWith("/")) return null;
    return u.origin;
  } catch { return null; }
}

/**
 * Reads FACILITATOR_TOKEN, RUNTIME_HOST, ALLOWED_ORIGINS, TRUST_PROXY, WS_MAX_CONNECTIONS, WS_MAX_CONNECTIONS_PER_IP, WS_MSG_RATE,
 * WS_MSG_BURST and WS_JOIN_TIMEOUT_MS. Errors name the variable and the allowed range and NEVER contain the token's value.
 */
export function parseSecurityConfig(env: NodeJS.ProcessEnv): SecurityParse {
  const errors: string[] = [];
  const limits: Limits = { ...DEFAULT_LIMITS };

  const rawToken = env.FACILITATOR_TOKEN;
  let facilitatorToken: string | undefined;
  if (rawToken !== undefined && rawToken !== "") {
    if (isValidToken(rawToken)) facilitatorToken = rawToken;
    else errors.push(`FACILITATOR_TOKEN is invalid: use ${TOKEN_RULE} (the value is not shown); unset it to run without a token`);
  }

  limits.maxConnections = intVar(env, "WS_MAX_CONNECTIONS", 1, 10_000, DEFAULT_LIMITS.maxConnections, errors);
  limits.maxConnectionsPerIp = intVar(env, "WS_MAX_CONNECTIONS_PER_IP", 1, 10_000, DEFAULT_LIMITS.maxConnectionsPerIp, errors);
  limits.msgRate = intVar(env, "WS_MSG_RATE", 1, 1_000, DEFAULT_LIMITS.msgRate, errors);
  limits.msgBurst = intVar(env, "WS_MSG_BURST", 1, 10_000, DEFAULT_LIMITS.msgBurst, errors);
  limits.joinTimeoutMs = intVar(env, "WS_JOIN_TIMEOUT_MS", 500, 600_000, DEFAULT_LIMITS.joinTimeoutMs, errors);

  const hostText = (env.RUNTIME_HOST ?? "").trim();
  const host = hostText === "" ? "0.0.0.0" : hostText;
  if (hostText !== "" && !net.isIP(hostText) && !/^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(hostText)) {
    errors.push(`RUNTIME_HOST is invalid (the value is not shown): use an IP address or a host name (default 0.0.0.0; 127.0.0.1 behind a reverse proxy)`);
  }

  const allowedOrigins: string[] = [];
  const originsText = (env.ALLOWED_ORIGINS ?? "").trim();
  if (originsText !== "") {
    for (const part of originsText.split(",").map((s) => s.trim()).filter(Boolean)) {
      const o = normalizeOrigin(part);
      if (o) allowedOrigins.push(o);
      else errors.push(`ALLOWED_ORIGINS has an invalid entry (not shown): use comma separated origins such as https://play.example.com (scheme, host and optional port; no path)`);
    }
  }

  const proxyText = (env.TRUST_PROXY ?? "").trim();
  if (proxyText !== "" && proxyText !== "0" && proxyText !== "1") errors.push(`TRUST_PROXY ${quote(proxyText)} is invalid: use 0 (default) or 1`);

  if (errors.length) return { ok: false, errors };
  return { ok: true, config: { facilitatorToken, host, allowedOrigins, trustProxy: proxyText === "1", limits } };
}

/** The one line printed at startup when no token is set. Contains no secret. */
export const OPEN_SERVER_WARNING =
  "WARNING: FACILITATOR_TOKEN is not set, so the server is OPEN: anyone who can reach it can join as facilitator and read every private fact (see docs/THREAT_MODEL.md)";

/** Shown to a facilitator once, in `joined`, when the server runs without a token. */
export const OPEN_SERVER_NOTICE = "This server has no FACILITATOR_TOKEN: anyone who can reach it can join as facilitator. Set one (see docs/THREAT_MODEL.md).";

/** Token bucket: `burst` tokens at most, refilled at `ratePerSec`. Time is injected for tests. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(private readonly ratePerSec: number, private readonly burst: number, private readonly now: () => number) {
    this.tokens = burst; this.last = now();
  }
  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + Math.max(0, t - this.last) * this.ratePerSec / 1000);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** Counts events inside a sliding window; used for rate-limit drops per connection and failed logins per IP. */
export class WindowCounter {
  private stamps: number[] = [];
  /** Time of the latest hit (0 before the first); lets a sweep expire a counter without scanning its events. */
  lastHit = 0;
  constructor(private readonly windowMs: number, private readonly now: () => number) {}
  /** Records one event and returns how many fall inside the window (this one included). */
  hit(): number {
    const t = this.now();
    this.stamps = this.stamps.filter((s) => t - s < this.windowMs);
    this.stamps.push(t);
    this.lastHit = t;
    return this.stamps.length;
  }
  count(): number {
    const t = this.now();
    this.stamps = this.stamps.filter((s) => t - s < this.windowMs);
    return this.stamps.length;
  }
}

/** The key the connection caps use: the address itself (IPv4-mapped IPv6 as the IPv4 address, lower case). */
export function ipKey(ip: string): string {
  const v4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return v4 ? v4[1]! : ip.toLowerCase();
}

/**
 * The key the failed-login throttle uses: like ipKey, but a global unicast IPv6 address (2000::/3) is keyed by its /64, because one host
 * or household owns a whole /64 and could rotate through it. Link-local (fe80::/10), unique-local (fc00::/7) and other addresses keep
 * the full address, since many people on one LAN or VLAN share those prefixes.
 */
export function authKey(ip: string): string {
  const k = ipKey(ip);
  if (!k.includes(":") || net.isIP(k) !== 6) return k;
  const [head = "", tail = ""] = k.split("::");
  const a = head ? head.split(":") : [];
  const b = k.includes("::") && tail ? tail.split(":") : [];
  const groups = k.includes("::") ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill("0"), ...b] : a;
  const first = parseInt(groups[0] || "0", 16);
  if (first < 0x2000 || first > 0x3fff) return k;
  return groups.slice(0, 4).map((g) => parseInt(g || "0", 16).toString(16)).join(":") + "::/64";
}

export const MAX_TRACKED_ADDRESSES = 10_000;

/** Failed facilitator joins per IP: more than `max` inside the window blocks that IP for `blockMs`. The map is pruned as it is used. */
export class AuthThrottle {
  private readonly fails = new Map<string, WindowCounter>();
  private readonly blockedUntil = new Map<string, number>();
  private lastSweep = Number.NEGATIVE_INFINITY;
  /** Number of full sweeps run (for tests): they are rare by design, never one per failure. */
  sweeps = 0;
  constructor(private readonly o: { max: number; windowMs: number; blockMs: number; now: () => number; maxEntries?: number }) {}
  fail(ip: string): void {
    const key = authKey(ip);
    let c = this.fails.get(key);
    if (!c) { c = new WindowCounter(this.o.windowMs, this.o.now); this.fails.set(key, c); }
    if (c.hit() > this.o.max) { this.blockedUntil.set(key, this.o.now() + this.o.blockMs); this.fails.delete(key); }
    this.bound();
  }
  /** Milliseconds until the IP may connect again, or 0. */
  blockedForMs(ip: string): number {
    const key = authKey(ip);
    const until = this.blockedUntil.get(key);
    if (until === undefined) return 0;
    const left = until - this.o.now();
    if (left <= 0) { this.blockedUntil.delete(key); return 0; }
    return left;
  }
  /** Entries tracked (for tests and monitoring). */
  size(): number { return this.fails.size + this.blockedUntil.size; }
  /**
   * Memory bound with O(1) work per failure: the oldest entry is evicted when a map passes its cap (a Map iterates in insertion order),
   * and expired entries are swept from BOTH maps at most once a second, and only when a map is large.
   */
  private bound(): void {
    const cap = this.o.maxEntries ?? MAX_TRACKED_ADDRESSES;
    for (const m of [this.fails, this.blockedUntil] as Map<string, unknown>[]) {
      while (m.size > cap) { const oldest = m.keys().next().value as string | undefined; if (oldest === undefined) break; m.delete(oldest); }
    }
    if (this.fails.size < cap / 10 && this.blockedUntil.size < cap / 10) return;
    const t = this.o.now();
    if (t - this.lastSweep < 1_000) return;
    this.lastSweep = t; this.sweeps++;
    for (const [k, c] of this.fails) if (t - c.lastHit >= this.o.windowMs) this.fails.delete(k);
    for (const [k, until] of this.blockedUntil) if (until <= t) this.blockedUntil.delete(k);
  }
}

/** The address that per-IP limits apply to: the socket's, or with trustProxy the last X-Forwarded-For entry (the one the proxy appended). */
export function clientIp(req: { socket: { remoteAddress?: string | undefined }; headers: Record<string, string | string[] | undefined> }, trustProxy: boolean): string {
  if (trustProxy) {
    const h = req.headers["x-forwarded-for"];
    const v = (Array.isArray(h) ? h.join(",") : h) ?? "";
    const last = v.split(",").map((s) => s.trim()).filter(Boolean).pop();
    if (last && last.length <= 64) return last;
  }
  return req.socket.remoteAddress ?? "unknown";
}
