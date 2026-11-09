import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../../api.js";
import type { ControlConfig } from "../../config.js";
import { ControlError, type ControlErrorCode } from "../../supervisor.js";

// US-0071 (EPIC-0003 voice A1b, Task 5): POST /sessions/:id/voice-token, behind the service token. The BFF calls it for the cookie's own
// seat; the body names the role and participant, never anything the browser chose.
const TOKEN = "t".repeat(40);
const ID = "a".repeat(32);
const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }))); });

async function boot(voiceToken: (id: string, roleId: string, participantId: string) => Promise<{ token: string; expiresAt: number }>, log: string[] = []) {
  const spy = vi.fn(voiceToken);
  const handler = createApi({ config: { serviceToken: TOKEN } as ControlConfig, supervisor: { voiceToken: spy } as never, scenarios: () => Promise.resolve([]), log: (m) => log.push(m) });
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  const post = async (body: unknown, token: string | null = TOKEN, id = ID) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token !== null) headers["x-service-token"] = token;
    const res = await fetch(`http://127.0.0.1:${port}/sessions/${id}/voice-token`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as { success: boolean; data: unknown; error: { code: string; message: string } | null } };
  };
  return { post, spy };
}
const ok = async () => ({ token: "jwt.token.here", expiresAt: 1_700_000_600_000 });
const refuse = (code: ControlErrorCode, message: string) => async (): Promise<never> => { throw new ControlError(code, message); };

describe("POST /sessions/:id/voice-token (US-0071, A1b Task 5)", () => {
  it("without the service token (or with the wrong one) is 401 and calls nothing", async () => {
    const { post, spy } = await boot(ok);
    expect((await post({ roleId: "tech_lead", participantId: "p1" }, null)).status).toBe(401);
    expect((await post({ roleId: "tech_lead", participantId: "p1" }, "w".repeat(40))).status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it("200 carries only token and expiresAt", async () => {
    const { post, spy } = await boot(ok);
    const r = await post({ roleId: "tech_lead", participantId: "p1" });
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual({ token: "jwt.token.here", expiresAt: 1_700_000_600_000 });
    expect(spy).toHaveBeenCalledWith(ID, "tech_lead", "p1");
  });

  it("an answer with extra fields is cut down to token and expiresAt", async () => {
    const { post } = await boot(async () => ({ token: "t", expiresAt: 1, room: "v".repeat(33), identity: "x" }) as never);
    expect((await post({ roleId: "tech_lead", participantId: "p1" })).json.data).toEqual({ token: "t", expiresAt: 1 });
  });

  it("a body with an extra key, a role id with a dot, a reserved role, rebind-pending, a control character or a long id is 400 before anything is called", async () => {
    const { post, spy } = await boot(ok);
    for (const body of [
      { roleId: "tech_lead", participantId: "p1", room: "x" },
      { roleId: "tech_lead.g12345678", participantId: "p1" },
      { roleId: "facilitator", participantId: "p1" },
      { roleId: "tech_lead", participantId: "rebind-pending" },
      { roleId: "tech_lead", participantId: "p\u0001" },
      { roleId: "tech_lead", participantId: "p\u007f" },
      { roleId: "tech_lead", participantId: "x".repeat(129) },
      { roleId: "tech_lead", participantId: "" },
      { roleId: "tech_lead" }, {}, "not json",
    ]) {
      const r = await post(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error?.code).toBe("bad_request");
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("an unknown session is 404", async () => {
    const { post } = await boot(refuse("not_found", "that session does not exist"));
    expect((await post({ roleId: "tech_lead", participantId: "p1" })).status).toBe(404);
  });

  it("a malformed session id is 404 and calls nothing", async () => {
    const { post, spy } = await boot(ok);
    expect((await post({ roleId: "tech_lead", participantId: "p1" }, TOKEN, "..")).status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  it("voice_refused is 409 with the fixed message, voice_off is 409, voice_unavailable is 503", async () => {
    for (const [code, status, message] of [
      ["voice_refused", 409, "Voice is not available for this seat."], ["voice_off", 409, "Voice is off for this session."], ["voice_unavailable", 503, "Voice is not available right now."],
    ] as const) {
      const log: string[] = [];
      const { post } = await boot(refuse(code, message), log);
      const r = await post({ roleId: "tech_lead", participantId: "p1" });
      expect(r.status).toBe(status);
      expect(r.json.error).toEqual({ code, message });
      expect(log).toEqual([]);
    }
  });

  it("an unexpected failure is 500 with the fixed sentence and the log carries the error name only", async () => {
    const log: string[] = [];
    const { post } = await boot(async () => { throw new Error("tech_lead.g12345678 in v0123"); }, log);
    const r = await post({ roleId: "tech_lead", participantId: "p1" });
    expect(r.status).toBe(500);
    expect(log).toEqual(["request failed (Error)"]);
  });
});
