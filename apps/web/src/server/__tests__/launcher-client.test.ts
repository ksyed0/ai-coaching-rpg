import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LauncherClient,
  LauncherError,
  type LauncherReason,
} from "../launcher-client";

const BASE = "http://127.0.0.1:47123";
const TOKEN = "service-token-0123456789abcdef0123456789abcdef";
const SID = "s-0123456789abcdef";
const INFO = {
  sessionId: SID,
  scenarioId: "friday-escalation",
  status: "running",
  port: 40001,
  modelLabel: "mock",
};

const envelope = (data: unknown) => ({ success: true, data, error: null });
const errorEnvelope = (code: string, message = "server text") => ({
  success: false,
  data: null,
  error: { code, message },
});
const reply = (body: unknown, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

type Call = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  signal: AbortSignal | undefined;
};
function fakeFetch(handler: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const c: Call = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: init?.body as string | undefined,
        signal: init?.signal ?? undefined,
      };
      calls.push(c);
      return handler(c);
    },
  );
  return { fetch: fn as unknown as typeof fetch, calls };
}
const client = (
  f: typeof fetch,
  o: { timeoutMs?: number; longTimeoutMs?: number } = {},
) => new LauncherClient({ baseUrl: BASE, token: TOKEN, fetch: f, ...o });
async function reasonOf(
  p: Promise<unknown>,
): Promise<{ reason: LauncherReason; text: string }> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(LauncherError);
    const err = e as LauncherError;
    return {
      reason: err.reason,
      text: `${err.message} ${err.name} ${err.stack ?? ""} ${String((err as { cause?: unknown }).cause ?? "")}`,
    };
  }
  throw new Error("expected a LauncherError");
}

afterEach(() => vi.restoreAllMocks());

