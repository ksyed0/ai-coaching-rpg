import type { ConsentStore } from "./consent.js";
import type { PlayerCredentials } from "./credentials.js";

/** The durable seat state a session carries: who holds which credential, and who has consented. `persist` writes both files. */
export type Seats = { credentials: PlayerCredentials; consent: ConsentStore; persist(): void };
