import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { contentSecurityPolicy, isPrivatePath, PRIVATE_PREFIXES, ROBOTS_TAG } from "../headers";
import { config, proxy } from "../../proxy";
import nextConfig from "../../../next.config";
import robots from "../../app/robots";

const directive = (csp: string, name: string) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? "";
const run = (path: string) => proxy(new NextRequest(`https://play.example.org${path}`));

describe("security headers (src/proxy.ts)", () => {
  it("the CSP header carries a fresh nonce per request and no unsafe-inline for scripts", () => {
    const a = run("/join").headers.get("Content-Security-Policy")!;
    const b = run("/join").headers.get("Content-Security-Policy")!;
    const nonceOf = (csp: string) => /'nonce-([A-Za-z0-9+/=]+)'/.exec(directive(csp, "script-src"))?.[1];
    expect(nonceOf(a)).toMatch(/^[A-Za-z0-9+/]{22}==$/); // 16 random bytes
    expect(nonceOf(b)).toBeDefined();
    expect(nonceOf(a)).not.toBe(nonceOf(b));
    for (const csp of [a, b]) {
      expect(directive(csp, "script-src")).not.toContain("unsafe-inline");
      expect(directive(csp, "script-src")).toContain("'strict-dynamic'");
      expect(directive(csp, "object-src")).toBe("object-src 'none'");
      expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
      expect(directive(csp, "base-uri")).toBe("base-uri 'none'");
      expect(directive(csp, "default-src")).toBe("default-src 'self'");
    }
  });

  it("hands the nonce to the renderer on the request (Next reads it from the request's CSP)", () => {
    const res = run("/join");
    const csp = res.headers.get("Content-Security-Policy")!;
    // NextResponse.next({ request: { headers } }) records overridden request headers as x-middleware-request-*.
    expect(res.headers.get("x-middleware-request-content-security-policy")).toBe(csp);
    expect(csp).toContain(`'nonce-${res.headers.get("x-middleware-request-x-nonce")}'`);
  });

  it("every private route sends X-Robots-Tag; a public one does not", () => {
    for (const p of ["/join", "/join?session=s&role=r", "/session/abc", "/report/x", "/console", "/console/login", "/admin", "/api/v1/stream"]) {
      expect(run(p).headers.get("X-Robots-Tag"), p).toBe(ROBOTS_TAG);
    }
    for (const p of ["/", "/joinery", "/robots.txt"]) expect(run(p).headers.get("X-Robots-Tag"), p).toBeNull();
  });

  it("sets the other security headers on every page", () => {
    const h = run("/session/abc").headers;
    expect(h.get("X-Content-Type-Options")).toBe("nosniff");
    expect(h.get("Referrer-Policy")).toBe("no-referrer");
    expect(h.get("X-Frame-Options")).toBe("DENY");
    expect(h.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(h.get("Permissions-Policy")).toContain("camera=()");
  });

  it("allows eval only in development and upgrades insecure requests only for an https origin", () => {
    const prod = contentSecurityPolicy("N", { dev: false, https: true });
    expect(prod).not.toContain("unsafe-eval");
    expect(prod).toContain("upgrade-insecure-requests");
    const dev = contentSecurityPolicy("N", { dev: true, https: false });
    expect(directive(dev, "script-src")).toContain("'unsafe-eval'");
    expect(dev).not.toContain("upgrade-insecure-requests");
    expect(directive(dev, "script-src")).not.toContain("unsafe-inline");
  });
});

describe("robots", () => {
  it("robots.txt disallows the private prefixes", () => {
    const r = robots();
    const rules = Array.isArray(r.rules) ? r.rules : [r.rules];
    const all = rules.find((x) => x.userAgent === "*")!;
    const disallow = ([] as string[]).concat(all.disallow ?? []);
    for (const p of ["/join", "/session", "/report", "/console", "/admin", "/api"]) expect(disallow).toContain(p);
    expect(disallow).toEqual([...PRIVATE_PREFIXES]);
  });

  it("isPrivatePath matches a prefix as a whole path segment", () => {
    expect(isPrivatePath("/join")).toBe(true);
    expect(isPrivatePath("/session/x/y")).toBe(true);
    expect(isPrivatePath("/joinery")).toBe(false);
    expect(isPrivatePath("/")).toBe(false);
  });
});

describe("proxy matcher and body buffering", () => {
  // Next builds the matcher from this source; as a plain regular expression it must give the same answers for these literal paths.
  const sources = config.matcher.map((m) => m.source);
  const runs = (path: string) => sources.some((src) => new RegExp(`^${src}$`).test(path));

  it("never runs the proxy for /api (Next would buffer a copy of every request body in memory before the handler's 8 KiB limit)", () => {
    for (const p of ["/api", "/api/", "/api/v1/join", "/api/v1/stream", "/api/anything/else"]) expect(runs(p), p).toBe(false);
  });

  it("runs it for pages (they need the nonce) but not for build assets or the favicon itself", () => {
    for (const p of ["/", "/join", "/session/abc", "/report/x", "/console", "/apis", "/favicon.ico.html", "/robots.txt"]) expect(runs(p), p).toBe(true);
    for (const p of ["/_next/static/chunks/a.js", "/_next/image", "/favicon.ico"]) expect(runs(p), p).toBe(false);
  });

  it("caps what Next buffers for the paths the proxy does run on", () => {
    expect(nextConfig.experimental?.proxyClientMaxBodySize).toBe("8kb");
  });
});
