import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { loadDrafts } from "../draft.js";
import { JoinCodes } from "../../engine/join-codes.js";
import { writeJoinCodesFile } from "../../engine/join-code-file.js";
import { PlayerCredentials } from "../../engine/credentials.js";
import { writeCredentialsFile } from "../../engine/credentials-file.js";
import { makeDraftDir, makeRunner } from "./fixtures.js";

let root: string, dir: string;
let run: ReturnType<typeof makeRunner>;
beforeEach(async () => { ({ root, dir } = await makeDraftDir()); run = makeRunner(root); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("pnpm moderate open and the credentials file (US-0053)", () => {
  it("moderate open copies no credential data into review.opened (regression guard)", async () => {
    const { sessionId } = await loadDrafts(dir);
    const sessions = path.join(root, "data/sessions");
    await mkdir(sessions, { recursive: true });
    const bind = { sessionId, scenarioSha256: "c".repeat(64) };
    writeJoinCodesFile(sessions, sessionId, JoinCodes.issue(["alice"], bind).codes);
    const credentials = PlayerCredentials.create(bind);
    const plain = credentials.issue("alice", "Alice Example");
    writeCredentialsFile(sessions, sessionId, credentials);
    const rec = credentials.toRecord();
    expect((await run(["open", path.relative(root, dir), "--by", "kamal"])).code).toBe(0);
    const first = (await readFile(path.join(dir, "review.jsonl"), "utf8")).split("\n")[0]!;
    expect(JSON.parse(first)).toMatchObject({ type: "review.opened", codes: { sessionId } }); // the codes record is there
    for (const secret of [plain, rec.salt, rec.roles.alice!.hash, rec.logIdentity, "Alice Example"]) expect(first).not.toContain(secret);
  });
});
