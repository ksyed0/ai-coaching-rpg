import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { decodeWav } from "@acr/adapters";
import { isFileSafeId } from "@acr/events";
import type { AudioIngest } from "./audio-ingest.js";

/** The one sentence any unusable ingest file is refused with (never a path or a role id). */
export const INGEST_FILE_REFUSED = "an ingest file is not a readable 16 kHz 16-bit mono WAV file";
/** About 50 minutes of 16 kHz 16-bit audio: far beyond any fixture or demo file. */
export const MAX_INGEST_FILE_BYTES = 100 * 1024 * 1024;
const RATE = 16_000;

/**
 * US-0070: WAV files as tracks, `<dir>/<roleId>.wav` per listed role. A role id is checked with `isFileSafeId` (in the constructor, before
 * any path is built). A missing file means no audio for that role; any other unusable file (a symlink, a directory, too large, not 16 kHz
 * mono 16-bit PCM) rejects `start` with INGEST_FILE_REFUSED. Frames go out in role-interleaved time order (frame 0 of every role, then
 * frame 1, ...), awaiting `pace(frameMs)` after each frame time (a no-op in tests and CI; real time in the worker process). A trailing
 * partial frame is padded with silence.
 */
export class FileIngest implements AudioIngest {
  private stopped = false;
  private running: Promise<void> | null = null;

  constructor(private readonly o: { dir: string; roles: string[]; frameMs: 20; pace: (ms: number) => Promise<void> }) {
    if (o.frameMs !== 20) throw new RangeError("file ingest frames are 20 ms");
    for (const r of o.roles) if (!isFileSafeId(r)) throw new RangeError("an ingest role id is not a safe file name");
  }

  start(onFrame: (roleId: string, frame: Int16Array) => void): Promise<void> {
    this.running ??= this.run(onFrame);
    return this.running;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.running?.catch(() => undefined);
  }

  private async run(onFrame: (roleId: string, frame: Int16Array) => void): Promise<void> {
    const tracks: { roleId: string; pcm: Int16Array }[] = [];
    for (const roleId of this.o.roles) {
      const pcm = readTrack(path.join(this.o.dir, `${roleId}.wav`));
      if (pcm) tracks.push({ roleId, pcm });
    }
    const per = (RATE * this.o.frameMs) / 1000;
    const frames = Math.max(0, ...tracks.map((t) => Math.ceil(t.pcm.length / per)));
    for (let i = 0; i < frames && !this.stopped; i++) {
      for (const t of tracks) {
        if (i * per >= t.pcm.length) continue;
        const f = new Int16Array(per);
        f.set(t.pcm.subarray(i * per, Math.min(t.pcm.length, (i + 1) * per)));
        onFrame(t.roleId, f);
      }
      await this.o.pace(this.o.frameMs);
    }
  }
}

/** The track's samples, or null when the file does not exist. One descriptor, opened without following a symlink, judged by fstat. */
function readTrack(file: string): Int16Array | null {
  let fd: number;
  try { fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(INGEST_FILE_REFUSED);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_INGEST_FILE_BYTES) throw new Error(INGEST_FILE_REFUSED);
    const bytes = new Uint8Array(st.size);
    let off = 0;
    while (off < bytes.length) { const n = readSync(fd, bytes, off, bytes.length - off, off); if (n === 0) break; off += n; }
    const wav = decodeWav(bytes.subarray(0, off));
    if (wav.sampleRate !== RATE) throw new Error(INGEST_FILE_REFUSED);
    return wav.pcm;
  } catch { throw new Error(INGEST_FILE_REFUSED); }
  finally { closeSync(fd); }
}
