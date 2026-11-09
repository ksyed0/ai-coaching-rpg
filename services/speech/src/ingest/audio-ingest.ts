/**
 * US-0070 (spec 4, D2): where a worker's audio comes from: 20 ms frames of 16 kHz mono 16-bit PCM, each tagged with the role (seat) whose
 * track it is. A1a has the file-fed implementation (tests, CI, the offline demo); A1b adds LiveKit. An ingest knows nothing of consent:
 * the per-track pipeline decides whether a frame may be used (the privacy invariant).
 */
export interface AudioIngest {
  /** Starts delivering frames; resolves when the source is exhausted or `stop` was called (rejects with a fixed sentence on a bad source). */
  start(onFrame: (roleId: string, frame: Int16Array) => void): Promise<void>;
  /** Stops delivering; resolves once no further frame will come. Harmless when not started or already stopped. */
  stop(): Promise<void>;
}
