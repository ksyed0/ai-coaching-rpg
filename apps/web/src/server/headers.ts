// Security headers for pages, built per request by src/proxy.ts (Next 16's name for middleware). Pure: no Next imports, so it is unit tested.
import { liveKitOrigin } from "./config";

/** Routes that are never indexed: they send X-Robots-Tag and robots.txt disallows them (web spec section 8). */
export const PRIVATE_PREFIXES = ["/join", "/session", "/report", "/console", "/admin", "/api"] as const;
export const ROBOTS_TAG = "noindex, nofollow";

/** A prefix matches as a whole path segment: /session and /session/x, not /sessions. */
export const isPrivatePath = (pathname: string): boolean => PRIVATE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));

/** 16 random bytes, base64: unguessable and unique per response. */
export function newNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
}

/**
 * The per-request policy. Scripts run only with this response's nonce ('strict-dynamic' lets those load their own chunks); no
 * 'unsafe-inline'. 'unsafe-eval' only in development (React's dev tooling). Next reads the nonce from the request's copy of this header
 * and puts it on its own scripts, so pages must render dynamically.
 */
export function contentSecurityPolicy(nonce: string, o: { dev: boolean; https: boolean; /** US-0071: the validated LiveKit origin, session pages only. */ livekit?: string }): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${o.dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self'${o.livekit === undefined ? "" : ` ${liveKitSources(o.livekit)}`}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(o.https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

/**
 * US-0071 (A1b Task 12): the LiveKit signalling origin and its HTTP twin on the same host and port (livekit-client may also make an HTTP
 * request there: not verified, so both are allowed, on the session page only). Only an origin that liveKitOrigin itself returns is
 * accepted, so nothing but scheme, host and port can ever reach the policy.
 */
function liveKitSources(origin: string): string {
  if (liveKitOrigin(origin) !== origin) throw new RangeError("the LiveKit origin must be one liveKitOrigin validated");
  const twin = origin.startsWith("wss:") ? `https:${origin.slice(4)}` : `http:${origin.slice(3)}`;
  return `${origin} ${twin}`;
}

/** Whether a page is the participant's session page, the only one that may use the microphone and reach LiveKit (US-0071). */
export const isSessionPage = (pathname: string): boolean => pathname.startsWith("/session/");

/**
 * The response headers for one page request (the CSP is passed in so the request and the response carry the same nonce). US-0071:
 * `microphone` allows the microphone for this page's own origin; the proxy asks for it only on a session page with LiveKit configured.
 */
export function pageHeaders(pathname: string, csp: string, o: { microphone: boolean } = { microphone: false }): [string, string][] {
  const h: [string, string][] = [
    ["Content-Security-Policy", csp],
    ["X-Content-Type-Options", "nosniff"],
    ["Referrer-Policy", "no-referrer"],
    ["X-Frame-Options", "DENY"],
    ["Permissions-Policy", `camera=(), microphone=${o.microphone ? "(self)" : "()"}, geolocation=()`],
    ["Cross-Origin-Opener-Policy", "same-origin"],
    ["Cross-Origin-Resource-Policy", "same-origin"],
  ];
  // The report pages open with a secret in the address and show a person's report: never stored by a browser or a shared cache.
  if (pathname === "/report" || pathname.startsWith("/report/")) h.push(["Cache-Control", "no-store"]);
  if (isPrivatePath(pathname)) h.push(["X-Robots-Tag", ROBOTS_TAG]);
  return h;
}
