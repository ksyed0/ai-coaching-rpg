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
import { aiErrorText, parseAiAnswer, readRoster, setAiRoles } from "../../lib/console-ai";
import { confirmCopy } from "../../lib/console-confirm";
import { roleLabel } from "../../lib/names";
import { AiRoleSwitch } from "./AiRoleSwitch";
import { CodesPanel } from "./CodesPanel";
import { ConfirmDialog } from "./ConfirmDialog";

// /console/new: pick a scenario and create a session. Creating can take minutes when the control service has to wait for a runtime,
// so the page says it is working. There is no automatic retry: a second Create is the facilitator's own decision. The codes in the
// answer are shown once, in a CodesPanel, and nowhere else.

export type NewSessionFormProps = { fetch?: typeof fetch };

type Created = { sessionId: string; modelLabel: string | null };
type Ask = { roleId: string; toAi: boolean; opener: HTMLElement; joined: boolean; name?: string };
/** The codes of roles switched back to a human: shown once, in their own panel (they accumulate until copied). */
type Fresh = { seq: number; codes: CodeEntry[] };

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
  // The roles of the created session (kept when the join codes are dismissed) and which of them an AI player holds. A just-created
  // session may have people who joined since: a switch to AI reads the roster once to word the confirmation.
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [aiRoles, setAiRolesState] = useState<string[]>([]);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Fresh | null>(null);
  // Every panel of a switched-to-AI role's remaining codes gets its own number, so the panel is rebuilt without the removed code.
  const [codesSeq, setCodesSeq] = useState(0);
  // True when a role switch could not be confirmed and the roster could not be read: the switches stay off (open the session instead).
  const [stale, setStale] = useState(false);
  const switchBusy = useRef(false);
  const refocus = useRef<string | null>(null);
  const freshSeq = useRef(0);

  // Focus returns to the role's switch after a change (it stays the same element, but a refused or cancelled change is covered too).
  useEffect(() => {
    const roleId = refocus.current;
    if (roleId === null || ask !== null) return;
    const el = document.querySelector<HTMLElement>(`[data-ai-switch="${CSS.escape(roleId)}"]`);
    if (!el || (el as HTMLButtonElement).disabled) return;
    refocus.current = null;
    el.focus();
  });

  /** Applies a whole answer: no AI role keeps a code on screen, and every returned code is shown once. */
  function applyAi(roles: string[], returned: CodeEntry[]) {
    const ai = new Set(roles);
    setAiRolesState(roles);
    setCodes((cur) => {
      const left = cur.filter((c) => !ai.has(c.roleId));
      return left.length === cur.length ? cur : left;
    });
    setCodesSeq((n) => n + 1);
    const incoming = returned.filter((c) => !ai.has(c.roleId));
    setFresh((cur) => {
      const merged = [...(cur?.codes ?? []).filter((c) => !ai.has(c.roleId) && !incoming.some((i) => i.roleId === c.roleId)), ...incoming];
      return merged.length === 0 ? null : { seq: ++freshSeq.current, codes: merged };
    });
  }

  async function askSwitch(roleId: string, toAi: boolean, opener: HTMLElement) {
    if (switchBusy.current || !created) return;
    if (!toAi) {
      setAsk({ roleId, toAi, opener, joined: false });
      return;
    }
    // One read, not a poll. If it fails the safe wording is the stronger one (someone may have joined).
    switchBusy.current = true;
    setSwitching(true);
    const roster = await readRoster(created.sessionId, fetchImpl);
    switchBusy.current = false;
    setSwitching(false);
    const entry = roster?.find((e) => e.roleId === roleId);
    setAsk({
      roleId,
      toAi,
      opener,
      joined: roster === null ? true : entry?.joined === true,
      ...(entry?.name ? { name: entry.name } : {}),
    });
  }

  async function switchRole(a: Ask) {
    if (switchBusy.current || !created) return;
    switchBusy.current = true;
    setSwitching(true);
    setSwitchError(null);
    refocus.current = a.roleId;
    // The WHOLE wanted set: the current AI roles with this one added or taken out.
    const others = aiRoles.filter((r) => r !== a.roleId);
    const wanted = a.toAi ? [...others, a.roleId] : others;
    const r = await setAiRoles(created.sessionId, wanted, fetchImpl);
    switchBusy.current = false;
    setSwitching(false);
    if (!r.ok) {
      setSwitchError(aiErrorText(r));
      if (r.code === "ai_roles_unconfirmed") {
        // The change may have been applied: take the roster as the truth, or switch the switches off.
        const roster = await readRoster(created.sessionId, fetchImpl);
        if (roster === null) setStale(true);
        else applyAi(roster.filter((e) => e.ai === true).map((e) => e.roleId), []);
      }
    } else {
      const answer = parseAiAnswer(r.data);
      applyAi(answer.roles, answer.codes);
    }
    setAsk(null);
  }

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
    const issued = parseCodes(d.codes);
    setCodes(issued);
    setRoleIds(issued.map((c) => c.roleId));
    setAiRolesState([]);
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
        <section className="card stack" aria-labelledby="new-roles-h">
          <h2 className="s" id="new-roles-h">
            Roles
          </h2>
          <ul className="codes">
            {roleIds.map((roleId) => {
              const ai = aiRoles.includes(roleId);
              return (
                <li className="code-row" key={roleId}>
                  <span className="code-role">{roleLabel(roleId)}</span>
                  {ai ? (
                    <>
                      <b>AI player</b> <span className="pill ai">AI</span>
                    </>
                  ) : (
                    <span className="muted">Human</span>
                  )}
                  <AiRoleSwitch
                    roleId={roleId}
                    ai={ai}
                    joined={false}
                    disabled={switching || stale}
                    onAsk={(opener) => void askSwitch(roleId, !ai, opener)}
                  />
                </li>
              );
            })}
          </ul>
          <p className="err" role="alert">
            {switchError}
          </p>
          {stale ? (
            <p className="muted">The roster could not be read. Open the session to see which roles are AI players.</p>
          ) : null}
        </section>
        <CodesPanel key={`codes-${codesSeq}`} codes={codes} onDismiss={() => setCodes([])} />
        {fresh ? (
          <CodesPanel
            key={`fresh-${fresh.seq}`}
            codes={fresh.codes}
            heading={fresh.codes.length === 1 ? `New code for ${roleLabel(fresh.codes[0]!.roleId)}` : "New codes"}
            onDismiss={() => setFresh(null)}
          />
        ) : null}
        {ask ? (
          <SwitchDialog
            ask={ask}
            pending={switching}
            onCancel={() => {
              refocus.current = ask.roleId;
              setAsk(null);
            }}
            onConfirm={() => void switchRole(ask)}
          />
        ) : null}
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

function SwitchDialog(p: { ask: Ask; pending: boolean; onCancel: () => void; onConfirm: () => void }) {
  const role = roleLabel(p.ask.roleId);
  const copy = confirmCopy(
    p.ask.toAi
      ? { kind: "to_ai", role, joined: p.ask.joined, ...(p.ask.name ? { name: p.ask.name } : {}) }
      : { kind: "to_human", role },
  );
  return (
    <ConfirmDialog
      title={copy.title}
      description={copy.description}
      confirmLabel={copy.confirmLabel}
      tone={copy.tone}
      pending={p.pending}
      opener={p.ask.opener}
      onCancel={p.onCancel}
      onConfirm={p.onConfirm}
    />
  );
}
