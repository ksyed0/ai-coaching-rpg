import { closeSync, fstatSync, openSync } from "node:fs";
import { link, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialRecordError, PlayerCredentials } from "../credentials.js";
import { credentialsFileName, readCredentialsFile, writeCredentialsFile } from "../credentials-file.js";
import { ConsentStore } from "../consent.js";
import { consentFileName, readConsentFile, writeConsentFile } from "../consent-file.js";
import { readSecureJson, removeSecureFile, SecureFileError, sweepSecureTemps, writeSecureJson, type SyncCheck } from "../secure-json-file.js";

const isPosix = process.platform !== "win32";
let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "acr-secure-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const kindOf = (fn: () => unknown): string | undefined => { try { fn(); } catch (e) { return e instanceof SecureFileError ? e.kind : "other"; } return undefined; };

describe("secure JSON file helper (US-0053)", () => {
  it.skipIf(!isPosix)("test_write_is_0600_and_atomic_and_leaves_no_temp_file_after_a_failing_beforeCommit", async () => {
    writeSecureJson(dir, "x.json", { a: 1 });
    const fd = openSync(path.join(dir, "x.json"), "r"); // one handle: no check-then-open gap
    try { expect(fstatSync(fd).mode & 0o777).toBe(0o600); } finally { closeSync(fd); }
    expect(readSecureJson(dir, "x.json", { maxBytes: 100 })).toEqual({ a: 1 });
    expect(() => writeSecureJson(dir, "x.json", { a: 2 }, () => { throw new Error("lock lost"); })).toThrow("lock lost");
    expect(await readdir(dir)).toEqual(["x.json"]);
    expect(readSecureJson(dir, "x.json", { maxBytes: 100 })).toEqual({ a: 1 }); // the old content survived
    expect(() => writeSecureJson(dir, "x.json", { a: 3 }, (async () => undefined) as unknown as SyncCheck)).toThrow(/synchronous/);
    expect(await readdir(dir)).toEqual(["x.json"]);
  });

  it.skipIf(!isPosix)("test_read_refuses_a_symlink_a_hard_linked_file_a_non_regular_file_and_an_oversized_file", async () => {
    await writeFile(path.join(dir, "real.json"), "{}", { mode: 0o600 });
    await symlink(path.join(dir, "real.json"), path.join(dir, "sym.json"));
    expect(kindOf(() => readSecureJson(dir, "sym.json", { maxBytes: 100 }))).toBe("symlink");
    await link(path.join(dir, "real.json"), path.join(dir, "hard.json"));
    expect(kindOf(() => readSecureJson(dir, "hard.json", { maxBytes: 100 }))).toBe("links");
    await mkdir(path.join(dir, "d.json"));
    expect(kindOf(() => readSecureJson(dir, "d.json", { maxBytes: 100 }))).toBe("not_file");
    await writeFile(path.join(dir, "big.json"), JSON.stringify("x".repeat(200)), { mode: 0o600 });
    expect(kindOf(() => readSecureJson(dir, "big.json", { maxBytes: 100 }))).toBe("size");
    await writeFile(path.join(dir, "bad.json"), "{nope", { mode: 0o600 });
    expect(kindOf(() => readSecureJson(dir, "bad.json", { maxBytes: 100 }))).toBe("json");
  });

  it("test_read_returns_null_when_absent", () => {
    expect(readSecureJson(dir, "none.json", { maxBytes: 100 })).toBeNull();
    removeSecureFile(dir, "none.json");
  });

  it("test_sweepSecureTemps_removes_only_matching_temp_files", async () => {
    const mine = ["f.json.0123456789ab.tmp", "f.json.ffffffffffff.tmp"];
    const keep = ["f.json", "g.json.0123456789ab.tmp", "f.json.0123456789a.tmp", "f.json.0123456789ab.tmp.bak", "f.json.0123456789AC.tmp"];
    for (const n of [...mine, ...keep]) await writeFile(path.join(dir, n), "x");
    await mkdir(path.join(dir, "f.json.aaaaaaaaaaaa.tmp"));
    expect(sweepSecureTemps(dir, "f.json")).toBe(2);
    expect((await readdir(dir)).sort()).toEqual([...keep, "f.json.aaaaaaaaaaaa.tmp"].sort());
    expect(sweepSecureTemps(path.join(dir, "missing"), "f.json")).toBe(0);
  });

  it("test_credentials_and_consent_files_round_trip_under_their_names", async () => {
    const bind = { sessionId: "s", scenarioSha256: "c".repeat(64) };
    const creds = PlayerCredentials.create(bind);
    const plain = creds.issue("a", "Ada");
    writeCredentialsFile(dir, "s", creds);
    const consent = new ConsentStore({ version: "v1", text: "t" });
    consent.give("a", "p1", "v1", 3);
    writeConsentFile(dir, bind, consent);
    expect((await readdir(dir)).sort()).toEqual([consentFileName("s"), credentialsFileName("s")].sort());
    expect(credentialsFileName("s")).toBe("s.credentials.json");
    expect(consentFileName("s")).toBe("s.consent.json");
    expect(readCredentialsFile(dir, "s")!.verify("a", plain)).toBe(true);
    expect(readConsentFile(dir, bind, { version: "v1", text: "t" })!.has("a", "p1")).toBe(true);
    expect(readCredentialsFile(dir, "other")).toBeNull();
    await writeFile(path.join(dir, credentialsFileName("t")), "{}", { mode: 0o600 });
    expect(() => readCredentialsFile(dir, "t")).toThrow(CredentialRecordError);
    expect(() => credentialsFileName("../x")).toThrow();
  });
});
