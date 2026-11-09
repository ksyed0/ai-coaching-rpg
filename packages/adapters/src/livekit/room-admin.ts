import { RoomServiceClient } from "livekit-server-sdk";

/**
 * US-0071 (EPIC-0003 voice A1b, Task 4): the three LiveKit server calls control needs, behind a port so tests use a fake. Control removes
 * stale identities from a seat room, sweeps a room's participants, and deletes a session's rooms at its end. A "not found" answer (no such
 * room or participant) is success: the state control wanted already holds. Any other failure is a LiveKitAdminError with a fixed
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

/** A twirp "not found" (status 404 or code not_found). */
function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { status?: unknown; code?: unknown };
  return e.status === 404 || e.code === "not_found";
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
