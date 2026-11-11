import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ChildMessageSchema as RuntimeChild, ParentMessageSchema as RuntimeParent, VOICE_ALERT_CODES as RUNTIME_VOICE_ALERT_CODES, VOICE_REFUSALS as RUNTIME_VOICE_REFUSALS,
  type ChildMessage as RuntimeChildMessage, type ParentMessage as RuntimeParentMessage,
} from "../../../runtime/src/host/parent-channel.js";
import { REBIND_PENDING } from "../../../runtime/src/engine/consent.js";
import { REBIND_PENDING_PARTICIPANT, VOICE_REFUSALS as SPEECH_VOICE_REFUSALS } from "../../../speech/src/protocol.js";
import { ChildMessageSchema, ParentMessageSchema, RoleIdSchema, VOICE_ALERT_CODES, VOICE_REFUSALS, type ChildMessage, type ParentMessage } from "../protocol.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

describe("protocol copy", () => {
  it("has the same types as the runtime's", () => {
    expectTypeOf<Equal<ParentMessage, RuntimeParentMessage>>().toEqualTypeOf<true>();
    expectTypeOf<Equal<ChildMessage, RuntimeChildMessage>>().toEqualTypeOf<true>();
  });

  it("exports the role-id schema the messages use", () => {
    expect(RoleIdSchema.safeParse("tech_lead").success).toBe(true);
    expect(RoleIdSchema.safeParse("facilitator").success).toBe(false);
  });

  it("US-0070: the voice refusal and alert lists are the same in the runtime, control and the speech worker protocol", () => {
    expect(VOICE_REFUSALS).toEqual(RUNTIME_VOICE_REFUSALS);
    expect(SPEECH_VOICE_REFUSALS).toEqual(RUNTIME_VOICE_REFUSALS);
    expect(VOICE_ALERT_CODES).toEqual(RUNTIME_VOICE_ALERT_CODES);
    expect(VOICE_ALERT_CODES).toEqual(["worker_down", "stt_unavailable", "stt_failed", "worker_restarting", "voice_off", "stt_recovered", "livekit_lost", "livekit_recovered", "disk_low", "write_error"]);
    expect(REBIND_PENDING_PARTICIPANT).toBe(REBIND_PENDING);
  });

  const seg = "0123456789abcdef";
  const holder = (i: number) => ({ roleId: `r${i}`, participantId: `p${i}`, recording: i % 2 === 0, voiceChosen: i % 3 === 0 });
  const valid: unknown[] = [
    // US-0070: voice (overview section 2).
    { type: "ready", port: 4000, status: "new", modelLabel: "local", voice: true },
    { type: "voice_line_ack", segmentId: seg, seq: 1 },
    ...RUNTIME_VOICE_REFUSALS.map((code) => ({ type: "voice_line_refused", segmentId: seg, code })),
    { type: "voice_seats", paused: false, ended: false, holders: [], open: [] },
    { type: "voice_seats", paused: true, ended: true, holders: Array.from({ length: 256 }, (_, i) => holder(i)), open: [] },
    // US-0071 (A1b Task 5): the open seats (released by a socket close, the same person may come back).
    { type: "voice_seats", paused: false, ended: false, holders: [holder(0)], open: ["tech_lead", "cfo"] },
    { type: "voice_seats", paused: false, ended: false, holders: [], open: Array.from({ length: 256 }, (_, i) => `r${i}`) },
    { type: "voice_turn", open: true }, { type: "voice_turn", open: false },
    { type: "voice_choice", roleId: "tech_lead", participantId: "p-1", choice: "voice", at: 0 },
    { type: "voice_choice", roleId: "tech_lead", participantId: "p-1", choice: "text_only", at: 1731050000000 },
    { type: "codes", codes: [{ roleId: "cfo", code: "abc-123" }] },
    { type: "codes", codes: [] },
    { type: "ready", port: 4000, status: "new", modelLabel: "local" },
    { type: "ready", port: 65535, status: "resumed", modelLabel: "m", logIdentity: "id" },
    { type: "ended" },
    { type: "reissued", requestId: "r1", code: "c" },
    { type: "reissue_failed", requestId: "r-1", reason: "no" },
    { type: "ai_roles_set", requestId: "r1", codes: [{ roleId: "tech_lead", code: "c" }] },
    { type: "ai_roles_set", requestId: "r1", codes: [] },
    { type: "ai_roles_failed", requestId: "r-1", reason: "the AI roles could not be changed" },
    { type: "ready", port: 4000, status: "new", modelLabel: "local", aiRoles: ["tech_lead"] },
    { type: "ready", port: 4000, status: "new", modelLabel: "local", aiRoles: Array.from({ length: 256 }, (_, i) => `r${i}`) },
    { type: "ready", port: 4000, status: "resumed", modelLabel: "local", aiRoles: ["tech_lead"], aiCalls: 3 },
    { type: "ready", port: 4000, status: "resumed", modelLabel: "local", aiCalls: 1_000_000 },
    { type: "ready", port: 4000, status: "new", modelLabel: "local", aiRolesReset: ["tech_lead"] },
    { type: "ready", port: 4000, status: "new", modelLabel: "local", aiRolesReset: Array.from({ length: 256 }, (_, i) => `r${i}`) },
    { type: "ready", port: 4000, status: "new", modelLabel: "local", aiRoles: ["tech_lead"], includeInGroup: false },
    { type: "ready", port: 4000, status: "new", modelLabel: "local", aiRolesReset: ["tech_lead"], includeInGroupReset: false },
  ];
  const invalid: unknown[] = [
    null, "x", [], {}, { type: "codes" }, { type: "codes", codes: [{ roleId: "cfo", code: "" }] }, { type: "codes", codes: [{ roleId: "Bad Id", code: "c" }] },
    { type: "ready", port: 0, status: "new", modelLabel: "m" }, { type: "ready", port: 70000, status: "new", modelLabel: "m" },
    { type: "ready", port: 1.5, status: "new", modelLabel: "m" }, { type: "ready", port: 1, status: "bogus", modelLabel: "m" },
    { type: "ready", port: 1, status: "new", modelLabel: "" }, { type: "ended", extra: 1 }, { type: "reissued", requestId: "../x", code: "c" },
    { type: "reissue_failed", requestId: "r", reason: "x".repeat(201) }, { type: "nope" },
    { type: "ai_roles_set", requestId: "r1", codes: Array.from({ length: 257 }, (_, i) => ({ roleId: `r${i}`, code: "c" })) },
    { type: "ai_roles_set", requestId: "r1", codes: [{ roleId: "facilitator", code: "c" }] }, { type: "ai_roles_set", requestId: "r1" },
    { type: "ai_roles_failed", requestId: "r", reason: "x".repeat(201) }, { type: "ai_roles_failed", requestId: "r" },
    { type: "ready", port: 4000, status: "new", modelLabel: "m", aiRoles: Array.from({ length: 257 }, (_, i) => `r${i}`) },
    { type: "ready", port: 4000, status: "new", modelLabel: "m", aiRoles: ["facilitator"] }, { type: "ready", port: 4000, status: "new", modelLabel: "m", aiRoles: "tech_lead" },
    { type: "ready", port: 4000, status: "new", modelLabel: "m", aiCalls: 0 }, { type: "ready", port: 4000, status: "new", modelLabel: "m", aiCalls: 1_000_001 },
    { type: "ready", port: 4000, status: "new", modelLabel: "m", aiCalls: 1.5 },
    { type: "ready", port: 4000, status: "new", modelLabel: "m", aiRolesReset: ["facilitator"] }, { type: "ready", port: 4000, status: "new", modelLabel: "m", aiRolesReset: "tech_lead" },
    { type: "ready", port: 4000, status: "new", modelLabel: "m", aiRolesReset: Array.from({ length: 257 }, (_, i) => `r${i}`) },
    { type: "ready", port: 4000, status: "new", modelLabel: "m", includeInGroup: true }, { type: "ready", port: 4000, status: "new", modelLabel: "m", includeInGroup: "false" },
    { type: "ready", port: 4000, status: "new", modelLabel: "m", includeInGroupReset: true }, { type: "ready", port: 4000, status: "new", modelLabel: "m", includeInGroupReset: 0 },
    // US-0070: voice.
    { type: "ready", port: 4000, status: "new", modelLabel: "m", voice: false }, { type: "ready", port: 4000, status: "new", modelLabel: "m", voice: "true" },
    { type: "voice_line_ack", segmentId: seg, seq: 0 }, { type: "voice_line_ack", segmentId: seg, seq: 1.5 }, { type: "voice_line_ack", segmentId: "a/b", seq: 1 },
    { type: "voice_line_ack", segmentId: seg, seq: 1, extra: 1 }, { type: "voice_line_ack", seq: 1 },
    { type: "voice_line_refused", segmentId: seg, code: "other" }, { type: "voice_line_refused", segmentId: seg }, { type: "voice_line_refused", segmentId: seg, code: "failed", message: "m" },
    { type: "voice_seats", paused: false, ended: false, holders: Array.from({ length: 257 }, (_, i) => holder(i)), open: [] },
    { type: "voice_seats", paused: false, ended: false, holders: [{ ...holder(0), roleId: "facilitator" }], open: [] },
    { type: "voice_seats", paused: false, ended: false, holders: [{ ...holder(0), participantId: "rebind-pending" }], open: [] },
    { type: "voice_seats", paused: false, ended: false, holders: [{ ...holder(0), extra: 1 }], open: [] }, { type: "voice_seats", paused: false, holders: [], open: [] },
    // US-0071: voiceChosen and open are required; an open role is a role id.
    { type: "voice_seats", paused: false, ended: false, holders: [{ roleId: "r0", participantId: "p0", recording: true }], open: [] },
    { type: "voice_seats", paused: false, ended: false, holders: [{ ...holder(0), voiceChosen: "true" }], open: [] },
    { type: "voice_seats", paused: false, ended: false, holders: [] },
    { type: "voice_seats", paused: false, ended: false, holders: [], open: ["a.b"] },
    { type: "voice_seats", paused: false, ended: false, holders: [], open: ["facilitator"] },
    { type: "voice_seats", paused: false, ended: false, holders: [], open: Array.from({ length: 257 }, (_, i) => `r${i}`) },
    { type: "voice_seats", paused: false, ended: false, holders: [], open: "tech_lead" },
    { type: "voice_turn", open: "true" }, { type: "voice_turn" }, { type: "voice_turn", open: true, extra: 1 },
    { type: "voice_choice", roleId: "tech_lead", participantId: "p", choice: "voice_only", at: 0 },
    { type: "voice_choice", roleId: "tech_lead", participantId: "p", choice: "voice", at: -1 },
    { type: "voice_choice", roleId: "tech_lead", participantId: "p", choice: "voice", at: 1.5 },
    { type: "voice_choice", roleId: "tech_lead", participantId: "rebind-pending", choice: "voice", at: 0 },
    { type: "voice_choice", roleId: "facilitator", participantId: "p", choice: "voice", at: 0 },
    { type: "voice_choice", roleId: "tech_lead", participantId: "p", choice: "voice", at: 0, extra: 1 },
  ];
  it("accepts and rejects the same child messages as the runtime", () => {
    for (const m of valid) { expect(RuntimeChild.safeParse(m).success).toBe(true); expect(ChildMessageSchema.safeParse(m).success).toBe(true); }
    for (const m of invalid) expect(ChildMessageSchema.safeParse(m).success, JSON.stringify(m)).toBe(RuntimeChild.safeParse(m).success);
    for (const m of invalid) expect(ChildMessageSchema.safeParse(m).success).toBe(false);
  });

  it("accepts and rejects the same parent messages as the runtime", () => {
    const ok: unknown[] = [{ type: "reissue", requestId: "r1", roleId: "cfo" }, { type: "reissue", requestId: "r1", roleId: "cfo", by: "Sam" },
      { type: "reissue", requestId: "r1", roleId: "cfo", reason: "removed" }, { type: "reissue", requestId: "r1", roleId: "cfo", by: "Sam", reason: "removed" },
      { type: "set_ai_roles", requestId: "r1", roles: [] }, { type: "set_ai_roles", requestId: "r1", roles: ["tech_lead", "delivery_lead"] },
      { type: "set_ai_roles", requestId: "r1", roles: Array.from({ length: 256 }, (_, i) => `r${i}`) },
      { type: "set_ai_roles", requestId: "r1", roles: [], includeInGroup: true }, { type: "set_ai_roles", requestId: "r1", roles: ["tech_lead"], includeInGroup: false },
      { type: "bot_alert", roleId: "tech_lead", message: "skipped a turn: the model did not answer" }, { type: "bot_alert", roleId: "tech_lead", message: "x".repeat(200) },
      // US-0070: voice.
      { type: "voice_line", segmentId: seg, roleId: "tech_lead", participantId: "p-1", text: "We ship in May." },
      { type: "voice_line", segmentId: seg, roleId: "tech_lead", participantId: "p-1", text: "x".repeat(2000) },
      { type: "speech_activity", roleId: "tech_lead", active: true }, { type: "speech_activity", roleId: "tech_lead", active: false },
      { type: "speech_activity", roleId: "tech_lead", active: false, silentMs: 0 }, { type: "speech_activity", roleId: "tech_lead", active: false, silentMs: 60000 },
      { type: "voice_notice", roleId: "tech_lead", participantId: "p-1", code: "stt_failed" }, { type: "voice_notice", roleId: "tech_lead", participantId: "p-1", code: "empty" },
      ...RUNTIME_VOICE_ALERT_CODES.map((code) => ({ type: "voice_alert", code })),
      // US-0071: the new alert codes and the availability message (fire-and-forget).
      { type: "voice_alert", code: "voice_off" }, { type: "voice_alert", code: "worker_restarting" }, { type: "voice_alert", code: "stt_recovered" },
      // US-0072 (A1c Task 10): a LiveKit outage and its end.
      { type: "voice_alert", code: "livekit_lost" }, { type: "voice_alert", code: "livekit_recovered" },
      // US-0073 (A2a Task 8): the audio store stopped recording (the transcript continues).
      { type: "voice_alert", code: "disk_low" }, { type: "voice_alert", code: "write_error" },
      { type: "voice_availability", available: false, off: false }, { type: "voice_availability", available: true, off: false },
      { type: "voice_availability", available: true, off: true }];
    const bad: unknown[] = [{ type: "reissue", requestId: "r1" }, { type: "reissue", requestId: "r1", roleId: "facilitator" }, { type: "reissue", requestId: "r 1", roleId: "cfo" },
      { type: "reissue", requestId: "r1", roleId: "cfo", by: "x".repeat(201) }, { type: "reissue", requestId: "r1", roleId: "cfo", z: 1 }, { type: "reissue", requestId: "r1", roleId: "cfo", reason: "other" }, { type: "reissue", requestId: "r1", roleId: "cfo", reason: "" }, { type: "other" }, null,
      { type: "set_ai_roles", requestId: "r1", roles: Array.from({ length: 257 }, (_, i) => `r${i}`) }, { type: "set_ai_roles", requestId: "r1", roles: "tech_lead" },
      { type: "set_ai_roles", requestId: "r1", roles: ["facilitator"] }, { type: "set_ai_roles", requestId: "r1", roles: [], by: "Kim" }, { type: "set_ai_roles", requestId: "r1", roles: [], includeInGroup: "x" }, { type: "set_ai_roles", requestId: "r1", roles: [], includeInGroup: 1 },
      { type: "set_ai_roles", requestId: "r1", roles: [], includeInGroup: null },
      { type: "set_ai_roles", requestId: "r 1", roles: [] }, { type: "set_ai_roles", roles: [] },
      { type: "bot_alert", roleId: "tech_lead", message: "x".repeat(201) }, { type: "bot_alert", roleId: "tech_lead", message: "" }, { type: "bot_alert", roleId: "facilitator", message: "m" },
      { type: "bot_alert", roleId: "tech_lead", message: "m", extra: 1 }, { type: "bot_alert", roleId: "tech_lead", message: "m", requestId: "r1" }, { type: "bot_alert", message: "m" },
      // US-0070: voice.
      { type: "voice_line", segmentId: seg, roleId: "tech_lead", participantId: "p-1", text: "" },
      { type: "voice_line", segmentId: seg, roleId: "tech_lead", participantId: "p-1", text: "x".repeat(2001) },
      { type: "voice_line", segmentId: "a/b", roleId: "tech_lead", participantId: "p-1", text: "t" },
      { type: "voice_line", segmentId: seg, roleId: "tech_lead", participantId: "p-1", text: "t", extra: 1 },
      { type: "voice_line", segmentId: seg, roleId: "facilitator", participantId: "p-1", text: "t" },
      { type: "voice_line", segmentId: seg, roleId: "tech_lead", participantId: "rebind-pending", text: "t" },
      { type: "voice_line", segmentId: seg, roleId: "tech_lead", participantId: "p-1", text: "t", startMs: 0 },
      { type: "speech_activity", roleId: "tech_lead", active: true, silentMs: 0 }, { type: "speech_activity", roleId: "tech_lead", active: false, silentMs: 60001 },
      { type: "speech_activity", roleId: "tech_lead", active: false, silentMs: -1 }, { type: "speech_activity", roleId: "tech_lead", active: "no" },
      { type: "voice_notice", roleId: "tech_lead", participantId: "p-1", code: "paused" }, { type: "voice_notice", roleId: "tech_lead", participantId: "p-1", code: "stt_failed", extra: 1 },
      { type: "voice_notice", roleId: "tech_lead", code: "empty" },
      { type: "voice_alert", code: "nope" }, { type: "voice_alert", code: "worker_down", message: "m" }, { type: "voice_alert" },
      // US-0071.
      { type: "voice_availability", available: false, off: false, extra: 1 }, { type: "voice_availability", available: false, off: 1 },
      { type: "voice_availability", available: "false", off: false }, { type: "voice_availability", available: false }, { type: "voice_availability", off: false }];
    for (const m of ok) { expect(RuntimeParent.safeParse(m).success).toBe(true); expect(ParentMessageSchema.safeParse(m).success).toBe(true); }
    for (const m of bad) { expect(RuntimeParent.safeParse(m).success).toBe(false); expect(ParentMessageSchema.safeParse(m).success).toBe(false); }
  });
});