describe("LauncherClient requests", () => {
  it("scenarios: GET /scenarios with the service token in the header only", async () => {
    const f = fakeFetch(() =>
      reply(
        envelope([
          { id: "friday-escalation", title: "Friday escalation", extra: 1 },
        ]),
      ),
    );
    expect(await client(f.fetch).scenarios()).toEqual([
      { id: "friday-escalation", title: "Friday escalation" },
    ]);
    expect(f.calls[0]).toMatchObject({
      url: `${BASE}/scenarios`,
      method: "GET",
    });
    expect(f.calls[0]!.headers["x-service-token"]).toBe(TOKEN);
    expect(f.calls[0]!.url).not.toContain(TOKEN);
  });

  it("createSession: POST /sessions { scenarioId } returns the codes", async () => {
    const created = {
      sessionId: SID,
      status: "running",
      port: 40001,
      modelLabel: "mock",
      codes: [{ roleId: "tech_lead", code: "ABCD-EFGH" }],
    };
    const f = fakeFetch(() => reply(envelope(created)));
    expect(await client(f.fetch).createSession("friday-escalation")).toEqual(
      created,
    );
    expect(f.calls[0]).toMatchObject({
      url: `${BASE}/sessions`,
      method: "POST",
    });
    expect(f.calls[0]!.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({
      scenarioId: "friday-escalation",
    });
  });

  it("sessions and session: the listed shape, optional fields kept only when valid", async () => {
    const f = fakeFetch((c) =>
      reply(
        envelope(
          c.url.endsWith("/sessions")
            ? [INFO, { sessionId: "s-2", scenarioId: "x", status: "stopped" }]
            : INFO,
        ),
      ),
    );
    const c = client(f.fetch);
    expect(await c.sessions()).toEqual([
      INFO,
      { sessionId: "s-2", scenarioId: "x", status: "stopped" },
    ]);
    expect(await c.session(SID)).toEqual(INFO);
    expect(f.calls[1]!.url).toBe(`${BASE}/sessions/${SID}`);
  });

  it("facilitator: GET /sessions/:id/facilitator returns port and token together", async () => {
    const f = fakeFetch(() =>
      reply(envelope({ port: 40001, token: "t".repeat(64) })),
    );
    expect(await client(f.fetch).facilitator(SID)).toEqual({
      port: 40001,
      token: "t".repeat(64),
    });
    expect(f.calls[0]!.url).toBe(`${BASE}/sessions/${SID}/facilitator`);
  });

  it("reissue: one role; reissueAll: all:true; both pass `by`", async () => {
    const f = fakeFetch((c) =>
      reply(
        envelope(
          JSON.parse(c.body!).roleId
            ? { code: "WXYZ-1234" }
            : {
                codes: [
                  { roleId: "a", code: "AAAA-1111" },
                  { roleId: "b", code: "BBBB-2222" },
                ],
              },
        ),
      ),
    );
    const c = client(f.fetch);
    expect(await c.reissue(SID, "tech_lead", "Ann")).toBe("WXYZ-1234");
    expect(f.calls[0]).toMatchObject({
      url: `${BASE}/sessions/${SID}/codes/reissue`,
      method: "POST",
    });
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({
      roleId: "tech_lead",
      by: "Ann",
    });
    expect(await c.reissueAll(SID, "Ann")).toEqual([
      { roleId: "a", code: "AAAA-1111" },
      { roleId: "b", code: "BBBB-2222" },
    ]);
    expect(JSON.parse(f.calls[1]!.body!)).toEqual({ all: true, by: "Ann" });
  });

  it("restart: POST /sessions/:id/restart with an empty object, codes optional", async () => {
    const f = fakeFetch(() =>
      reply(envelope({ ...INFO, codes: [{ roleId: "a", code: "AAAA-1111" }] })),
    );
    expect(await client(f.fetch).restart(SID)).toEqual({
      ...INFO,
      codes: [{ roleId: "a", code: "AAAA-1111" }],
    });
    expect(f.calls[0]).toMatchObject({
      url: `${BASE}/sessions/${SID}/restart`,
      method: "POST",
    });
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({});
    const g = fakeFetch(() => reply(envelope(INFO)));
    expect(await client(g.fetch).restart(SID)).toEqual(INFO);
  });

  it("a session id that could change the path is refused before any request", async () => {
    const f = fakeFetch(() => reply(envelope(INFO)));
    for (const bad of ["../x", "a/b", "", "a?b", "s-1#"])
      expect((await reasonOf(client(f.fetch).session(bad))).reason).toBe(
        "not_found",
      );
    expect(f.calls).toHaveLength(0);
  });
});

describe("LauncherClient timeouts", () => {
  /** AbortSignal.timeout replaced by a signal the test aborts by hand; records the requested milliseconds. */
  function fakeTimeouts() {
    const made: { ms: number; ctl: AbortController }[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      const ctl = new AbortController();
      made.push({ ms, ctl });
      return ctl.signal;
    });
    return made;
  }
  const hangs = (c: Call) =>
    new Promise<Response>((_res, rej) =>
      c.signal!.addEventListener("abort", () => rej(c.signal!.reason), {
        once: true,
      }),
    );

  it("reads use timeoutMs (default 5000); create, restart, reissue and reissueAll use longTimeoutMs (default 120000)", async () => {
    const made = fakeTimeouts();
    const f = fakeFetch(() =>
      reply(
        envelope({
          code: "AAAA-1111",
          codes: [],
          sessionId: SID,
          status: "running",
          port: 1,
          modelLabel: "m",
          scenarioId: "x",
          token: "t",
          ...{},
        }),
      ),
    );
    const c = client(f.fetch);
    const settle = (p: Promise<unknown>) => p.catch(() => undefined);
    await settle(c.scenarios());
    await settle(c.sessions());
    await settle(c.session(SID));
    await settle(c.facilitator(SID));
    await settle(c.createSession("x"));
    await settle(c.restart(SID));
    await settle(c.reissue(SID, "r", "b"));
    await settle(c.reissueAll(SID, "b"));
    expect(made.map((m) => m.ms)).toEqual([
      5000, 5000, 5000, 5000, 120_000, 120_000, 120_000, 120_000,
    ]);
    const custom = fakeTimeouts();
    await settle(
      client(f.fetch, { timeoutMs: 7, longTimeoutMs: 9 }).session(SID),
    );
    await settle(
      client(f.fetch, { timeoutMs: 7, longTimeoutMs: 9 }).restart(SID),
    );
    expect(custom.map((m) => m.ms)).toEqual([7, 9]);
  });

  it("a request that outlives its timeout becomes reason timeout", async () => {
    const made = fakeTimeouts();
    const f = fakeFetch(hangs);
    const p = reasonOf(client(f.fetch).session(SID));
    await vi.waitFor(() => expect(made).toHaveLength(1));
    made[0]!.ctl.abort(new DOMException("timed out", "TimeoutError"));
    expect((await p).reason).toBe("timeout");
  });

  it("a body that stalls after the headers is bounded by the same timeout", async () => {
    const made = fakeTimeouts();
    const f = fakeFetch((c) => {
      const body = new ReadableStream({
        start(ctl) {
          c.signal!.addEventListener(
            "abort",
            () => ctl.error(c.signal!.reason),
            { once: true },
          );
        },
      });
      return new Response(body, { status: 200 });
    });
    const p = reasonOf(client(f.fetch).session(SID));
    await vi.waitFor(() => expect(made).toHaveLength(1));
    made[0]!.ctl.abort(new DOMException("timed out", "TimeoutError"));
    expect((await p).reason).toBe("timeout");
  });
});

