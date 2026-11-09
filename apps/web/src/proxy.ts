import { NextResponse, type NextRequest } from "next/server";
import { liveKitOrigin } from "./server/config";
import { contentSecurityPolicy, isSessionPage, newNonce, pageHeaders } from "./server/headers";

// Next 16 renamed middleware to proxy (src/middleware.ts is deprecated and warns at build). Logic lives in src/server/headers.ts.
// A fresh nonce per request: the request copy of the CSP is how Next finds the nonce for its own scripts; the response copy is enforced.
// US-0071 (A1b Task 12): only the session page may use the microphone and reach LiveKit, and only with a valid LIVEKIT_URL. The value is
// read through liveKitOrigin, the rule loadConfig applies to config.livekitUrl, never used raw; an invalid one simply adds nothing here
// (the API routes refuse to start with it). loadConfig itself is not called: it needs every other setting, and the proxy serves public pages.
export function proxy(request: NextRequest): NextResponse {
  const pathname = request.nextUrl.pathname;
  const livekit = isSessionPage(pathname) ? liveKitOrigin(process.env.LIVEKIT_URL) : undefined;
  const csp = contentSecurityPolicy(newNonce(), {
    dev: process.env.NODE_ENV === "development",
    https: (process.env.PUBLIC_ORIGIN ?? "").startsWith("https:"),
    ...(livekit !== undefined && { livekit }),
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Content-Security-Policy", csp);
  requestHeaders.set("x-nonce", /'nonce-([^']+)'/.exec(csp)![1]!);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [name, value] of pageHeaders(pathname, csp, { microphone: livekit !== undefined })) response.headers.set(name, value);
  return response;
}

export const config = {
  // Pages only. Never /api: Next copies the request body of every path the proxy runs on into memory (up to
  // experimental.proxyClientMaxBodySize) before the handler's own 8 KiB limit; the API sets its own headers (envelope.ts, the SSE
  // response, next.config.ts). Nor build assets or the favicon, which carry nothing private.
  matcher: [{ source: "/((?!api/|api$|_next/static/|_next/image|favicon\\.ico$).*)" }],
};
