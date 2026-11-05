import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import { collectSecrets, listReleasedRoles, readReleasedView } from "../index.js";
import { makeDraftDir, makeRunner } from "../../review/__tests__/fixtures.js";

// A review that loads with another session id than the folder's first event (a swap between the locate and the load).
const state = vi.hoisted(() => ({ swap: false }));
vi.mock("../../review/store.js", async (orig) => {
  const real = await orig<typeof import("../../review/store.js")>();
  return {
    ...real,
    loadReview: async (dir: string) => {
      const l = await real.loadReview(dir);
      if (!state.swap) return l;
      return { ...l, view: { ...l.view, opened: { ...l.view.opened, session: { ...l.view.opened.session, id: "other-session" } } } };
    },
  };
});

let root: string, sessionId: string;
beforeEach(async () => {
  let dir: string;
  ({ root, dir } = await makeDraftDir());
  sessionId = path.basename(dir);
  const run = makeRunner(root);
  const rel = path.relative(root, dir);
  await run(["open", rel, "--by", "kamal"]);
  state.swap = false;
});
afterEach(async () => {
  state.swap = false;
  await rm(root, { recursive: true, force: true });
});

describe("the session id is re-checked after the review is loaded", () => {
  it("a review that loads with another session id gives unavailable / null, never its data", async () => {
    expect((await listReleasedRoles(root, sessionId))).not.toBeNull();
    state.swap = true;
    expect(await readReleasedView(root, sessionId, "alice", collectSecrets({}))).toEqual({ kind: "unavailable" });
    expect(await listReleasedRoles(root, sessionId)).toBeNull();
  });
});
