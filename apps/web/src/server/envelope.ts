// The response envelope of AGENTS.md section 15. The clock is injectable so tests never assert on real time.

let clock: () => Date = () => new Date();
export function setEnvelopeClock(fn: () => Date): void { clock = fn; }

function respond(body: unknown, status: number, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  // Set last: caller headers (Set-Cookie, Retry-After) are kept but cannot make a credential-bearing response cacheable.
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "application/json");
  // Every API answer is private (web spec section 8): never indexed, whatever the caller passed.
  headers.set("X-Robots-Tag", "noindex, nofollow");
  let text: string;
  try {
    text = JSON.stringify(body);
  } catch {
    // Unserialisable data (BigInt, cycle) must not escape as a throw or a malformed envelope.
    text = JSON.stringify({ success: false, data: null, error: { code: "internal", message: "Internal error." }, meta: meta() });
    // The caller's cookie belonged to the answer that failed: a 500 must not sign anyone in (or out).
    headers.delete("Set-Cookie");
    return new Response(text, { ...init, status: 500, headers });
  }
  return new Response(text, { ...init, status, headers });
}

function meta() { return { version: "1.0", timestamp: clock().toISOString() }; }

export function ok<T>(data: T, init?: ResponseInit): Response {
  return respond({ success: true, data: data ?? null, error: null, meta: meta() }, init?.status ?? 200, init);
}

export function fail(status: number, code: string, message: string, init?: ResponseInit): Response {
  return respond({ success: false, data: null, error: { code, message }, meta: meta() }, status, init);
}
