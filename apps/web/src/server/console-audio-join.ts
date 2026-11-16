import type { AudioSegment } from "./launcher-client";

// A2b-2: the pure join of the recorded clips to the transcript lines. The seq is the key; a line of another seat is never used. The
// output is what the browser may see: no participant id, no seq, no identity.

export type Clip = {
  role: string;
  segment: string;
  startMs: number;
  endMs: number;
  status: string;
  audio: "available" | "deleted" | "missing";
  text?: string;
};

export function joinClips(segments: AudioSegment[], lines: { seq: number; roleId: string; text: string }[]): Clip[] {
  const bySeq = new Map<number, { roleId: string; text: string }>();
  for (const l of lines) bySeq.set(l.seq, { roleId: l.roleId, text: l.text });
  return [...segments]
    .sort((a, b) => a.startMs - b.startMs)
    .map((s) => {
      const line = s.status === "transcribed" && s.seq !== undefined ? bySeq.get(s.seq) : undefined;
      return {
        role: s.role, segment: s.segment, startMs: s.startMs, endMs: s.endMs, status: s.status, audio: s.audio,
        ...(line !== undefined && line.roleId === s.role && { text: line.text }),
      };
    });
}
