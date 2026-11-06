"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getJson } from "../lib/api";
import { MESSAGES } from "../lib/messages";
import { comparisonRows, type ComparisonRow } from "../lib/report-compare";
import { ComparisonTable } from "./ComparisonTable";
import { ResponseForm } from "./ResponseForm";
import { ResponsesList, parseResponses, type ResponseItem } from "./ResponsesList";
import { SelfRatingForm, type RatingForm } from "./SelfRatingForm";

// The participant's released report. The text arrives already scrubbed and rendered to markdown by the runtime; it is shown here as
// escaped plain text in a pre-wrap block, never parsed into HTML. Who the reader is comes from the HttpOnly cookie, not from this page.

export type ReportViewProps = { fetch?: typeof fetch };
type Model =
  | { kind: "loading" }
  | { kind: "report"; own: string; group: string | null; until: string | null; rows: ComparisonRow[]; responses: ResponseItem[]; criteria: { id: string; name: string }[] }
  | { kind: "form"; form: RatingForm }
  | { kind: "not_released" | "closed" | "old_schema" | "refused" | "retry" | "throttled" };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The blind form, checked field by field: anything off reads as a failed load. */
function parseForm(d: Record<string, unknown>): RatingForm | null {
  if (!Array.isArray(d.criteria) || !Array.isArray(d.scale) || !isObj(d.existing)) return null;
  const criteria: RatingForm["criteria"] = [];
  for (const c of d.criteria) {
    if (!isObj(c) || typeof c.id !== "string" || typeof c.name !== "string") return null;
    criteria.push({ id: c.id, name: c.name });
  }
  const scale: RatingForm["scale"] = [];
  for (const s of d.scale) {
    if (!isObj(s) || typeof s.level !== "number" || typeof s.label !== "string" || typeof s.meaning !== "string") return null;
    scale.push({ level: s.level, label: s.label, meaning: s.meaning });
  }
  const existing: RatingForm["existing"] = {};
  for (const [k, v] of Object.entries(d.existing)) {
    if (!isObj(v) || !(typeof v.level === "number" || v.level === "na" || v.level === null)) return null;
    existing[k] = { level: v.level, ...(typeof v.note === "string" ? { note: v.note } : {}) };
  }
  return { criteria, scale, existing };
}

/** The criteria (id, name) of the structured report, for the response form's select; malformed entries are skipped. */
function criteriaOf(own: unknown): { id: string; name: string }[] {
  if (!isObj(own) || !Array.isArray(own.criteria)) return [];
  return own.criteria.flatMap((c) => (isObj(c) && typeof c.id === "string" && typeof c.name === "string" ? [{ id: c.id, name: c.name }] : []));
}

function parse(data: unknown): Model {
  if (!isObj(data)) return { kind: "retry" };
  if (data.state === "not_released") return { kind: "not_released" };
  if (data.state === "closed") return { kind: "closed" };
  if (data.state === "old_schema") return { kind: "old_schema" };
  if (data.state === "self_assess") {
    const form = parseForm(data);
    return form === null ? { kind: "retry" } : { kind: "form", form };
  }
  const md = isObj(data.view) && isObj(data.view.markdown) ? data.view.markdown : null;
  if (data.state !== "released" || md === null || typeof md.own !== "string") return { kind: "retry" };
  const structured = isObj(data.view) ? data.view.own : undefined;
  const criteria = criteriaOf(structured);
  return {
    kind: "report",
    rows: comparisonRows(structured),
    criteria,
    responses: parseResponses(isObj(structured) ? structured.responses : undefined, criteria),
    own: md.own,
    group: typeof md.group === "string" ? md.group : null,
    until: typeof data.availableUntil === "string" ? data.availableUntil : null,
  };
}

function formatUntil(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "short" }).format(d);
}

export function ReportView({ fetch: fetchImpl }: ReportViewProps) {
  const [model, setModel] = useState<Model>({ kind: "loading" });
  const heading = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async (alive: () => boolean) => {
    const r = await getJson("/api/v1/report", fetchImpl);
    if (!alive()) return;
    if (r.ok) setModel(parse(r.data));
    else if (r.status === 404) setModel({ kind: "refused" });
    else if (r.status === 429) setModel({ kind: "throttled" });
    else setModel({ kind: "retry" });
  }, [fetchImpl]);

  useEffect(() => {
    let live = true;
    void load(() => live);
    return () => { live = false; };
  }, [load]);

  useEffect(() => { if (model.kind !== "loading") heading.current?.focus(); }, [model.kind]);

  const retry = () => { setModel({ kind: "loading" }); void load(() => true); };
  const note: Record<string, string> = {
    loading: MESSAGES.reportLoading,
    not_released: MESSAGES.reportNotReleased,
    closed: MESSAGES.reportClosed,
    old_schema: MESSAGES.reportOldSchema,
    refused: MESSAGES.reportRefused,
    retry: MESSAGES.reportRetry,
    throttled: MESSAGES.reportThrottled,
  };
  const until = model.kind === "report" && model.until !== null ? formatUntil(model.until) : null;

  return (
    <>
      <div className="tb">
        <h1 ref={heading} tabIndex={-1}>Participant report</h1>
        {until !== null ? <p>{`Available until ${until}`}</p> : null}
      </div>
      <div className="body report">
        {model.kind === "report" ? (
          <>
            <section className="card stack" aria-labelledby="report-own">
              <h2 className="s" id="report-own">Your report</h2>
              <pre className="report-text">{model.own}</pre>
            </section>
            {model.group !== null ? (
              <section className="card stack" aria-labelledby="report-group">
                <h2 className="s" id="report-group">Group report</h2>
                <pre className="report-text">{model.group}</pre>
              </section>
            ) : null}
            <ComparisonTable rows={model.rows} />
            <ResponsesList items={model.responses} />
            <ResponseForm
              criteria={model.criteria}
              used={model.responses.length}
              fetch={fetchImpl}
              onSent={(v) => setModel(parse(v))}
              onRefused={() => setModel({ kind: "refused" })}
            />
            <p className="no-print"><button className="btn" type="button" onClick={() => window.print()}>Print</button></p>
          </>
        ) : model.kind === "form" ? (
          <SelfRatingForm form={model.form} fetch={fetchImpl} onSaved={(v) => setModel(parse(v))} onRefused={() => setModel({ kind: "refused" })} />
        ) : (
          <>
            <p className={model.kind === "loading" ? "muted" : "banner warn"} role="status">{note[model.kind]}</p>
            {model.kind === "retry" || model.kind === "throttled" ? <p><button className="btn pri" type="button" onClick={retry}>Try again</button></p> : null}
          </>
        )}
      </div>
    </>
  );
}
