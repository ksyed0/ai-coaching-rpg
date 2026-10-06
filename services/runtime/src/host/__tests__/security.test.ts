import { describe, expect, it } from "vitest";
import { AuthThrottle, authKey, ipKey, DEFAULT_LIMITS, TokenBucket, WindowCounter, clientIp, isValidToken, normalizeOrigin, parseSecurityConfig, secretsMatch } from "../security.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

describe("secretsMatch", () => {
  it("matches equal strings and refuses different, empty and different-length ones", () => {
    expect(secretsMatch(TOKEN, TOKEN)).toBe(true);
    expect(secretsMatch(TOKEN, TOKEN.slice(0, -1) + "x")).toBe(false);
    expect(secretsMatch(TOKEN, "")).toBe(false);
    expect(secretsMatch("", "")).toBe(true);
    expect(secretsMatch(TOKEN, TOKEN + "0")).toBe(false);
    expect(secretsMatch(TOKEN, "x".repeat(100_000))).toBe(false);
  });
});

describe("isValidToken", () => {
  it("accepts 16 to 256 printable characters without whitespace", () => {
    expect(isValidToken("a".repeat(16))).toBe(true);
    expect(isValidToken("a".repeat(256))).toBe(true);
    expect(isValidToken("a".repeat(15))).toBe(false);
    expect(isValidToken("a".repeat(257))).toBe(false);
    expect(isValidToken("has space in it 123456")).toBe(false);
    expect(isValidToken("tab\there0123456789abc")).toBe(false);
    expect(isValidToken("unicode-é-0123456789abcdef")).toBe(false);
  });
});

describe("parseSecurityConfig", () => {
  it("defaults: no token, open, documented limits", () => {
    const r = parseSecurityConfig({});
    expect(r).toEqual({ ok: true, config: { facilitatorToken: undefined, host: "0.0.0.0", allowedOrigins: [], trustProxy: false, limits: DEFAULT_LIMITS } });
  });
  it("reads every variable", () => {
    const r = parseSecurityConfig({ FACILITATOR_TOKEN: TOKEN, RUNTIME_HOST: "127.0.0.1", ALLOWED_ORIGINS: "https://a.example, http://localhost:3000", TRUST_PROXY: "1", WS_MAX_CONNECTIONS: "10", WS_MAX_CONNECTIONS_PER_IP: "2", WS_MSG_RATE: "9", WS_MSG_BURST: "30", WS_JOIN_TIMEOUT_MS: "1500" });
    expect(r.ok && r.config).toMatchObject({ facilitatorToken: TOKEN, host: "127.0.0.1", allowedOrigins: ["https://a.example", "http://localhost:3000"], trustProxy: true });
    expect(r.ok && r.config.limits).toMatchObject({ maxConnections: 10, maxConnectionsPerIp: 2, msgRate: 9, msgBurst: 30, joinTimeoutMs: 1500 });
  });
  it("treats a blank token as unset", () => {
    const r = parseSecurityConfig({ FACILITATOR_TOKEN: "" });
    expect(r.ok && r.config.facilitatorToken).toBeUndefined();
  });
  it("never echoes an invalid token, in any error", () => {
    for (const bad of ["short", "has spaces in the token value", "x".repeat(300), "secret\u0000value-0123456789"]) {
      const r = parseSecurityConfig({ FACILITATOR_TOKEN: bad });
      expect(r.ok).toBe(false);
      const text = JSON.stringify(r);
      expect(text).toContain("FACILITATOR_TOKEN");
      expect(text).not.toContain(bad.slice(0, 8) === "x".repeat(8) ? "xxxxxxxx" : bad.slice(0, 5));
    }
  });
  it("names the variable and the range for each bad value", () => {
    const cases: [string, string][] = [
      ["WS_MAX_CONNECTIONS", "0"], ["WS_MAX_CONNECTIONS", "10001"], ["WS_MAX_CONNECTIONS_PER_IP", "-1"], ["WS_MSG_RATE", "1.5"], ["WS_MSG_BURST", "abc"],
      ["WS_JOIN_TIMEOUT_MS", "100"], ["WS_JOIN_TIMEOUT_MS", "10s"], ["TRUST_PROXY", "yes"], ["RUNTIME_HOST", "bad host!"], ["ALLOWED_ORIGINS", "not a url"], ["ALLOWED_ORIGINS", "https://a.example/path"],
    ];
    for (const [name, value] of cases) {
      const r = parseSecurityConfig({ [name]: value });
      expect(r.ok, `${name}=${value}`).toBe(false);
      expect(!r.ok && r.errors.join(" ")).toContain(name);
    }
  });
  it("collects several errors at once", () => {
    const r = parseSecurityConfig({ WS_MSG_RATE: "0", WS_MSG_BURST: "0" });
    expect(!r.ok && r.errors.length).toBe(2);
  });
});

