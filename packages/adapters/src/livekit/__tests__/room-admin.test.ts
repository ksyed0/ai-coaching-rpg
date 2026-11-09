import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createRoomAdmin, LiveKitAdminError, type RoomServiceClientLike } from "../index.js";

// US-0071 (EPIC-0003 voice A1b, Task 4): the room admin behind a port. A fake client stands in for the server; "not found" is success.
const ROOM = `v${"1b".repeat(16)}`;
const IDENTITY = "tech_lead.g0123abcd";
const HOST = new URL("http://127.0.0.1:7880");

function fake(o: { fail?: unknown } = {}) {
  const calls: unknown[][] = [];
  const client: RoomServiceClientLike = {
    async removeParticipant(room, identity) { calls.push(["remove", room, identity]); if (o.fail) throw o.fail; },
    async listParticipants(room) { calls.push(["list", room]); if (o.fail) throw o.fail; return [{ identity: IDENTITY, name: "Pat Secret", metadata: "x" }, { identity: "SPEECH.deadbeef" }]; },
    async deleteRoom(room) { calls.push(["delete", room]); if (o.fail) throw o.fail; },
  };
  return { client, calls };
}
const notFound = Object.assign(new Error(`twirp error not_found: room ${ROOM} does not exist`), { status: 404, code: "not_found" });

