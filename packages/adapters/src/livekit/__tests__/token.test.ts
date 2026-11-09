import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveKitTokenError, mintParticipantToken, mintWorkerToken, VOICE_TOKEN_TTL_S } from "../index.js";

// US-0071 (EPIC-0003 voice A1b, Task 4): the LiveKit token grants, pinned on the decoded JWT itself (spec 9, overview 7, Global
// Constraints). The JWT is decoded and its HS256 signature checked by hand, so nothing here trusts the SDK's own reading of it.
const KEY = "APItestkey0001";
const SECRET = "s".repeat(40);
const ROOM = `v${"0a".repeat(16)}`;
const IDENTITY = "tech_lead.g0123abcd";
const NOW = 1_800_000_000_000; // ms. The SDK signs with jose's `new Date()`: only Date is faked (no timer), so the times are exact
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"], now: NOW }); });
afterEach(() => { vi.useRealTimers(); });

const b64url = (b: Buffer) => b.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
function decode(token: string): { header: Record<string, unknown>; payload: Record<string, any>; signed: string; sig: string } {
  const parts = token.split(".");
  expect(parts).toHaveLength(3);
  const [h, p, sig] = parts as [string, string, string];
  const json = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Record<string, any>;
  return { header: json(h), payload: json(p), signed: `${h}.${p}`, sig };
}
const verifies = (token: string, secret: string) => { const d = decode(token); return b64url(createHmac("sha256", secret).update(d.signed).digest()) === d.sig; };
const participant = () => mintParticipantToken({ apiKey: KEY, apiSecret: SECRET, room: ROOM, identity: IDENTITY });
const worker = () => mintWorkerToken({ apiKey: KEY, apiSecret: SECRET, room: ROOM, identity: "SPEECH.deadbeef" });

describe("mintParticipantToken (US-0071)", () => {
  it("the participant token expires 600 s after now", async () => {
    const { token, expiresAt } = await participant();
    const { payload, header } = decode(token);
    expect(header.alg).toBe("HS256");
    expect(VOICE_TOKEN_TTL_S).toBe(600);
    expect(payload.nbf).toBe(NOW / 1000);
    expect(payload.exp).toBe(NOW / 1000 + 600);
    expect(expiresAt).toBe(NOW + 600_000);
    expect(payload.iss).toBe(KEY);
  });

  it("its video grant is exactly the microphone-only grant", async () => {
    const { payload } = decode((await participant()).token);
    expect(payload.video).toEqual({ room: ROOM, roomJoin: true, canPublish: true, canPublishSources: ["microphone"], canSubscribe: false, canPublishData: false, canUpdateOwnMetadata: false });
  });

  it("sub is the identity and nothing else of the participant is carried", async () => {
    const { payload } = decode((await participant()).token);
    expect(payload.sub).toBe(IDENTITY);
    expect(payload).not.toHaveProperty("metadata");
    expect(payload).not.toHaveProperty("attributes");
    expect(payload.name ?? "").not.toMatch(/[A-Z ]/); // no display name: at most the identity itself
  });

  it("the signature verifies with the secret and not with another", async () => {
    const { token } = await participant();
    expect(verifies(token, SECRET)).toBe(true);
    expect(verifies(token, "t".repeat(40))).toBe(false);
  });
});

describe("mintWorkerToken (US-0071)", () => {
  it("the worker token has canPublish false, canSubscribe true, hidden true, canPublishData false", async () => {
    const { token, expiresAt } = await worker();
    const { payload } = decode(token);
    expect(payload.video).toEqual({ room: ROOM, roomJoin: true, canPublish: false, canSubscribe: true, canPublishData: false, canUpdateOwnMetadata: false, hidden: true });
    expect(payload.sub).toBe("SPEECH.deadbeef");
    expect(payload.exp).toBe(NOW / 1000 + 600);
    expect(expiresAt).toBe(NOW + 600_000);
    expect(verifies(token, SECRET)).toBe(true);
  });
});

describe("token errors (US-0071)", () => {
  it("an empty key or secret never falls back to LIVEKIT_API_KEY / LIVEKIT_API_SECRET from the environment", async () => {
    const saved = { k: process.env.LIVEKIT_API_KEY, s: process.env.LIVEKIT_API_SECRET };
    process.env.LIVEKIT_API_KEY = "ENVKEY"; process.env.LIVEKIT_API_SECRET = "e".repeat(40);
    try {
      await expect(mintParticipantToken({ apiKey: "", apiSecret: SECRET, room: ROOM, identity: IDENTITY })).rejects.toBeInstanceOf(LiveKitTokenError);
      await expect(mintParticipantToken({ apiKey: KEY, apiSecret: "", room: ROOM, identity: IDENTITY })).rejects.toBeInstanceOf(LiveKitTokenError);
    } finally {
      if (saved.k === undefined) delete process.env.LIVEKIT_API_KEY; else process.env.LIVEKIT_API_KEY = saved.k;
      if (saved.s === undefined) delete process.env.LIVEKIT_API_SECRET; else process.env.LIVEKIT_API_SECRET = saved.s;
    }
  });

  it("an error never contains the key, the secret, the room or the identity", async () => {
    const cases = [
      mintParticipantToken({ apiKey: KEY, apiSecret: "", room: ROOM, identity: IDENTITY }),
      mintParticipantToken({ apiKey: "", apiSecret: SECRET, room: ROOM, identity: IDENTITY }),
      mintWorkerToken({ apiKey: KEY, apiSecret: "", room: ROOM, identity: "SPEECH.deadbeef" }),
      mintParticipantToken({ apiKey: KEY, apiSecret: SECRET, room: "", identity: IDENTITY }),
      mintParticipantToken({ apiKey: KEY, apiSecret: SECRET, room: ROOM, identity: "" }),
    ];
    for (const p of cases) {
      const err = await p.then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(LiveKitTokenError);
      const text = `${(err as Error).message}\n${(err as Error).stack ?? ""}\n${JSON.stringify(err)}`;
      for (const s of [KEY, SECRET, ROOM, IDENTITY, "SPEECH.deadbeef"]) expect(text).not.toContain(s);
      expect((err as Error & { cause?: unknown }).cause).toBeUndefined();
    }
  });
});
