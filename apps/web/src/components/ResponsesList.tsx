import { MESSAGES } from "../lib/messages";

// The participant's own responses, with the facilitator's outcome and reason once resolved. All text is rendered as React text.

export type ResponseItem = { criterion: string; text: string; dispute: boolean; outcome?: string; reason?: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const OUTCOMES = new Set(["upheld", "amended", "declined"]);

/** Untrusted `own.responses`, checked entry by entry; the criterion id becomes its name (or "Whole report"). */
export function parseResponses(raw: unknown, criteria: { id: string; name: string }[]): ResponseItem[] {
  if (!Array.isArray(raw)) return [];
  const out: ResponseItem[] = [];
  for (const r of raw) {
    if (!isObj(r) || typeof r.text !== "string") continue;
    const name = typeof r.criterion === "string" ? criteria.find((c) => c.id === r.criterion)?.name : undefined;
    const res = isObj(r.resolution) ? r.resolution : null;
    out.push({
      criterion: name ?? MESSAGES.responsesWhole,
      text: r.text,
      dispute: r.dispute === true,
      ...(res !== null && typeof res.outcome === "string" && OUTCOMES.has(res.outcome) ? { outcome: res.outcome } : {}),
      ...(res !== null && typeof res.reason === "string" ? { reason: res.reason } : {}),
    });
  }
  return out;
}

export function ResponsesList({ items }: { items: ResponseItem[] }) {
  return (
    <section className="card stack" aria-labelledby="report-responses">
      <h2 className="s" id="report-responses">{MESSAGES.responsesHeading}</h2>
      <p className="muted">{MESSAGES.responsesUsed(items.length)}</p>
      {items.length === 0 ? <p>{MESSAGES.responsesNone}</p> : (
        <ul className="stack">
          {items.map((r, i) => (
            <li key={i} className="stack">
              <p>
                <strong>{r.criterion}</strong>
                {r.dispute ? <> <span className="muted">{MESSAGES.responsesDispute}</span></> : null}
              </p>
              <p className="report-text">{r.text}</p>
              {r.outcome !== undefined ? <p>{MESSAGES.responsesOutcome(r.outcome)}</p> : null}
              {r.outcome !== undefined && r.reason !== undefined && r.reason !== "" ? <p>{MESSAGES.responsesReason(r.reason)}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
