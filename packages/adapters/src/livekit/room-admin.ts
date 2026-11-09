import { RoomServiceClient } from "livekit-server-sdk";

/**
 * US-0071 (EPIC-0003 voice A1b, Task 4): the three LiveKit server calls control needs, behind a port so tests use a fake. Control removes
 * stale identities from a seat room, sweeps a room's participants, and deletes a session's rooms at its end. A twirp `not_found` answer (no
 * such room or participant; never a bare HTTP 404) is success: the state control wanted already holds. Any other failure is a LiveKitAdminError with a fixed
 * message; the original error is kept as `cause` for the caller, never in the message (it may name the room or the identity).
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

export class LiveKitAdminError extends Error {
  constructor(what: "remove" | "list" | "delete", cause: unknown) {
    super(`the LiveKit server refused or did not answer a ${what} call`, { cause });
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
