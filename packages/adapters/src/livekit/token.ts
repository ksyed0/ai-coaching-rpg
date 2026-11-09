import { AccessToken, TrackSource, type VideoGrant } from "livekit-server-sdk";

/**
 * US-0071 (EPIC-0003 voice A1b, spec 9, overview 7): LiveKit access tokens, minted by control only (the key and secret live in control's
 * environment and nowhere else). Each token is for ONE seat room and lives VOICE_TOKEN_TTL_S. The grants are exactly those of the plan's
 * Global Constraints; the decoded JWT is pinned by `token.test.ts`. The SDK signs with the system clock (jose's `new Date()`), so
 * `expiresAt` is read back from the token's own `exp` claim rather than computed beside it.
 */
export const VOICE_TOKEN_TTL_S = 600;

/** A token could not be minted. The message is fixed: never the key, the secret, the room or the identity; no `cause`. */
export class LiveKitTokenError extends Error {
  constructor() { super("a LiveKit token could not be minted"); this.name = "LiveKitTokenError"; }
}

export type MintInput = { apiKey: string; apiSecret: string; room: string; identity: string };
export type MintedToken = { token: string; /** ms since the epoch */ expiresAt: number };

/** A participant may join their own seat room and publish a microphone only: no subscribe, no data, no metadata change. */
const participantGrant = (room: string): VideoGrant => ({
  room, roomJoin: true, canPublish: true, canPublishSources: [TrackSource.MICROPHONE], canSubscribe: false, canPublishData: false, canUpdateOwnMetadata: false,
});
/** The speech worker joins hidden and may only subscribe. */
const workerGrant = (room: string): VideoGrant => ({
  room, roomJoin: true, canPublish: false, canSubscribe: true, canPublishData: false, canUpdateOwnMetadata: false, hidden: true,
});

async function mint(o: MintInput, grant: (room: string) => VideoGrant): Promise<MintedToken> {
  // Checked here: the SDK falls back to LIVEKIT_API_KEY / LIVEKIT_API_SECRET from the environment for an empty argument.
  if (!nonEmpty(o.apiKey) || !nonEmpty(o.apiSecret) || !nonEmpty(o.room) || !nonEmpty(o.identity)) throw new LiveKitTokenError();
  let token: string;
  try {
    const at = new AccessToken(o.apiKey, o.apiSecret, { identity: o.identity, ttl: VOICE_TOKEN_TTL_S });
    at.addGrant(grant(o.room));
    token = await at.toJwt();
  } catch {
    throw new LiveKitTokenError(); // the SDK's message is not passed on
  }
  const exp = expOf(token);
  if (exp === null) throw new LiveKitTokenError();
  return { token, expiresAt: exp * 1000 };
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** The `exp` claim (seconds) of a JWT, or null. */
function expOf(token: string): number | null {
  const payload = token.split(".")[1];
  if (payload === undefined) return null;
  try {
    const exp = (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isSafeInteger(exp) ? exp : null;
  } catch { return null; }
}

/** A seat's microphone-only token for its own room (identity `<roleId>.g<generation>`). */
export function mintParticipantToken(o: MintInput): Promise<MintedToken> { return mint(o, participantGrant); }

/** The speech worker's hidden, subscribe-only token for one seat room (identity `SPEECH.<8 hex>`), minted fresh for every connect. */
export function mintWorkerToken(o: MintInput): Promise<MintedToken> { return mint(o, workerGrant); }
