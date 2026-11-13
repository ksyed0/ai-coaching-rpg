import { writeFileAtomic } from "./atomic-file.js";
import { nodeStoreFs, type StoreFs } from "./store-fs.js";

export const MARKER_NAME = "session.json";

/**
 * US-0074 (voice A2b-1a, Task 1): writes `<dir>/session.json` `{ v: 1, sessionId }` (0600) so control can find the audio of a session
 * by its id. Atomic and link-refusing (see `writeFileAtomic`); throws on failure, names nothing.
 */
export function writeSessionMarker(dir: string, sessionId: string, fs: StoreFs = nodeStoreFs): void {
  writeFileAtomic(fs, dir, MARKER_NAME, Buffer.from(JSON.stringify({ v: 1, sessionId }), "utf8"));
}
