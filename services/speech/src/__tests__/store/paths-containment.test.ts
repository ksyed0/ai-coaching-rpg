import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// US-0073 (A2a Task 10, mutation check c): the containment check in paths.ts is a second, independent layer. With the id rule switched
// off (isFileSafeId always true), an escaping role or segment id must STILL be refused, by `assertInside` alone.
vi.mock("@acr/events", async (orig) => ({ ...(await orig<typeof import("@acr/events")>()), isFileSafeId: () => true }));
const { StorePathError, ensureRoleDir, roleDir, segmentFile } = await import("../../store/paths.js");

const ID = "0123456789abcdef0123456789abcdef";
const AUDIO = path.join(path.sep, "nonexistent-acr-audio-root", "audio");

describe("path containment without the id rule (defence in depth)", () => {
  it.each([["../..", "seg"], ["coach", "../../../x"], ["..", "../x"]])("test_escaping_ids_%j_%j_are_refused_by_containment_alone", (role, seg) => {
    expect(() => segmentFile(AUDIO, ID, role, seg)).toThrow(StorePathError);
  });
  it("test_a_role_that_resolves_to_the_audio_dir_itself_or_above_is_refused", () => {
    expect(() => roleDir(AUDIO, ID, "..")).toThrow(StorePathError); // <audio>/<id>/.. is <audio>: not strictly inside
    expect(() => roleDir(AUDIO, ID, "../..")).toThrow(StorePathError);
    expect(() => ensureRoleDir(AUDIO, ID, "../..")).toThrow(StorePathError); // refused before any folder is made
  });
});
