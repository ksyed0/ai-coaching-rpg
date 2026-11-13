import type { AiRoleSet } from "./ai-roles.js";
import type { ConsentStore } from "./consent.js";
import type { PlayerCredentials } from "./credentials.js";
import type { VoiceFileIO } from "./voice-file.js";

/**
 * The durable seat state a session carries: who holds which credential, who has consented, and (US-0060) which roles an AI plays.
 * `persist` writes the files in that order. `aiRoles` is optional so literals of `Seats` stay valid; absent means none, and
 * `openSession` always sets it.
 */
export type Seats = {
  credentials: PlayerCredentials; consent: ConsentStore; aiRoles?: AiRoleSet; persist(): void;
  /**
   * US-0070: the session's voice record (`<sessionId>.voice.json`), bound to the credentials' log identity. Optional: absent (embedders,
   * tests), voice choices live in memory only. Read and written by the host only while voice is enabled; `persist` never touches it.
   */
  voiceFile?: VoiceFileIO;
};
