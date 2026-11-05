import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReportAccessStore } from "../report-access.js";
import { ControlError } from "../supervisor.js";
import { readOnce } from "./read-once.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = mkdtempSync(path.join(tmpdir(), "acr-ctl-rpt-")); dirs.push(d); return d; };
const DAY = 86_400_000;
const T0 = 1_800_000_000_000;
const SID = "sess-1";

function make(opts: { days?: number; beforeWrite?: () => Promise<void>; maxBytes?: number; syncDir?: (d: string) => void } = {}) {
  const file = path.join(tmp(), "report-access.json");
  const clock = { t: T0 };
  const store = new ReportAccessStore({ file, days: opts.days ?? 90, now: () => clock.t }, {
    ...(opts.beforeWrite ? { beforeWrite: opts.beforeWrite } : {}),
    ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
    ...(opts.syncDir ? { syncDir: opts.syncDir } : {}),
  });
  return { file, clock, store };
}
const code = async (p: Promise<unknown>): Promise<{ code: string; message: string } | null> => {
  try { await p; return null; } catch (e) { if (e instanceof ControlError) return { code: e.code, message: e.message }; throw e; }
};

describe("ReportAccessStore", () => {
  it("issues <id>.<secret> tokens and never stores the token or secret", async () => {
    const { file, store } = make();
    const { credential, token } = await store.issue(SID, "alice");
    expect(token).toMatch(/^[A-Za-z0-9_-]{11}\.[A-Za-z0-9_-]{22}$/);
    expect(token.split(".")[0]).toBe(credential.id);
    expect(credential).toEqual({ id: credential.id, sessionId: SID, role: "alice", createdAt: T0, expiresAt: T0 + 90 * DAY });
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain(token);
    expect(text).not.toContain(token.split(".")[1]);
    expect(Object.keys(credential)).not.toContain("hash");
    expect(Object.keys(credential)).not.toContain("salt");
  });

  it("writes the file with mode 0600", async () => {
    const { file, store } = make();
    await store.issue(SID, "alice");
    expect(readOnce(file).mode).toBe(0o600);
  });

  it("verifies a good token and rejects a wrong secret and an unknown id", async () => {
    const { store } = make();
    const { credential, token } = await store.issue(SID, "alice");
    expect(await store.verify(token)).toMatchObject({ id: credential.id, sessionId: SID, role: "alice" });
    const [id, secret] = token.split(".");
    const flipped = (secret![0] === "A" ? "B" : "A") + secret!.slice(1);
    expect(await store.verify(`${id}.${flipped}`)).toBeNull();
    expect(await store.verify(`AAAAAAAAAAA.${secret}`)).toBeNull();
  });

  it("a second issue for a live (session, role) pair is a conflict; another role or session is fine", async () => {
    const { store } = make();
    await store.issue(SID, "alice");
    const err = await code(store.issue(SID, "alice"));
    expect(err?.code).toBe("conflict");
    expect(err?.message).toBe("A link is already active for this role.");
    await store.issue(SID, "bob");
    await store.issue("sess-2", "alice");
  });

  it("an expired or revoked pair may be issued again", async () => {
    const { store, clock } = make({ days: 1 });
    await store.issue(SID, "alice");
    clock.t = T0 + DAY;
    await store.issue(SID, "alice");
    await store.revoke(SID, "alice");
    await store.issue(SID, "alice");
  });

  it("reissue kills the old token and returns a working new one", async () => {
    const { store } = make();
    const first = await store.issue(SID, "alice");
    const second = await store.reissue(SID, "alice");
    expect(second.token).not.toBe(first.token);
    expect(await store.verify(first.token)).toBeNull();
    expect(await store.check(first.credential.id)).toBeNull();
    expect(await store.verify(second.token)).not.toBeNull();
    // reissue with nothing to revoke just issues
    const fresh = await store.reissue(SID, "bob");
    expect(await store.verify(fresh.token)).not.toBeNull();
  });

  it("is dead at exactly expiresAt and alive one millisecond before", async () => {
    const { store, clock } = make({ days: 2 });
    const { credential, token } = await store.issue(SID, "alice");
    clock.t = credential.expiresAt - 1;
    expect(await store.verify(token)).not.toBeNull();
    expect(await store.check(credential.id)).not.toBeNull();
    clock.t = credential.expiresAt;
    expect(await store.verify(token)).toBeNull();
    expect(await store.check(credential.id)).toBeNull();
  });

  it("revoke kills verify and check, reports whether anything was live, and works on an expired credential", async () => {
    const { store, clock } = make();
    const { credential, token } = await store.issue(SID, "alice");
    expect(await store.revoke(SID, "alice")).toBe(true);
    expect(await store.verify(token)).toBeNull();
    expect(await store.check(credential.id)).toBeNull();
    expect(await store.revoke(SID, "alice")).toBe(false);
    expect(await store.revoke(SID, "nobody")).toBe(false);
    const second = await store.issue(SID, "bob");
    clock.t = second.credential.expiresAt + 5;
    expect(await store.revoke(SID, "bob")).toBe(true);
    const listed = await store.list(SID);
    expect(listed.find((c) => c.id === second.credential.id)?.revokedAt).toBe(clock.t);
  });

  it("list returns only the session's credentials, with no salt or hash", async () => {
    const { store } = make();
    await store.issue(SID, "alice");
    await store.issue("sess-2", "alice");
    const listed = await store.list(SID);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ sessionId: SID, role: "alice" });
    expect(Object.keys(listed[0]!).sort()).toEqual(["createdAt", "expiresAt", "id", "role", "sessionId"]);
  });

  it("a check write racing a revoke can never resurrect the credential (100 runs, slow writes)", async () => {
    for (let i = 0; i < 100; i++) {
      let n = 0;
      const { store, clock } = make({ beforeWrite: async () => { n++; await new Promise((r) => setTimeout(r, n % 3)); } });
      const { credential } = await store.issue(SID, "alice");
      clock.t += 11 * 60_000; // a lastUsedAt write is due
      const [a, b] = i % 2 === 0
        ? await Promise.all([store.check(credential.id), store.revoke(SID, "alice")])
        : (await Promise.all([store.revoke(SID, "alice"), store.check(credential.id)])).reverse();
      void a; void b;
      expect(await store.check(credential.id)).toBeNull();
      const [c] = await store.list(SID);
      expect(c?.revokedAt).toBeDefined();
    }
  });

  it("lastUsedAt changes at most once per 10 minutes", async () => {
    const { store, clock } = make();
    const { credential } = await store.issue(SID, "alice");
    expect((await store.check(credential.id))?.lastUsedAt).toBe(T0);
    clock.t = T0 + 9 * 60_000;
    expect((await store.check(credential.id))?.lastUsedAt).toBe(T0);
    clock.t = T0 + 10 * 60_000;
    expect((await store.check(credential.id))?.lastUsedAt).toBe(T0 + 10 * 60_000);
    clock.t = T0 + 19 * 60_000;
    expect((await store.check(credential.id))?.lastUsedAt).toBe(T0 + 10 * 60_000);
    expect((await store.list(SID))[0]?.lastUsedAt).toBe(T0 + 10 * 60_000);
  });

  it("check with an expected session: a different session is null and the file is untouched; the right one behaves as before", async () => {
    const { file, store, clock } = make();
    const { credential } = await store.issue(SID, "alice");
    const before = readFileSync(file);
    clock.t = T0 + 60 * 60_000;
    expect(await store.check(credential.id, "sess-2")).toBeNull();
    expect(readFileSync(file).equals(before)).toBe(true);
    expect((await store.check(credential.id, SID))?.lastUsedAt).toBe(T0 + 60 * 60_000);
    expect((await store.check(credential.id))?.id).toBe(credential.id);
  });

  it("a check inside the window does not rewrite the file", async () => {
    let writes = 0;
    const { store } = make({ beforeWrite: async () => { writes++; } });
    const { credential } = await store.issue(SID, "alice");
    await store.check(credential.id);
    const before = writes;
    await store.check(credential.id);
    await store.check(credential.id);
    expect(writes).toBe(before);
  });

  it("rejects malformed tokens before any file read", async () => {
    const { store, file } = make();
    writeFileSync(file, "this is not json at all");
    for (const t of ["", "nodot", "a.b", ".", `${"A".repeat(10_000)}.${"B".repeat(10_000)}`, "AAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA!", "AAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.x", "AAAAAAAAAA+.AAAAAAAAAAAAAAAAAAAAAA"]) {
      expect(await store.verify(t)).toBeNull(); // a corrupt file would throw/fail closed only if it were read
    }
    expect(await store.verify(undefined as unknown as string)).toBeNull();
    expect(await store.check("not an id!")).toBeNull();
    expect(await store.check("")).toBeNull();
  });

  it("a corrupt file fails closed without echoing its content", async () => {
    const { store, file } = make();
    const { token, credential } = await store.issue(SID, "alice");
    const secretText = "SUPER-SECRET-CONTENT";
    writeFileSync(file, `{"oops": "${secretText}"`);
    expect(await store.verify(token)).toBeNull();
    expect(await store.check(credential.id)).toBeNull();
    for (const p of [store.issue(SID, "bob"), store.reissue(SID, "alice"), store.revoke(SID, "alice"), store.list(SID)]) {
      const err = await code(p);
      expect(err?.code).toBe("unavailable");
      expect(err?.message).not.toContain(secretText);
      expect(err?.message).not.toContain(file);
    }
    // wrong shape fails closed too
    writeFileSync(file, JSON.stringify([{ id: "x" }]));
    expect((await code(store.issue(SID, "bob")))?.code).toBe("unavailable");
    expect(readFileSync(file, "utf8")).toBe(JSON.stringify([{ id: "x" }]));
  });

  it("concurrent issues for different roles both persist", async () => {
    const { store } = make({ beforeWrite: async () => { await new Promise((r) => setTimeout(r, 2)); } });
    const roles = ["a1", "a2", "a3", "a4", "a5"];
    const out = await Promise.all(roles.map((r) => store.issue(SID, r)));
    for (const o of out) expect(await store.verify(o.token)).not.toBeNull();
    expect((await store.list(SID)).map((c) => c.role).sort()).toEqual(roles);
  });

  it("concurrent issues for the same role yield exactly one winner", async () => {
    const { store } = make();
    const results = await Promise.all([store.issue(SID, "alice"), store.issue(SID, "alice"), store.issue(SID, "alice")].map((p) => p.then(() => "ok", (e: ControlError) => e.code)));
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "conflict")).toHaveLength(2);
  });

  it("rejects an invalid session id or role with bad_request and writes nothing", async () => {
    const { store, file } = make();
    for (const [s, r] of [["../x", "alice"], ["", "alice"], [SID, ""], [SID, "../x"], [SID, "facilitator"], [SID, "__proto__"]] as const) {
      expect((await code(store.issue(s, r)))?.code).toBe("bad_request");
      expect((await code(store.reissue(s, r)))?.code).toBe("bad_request");
      expect((await code(store.revoke(s, r)))?.code).toBe("bad_request");
    }
    expect((await code(store.list("../x")))?.code).toBe("bad_request");
    expect(() => readFileSync(file)).toThrow();
  });

  it("survives a new store instance on the same file", async () => {
    const { file, store, clock } = make();
    const { token } = await store.issue(SID, "alice");
    const again = new ReportAccessStore({ file, days: 90, now: () => clock.t });
    expect(await again.verify(token)).not.toBeNull();
  });

  it("rejects a days value that is not an integer 1..365 at construction, without naming the value", () => {
    for (const days of [NaN, Infinity, 0, 366, 1.5, -1]) {
      expect(() => new ReportAccessStore({ file: "x", days, now: () => T0 })).toThrow(/days/);
      try { new ReportAccessStore({ file: "x", days, now: () => T0 }); } catch (e) { expect((e as Error).message).toBe("days must be an integer from 1 to 365"); }
    }
  });

  it("a non-finite now() refuses to write and leaves the file byte-identical and readable", async () => {
    const { store, file, clock } = make();
    const { token } = await store.issue(SID, "alice");
    const before = readFileSync(file);
    for (const bad of [NaN, Infinity]) {
      clock.t = bad;
      expect((await code(store.issue(SID, "bob")))?.code).toBe("unavailable");
      expect((await code(store.reissue(SID, "alice")))?.code).toBe("unavailable");
      expect(readFileSync(file).equals(before)).toBe(true);
    }
    clock.t = T0;
    expect(await store.verify(token)).not.toBeNull();
  });

  it("a write that would exceed the size cap is refused and leaves the file byte-identical and readable", async () => {
    const { store, file } = make({ maxBytes: 300 });
    const { token } = await store.issue(SID, "alice");
    const before = readFileSync(file);
    expect(before.length).toBeLessThan(300);
    expect((await code(store.issue(SID, "bob")))?.code).toBe("unavailable");
    expect((await code(store.issue(SID, "carol")))?.code).toBe("unavailable");
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(await store.verify(token)).not.toBeNull();
  });

  it("issue and reissue prune records dead for more than 30 days and keep live and recently dead ones", async () => {
    const { store, clock } = make({ days: 10 });
    const old = await store.issue(SID, "old");            // expires T0+10d
    const revokedOld = await store.issue(SID, "rev");
    await store.revoke(SID, "rev");                       // revoked at T0
    clock.t = T0 + 5 * DAY;
    const recent = await store.issue(SID, "recent");      // expires T0+15d
    clock.t = T0 + 44 * DAY;                              // old: dead 34d; rev: dead 44d; recent: dead 29d
    const live = await store.issue(SID, "live");
    let ids = (await store.list(SID)).map((c) => c.id);
    expect(ids).not.toContain(old.credential.id);
    expect(ids).not.toContain(revokedOld.credential.id);
    expect(ids).toContain(recent.credential.id);
    expect(ids).toContain(live.credential.id);
    clock.t = T0 + 46 * DAY;                              // recent now dead 31d
    await store.reissue(SID, "live");
    ids = (await store.list(SID)).map((c) => c.id);
    expect(ids).not.toContain(recent.credential.id);
    expect(ids).toContain(live.credential.id);            // revoked just now, kept
    expect(ids).toHaveLength(2);
  });

  it("a failing directory sync after the rename does not fail the write", async () => {
    const { store, file } = make({ syncDir: () => { throw new Error("EIO"); } });
    const { token } = await store.issue(SID, "alice");
    expect(readFileSync(file, "utf8")).toContain(token.split(".")[0]);
    expect(await store.verify(token)).not.toBeNull();
  });
});
