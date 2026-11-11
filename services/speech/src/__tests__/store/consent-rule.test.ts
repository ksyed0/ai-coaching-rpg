import { describe, expect, it } from "vitest";
import { VOICE_REFUSALS, type VoiceRefusal } from "../../protocol.js";
import { decide } from "../../store/consent-rule.js";

/** US-0073 (voice A2a, Task 6, review C2): audio is kept only on an allowlist; every other outcome writes nothing. */
describe("consent rule", () => {
  it("test_the_refusal_keep_set_is_exactly_paused_and_not_in_scene", () => {
    const kept = VOICE_REFUSALS.filter((code) => decide({ kind: "refused", code }).keep);
    // A code added to VOICE_REFUSALS is dropped (keep: false) until someone decides otherwise and edits this set.
    expect(new Set(kept)).toEqual(new Set(["paused", "not_in_scene"]));
    expect(decide({ kind: "refused", code: "paused" })).toEqual({ keep: true, status: "refused:paused" });
    expect(decide({ kind: "refused", code: "not_in_scene" })).toEqual({ keep: true, status: "refused:not_in_scene" });
  });
  it.each(["failed", "ended", "not_started", "voice_off", "unknown_role", "ai_role", "not_holder", "not_recording"] as const)("test_refused_%s_is_not_kept", (code) => {
    expect(decide({ kind: "refused", code })).toEqual({ keep: false });
  });
  it("test_an_unknown_future_code_is_not_kept", () => {
    expect(decide({ kind: "refused", code: "some_new_code" as VoiceRefusal })).toEqual({ keep: false });
    expect(decide({ kind: "refused", code: "__proto__" as VoiceRefusal })).toEqual({ keep: false });
  });
  it("test_a_timeout_is_not_kept", () => { expect(decide({ kind: "timeout" })).toEqual({ keep: false }); });
  it("test_accepted_is_kept_as_transcribed", () => { expect(decide({ kind: "accepted" })).toEqual({ keep: true, status: "transcribed" }); });
  it.each(["empty", "stt_failed"] as const)("test_no_text_%s_is_kept_with_its_status", (status) => {
    expect(decide({ kind: "no_text", status })).toEqual({ keep: true, status });
  });
  it("test_an_unknown_outcome_kind_or_no_text_status_is_not_kept", () => {
    expect(decide({ kind: "weird" } as unknown as Parameters<typeof decide>[0])).toEqual({ keep: false });
    expect(decide({ kind: "no_text", status: "other" } as unknown as Parameters<typeof decide>[0])).toEqual({ keep: false });
  });
});
