import { afterEach, describe, expect, it } from "vitest";
import { fail, ok, setEnvelopeClock } from "../envelope";

const FIXED = new Date(Date.UTC(2030, 0, 2, 3, 4, 5));
afterEach(() => setEnvelopeClock(() => new Date()));

describe("envelope", () => {
  it("fail uses the envelope with a timestamp and version 1.0", async () => {
    setEnvelopeClock(() => FIXED);
    const res = fail(403, "forbidden", "Not allowed.");
    expect(res.status).toBe(403);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.json()).toEqual({ success: false, data: null, error: { code: "forbidden", message: "Not allowed." }, meta: { version: "1.0", timestamp: FIXED.toISOString() } });
  });

  it("ok wraps data with status 200", async () => {
    setEnvelopeClock(() => FIXED);
    const res = ok({ a: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { a: 1 }, error: null, meta: { version: "1.0", timestamp: FIXED.toISOString() } });
  });

  it("merges extra headers but never lets them weaken the fixed ones", () => {
    const res = ok({}, { headers: { "Set-Cookie": "a=b", "Cache-Control": "public", "Content-Type": "text/html" } });
    expect(res.headers.get("Set-Cookie")).toBe("a=b");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  it("honours a status in init for ok and ignores none for fail", () => {
    expect(ok({}, { status: 201 }).status).toBe(201);
    expect(fail(429, "throttled", "Slow down.", { headers: { "Retry-After": "5" } }).headers.get("Retry-After")).toBe("5");
  });

  it("ok(undefined) keeps the data key as null", async () => {
    const body = await ok(undefined).json();
    expect(body).toHaveProperty("data", null);
    expect(body.success).toBe(true);
  });

  it("data that cannot be serialised becomes an internal-error envelope instead of throwing", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const bad of [circular, 10n]) {
      const res = ok(bad);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body).toMatchObject({ success: false, data: null, error: { code: "internal" } });
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });
});
