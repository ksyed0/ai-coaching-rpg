/**
 * The runtime's file helpers that other services share (US-0073): the single-writer `SessionLock` and the private-directory helpers.
 * `log-files.ts` imports only node and `@acr/events`, so importing this subpath drags no engine code along.
 */
export {
  SessionLock, SessionLockError, assertInside, ensurePrivateDir, fsyncDirSync, DEFAULT_LOCK_STALE_MS,
} from "../engine/log-files.js";
export type { LockOptions } from "../engine/log-files.js";
