/**
 * US-0070 (spec 4, D2): where a worker's audio comes from: 20 ms frames of 16 kHz mono 16-bit PCM, each tagged with the role (seat) whose
 * track it is. A1a has the file-fed implementation (tests, CI, the offline demo); A1b adds LiveKit. An ingest knows nothing of consent:
 * the per-track pipeline decides whether a frame may be used (the privacy invariant).
 *
 * US-0071 (A1b Task 7): every frame also carries the seat GENERATION whose track produced it (`undefined` for file ingest), and an
 * ingest that chooses what to listen to (LiveKit) is told which seats may be listened to, and with which generation (`setAllowed`).
 */
export type FrameSink = (roleId: string, generation: string | undefined, frame: Int16Array) => void;

export interface AudioIngest {
  /** Starts delivering frames; resolves when the source is exhausted or `stop` was called (rejects with a fixed sentence on a bad source). */
  start(onFrame: FrameSink): Promise<void>;
  /** Stops delivering; resolves once no further frame will come. Harmless when not started or already stopped. */
  stop(): Promise<void>;
  /**
   * The seats that may be listened to now, role -> generation: EMPTY while paused or ended. Applied synchronously. File ingest has no
   * choice of what it reads and ignores it (the gate still drops what may not be used).
   */
  setAllowed?(allowed: ReadonlyMap<string, string>): void;
}
