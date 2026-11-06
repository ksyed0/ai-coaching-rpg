import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LauncherClient,
  LauncherError,
  MAX_REPORT_RESPONSE_CHARS,
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

  it("reissue with reason removed sends roleId, by and reason; without it the body has no reason key", async () => {
    const f = fakeFetch(() => reply(envelope({ code: "WXYZ-1234" })));
    const c = client(f.fetch);
    expect(await c.reissue(SID, "tech_lead", "Ann", "removed")).toBe(
      "WXYZ-1234",
    );
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({
      roleId: "tech_lead",
      by: "Ann",
      reason: "removed",
    });
    await c.reissue(SID, "tech_lead", "Ann");
    const plain = JSON.parse(f.calls[1]!.body!);
    expect(plain).toEqual({ roleId: "tech_lead", by: "Ann" });
    expect(Object.keys(plain)).not.toContain("reason");
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

describe("LauncherClient AI roles", () => {
  it("setAiRoles: PUT /sessions/:id/ai-roles { roles }, answers roles and the human codes only", async () => {
    const f = fakeFetch(() =>
      reply(envelope({ roles: ["tech_lead"], includeInGroup: true, codes: [{ roleId: "delivery_lead", code: "ABCD-EFGH", extra: 1 }], secret: "x" })),
    );
    const r = await client(f.fetch).setAiRoles(SID, ["tech_lead"]);
    expect(r).toEqual({ roles: ["tech_lead"], includeInGroup: true, codes: [{ roleId: "delivery_lead", code: "ABCD-EFGH" }] });
    expect(f.calls[0]).toMatchObject({ url: `${BASE}/sessions/${SID}/ai-roles`, method: "PUT" });
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({ roles: ["tech_lead"] });
  });

  it("setAiRoles: sends includeInGroup only when defined, and keeps false", async () => {
    const f = fakeFetch(() => reply(envelope({ roles: [], includeInGroup: false, codes: [] })));
    const r = await client(f.fetch).setAiRoles(SID, [], false);
    expect(r.includeInGroup).toBe(false);
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({ roles: [], includeInGroup: false });
    const g = fakeFetch(() => reply(envelope({ roles: [], includeInGroup: true, codes: [] })));
    await client(g.fetch).setAiRoles(SID, []);
    expect(Object.keys(JSON.parse(g.calls[0]!.body!))).toEqual(["roles"]);
  });

  it("a reply without includeInGroup is a launcher error", async () => {
    for (const v of [undefined, "true", 1, null]) {
      const f = fakeFetch(() => reply(envelope({ roles: [], codes: [], ...(v !== undefined && { includeInGroup: v }) })));
      expect((await reasonOf(client(f.fetch).setAiRoles(SID, []))).reason).toBe("failed");
    }
  });

  it("session info keeps includeInGroup only when it is a boolean", async () => {
    const f = fakeFetch(() => reply(envelope({ sessionId: SID, scenarioId: "pitch", status: "running", includeInGroup: false })));
    expect((await client(f.fetch).session(SID)).includeInGroup).toBe(false);
    const g = fakeFetch(() => reply(envelope({ sessionId: SID, scenarioId: "pitch", status: "running", includeInGroup: "no" })));
    expect("includeInGroup" in (await client(g.fetch).session(SID))).toBe(false);
  });

  it("setAiRoles: a reply that is not roles plus codes is a failure", async () => {
    for (const data of [{ roles: "x", includeInGroup: true, codes: [] }, { roles: [1], includeInGroup: true, codes: [] }, { roles: [], includeInGroup: true, codes: [{ roleId: "a" }] }, { includeInGroup: true, codes: [] }]) {
      const f = fakeFetch(() => reply(envelope(data)));
      expect((await reasonOf(client(f.fetch).setAiRoles(SID, []))).reason).toBe("failed");
    }
  });

  it.each(["ai_role", "ai_notice", "ai_started", "ai_no_human", "ai_too_many"] as const)("the control code %s is its own reason, 409, and the server text never passes through", async (code) => {
    const f = fakeFetch(() => reply(errorEnvelope(code, "SECRET server text"), 409));
    const r = await reasonOf(client(f.fetch).setAiRoles(SID, ["a"]));
    expect(r.reason).toBe(code);
    expect(r.text).not.toContain("SECRET");
  });

  it("ai_invalid (400) is its own reason", async () => {
    const f = fakeFetch(() => reply(errorEnvelope("ai_invalid", "SECRET"), 400));
    expect((await reasonOf(client(f.fetch).setAiRoles(SID, ["a"]))).reason).toBe("ai_invalid");
  });

  it("intents: GET /sessions/:id/ai-roles/:roleId/intents keeps only the six fields, drops unknown trigger/outcome/reason, caps hint at 300 code points and entries at 50", async () => {
    const good = { ts: 5, sceneId: "s1", trigger: "reply", outcome: "spoken" };
    const hint = "\u{1F600}".repeat(400);
    const many = Array.from({ length: 60 }, (_, i) => ({ ...good, ts: i }));
    const f = fakeFetch(() =>
      reply(
        envelope({
          entries: [
            { ...good, extra: "x", hint },
            { ...good, sceneId: null, outcome: "skipped", reason: "budget" },
            { ...good, trigger: "x" },
            { ...good, outcome: "x" },
            { ...good, outcome: "skipped", reason: "x" },
            "nope",
          ],
          other: 1,
        }),
      ),
    );
    const r = await client(f.fetch).intents(SID, "tech_lead");
    expect(r).toEqual([
      { ...good, hint: "\u{1F600}".repeat(300) },
      { ...good, sceneId: null, outcome: "skipped", reason: "budget" },
    ]);
    expect(f.calls[0]).toMatchObject({ url: `${BASE}/sessions/${SID}/ai-roles/tech_lead/intents`, method: "GET" });
    const g = fakeFetch(() => reply(envelope({ entries: many })));
    expect(await client(g.fetch).intents(SID, "tech_lead")).toHaveLength(50);
  });

  it("intents: an entry whose sceneId is not an id (or too long) is dropped", async () => {
    const good = { ts: 5, trigger: "reply", outcome: "spoken" };
    const f = fakeFetch(() =>
      reply(envelope({ entries: [{ ...good, sceneId: "Not An Id" }, { ...good, sceneId: "x".repeat(129) }, { ...good, sceneId: "scene_1" }] })),
    );
    expect(await client(f.fetch).intents(SID, "tech_lead")).toEqual([{ ...good, sceneId: "scene_1" }]);
  });

  it("setAiRoles: a returned role that is not an id is a failure", async () => {
    const f = fakeFetch(() => reply(envelope({ roles: ["Tech Lead"], codes: [] })));
    expect((await reasonOf(client(f.fetch).setAiRoles(SID, []))).reason).toBe("failed");
  });

  it("intents: a role id that is not an id never reaches the network", async () => {
    const f = fakeFetch(() => reply(envelope({ entries: [] })));
    for (const bad of ["../x", "a/b", "Tech Lead", "", "x".repeat(129)])
      expect((await reasonOf(client(f.fetch).intents(SID, bad))).reason).toBe("not_found");
    expect(f.calls).toHaveLength(0);
  });
});

describe("LauncherClient AI turns", () => {
  const RES = "0123456789abcdef0123456789abcdef";
  it("reserveTurn, runTurn and releaseTurn: POST to reserve, run and release with the reservation in the body only", async () => {
    const f = fakeFetch((c) => reply(envelope(c.url.endsWith("/reserve") ? { reservation: RES } : c.url.endsWith("/run") ? { started: true } : {})));
    const c = client(f.fetch);
    expect(await c.reserveTurn(SID, "tech_lead")).toBe(RES);
    await c.runTurn(SID, "tech_lead", RES, "HINT");
    await c.runTurn(SID, "tech_lead", RES);
    await c.releaseTurn(SID, "tech_lead", RES);
    expect(f.calls.map((x) => [x.method, x.url])).toEqual([
      ["POST", `${BASE}/sessions/${SID}/ai-roles/tech_lead/reserve`],
      ["POST", `${BASE}/sessions/${SID}/ai-roles/tech_lead/run`],
      ["POST", `${BASE}/sessions/${SID}/ai-roles/tech_lead/run`],
      ["POST", `${BASE}/sessions/${SID}/ai-roles/tech_lead/release`],
    ]);
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({});
    expect(JSON.parse(f.calls[1]!.body!)).toEqual({ reservation: RES, hint: "HINT" });
    expect(JSON.parse(f.calls[2]!.body!)).toEqual({ reservation: RES });
    expect(JSON.parse(f.calls[3]!.body!)).toEqual({ reservation: RES });
    expect(f.calls.some((x) => x.url.includes(RES))).toBe(false);
  });

  it("reserveTurn: a reply without a 32-hex reservation is a failure; a bad role id never reaches the network", async () => {
    const f = fakeFetch(() => reply(envelope({ reservation: "nope" })));
    expect((await reasonOf(client(f.fetch).reserveTurn(SID, "tech_lead"))).reason).toBe("failed");
    expect((await reasonOf(client(f.fetch).reserveTurn(SID, "../x"))).reason).toBe("not_found");
    expect((await reasonOf(client(f.fetch).runTurn(SID, "a/b", RES))).reason).toBe("not_found");
    expect(f.calls).toHaveLength(1);
  });

  it.each(["ai_busy", "ai_budget", "ai_absent", "ai_expired"] as const)("%s is its own reason and the server text never passes through", async (code) => {
    const f = fakeFetch(() => reply(errorEnvelope(code, "SECRET"), 409));
    const r = await reasonOf(client(f.fetch).reserveTurn(SID, "tech_lead"));
    expect(r.reason).toBe(code);
    expect(r.text).not.toContain("SECRET");
  });
});

describe("LauncherClient report links", () => {
  const CRED = { id: "AbCdEfGhIjK", sessionId: SID, role: "ana", createdAt: 1, expiresAt: 2, lastUsedAt: 1 };

  it("reportLinks: GET and the credential id is dropped", async () => {
    const f = fakeFetch(() => reply(envelope({ state: "ready", players: { rated: 1, total: 2 }, roles: [{ role: "ana", credential: CRED, selfRated: { rated: 2, total: 5 } }, { role: "bo", credential: null, selfRated: null }] })));
    const out = await client(f.fetch).reportLinks(SID);
    expect(f.calls[0]).toMatchObject({ url: `${BASE}/sessions/${SID}/report-links`, method: "GET" });
    expect(out).toEqual({ state: "ready", players: { rated: 1, total: 2 }, roles: [{ role: "ana", credential: { role: "ana", createdAt: 1, expiresAt: 2, lastUsedAt: 1 }, selfRated: { rated: 2, total: 5 } }, { role: "bo", credential: null, selfRated: null }] });
    expect(JSON.stringify(out)).not.toContain("AbCdEfGhIjK");
  });

  it("reportLinks: players and selfRated may be null, and a malformed count is reason failed", async () => {
    const f = fakeFetch(() => reply(envelope({ state: "ready", players: null, roles: [{ role: "ana", credential: null, selfRated: null }] })));
    expect(await client(f.fetch).reportLinks(SID)).toEqual({ state: "ready", players: null, roles: [{ role: "ana", credential: null, selfRated: null }] });
    const g = fakeFetch(() => reply(envelope({ state: "ready", players: null, roles: [{ role: "ana", credential: null, selfRated: { rated: "2", total: 5 } }] })));
    expect((await reasonOf(client(g.fetch).reportLinks(SID))).reason).toBe("failed");
  });

  it("reportLinks: a malformed answer is reason failed", async () => {
    const f = fakeFetch(() => reply(envelope({ state: "weird", roles: [] })));
    expect((await reasonOf(client(f.fetch).reportLinks(SID))).reason).toBe("failed");
  });

  it("issueReportLink and reissueReportLink: POST, token returned, id dropped", async () => {
    const f = fakeFetch(() => reply(envelope({ credential: CRED, token: "AbCdEfGhIjK.secret" })));
    const c = client(f.fetch);
    const a = await c.issueReportLink(SID, "ana");
    const b = await c.reissueReportLink(SID, "ana");
    expect(f.calls[0]).toMatchObject({ url: `${BASE}/sessions/${SID}/report-links`, method: "POST", body: JSON.stringify({ role: "ana" }) });
    expect(f.calls[1]).toMatchObject({ url: `${BASE}/sessions/${SID}/report-links/ana/reissue`, method: "POST" });
    expect(a.token).toBe("AbCdEfGhIjK.secret");
    expect(b.credential).toEqual({ role: "ana", createdAt: 1, expiresAt: 2, lastUsedAt: 1 });
  });

  it("revokeReportLink: DELETE and the boolean", async () => {
    const f = fakeFetch(() => reply(envelope({ revoked: true })));
    expect(await client(f.fetch).revokeReportLink(SID, "ana")).toBe(true);
    expect(f.calls[0]).toMatchObject({ url: `${BASE}/sessions/${SID}/report-links/ana`, method: "DELETE" });
  });

  it("a role that is not an id never reaches the network", async () => {
    const f = fakeFetch(() => reply(envelope({ revoked: true })));
    expect((await reasonOf(client(f.fetch).revokeReportLink(SID, "../x"))).reason).toBe("not_found");
    expect(f.calls).toHaveLength(0);
  });

  it("a conflict carries the control's sentence as detail, other reasons carry none", async () => {
    const f = fakeFetch(() => reply(errorEnvelope("conflict", "A link is already active for this role."), 409));
    try { await client(f.fetch).issueReportLink(SID, "ana"); throw new Error("no"); } catch (e) {
      expect((e as LauncherError).reason).toBe("conflict");
      expect((e as LauncherError).detail).toBe("A link is already active for this role.");
    }
    const g = fakeFetch(() => reply(errorEnvelope("conflict", "x".repeat(2000)), 409));
    try { await client(g.fetch).issueReportLink(SID, "ana"); throw new Error("no"); } catch (e) {
      expect((e as LauncherError).detail).toBeUndefined();
    }
  });

  it("exchangeReportToken: POST { token }, shape checked", async () => {
    const f = fakeFetch(() => reply(envelope({ credentialId: "AbCdEfGhIjK", sessionId: SID, role: "ana", expiresAt: 99, extra: 1 })));
    expect(await client(f.fetch).exchangeReportToken("tok")).toEqual({ credentialId: "AbCdEfGhIjK", sessionId: SID, role: "ana", expiresAt: 99 });
    expect(f.calls[0]).toMatchObject({ url: `${BASE}/report-access/exchange`, method: "POST", body: JSON.stringify({ token: "tok" }) });
    const g = fakeFetch(() => reply(errorEnvelope("not_found", "Not found."), 404));
    expect((await reasonOf(client(g.fetch).exchangeReportToken("tok"))).reason).toBe("not_found");
    const h = fakeFetch(() => reply(envelope({ credentialId: 1 })));
    expect((await reasonOf(client(h.fetch).exchangeReportToken("tok"))).reason).toBe("failed");
  });

  it("readReport: GET by session and credential id; released and not_released pass; a bad credential id never goes out", async () => {
    const f = fakeFetch(() => reply(envelope({ state: "released", view: { kind: "released" } })));
    expect(await client(f.fetch).readReport(SID, "AbCdEfGhIjK")).toEqual({ state: "released", view: { kind: "released" } });
    expect(f.calls[0]).toMatchObject({ url: `${BASE}/sessions/${SID}/reports/AbCdEfGhIjK`, method: "GET" });
    const g = fakeFetch(() => reply(envelope({ state: "not_released" })));
    expect(await client(g.fetch).readReport(SID, "AbCdEfGhIjK")).toEqual({ state: "not_released" });
    expect((await reasonOf(client(g.fetch).readReport(SID, "a/b"))).reason).toBe("not_found");
    expect(g.calls).toHaveLength(1);
  });

  it("readReport parses all five states and fails closed on anything else", async () => {
    const form = {
      criteria: [{ id: "listening", name: "Listening" }],
      scale: [{ level: 1, label: "Low", meaning: "m" }],
      existing: { listening: { level: 3, note: "ok" }, discovery: { level: "na" } },
    };
    const read = (data: unknown) => client(fakeFetch(() => reply(envelope(data))).fetch).readReport(SID, "AbCdEfGhIjK");
    expect(await read({ state: "self_assess", ...form, extra: "dropped" })).toEqual({ state: "self_assess", ...form });
    expect(await read({ state: "released", view: { kind: "released" } })).toEqual({ state: "released", view: { kind: "released" } });
    expect(await read({ state: "not_released" })).toEqual({ state: "not_released" });
    expect(await read({ state: "closed" })).toEqual({ state: "closed" });
    expect(await read({ state: "old_schema" })).toEqual({ state: "old_schema" });
    for (const odd of [
      { state: "weird" }, { state: "released" }, { state: "self_assess" }, { state: "self_assess", ...form, criteria: [{ id: 1 }] },
      { state: "self_assess", ...form, existing: { a: { level: 9 } } }, { state: "self_assess", ...form, scale: "x" }, {},
    ]) {
      expect((await reasonOf(read(odd))).reason, JSON.stringify(odd)).toBe("failed");
    }
  });

  it("busy is a known LauncherReason and the server text never passes through", async () => {
    const f = fakeFetch(() => reply(errorEnvelope("busy", "SECRET"), 503));
    const r = await reasonOf(client(f.fetch).readReport(SID, "AbCdEfGhIjK"));
    expect(r.reason).toBe("busy");
    expect(r.text).not.toContain("SECRET");
  });

  it("readReport accepts a 2 MiB released report; the general cap (1 MiB) still applies to every other call", async () => {
    const big = { state: "released", view: { markdown: { own: "x".repeat(2 * 1024 * 1024), group: null } } };
    const f = fakeFetch(() => reply(envelope(big)));
    expect((await client(f.fetch).readReport(SID, "AbCdEfGhIjK")).state).toBe("released");
    const g = fakeFetch(() => reply(envelope({ state: "ready", roles: [], pad: "x".repeat(2 * 1024 * 1024) })));
    expect((await reasonOf(client(g.fetch).reportLinks(SID))).reason).toBe("failed");
    const h = fakeFetch(() => reply(envelope({ state: "released", view: { pad: "x".repeat(MAX_REPORT_RESPONSE_CHARS) } })));
    expect((await reasonOf(client(h.fetch).readReport(SID, "AbCdEfGhIjK"))).reason).toBe("failed");
  });
});

describe("LauncherClient participant writes", () => {
  const RATINGS = [{ criterion: "c1", level: 3 }];
  const CRED = "AbCdEfGhIjK";
  const url = `${BASE}/sessions/${SID}/reports/${CRED}`;
  const err = (status: number, code: string, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(errorEnvelope(code, "SECRET control text")), { status, headers: { "Content-Type": "application/json", ...headers } });

  it("rateReport: PUT self-ratings and respondReport: POST responses, ok on 200", async () => {
    const f = fakeFetch(() => reply(envelope({ wrote: 1 })));
    expect(await client(f.fetch).rateReport(SID, CRED, RATINGS)).toEqual({ state: "ok" });
    expect(await client(f.fetch).respondReport(SID, CRED, { text: "hi", dispute: true })).toEqual({ state: "ok" });
    expect(f.calls[0]).toMatchObject({ url: `${url}/self-ratings`, method: "PUT", body: JSON.stringify({ ratings: RATINGS }) });
    expect(f.calls[1]).toMatchObject({ url: `${url}/responses`, method: "POST", body: JSON.stringify({ text: "hi", dispute: true }) });
  });

  it("maps status and code to the closed union and never uses the message", async () => {
    const table: [number, string, unknown][] = [
      [409, "closed", { state: "closed" }],
      [409, "not_released", { state: "not_released" }],
      [409, "withdrawn", { state: "withdrawn" }],
      [409, "too_many", { state: "too_many" }],
      [409, "old_schema", { state: "old_schema" }],
      [400, "bad_request", { state: "invalid" }],
      [400, "invalid", { state: "invalid" }],
      [413, "payload_too_large", { state: "too_large" }],
      [503, "busy", { state: "busy" }],
    ];
    for (const [status, code, want] of table) {
      const f = fakeFetch(() => err(status, code));
      const out = await client(f.fetch).rateReport(SID, CRED, RATINGS);
      expect(out).toEqual(want);
      expect(JSON.stringify(out)).not.toContain("SECRET");
    }
  });

  it("429 reads Retry-After seconds into retryAfterMs (not capacity)", async () => {
    const f = fakeFetch(() => err(429, "throttled", { "Retry-After": "7" }));
    expect(await client(f.fetch).respondReport(SID, CRED, { text: "x" })).toEqual({ state: "throttled", retryAfterMs: 7000 });
    const g = fakeFetch(() => err(429, "throttled"));
    expect(await client(g.fetch).respondReport(SID, CRED, { text: "x" })).toEqual({ state: "throttled", retryAfterMs: 1000 });
  });

  it("404 throws not_found and 503 unavailable throws unavailable", async () => {
    expect((await reasonOf(client(fakeFetch(() => err(404, "not_found")).fetch).rateReport(SID, CRED, RATINGS))).reason).toBe("not_found");
    const r = await reasonOf(client(fakeFetch(() => err(503, "unavailable")).fetch).rateReport(SID, CRED, RATINGS));
    expect(r.reason).toBe("unavailable");
    expect(r.text).not.toContain("SECRET");
  });

  it("a credential id that is not base64url never reaches the network", async () => {
    const f = fakeFetch(() => reply(envelope({})));
    expect((await reasonOf(client(f.fetch).rateReport(SID, "../x", RATINGS))).reason).toBe("not_found");
    expect(f.calls).toHaveLength(0);
  });

  it("allows about 15 s for a write while other calls keep the default", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    const f = fakeFetch(() => reply(envelope({ wrote: 1 })));
    await client(f.fetch).rateReport(SID, CRED, RATINGS);
    expect(spy).toHaveBeenLastCalledWith(15_000);
    await client(f.fetch).scenarios().catch(() => {});
    expect(spy).toHaveBeenLastCalledWith(5_000);
  });
});
