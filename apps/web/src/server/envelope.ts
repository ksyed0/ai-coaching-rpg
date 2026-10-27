// The response envelope of AGENTS.md section 15. The clock is injectable so tests never assert on real time.

let clock: () => Date = () => new Date();
export function setEnvelopeClock(fn: () => Date): void { clock = fn; }

function respond(body: unknown, status: number, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  // Set last: caller headers (Set-Cookie, Retry-After) are kept but cannot make a credential-bearing response cacheable.
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { ...init, status, headers });
}

const meta = () => ({ version: "1.0", timestamp: clock().toISOString() });

export function ok<T>(data: T, init?: ResponseInit): Response {
  return respond({ success: true, data, error: null, meta: meta() }, init?.status ?? 200, init);
}

export function fail(status: number, code: string, message: string, init?: ResponseInit): Response {
  return respond({ success: false, data: null, error: { code, message }, meta: meta() }, status, init);
}
