import { describe, expect, it } from "vitest";
import {
  ControlToWorkerSchema, MAX_HOLDERS, MAX_LIVEKIT_TOKEN_CHARS, MAX_LIVEKIT_URL_CHARS, MAX_SILENT_MS, MAX_VOICE_TEXT_CHARS, REBIND_PENDING_PARTICIPANT, SegmentIdSchema,
  VOICE_REFUSALS, WorkerMessageSchema,
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
    // US-0071 (A1b Task 5): voiceChosen (ignored by the worker) and the seat generation (only with SPEECH_INGEST=livekit).
    { type: "voice_state", paused: false, ended: false, holders: [{ ...holder(0), voiceChosen: true }] },
    { type: "voice_state", paused: false, ended: false, holders: [{ ...holder(0), voiceChosen: false, generation: "0123abcd" }] },
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
    { type: "voice_state", paused: false, ended: false, holders: [{ ...holder(0), generation: "XYZ" }] },
    { type: "voice_state", paused: false, ended: false, holders: [{ ...holder(0), generation: "0123ABCD" }] },
    { type: "voice_state", paused: false, ended: false, holders: [{ ...holder(0), generation: "0123abc" }] },
    { type: "voice_state", paused: false, ended: false, holders: [{ ...holder(0), voiceChosen: "yes" }] },
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

describe("US-0071: LiveKit, health and slot messages", () => {
  const hex32 = "0123456789abcdef0123456789abcdef";
  const slot = "0123456789abcdef";
  const join = { type: "livekit_join", roleId: "tech_lead", url: "ws://127.0.0.1:7880", token: "header.payload.signature", room: `v${hex32}` };

  it("has the limits of the plan", () => {
    expect(MAX_LIVEKIT_URL_CHARS).toBe(512);
    expect(MAX_LIVEKIT_TOKEN_CHARS).toBe(4096);
  });

  it("control -> worker: livekit_join and stt_slot_grant", () => {
    const valid: unknown[] = [
      join, { ...join, url: "wss://pilot.example/" }, { ...join, token: "t" }, { ...join, token: "t".repeat(4096) },
      { type: "stt_slot_grant", slot },
    ];
    const invalid: unknown[] = [
      { ...join, url: "http://127.0.0.1:7880" }, { ...join, url: "https://pilot.example/" }, { ...join, url: "not a url" },
      { ...join, url: `wss://pilot.example/${"a".repeat(512)}` }, { ...join, url: "wss://user:pw@pilot.example/" },
      { ...join, token: "" }, { ...join, token: "t".repeat(4097) },
      { ...join, room: `v${hex32.slice(1)}` }, { ...join, room: `V${hex32}` }, { ...join, room: hex32 }, { ...join, room: `v${hex32}0` },
      { ...join, room: `v${hex32.slice(1)}g` }, { ...join, room: `v${hex32.toUpperCase()}` },
      { type: "livekit_join", url: join.url, token: join.token, room: join.room }, { ...join, roleId: "a.b" }, { ...join, roleId: "facilitator" },
      { ...join, extra: 1 },
      { type: "stt_slot_grant", slot: "../x" }, { type: "stt_slot_grant", slot: slot.slice(1) }, { type: "stt_slot_grant", slot: slot.toUpperCase() },
      { type: "stt_slot_grant", slot, extra: 1 }, { type: "stt_slot_grant" },
    ];
    for (const m of valid) expect(ControlToWorkerSchema.safeParse(m).success, JSON.stringify(m)).toBe(true);
    for (const m of invalid) expect(ControlToWorkerSchema.safeParse(m).success, JSON.stringify(m)).toBe(false);
  });

  it("worker -> control: livekit_token_request, livekit_status, stt_health and the slot messages", () => {
    const valid: unknown[] = [
      { type: "livekit_token_request", roleId: "tech_lead" },
      ...["connected", "failed", "disconnected"].map((state) => ({ type: "livekit_status", state })),
      { type: "stt_health", ok: true }, { type: "stt_health", ok: false },
      { type: "stt_slot_request", slot }, { type: "stt_slot_release", slot },
    ];
    const invalid: unknown[] = [
      // The role-id rule of every other message: a reserved word or a prototype key is refused here too (stricter than the plan's "valid by shape").
      { type: "livekit_token_request", roleId: "__proto__" }, { type: "livekit_token_request", roleId: "a.b" },
      { type: "livekit_token_request", roleId: "tech_lead", extra: 1 }, { type: "livekit_token_request" },
      { type: "livekit_status", state: "up" }, { type: "livekit_status", state: "connected", roleId: "tech_lead" }, { type: "livekit_status" },
      { type: "stt_health", ok: "yes" }, { type: "stt_health" }, { type: "stt_health", ok: true, extra: 1 },
      { type: "stt_slot_request", slot: "../x" }, { type: "stt_slot_request" }, { type: "stt_slot_request", slot, extra: 1 },
      { type: "stt_slot_release", slot: "../x" }, { type: "stt_slot_release", slot: "" },
    ];
    for (const m of valid) expect(WorkerMessageSchema.safeParse(m).success, JSON.stringify(m)).toBe(true);
    for (const m of invalid) expect(WorkerMessageSchema.safeParse(m).success, JSON.stringify(m)).toBe(false);
  });

  it("the new messages go one way only", () => {
    expect(WorkerMessageSchema.safeParse(join).success).toBe(false);
    expect(WorkerMessageSchema.safeParse({ type: "stt_slot_grant", slot }).success).toBe(false);
    expect(ControlToWorkerSchema.safeParse({ type: "livekit_token_request", roleId: "tech_lead" }).success).toBe(false);
    expect(ControlToWorkerSchema.safeParse({ type: "stt_slot_request", slot }).success).toBe(false);
  });
});
