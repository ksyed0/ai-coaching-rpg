// US-0082: "@Role" addressing. Framework-free and Node-free (the runtime, the control service's bots and the browser share it).
// An addressed line stays public: the address only says who the line is directed at.

/** A role a line may be directed at, and the words that may name it after an "@" (the role id is always one of them). */
export type AddressCandidate = { id: string; labels?: readonly string[] };

/** "tech_lead" -> "tech lead": a role id as words (the same rule as the page's role label, without the capital). */
export const roleWords = (roleId: string): string => roleId.replace(/[_-]+/g, " ").trim();

const MAX_ADDRESS_CHARS = 80;
const fold = (s: string): string => s.normalize("NFKC").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Reads a leading "@<role id>" or "@<label>" (for example "@tech_lead", "@Tech lead", "@Priya Raman") off a model's reply. Conservative:
 * only at the very start (after spaces), only a name of one of `candidates` (the caller passes the OTHER roles of the speaker's current
 * scene, so a model can never invent an addressee), whole words only (the next character is not a letter or digit), case and `_`/`-`
 * insensitive, longest name first. The "@name" and the separators after it are removed. Returns null (the reply is left exactly as it
 * was) when there is no match, or when nothing but punctuation would remain.
 */
export function splitLeadingAddress(raw: string, candidates: readonly AddressCandidate[]): { to: string; text: string } | null {
  if (typeof raw !== "string") return null;
  const start = raw.trimStart();
  if (!start.startsWith("@")) return null;
  const names: { id: string; name: string }[] = [];
  for (const c of candidates) {
    if (typeof c.id !== "string" || c.id.length === 0) continue;
    for (const n of [c.id, roleWords(c.id), ...(c.labels ?? [])]) {
      const f = fold(n);
      if (f.length > 0 && f.length <= MAX_ADDRESS_CHARS && !names.some((x) => x.id === c.id && x.name === f)) names.push({ id: c.id, name: f });
    }
  }
  names.sort((a, b) => b.name.length - a.name.length);
  const body = start.slice(1);
  for (const { id, name } of names) {
    // Compare the folded head of the body, one source character at a time, so the cut lands on the original text.
    for (let end = 1; end <= Math.min(body.length, MAX_ADDRESS_CHARS * 2); end++) {
      const head = fold(body.slice(0, end));
      if (head.length > name.length) break;
      if (head !== name) continue;
      const next = body.slice(end, end + 1);
      if (next !== "" && /[\p{L}\p{N}_]/u.test(next)) break; // "@techie" is not "@tech"
      const rest = body.slice(end).replace(/^[\s,:;.\-–—]+/u, "");
      if (!/[\p{L}\p{N}]/u.test(rest)) return null;
      return { to: id, text: rest };
    }
  }
  return null;
}
