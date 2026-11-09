/**
 * US-0071 (EPIC-0003 voice A1b): `@acr/adapters/livekit`, the ONLY way to reach `livekit-server-sdk` (R20, K12). Imported by control and
 * the opt-in live checks; the root `@acr/adapters` index never re-exports it (the runtime, the speech worker and the bots import the
 * root). The speech worker needs only the identity helpers: `@acr/adapters/livekit/identity`, which loads no SDK.
 */
export { GENERATION_HEX_CHARS, WORKER_IDENTITY_PREFIX, participantIdentity, parseParticipantIdentity, workerIdentity } from "./identity.js";
export { LiveKitTokenError, VOICE_TOKEN_TTL_S, mintParticipantToken, mintWorkerToken, type MintInput, type MintedToken } from "./token.js";
export { LiveKitAdminError, createRoomAdmin, type LiveKitAdminCause, type RoomAdmin, type RoomServiceClientLike } from "./room-admin.js";