describe("createRoomAdmin (US-0071)", () => {
  it("removeParticipant passes room and identity", async () => {
    const f = fake();
    const admin = createRoomAdmin({ host: HOST, apiKey: "k", apiSecret: "s".repeat(32), client: f.client });
    await admin.removeParticipant(ROOM, IDENTITY);
    expect(f.calls).toEqual([["remove", ROOM, IDENTITY]]);
  });

  it("listParticipants returns identities only", async () => {
    const f = fake();
    const admin = createRoomAdmin({ host: HOST, apiKey: "k", apiSecret: "s".repeat(32), client: f.client });
    expect(await admin.listParticipants(ROOM)).toEqual([IDENTITY, "SPEECH.deadbeef"]);
  });

  it("deleteRoom passes the room", async () => {
    const f = fake();
    const admin = createRoomAdmin({ host: HOST, apiKey: "k", apiSecret: "s".repeat(32), client: f.client });
    await admin.deleteRoom(ROOM);
    expect(f.calls).toEqual([["delete", ROOM]]);
  });

  it("a not-found answer resolves (an empty list for listParticipants)", async () => {
    const f = fake({ fail: notFound });
    const admin = createRoomAdmin({ host: HOST, apiKey: "k", apiSecret: "s".repeat(32), client: f.client });
    await expect(admin.removeParticipant(ROOM, IDENTITY)).resolves.toBeUndefined();
    await expect(admin.listParticipants(ROOM)).resolves.toEqual([]);
    await expect(admin.deleteRoom(ROOM)).resolves.toBeUndefined();
  });

  it("only the twirp code not_found is not-found: a bare 404 (a non-LiveKit server) rejects", async () => {
    // The SDK's toTwirpError gives status 404 and no code for any 404 whose body is not twirp JSON (another server on the port).
    const bare404 = Object.assign(new Error("Not Found"), { status: 404 });
    const f = fake({ fail: bare404 });
    const admin = createRoomAdmin({ host: HOST, apiKey: "k", apiSecret: "s".repeat(32), client: f.client });
    await expect(admin.removeParticipant(ROOM, IDENTITY)).rejects.toBeInstanceOf(LiveKitAdminError);
    await expect(admin.listParticipants(ROOM)).rejects.toBeInstanceOf(LiveKitAdminError);
    await expect(admin.deleteRoom(ROOM)).rejects.toBeInstanceOf(LiveKitAdminError);
    // The code alone, with no status, is still not-found.
    const codeOnly = Object.assign(new Error("x"), { code: "not_found" });
    const g = createRoomAdmin({ host: HOST, apiKey: "k", apiSecret: "s".repeat(32), client: fake({ fail: codeOnly }).client });
    await expect(g.removeParticipant(ROOM, IDENTITY)).resolves.toBeUndefined();
    await expect(g.listParticipants(ROOM)).resolves.toEqual([]);
    await expect(g.deleteRoom(ROOM)).resolves.toBeUndefined();
  });

  it("another failure rejects LiveKitAdminError whose message has no room or identity", async () => {
    const boom = Object.assign(new Error(`connect ECONNREFUSED for ${ROOM} ${IDENTITY}`), { status: 500 });
    const f = fake({ fail: boom });
    const admin = createRoomAdmin({ host: HOST, apiKey: "k", apiSecret: "s".repeat(32), client: f.client });
    for (const p of [admin.removeParticipant(ROOM, IDENTITY), admin.listParticipants(ROOM), admin.deleteRoom(ROOM)]) {
      const err = await p.then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(LiveKitAdminError);
      expect((err as Error).message).not.toContain(ROOM);
      expect((err as Error).message).not.toContain(IDENTITY);
      expect((err as Error).message).not.toContain("ECONNREFUSED");
      expect((err as Error & { cause?: unknown }).cause).toEqual({ status: 500 }); // only the sanitised shape, never the raw error
    }
  });

  it("the error keeps only a sanitised status and an allowlisted twirp code: inspect shows no room, identity, host or key", async () => {
    const KEY = "APIadminkey0001";
    const SECRET = "q".repeat(40);
    const raw = Object.assign(new Error(`twirp error for room ${ROOM} identity ${IDENTITY} at 127.0.0.1:7880 key ${KEY}`), {
      status: 403, code: "permission_denied", metadata: { room: ROOM, identity: IDENTITY, host: "127.0.0.1:7880" }, stack: `Error: ${ROOM}\n at ${IDENTITY}`,
    });
    const odd = Object.assign(new Error(ROOM), { status: `${ROOM}`, code: `room ${ROOM} not here` }); // non-number status, unknown code
    for (const [fail, want] of [[raw, { status: 403, code: "permission_denied" }], [odd, {}], ["a string error naming " + ROOM, {}]] as const) {
      const admin = createRoomAdmin({ host: HOST, apiKey: KEY, apiSecret: SECRET, client: fake({ fail }).client });
      for (const p of [admin.removeParticipant(ROOM, IDENTITY), admin.listParticipants(ROOM), admin.deleteRoom(ROOM)]) {
        const err = await p.then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(LiveKitAdminError);
        expect((err as Error & { cause?: unknown }).cause).toEqual(want);
        const text = `${inspect(err, { depth: 10, showHidden: true })}\n${JSON.stringify(err)}\n${(err as Error).stack ?? ""}`;
        for (const s of [ROOM, IDENTITY, "127.0.0.1", KEY, SECRET]) expect(text).not.toContain(s);
      }
    }
  });

  it("an empty key or secret never falls back to LIVEKIT_API_KEY / LIVEKIT_API_SECRET from the environment", async () => {
    // The SDK's ServiceBase.authHeader builds an AccessToken, which reads these variables for an empty argument.
    const saved = { k: process.env.LIVEKIT_API_KEY, s: process.env.LIVEKIT_API_SECRET };
    process.env.LIVEKIT_API_KEY = "ENVKEY"; process.env.LIVEKIT_API_SECRET = "e".repeat(40);
    const fetched: unknown[] = [];
    vi.stubGlobal("fetch", async (...args: unknown[]) => { fetched.push(args); throw new Error("no network in this test"); });
    try {
      for (const [apiKey, apiSecret] of [["", "s".repeat(32)], ["k", ""], ["", ""], [undefined, "s".repeat(32)]] as const) {
        let err: unknown = null;
        try {
          const admin = createRoomAdmin({ host: HOST, apiKey: apiKey as string, apiSecret });
          await admin.listParticipants(ROOM).catch(() => {}); // only reached if the guard is missing
        } catch (e) { err = e; }
        expect(err).toBeInstanceOf(RangeError);
        expect((err as Error).message).not.toContain("ENVKEY");
        expect((err as Error).message).not.toContain("e".repeat(40));
      }
      expect(fetched).toEqual([]); // no call was made, so none authenticated with the environment's key
    } finally {
      vi.unstubAllGlobals();
      if (saved.k === undefined) delete process.env.LIVEKIT_API_KEY; else process.env.LIVEKIT_API_KEY = saved.k;
      if (saved.s === undefined) delete process.env.LIVEKIT_API_SECRET; else process.env.LIVEKIT_API_SECRET = saved.s;
    }
  });

  it("refuses a host that is not loopback http without quoting it", () => {
    for (const h of ["https://127.0.0.1:7880", "http://10.0.0.5:7880", "http://user:pw@127.0.0.1:7880", "http://127.0.0.1:7880/path"]) {
      let msg = "";
      try { createRoomAdmin({ host: new URL(h), apiKey: "k", apiSecret: "s".repeat(32), client: fake().client }); } catch (err) { msg = (err as Error).message; }
      expect(msg, h).not.toBe("");
      expect(msg).not.toContain(new URL(h).host);
    }
  });
});
