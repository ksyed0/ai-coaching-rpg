import { SafeJsonFile } from "./safe-json-file.js";

type OwnersFile = { owners: Record<string, string> };

/** A parsed file must be `{ owners: { [sessionId]: accountId } }` and nothing else; anything different is refused, never read as empty. */
function parse(raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("the session owners file is not usable");
  const o = raw as Record<string, unknown>;
  const owners = o.owners;
  if (Object.keys(o).length !== 1 || typeof owners !== "object" || owners === null || Array.isArray(owners)) throw new Error("the session owners file is not usable");
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [k, v] of Object.entries(owners)) {
    if (typeof v !== "string" || v.length === 0) throw new Error("the session owners file is not usable");
    out[k] = v;
  }
  return out;
}

/**
 * US-0083: which facilitator account owns which session, in `<dataDir>/session-owners.json`. Kept apart from `sessions.json` so that file
 * (and a rollback to code that does not know owners) is untouched. Synchronous and re-read on every call: the file is small and the
 * SafeJsonFile checks run each time, so a corrupt, group-writable or symlinked file refuses (throws) and is never replaced. A missing
 * file is empty. Whether an account id exists is not checked here.
 */
export class OwnerStore {
  private readonly file: SafeJsonFile;
  constructor(file: string) { this.file = new SafeJsonFile(file); }

  private load(): Record<string, string> {
    const raw = this.file.read();
    return raw === null ? Object.create(null) as Record<string, string> : parse(raw);
  }

  get(sessionId: string): string | null { return this.load()[sessionId] ?? null; }

  all(): Record<string, string> { return { ...this.load() }; }

  /** `null` clears. Writing re-checks the existing file, so an unusable one is refused rather than overwritten. */
  set(sessionId: string, owner: string | null): void {
    const owners = this.load();
    if (owner === null) { if (!(sessionId in owners)) return; delete owners[sessionId]; }
    else owners[sessionId] = owner;
    const body: OwnersFile = { owners: { ...owners } };
    this.file.write(body);
  }
}
