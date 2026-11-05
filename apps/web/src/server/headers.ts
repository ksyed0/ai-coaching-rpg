// Security headers for pages, built per request by src/proxy.ts (Next 16's name for middleware). Pure: no Next imports, so it is unit tested.

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
export function contentSecurityPolicy(nonce: string, o: { dev: boolean; https: boolean }): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${o.dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(o.https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

/** The response headers for one page request (the CSP is passed in so the request and the response carry the same nonce). */
export function pageHeaders(pathname: string, csp: string): [string, string][] {
  const h: [string, string][] = [
    ["Content-Security-Policy", csp],
    ["X-Content-Type-Options", "nosniff"],
    ["Referrer-Policy", "no-referrer"],
    ["X-Frame-Options", "DENY"],
    ["Permissions-Policy", "camera=(), microphone=(), geolocation=()"],
    ["Cross-Origin-Opener-Policy", "same-origin"],
    ["Cross-Origin-Resource-Policy", "same-origin"],
  ];
  if (isPrivatePath(pathname)) h.push(["X-Robots-Tag", ROBOTS_TAG]);
  return h;
}
