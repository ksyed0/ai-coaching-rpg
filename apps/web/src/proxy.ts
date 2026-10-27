import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy, newNonce, pageHeaders } from "./server/headers";

// Next 16 renamed middleware to proxy (src/middleware.ts is deprecated and warns at build). Logic lives in src/server/headers.ts.
// A fresh nonce per request: the request copy of the CSP is how Next finds the nonce for its own scripts; the response copy is enforced.
export function proxy(request: NextRequest): NextResponse {
  const csp = contentSecurityPolicy(newNonce(), {
    dev: process.env.NODE_ENV === "development",
    https: (process.env.PUBLIC_ORIGIN ?? "").startsWith("https:"),
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Content-Security-Policy", csp);
  requestHeaders.set("x-nonce", /'nonce-([^']+)'/.exec(csp)![1]!);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [name, value] of pageHeaders(request.nextUrl.pathname, csp)) response.headers.set(name, value);
  return response;
}

export const config = {
  // Everything but build assets, which carry no secrets and are cached.
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico).*)" }],
};