describe("normalizeOrigin", () => {
  it("accepts scheme://host[:port] only", () => {
    expect(normalizeOrigin("https://Play.Example.com")).toBe("https://play.example.com");
    expect(normalizeOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    for (const bad of ["null", "ftp://x.example", "https://x.example/", "https://x.example/p", "https://u:p@x.example", "x.example"]) expect(normalizeOrigin(bad), bad).toBeNull();
  });
});

describe("TokenBucket", () => {
  it("allows the burst, then refills at the rate, never above the burst", () => {
    let t = 0;
    const b = new TokenBucket(5, 3, () => t);
    expect([b.take(), b.take(), b.take(), b.take()]).toEqual([true, true, true, false]);
    t += 199; expect(b.take()).toBe(false);
    t += 1; expect(b.take()).toBe(true); // 200 ms at 5/s = 1 token
    t += 60_000; expect([b.take(), b.take(), b.take(), b.take()]).toEqual([true, true, true, false]);
  });
  it("two buckets are independent", () => {
    const t = 0;
    const a = new TokenBucket(1, 1, () => t); const b = new TokenBucket(1, 1, () => t);
    expect(a.take()).toBe(true); expect(a.take()).toBe(false); expect(b.take()).toBe(true);
  });
});

describe("WindowCounter and AuthThrottle", () => {
  it("counts only events inside the window", () => {
    let t = 0;
    const c = new WindowCounter(1000, () => t);
    expect(c.hit()).toBe(1); t += 500; expect(c.hit()).toBe(2); t += 600; expect(c.hit()).toBe(2);
  });
  it("blocks an IP after more than max failures, for blockMs, and only that IP", () => {
    let t = 0;
    const th = new AuthThrottle({ max: 5, windowMs: 60_000, blockMs: 60_000, now: () => t });
    for (let i = 0; i < 5; i++) th.fail("1.1.1.1");
    expect(th.blockedForMs("1.1.1.1")).toBe(0);
    th.fail("1.1.1.1");
    expect(th.blockedForMs("1.1.1.1")).toBe(60_000);
    expect(th.blockedForMs("2.2.2.2")).toBe(0);
    t += 59_999; expect(th.blockedForMs("1.1.1.1")).toBe(1);
    t += 1; expect(th.blockedForMs("1.1.1.1")).toBe(0);
    th.fail("1.1.1.1"); expect(th.blockedForMs("1.1.1.1")).toBe(0); // the counter restarted
  });
  it("failures spread over more than a window never block", () => {
    let t = 0;
    const th = new AuthThrottle({ max: 2, windowMs: 1000, blockMs: 5000, now: () => t });
    for (let i = 0; i < 10; i++) { th.fail("x"); t += 600; }
    expect(th.blockedForMs("x")).toBe(0);
  });
});

describe("clientIp", () => {
  const req = (xff?: string) => ({ socket: { remoteAddress: "10.0.0.9" }, headers: xff === undefined ? {} : { "x-forwarded-for": xff } });
  it("uses the socket unless the proxy is trusted", () => {
    expect(clientIp(req("1.2.3.4"), false)).toBe("10.0.0.9");
    expect(clientIp(req("9.9.9.9, 1.2.3.4"), true)).toBe("1.2.3.4");
    expect(clientIp(req(), true)).toBe("10.0.0.9");
    expect(clientIp(req("x".repeat(200)), true)).toBe("10.0.0.9");
  });
});

describe("ipKey and authKey (review M2, m1)", () => {
  it("ipKey is the full address (IPv4-mapped becomes IPv4, lower case)", () => {
    expect(ipKey("203.0.113.9")).toBe("203.0.113.9");
    expect(ipKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(ipKey("FE80::1")).toBe("fe80::1");
    expect(ipKey("2001:db8:1:2::1")).not.toBe(ipKey("2001:db8:1:2::2"));
  });
  it("authKey aggregates only global unicast IPv6 (2000::/3) by /64", () => {
    expect(authKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(authKey("2001:db8:1:2::1"));
    expect(authKey("2001:db8:1:2::1")).not.toBe(authKey("2001:db8:1:3::1"));
    expect(authKey("3fff::1")).toBe(authKey("3fff::2")); // still 2000::/3
    for (const a of ["fe80::1", "fe80::2", "fd00:1:2:3::1", "fd00:1:2:3::2", "fc00::1", "::1", "4000::1", "4000::2"]) expect(authKey(a), a).toBe(ipKey(a));
    expect(authKey("203.0.113.9")).toBe("203.0.113.9");
    expect(authKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
  });
  it("a global /64 shares one failure budget; a link-local or ULA LAN does not", () => {
    let t = 0;
    const th = new AuthThrottle({ max: 2, windowMs: 60_000, blockMs: 60_000, now: () => t });
    th.fail("2001:db8::1"); th.fail("2001:db8::2"); th.fail("2001:db8::3");
    expect(th.blockedForMs("2001:db8::ffff")).toBeGreaterThan(0);
    th.fail("fe80::1"); th.fail("fe80::2"); th.fail("fe80::3"); th.fail("fd00::1"); th.fail("fd00::2"); th.fail("fd00::3");
    expect(th.blockedForMs("fe80::4")).toBe(0);
    expect(th.blockedForMs("fd00::4")).toBe(0);
  });
});

describe("AuthThrottle cost (review I-new-1)", () => {
  it("25,000 failures against 10,000 tracked addresses run at most one sweep and never scan per failure", () => {
    let t = 0;
    const th = new AuthThrottle({ max: 5, windowMs: 60_000, blockMs: 60_000, now: () => t });
    for (let i = 0; i < 10_000; i++) th.fail(`10.${i >> 8 & 255}.${i & 255}.${i >> 16}`);
    const before = th.sweeps;
    for (let i = 0; i < 25_000; i++) th.fail("203.0.113.1");
    expect(th.sweeps - before).toBeLessThanOrEqual(1);
    expect(th.size()).toBeLessThanOrEqual(20_000);
  });
  it("sweeps at most once per second even as time passes", () => {
    let t = 0;
    const th = new AuthThrottle({ max: 5, windowMs: 500, blockMs: 500, now: () => t, maxEntries: 100 });
    for (let i = 0; i < 100; i++) th.fail(`192.0.2.${i}`);
    const before = th.sweeps;
    for (let i = 0; i < 1_000; i++) { t += 1; th.fail("198.51.100.1"); }
    expect(th.sweeps - before).toBeLessThanOrEqual(2);
  });
  it("sweeping still removes expired entries from both maps", () => {
    let t = 0;
    const th = new AuthThrottle({ max: 0, windowMs: 1_000, blockMs: 1_000, now: () => t, maxEntries: 20 });
    for (let i = 0; i < 10; i++) th.fail(`192.0.2.${i}`);
    t += 5_000;
    th.fail("198.51.100.1");
    expect(th.size()).toBeLessThanOrEqual(2);
  });
});

describe("AuthThrottle memory (US-0017 review M2)", () => {
  it("stays bounded under many distinct (spoofed) addresses, in both maps, evicting the oldest", () => {
    let t = 0;
    const th = new AuthThrottle({ max: 1, windowMs: 60_000, blockMs: 600_000, now: () => t, maxEntries: 100 });
    for (let i = 0; i < 5_000; i++) { th.fail(`10.${i >> 8}.${i & 255}.1`); th.fail(`10.${i >> 8}.${i & 255}.1`); t += 1; }
    expect(th.size()).toBeLessThanOrEqual(200);
    expect(th.blockedForMs("10.0.0.1")).toBe(0); // evicted long ago
    expect(th.blockedForMs(`10.${4_999 >> 8}.${4_999 & 255}.1`)).toBeGreaterThan(0); // the newest is kept
  });
  it("prunes expired entries from the block list too", () => {
    let t = 0;
    const th = new AuthThrottle({ max: 0, windowMs: 1_000, blockMs: 1_000, now: () => t, maxEntries: 10 });
    for (let i = 0; i < 5; i++) th.fail(`192.0.2.${i}`);
    t += 10_000;
    for (let i = 0; i < 5; i++) th.fail(`198.51.100.${i}`);
    expect(th.size()).toBeLessThanOrEqual(5);
  });
});
