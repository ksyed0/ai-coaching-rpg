import { RoomServiceClient } from "livekit-server-sdk";

/**
 * US-0071 (EPIC-0003 voice A1b, Task 4): the three LiveKit server calls control needs, behind a port so tests use a fake. Control removes
 * stale identities from a seat room, sweeps a room's participants, and deletes a session's rooms at its end. A twirp `not_found` answer (no
 * such room or participant; never a bare HTTP 404) is success: the state control wanted already holds. Any other failure is a
 * LiveKitAdminError with a fixed message and only a sanitised `{ status?, code? }` as `cause` (the raw error may name the room, the
 * identity or the host). Callers log `errorName(err)` only.
 */
export interface RoomAdmin {
  removeParticipant(room: string, identity: string): Promise<void>;
  /** The identities in the room (nothing else of a participant is returned). */
  listParticipants(room: string): Promise<string[]>;
  deleteRoom(room: string): Promise<void>;
}

/** The part of the SDK's RoomServiceClient used here. */
export interface RoomServiceClientLike {
  removeParticipant(room: string, identity: string): Promise<unknown>;
  listParticipants(room: string): Promise<{ identity: string }[]>;
  deleteRoom(room: string): Promise<unknown>;
}

/** The twirp error codes (a fixed vocabulary that names nothing); any other `code` is dropped. */
const TWIRP_CODES: ReadonlySet<string> = new Set([
  "canceled", "unknown", "invalid_argument", "malformed", "deadline_exceeded", "not_found", "bad_route", "already_exists", "permission_denied",
  "unauthenticated", "resource_exhausted", "failed_precondition", "aborted", "out_of_range", "unimplemented", "internal", "unavailable", "data_loss",
]);

/** What a LiveKitAdminError keeps of the SDK's error: an HTTP status (an integer 100..599) and an allowlisted twirp code, nothing else. */
export type LiveKitAdminCause = { status?: number; code?: string };

function sanitise(err: unknown): LiveKitAdminCause {
  if (typeof err !== "object" || err === null) return {};
  const { status, code } = err as { status?: unknown; code?: unknown };
  return {
    ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    ...(typeof code === "string" && TWIRP_CODES.has(code) ? { code } : {}),
  };
}

/**
 * A LiveKit admin call failed. The message is fixed and `cause` is only the sanitised `{ status?, code? }`: the raw SDK error is never
 * kept, since its message, metadata or stack can name the room, the identity or the host.
 */
export class LiveKitAdminError extends Error {
  declare readonly cause: LiveKitAdminCause;
  constructor(what: "remove" | "list" | "delete", err: unknown) {
    super(`the LiveKit server refused or did not answer a ${what} call`, { cause: sanitise(err) });
    this.name = "LiveKitAdminError";
  }
}

/**
 * A twirp "not found": the code `not_found` only. A bare HTTP 404 is NOT one: the SDK's toTwirpError gives status 404 and no code for any
 * 404 whose body is not twirp JSON (another server on that port), and treating it as success would make every removal a silent no-op.
 */
function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  return (err as { code?: unknown }).code === "not_found";
}

/** The server API address: `http:` to 127.0.0.1 or [::1] with no user info and no path (the pilot laptop; LIVEKIT_HOST in control). */
function checkHost(host: URL): void {
  const loopback = host.hostname === "127.0.0.1" || host.hostname === "[::1]";
  if (host.protocol !== "http:" || !loopback || host.username !== "" || host.password !== "" || (host.pathname !== "/" && host.pathname !== "") || host.search !== "" || host.hash !== "") {
    throw new RangeError("createRoomAdmin: the LiveKit host must be http: on a loopback address with no path or user info");
  }
}

export function createRoomAdmin(o: { host: URL; apiKey: string; apiSecret: string; client?: RoomServiceClientLike }): RoomAdmin {
  checkHost(o.host);
  // Checked here: the SDK's ServiceBase.authHeader builds an AccessToken, which falls back to LIVEKIT_API_KEY / LIVEKIT_API_SECRET from
  // the environment for an empty argument.
  if (typeof o.apiKey !== "string" || o.apiKey.length === 0 || typeof o.apiSecret !== "string" || o.apiSecret.length === 0) {
    throw new RangeError("createRoomAdmin: the LiveKit API key and secret must both be set");
  }
  const client: RoomServiceClientLike = o.client ?? new RoomServiceClient(o.host.origin, o.apiKey, o.apiSecret);
  return {
    async removeParticipant(room, identity) {
      try { await client.removeParticipant(room, identity); } catch (err) { if (!isNotFound(err)) throw new LiveKitAdminError("remove", err); }
    },
    async listParticipants(room) {
      try { return (await client.listParticipants(room)).map((p) => p.identity); } catch (err) { if (isNotFound(err)) return []; throw new LiveKitAdminError("list", err); }
    },
    async deleteRoom(room) {
      try { await client.deleteRoom(room); } catch (err) { if (!isNotFound(err)) throw new LiveKitAdminError("delete", err); }
    },
  };
}
