import { beforeEach, describe, expect, it, vi } from "vitest";

// US-0071 (EPIC-0003 voice A1b, Task 4, review F12): the SDK-failure and malformed-JWT branches of token.ts, through a mocked
// AccessToken (token.test.ts runs the real SDK). An SDK error that quotes the secret must never come out; nor must a token whose `exp`
// cannot be read.
const SECRET = "z".repeat(40);
const KEY = "APIerrkey0001";
const ROOM = `v${"0c".repeat(16)}`;
const IDENTITY = "tech_lead.g0123abcd";
const jwt = { next: async (): Promise<string> => "" };

vi.mock("livekit-server-sdk", async (importOriginal) => {
  const real = await importOriginal<typeof import("livekit-server-sdk")>();
  class AccessToken {
    addGrant(): void {}
    toJwt(): Promise<string> { return jwt.next(); }
  }
  return { ...real, AccessToken };
});

const { LiveKitTokenError, mintParticipantToken, mintWorkerToken } = await import("../token.js");
const b64 = (o: unknown) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
const mints = () => [
  mintParticipantToken({ apiKey: KEY, apiSecret: SECRET, room: ROOM, identity: IDENTITY }),
  mintWorkerToken({ apiKey: KEY, apiSecret: SECRET, room: ROOM, identity: "SPEECH.deadbeef" }),
];
async function refused(p: Promise<unknown>): Promise<void> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(LiveKitTokenError);
  const text = `${(err as Error).message}\n${(err as Error).stack ?? ""}\n${JSON.stringify(err)}`;
  for (const s of [SECRET, KEY, ROOM, IDENTITY]) expect(text).not.toContain(s);
  expect((err as Error & { cause?: unknown }).cause).toBeUndefined();
}

beforeEach(() => { jwt.next = async () => ""; });

describe("token errors from the SDK (US-0071, F12)", () => {
  it("toJwt rejecting with the secret in its message gives a LiveKitTokenError that does not carry it", async () => {
    jwt.next = async () => { throw new Error(`HS256 signing failed for ${KEY}:${SECRET} in ${ROOM} as ${IDENTITY}`); };
    for (const p of mints()) await refused(p);
  });

  it("a token whose payload has no readable integer exp is refused", async () => {
    const header = b64({ alg: "HS256" });
    for (const token of [
      "no-dots-at-all", // no payload part
      `${header}.${b64("not json {")}.sig`, // payload is not JSON
      `${header}.${b64({ sub: IDENTITY })}.sig`, // no exp
      `${header}.${b64({ exp: "1800000600" })}.sig`, // exp not a number
      `${header}.${b64({ exp: 1_800_000_600.5 })}.sig`, // exp not an integer
      `${header}.${b64("null")}.sig`, // payload is JSON null
    ]) {
      jwt.next = async () => token;
      for (const p of mints()) await refused(p);
    }
  });

  it("a well-formed exp is read back as milliseconds (the mock is wired)", async () => {
    jwt.next = async () => `${b64({ alg: "HS256" })}.${b64({ exp: 1_800_000_600 })}.sig`;
    await expect(mints()[0]).resolves.toEqual({ token: expect.any(String), expiresAt: 1_800_000_600_000 });
  });
});
