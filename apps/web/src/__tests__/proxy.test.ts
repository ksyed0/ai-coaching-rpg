import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { buildCustomRoute } from "next/dist/lib/build-custom-route";
import { proxy } from "../proxy";
import nextConfig from "../../next.config";

// US-0071 (A1b Task 12): the microphone and the LiveKit origin are allowed on the participant's session page ONLY, and only when the web
// server has a valid LIVEKIT_URL. The CSP's LiveKit origin comes from the validated origin (config.ts liveKitOrigin), never the raw value.
// The static rule of next.config.ts no longer covers /session/*, so a session page gets exactly one Permissions-Policy (the proxy's).

const directive = (csp: string, name: string) => csp.split(";").map((d) => d.trim()).find((d) => d === name || d.startsWith(`${name} `)) ?? "";
const run = (path: string) => proxy(new NextRequest(`https://play.example.org${path}`));
const STATIC = "camera=(), microphone=(), geolocation=()";
const SESSION = "camera=(), microphone=(self), geolocation=()";

afterEach(() => vi.unstubAllEnvs());

describe("the session page with LiveKit (proxy)", () => {
  it("a session page with LIVEKIT_URL gets microphone=(self) and connect-src with the wss and https origins", () => {
    vi.stubEnv("LIVEKIT_URL", "wss://pilot.example");
    const h = run("/session/s-0123456789abcdef").headers;
    expect(h.get("Permissions-Policy")).toBe(SESSION);
    expect(directive(h.get("Content-Security-Policy")!, "connect-src")).toBe("connect-src 'self' wss://pilot.example https://pilot.example");
  });

  it("connect-src is built from the validated origin, not the raw variable", () => {
    vi.stubEnv("LIVEKIT_URL", "wss://pilot.example:7443");
    expect(directive(run("/session/x").headers.get("Content-Security-Policy")!, "connect-src")).toBe("connect-src 'self' wss://pilot.example:7443 https://pilot.example:7443");
    vi.stubEnv("LIVEKIT_URL", "WSS://Pilot.Example:443/");
    expect(directive(run("/session/x").headers.get("Content-Security-Policy")!, "connect-src")).toBe("connect-src 'self' wss://pilot.example https://pilot.example");
    vi.stubEnv("LIVEKIT_URL", "ws://127.0.0.1:7880");
    expect(directive(run("/session/x").headers.get("Content-Security-Policy")!, "connect-src")).toBe("connect-src 'self' ws://127.0.0.1:7880 http://127.0.0.1:7880");
  });

  it.each([
    "wss://pilot.example/path", "wss://pilot.example; script-src *", "wss://pilot.example 'unsafe-inline'", "ws://192.168.1.2:7880", "https://pilot.example", "wss://u:p@pilot.example", "*", "",
  ])("an invalid LIVEKIT_URL %j gives no LiveKit origin and microphone=()", (raw) => {
    vi.stubEnv("LIVEKIT_URL", raw);
    const h = run("/session/x").headers;
    const csp = h.get("Content-Security-Policy")!;
    expect(directive(csp, "connect-src")).toBe("connect-src 'self'");
    expect(h.get("Permissions-Policy")).toBe(STATIC);
    if (raw.length > 1) expect(csp).not.toContain(raw);
    expect(directive(csp, "script-src")).not.toContain("*");
  });

  it("a session page without LIVEKIT_URL keeps microphone=() and connect-src 'self'", () => {
    vi.stubEnv("LIVEKIT_URL", undefined);
    const h = run("/session/x").headers;
    expect(h.get("Permissions-Policy")).toBe(STATIC);
    expect(directive(h.get("Content-Security-Policy")!, "connect-src")).toBe("connect-src 'self'");
  });

  it("the console, join, report and other pages keep microphone=() and connect-src 'self' even with LIVEKIT_URL", () => {
    vi.stubEnv("LIVEKIT_URL", "wss://pilot.example");
    for (const p of ["/", "/join", "/join?session=s&role=r", "/console", "/console/sessions/s-1", "/report", "/report/enter", "/session", "/sessions", "/sessionx/y", "/admin", "/robots.txt", "/x/session/y"]) {
      const h = run(p).headers;
      expect(h.get("Permissions-Policy"), p).toBe(STATIC);
      expect(directive(h.get("Content-Security-Policy")!, "connect-src"), p).toBe("connect-src 'self'");
      expect(h.get("Content-Security-Policy"), p).not.toContain("pilot.example");
    }
  });

  it("/session/x still gets nosniff, Referrer-Policy, X-Frame-Options and the other page headers from the proxy", () => {
    vi.stubEnv("LIVEKIT_URL", "wss://pilot.example");
    const h = run("/session/x").headers;
    expect(h.get("X-Content-Type-Options")).toBe("nosniff");
    expect(h.get("Referrer-Policy")).toBe("no-referrer");
    expect(h.get("X-Frame-Options")).toBe("DENY");
    expect(h.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(h.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(h.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(directive(h.get("Content-Security-Policy")!, "frame-ancestors")).toBe("frame-ancestors 'none'");
  });

  it("camera=() and geolocation=() stay everywhere", () => {
    vi.stubEnv("LIVEKIT_URL", "wss://pilot.example");
    for (const p of ["/session/x", "/console", "/join", "/"]) {
      const pp = run(p).headers.get("Permissions-Policy")!;
      expect(pp, p).toContain("camera=()");
      expect(pp, p).toContain("geolocation=()");
    }
  });
});

describe("the static header rules (next.config.ts)", () => {
  /** Next compiles each `source` with path-to-regexp exactly like this (next/dist/lib/build-custom-route.js), so this is its own match. */
  async function staticRulesFor(path: string) {
    const rules = await nextConfig.headers!();
    return rules.filter((r) => new RegExp(buildCustomRoute("header", r).regex).test(path));
  }

  it("the static header rules do not cover /session/x", async () => {
    for (const p of ["/session/x", "/session/s-0123456789abcdef", "/session/x/y"]) expect(await staticRulesFor(p), p).toEqual([]);
  });

  it("/sessions, /api/v1/join and every other path still match the static rule with Permissions-Policy microphone=()", async () => {
    for (const p of ["/", "/sessions", "/session", "/api/v1/join", "/api/v1/voice/token", "/api/v1/stream", "/console", "/join", "/report/enter", "/_next/static/x.js"]) {
      const rules = await staticRulesFor(p);
      expect(rules, p).toHaveLength(1);
      const headers = Object.fromEntries(rules[0]!.headers.map((x) => [x.key, x.value]));
      expect(headers["Permissions-Policy"], p).toBe(STATIC);
      expect(headers["X-Content-Type-Options"], p).toBe("nosniff");
      expect(headers["X-Frame-Options"], p).toBe("DENY");
      expect(headers["Referrer-Policy"], p).toBe("no-referrer");
    }
  });
});
