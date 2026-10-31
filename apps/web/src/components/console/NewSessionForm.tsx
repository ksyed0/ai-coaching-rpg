"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { getJson, postJson } from "../../lib/api";
import {
  failureText,
  parseCodes,
  parseScenarios,
  shortId,
  type CodeEntry,
} from "../../lib/console-api";
import { CodesPanel } from "./CodesPanel";

// /console/new: pick a scenario and create a session. Creating can take minutes when the control service has to wait for a runtime,
// so the page says it is working. There is no automatic retry: a second Create is the facilitator's own decision. The codes in the
// answer are shown once, in a CodesPanel, and nowhere else.

export type NewSessionFormProps = { fetch?: typeof fetch };

type Created = { sessionId: string; modelLabel: string | null };

export function NewSessionForm({ fetch: fetchImpl }: NewSessionFormProps) {
  const [scenarios, setScenarios] = useState<
    { id: string; title: string }[] | null
  >(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scenarioId, setScenarioId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [codes, setCodes] = useState<CodeEntry[]>([]);
  const busy = useRef(false);

  useEffect(() => {
    let alive = true;
    void getJson("/api/v1/console/scenarios", fetchImpl).then((r) => {
      if (!alive) return;
      if (!r.ok) {
        setLoadError(failureText(r));
        return;
      }
      const list = parseScenarios(r.data);
      setScenarios(list);
      setScenarioId((cur) => cur || list[0]?.id || "");
    });
    return () => {
      alive = false;
    };
  }, [fetchImpl]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy.current || scenarioId === "") return;
    busy.current = true;
    setPending(true);
    setError(null);
    const r = await postJson(
      "/api/v1/console/sessions",
      { scenarioId },
      fetchImpl,
    );
    busy.current = false;
    setPending(false);
    if (!r.ok) {
      setError(failureText(r));
      return;
    }
    const d = (
      typeof r.data === "object" && r.data !== null ? r.data : {}
    ) as Record<string, unknown>;
    if (typeof d.sessionId !== "string") {
      setError(
        failureText({ ok: false, status: 500, code: "unknown", message: "" }),
      );
      return;
    }
    setCodes(parseCodes(d.codes));
    setCreated({
      sessionId: d.sessionId,
      modelLabel: typeof d.modelLabel === "string" ? d.modelLabel : null,
    });
  }

  if (created) {
    return (
      <div className="stack">
        <div className="card stack">
          <p role="status">Session {shortId(created.sessionId)} is ready.</p>
          {created.modelLabel ? (
            <p className="muted">Model: {created.modelLabel}</p>
          ) : null}
          <div className="actions">
            <a
              className="btn pri"
              href={`/console/${encodeURIComponent(created.sessionId)}`}
            >
              Open session
            </a>
          </div>
        </div>
        <CodesPanel codes={codes} onDismiss={() => setCodes([])} />
      </div>
    );
  }

  return (
    <form className="card stack" onSubmit={submit} noValidate>
      <div className="field">
        <label className="f" htmlFor="new-scenario">
          Scenario
        </label>
        <select
          className="t"
          id="new-scenario"
          name="scenario"
          value={scenarioId}
          disabled={pending || !scenarios || scenarios.length === 0}
          onChange={(e) => setScenarioId(e.target.value)}
        >
          {(scenarios ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        {scenarios && scenarios.length === 0 ? (
          <p className="muted small">No scenarios are available.</p>
        ) : null}
        {!scenarios && !loadError ? (
          <p className="muted small" role="status">
            Loading scenarios…
          </p>
        ) : null}
      </div>
      <div className="actions">
        <button
          className="btn pri"
          type="submit"
          disabled={pending || scenarioId === ""}
        >
          {pending ? "Creating…" : "Create session"}
        </button>
        <a href="/console">Back to sessions</a>
      </div>
      <p className="muted" role="status">
        {pending ? "Starting the session… this can take a moment." : ""}
      </p>
      <p className="err" role="alert">
        {loadError ?? error}
      </p>
    </form>
  );
}