describe("LauncherClient error mapping", () => {
  const TABLE: [number, string, LauncherReason][] = [
    [401, "unauthorized", "unauthorized"],
    [400, "bad_request", "bad_request"],
    [400, "unknown_scenario", "bad_request"],
    [413, "payload_too_large", "bad_request"],
    [404, "not_found", "not_found"],
    [409, "conflict", "conflict"],
    [429, "capacity", "capacity"],
    [504, "timeout", "timeout"],
    [502, "start_failed", "failed"],
    [503, "unavailable", "unavailable"],
    [500, "internal", "failed"],
    // Codes the BFF has never heard of are generic, whatever their status.
    [404, "brand_new_code", "failed"],
    [500, "", "failed"],
    [418, "teapot", "failed"],
  ];
  it.each(TABLE)(
    "HTTP %i with code %j maps to %s, and the server's message text never passes through",
    async (status, code, reason) => {
      const f = fakeFetch(() =>
        reply(
          errorEnvelope(code, "SECRET-SERVER-TEXT /var/data 127.0.0.1:40001"),
          status,
        ),
      );
      const r = await reasonOf(client(f.fetch).session(SID));
      expect(r.reason).toBe(reason);
      expect(r.text).not.toContain("SECRET-SERVER-TEXT");
      expect(r.text).not.toContain("40001");
    },
  );

  it.each([
    [401, "unauthorized"],
    [404, "not_found"],
    [409, "conflict"],
    [429, "capacity"],
    [504, "timeout"],
    [503, "unavailable"],
    [400, "bad_request"],
    [500, "failed"],
    [502, "failed"],
  ] as [number, LauncherReason][])(
    "HTTP %i without a readable envelope maps to %s",
    async (status, reason) => {
      const f = fakeFetch(() => reply("<html>oops</html>", status));
      expect((await reasonOf(client(f.fetch).session(SID))).reason).toBe(
        reason,
      );
    },
  );

  it("a network failure is unavailable and never shows the launcher URL or the token", async () => {
    const f = fakeFetch(() => {
      throw new TypeError(
        `fetch failed: connect ECONNREFUSED ${BASE} token=${TOKEN}`,
      );
    });
    const r = await reasonOf(client(f.fetch).session(SID));
    expect(r.reason).toBe("unavailable");
    for (const secret of [BASE, "47123", TOKEN, "127.0.0.1"])
      expect(r.text).not.toContain(secret);
  });

  it("the token is in no URL and no error, whatever the failure", async () => {
    const f = fakeFetch((c) =>
      reply(
        errorEnvelope("internal", `echo ${c.headers["x-service-token"]}`),
        500,
      ),
    );
    const c = client(f.fetch);
    for (const call of [
      () => c.scenarios(),
      () => c.sessions(),
      () => c.session(SID),
      () => c.facilitator(SID),
      () => c.createSession("x"),
      () => c.restart(SID),
      () => c.reissue(SID, "r", "b"),
      () => c.reissueAll(SID, "b"),
    ]) {
      expect((await reasonOf(call())).text).not.toContain(TOKEN);
    }
    for (const call of f.calls) expect(call.url).not.toContain(TOKEN);
  });

  it.each([
    ["not JSON", "this is not json"],
    ["an array", "[]"],
    ["null", "null"],
    [
      "success without data",
      JSON.stringify({ success: true, data: null, error: null }),
    ],
    ["success false with 200", JSON.stringify(errorEnvelope("not_found"))],
    ["a string success", JSON.stringify({ success: "yes", data: INFO })],
  ])("a malformed envelope (%s) is reason failed", async (_n, body) => {
    const f = fakeFetch(() => reply(body, 200));
    expect((await reasonOf(client(f.fetch).session(SID))).reason).toBe(
      "failed",
    );
  });

  it("a response that does not match the expected shape is reason failed", async () => {
    const bad: [
      string,
      () => unknown,
      (c: LauncherClient) => Promise<unknown>,
    ][] = [
      ["scenarios not an array", () => ({}), (c) => c.scenarios()],
      ["scenario without a title", () => [{ id: "x" }], (c) => c.scenarios()],
      [
        "session with an unknown status",
        () => ({ ...INFO, status: "weird" }),
        (c) => c.session(SID),
      ],
      [
        "session with a bad port",
        () => ({ ...INFO, port: 70000 }),
        (c) => c.session(SID),
      ],
      [
        "session with a string port",
        () => ({ ...INFO, port: "40001" }),
        (c) => c.session(SID),
      ],
      ["sessions with a bad entry", () => [INFO, 3], (c) => c.sessions()],
      [
        "facilitator without a token",
        () => ({ port: 1 }),
        (c) => c.facilitator(SID),
      ],
      [
        "facilitator with an empty token",
        () => ({ port: 1, token: "" }),
        (c) => c.facilitator(SID),
      ],
      [
        "create without codes",
        () => ({ sessionId: SID, status: "running", port: 1, modelLabel: "m" }),
        (c) => c.createSession("x"),
      ],
      [
        "create that is not running",
        () => ({
          sessionId: SID,
          status: "stopped",
          port: 1,
          modelLabel: "m",
          codes: [],
        }),
        (c) => c.createSession("x"),
      ],
      ["reissue without a code", () => ({}), (c) => c.reissue(SID, "r", "b")],
      [
        "reissueAll with a bad entry",
        () => ({ codes: [{ roleId: "a" }] }),
        (c) => c.reissueAll(SID, "b"),
      ],
      [
        "restart with bad codes",
        () => ({ ...INFO, codes: "x" }),
        (c) => c.restart(SID),
      ],
    ];
    for (const [name, data, call] of bad) {
      const f = fakeFetch(() => reply(envelope(data())));
      expect((await reasonOf(call(client(f.fetch)))).reason, name).toBe(
        "failed",
      );
    }
  });

  it("an oversized response is reason failed", async () => {
    const f = fakeFetch(() =>
      reply(`{"success":true,"data":"${"x".repeat(2 * 1024 * 1024)}"}`),
    );
    expect((await reasonOf(client(f.fetch).session(SID))).reason).toBe(
      "failed",
    );
  });

  it("never follows a redirect (the token header would travel with it)", async () => {
    const f = fakeFetch(() => reply(envelope(INFO)));
    await client(f.fetch).session(SID);
    const init = (f.fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as RequestInit;
    expect(init.redirect).toBe("error");
  });
});
