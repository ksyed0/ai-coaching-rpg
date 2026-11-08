import { describe, expect, it } from "vitest";
import {
  ControlToWorkerSchema, MAX_HOLDERS, MAX_SILENT_MS, MAX_VOICE_TEXT_CHARS, REBIND_PENDING_PARTICIPANT, SegmentIdSchema, VOICE_REFUSALS, WorkerMessageSchema,
} from "../protocol.js";

const seg = "0123456789abcdef";
const holder = (i: number) => ({ roleId: `r${i}`, participantId: `p${i}`, recording: i % 2 === 0 });

describe("worker protocol constants", () => {
  it("has the limits of the overview", () => {
    expect(MAX_VOICE_TEXT_CHARS).toBe(2000);
    expect(MAX_HOLDERS).toBe(256);
    expect(MAX_SILENT_MS).toBe(60_000);
    expect(REBIND_PENDING_PARTICIPANT).toBe("rebind-pending");
    expect(VOICE_REFUSALS).toEqual(["voice_off", "not_started", "unknown_role", "ai_role", "not_holder", "not_recording", "paused", "not_in_scene", "ended", "failed"]);
  });

  it("a segment id is a file-safe id", () => {
    for (const ok of [seg, "a", "a".repeat(64), "a_b-c"]) expect(SegmentIdSchema.safeParse(ok).success, ok).toBe(true);
    for (const bad of ["", "../x", "A", "a".repeat(65), "a/b", "a.b", 5, null]) expect(SegmentIdSchema.safeParse(bad).success, String(bad)).toBe(false);
  });
});

describe("worker -> control messages", () => {
  const line = { type: "voice_line", segmentId: seg, roleId: "tech_lead", participantId: "p-1", text: "We can ship in May.", startMs: 1000, endMs: 2500 };
  const valid: unknown[] = [
    { type: "worker_ready", stt: "ok" }, { type: "worker_ready", stt: "unavailable" },
    line, { ...line, text: "x".repeat(2000) }, { ...line, startMs: 0, endMs: 0 },
    { type: "speech_activity", roleId: "tech_lead", active: true },
    { type: "speech_activity", roleId: "tech_lead", active: false },
    { type: "speech_activity", roleId: "tech_lead", active: false, silentMs: 0 },
    { type: "speech_activity", roleId: "tech_lead", active: false, silentMs: 60000 },
    { type: "segment_failed", segmentId: seg, roleId: "cfo", participantId: "p", status: "empty" },
    { type: "segment_failed", segmentId: seg, roleId: "cfo", participantId: "p", status: "stt_failed" },
  ];
  const invalid: unknown[] = [
    null, "x", {}, { type: "nope" },
    { type: "worker_ready", stt: "ok", extra: 1 }, { type: "worker_ready", stt: "down" }, { type: "worker_ready" },
    { ...line, extra: 1 }, { ...line, segmentId: "../x" }, { ...line, segmentId: "A" }, { ...line, segmentId: "a".repeat(65) },
    { ...line, roleId: "facilitator" }, { ...line, roleId: "__proto__" }, { ...line, roleId: "Bad Id" },
    { ...line, text: "" }, { ...line, text: "x".repeat(2001) }, { ...line, participantId: "rebind-pending" }, { ...line, participantId: "" },
    { ...line, participantId: "p".repeat(129) }, { ...line, startMs: -1 }, { ...line, startMs: 1.5 }, { ...line, startMs: 3000, endMs: 2000 },
    { type: "speech_activity", roleId: "tech_lead", active: true, silentMs: 0 },
    { type: "speech_activity", roleId: "tech_lead", active: false, silentMs: -1 },
    { type: "speech_activity", roleId: "tech_lead", active: false, silentMs: 60001 },
    { type: "speech_activity", roleId: "tech_lead", active: false, silentMs: 1.5 },
    { type: "speech_activity", roleId: "tech_lead", active: "false" },
    { type: "speech_activity", roleId: "tech_lead", active: true, extra: 1 },
    { type: "segment_failed", segmentId: seg, roleId: "cfo", participantId: "p", status: "refused" },
    { type: "segment_failed", segmentId: seg, roleId: "cfo", participantId: "p", status: "empty", extra: 1 },
    { type: "segment_failed", segmentId: seg, roleId: "cfo", participantId: "rebind-pending", status: "empty" },
  ];
  it("accepts every message of the overview with minimal fields", () => {
    for (const m of valid) expect(WorkerMessageSchema.safeParse(m).success, JSON.stringify(m)).toBe(true);
  });
  it("refuses unknown keys, bad ids, bad text and bad timings", () => {
    for (const m of invalid) expect(WorkerMessageSchema.safeParse(m).success, JSON.stringify(m)).toBe(false);
  });
});

describe("control -> worker messages", () => {
  const valid: unknown[] = [
    { type: "voice_state", paused: false, ended: false, holders: [] },
    { type: "voice_state", paused: true, ended: false, holders: Array.from({ length: 256 }, (_, i) => holder(i)) },
    { type: "voice_line_result", segmentId: seg, seq: 1 },
    { type: "voice_line_result", segmentId: seg, refused: "not_holder" },
    ...VOICE_REFUSALS.map((refused) => ({ type: "voice_line_result", segmentId: seg, refused })),
  ];
  const invalid: unknown[] = [
    { type: "voice_state", paused: false, ended: false, holders: Array.from({ length: 257 }, (_, i) => holder(i)) },
    { type: "voice_state", paused: false, ended: false, holders: [], extra: 1 },
    { type: "voice_state", paused: false, holders: [] },
    { type: "voice_state", paused: false, ended: false, holders: [{ ...holder(0), extra: 1 }] },
    { type: "voice_state", paused: false, ended: false, holders: [{ ...holder(0), roleId: "facilitator" }] },
    { type: "voice_state", paused: false, ended: false, holders: [{ ...holder(0), participantId: "rebind-pending" }] },
    { type: "voice_state", paused: false, ended: false, holders: [{ roleId: "r", participantId: "p" }] },
    { type: "voice_line_result", segmentId: seg, seq: 1, refused: "not_holder" },
    { type: "voice_line_result", segmentId: seg },
    { type: "voice_line_result", segmentId: seg, seq: 0 },
    { type: "voice_line_result", segmentId: seg, seq: 1.5 },
    { type: "voice_line_result", segmentId: seg, refused: "other" },
    { type: "voice_line_result", segmentId: "../x", seq: 1 },
    { type: "voice_line_result", segmentId: seg, seq: 1, extra: 1 },
    { type: "voice_line", segmentId: seg },
  ];
  it("accepts voice_state with 0 and 256 holders and both forms of voice_line_result", () => {
    for (const m of valid) expect(ControlToWorkerSchema.safeParse(m).success, JSON.stringify(m)).toBe(true);
  });
  it("refuses 257 holders, unknown keys, both or neither of seq and refused, and seq 0", () => {
    for (const m of invalid) expect(ControlToWorkerSchema.safeParse(m).success, JSON.stringify(m)).toBe(false);
  });
});
