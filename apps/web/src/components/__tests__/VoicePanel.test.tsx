// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialState, type SessionState } from "@acr/events";
import { parseReadiness } from "../../lib/console-api";
import { CONSOLE_VOICE } from "../../lib/console-voice";
import { viewFromReset } from "../../lib/console-view";
import { useConsoleStream, type ConsoleStreamUi, type FacilitatorRosterEntry } from "../../lib/use-console-stream";
import { FakeClock, FakeEventSource, fakeFetch, fakeTimer, ok, readiness } from "../../lib/__tests__/fakes";
import { LiveView } from "../console/LiveView";
import { Readiness } from "../console/Readiness";
import { SpeakingIndicator } from "../console/SpeakingIndicator";
import { VoicePanel } from "../console/VoicePanel";

// US-0071 (A1b Task 16): the facilitator sees each human seat's voice state and who is speaking, in words with an aria-hidden icon;
// speaking changes several times a second, so it is visual and text only, never inside a live region. A text-only session (no entry
// carries `voice`) renders exactly as before.

afterEach(cleanup);
beforeEach(() => FakeEventSource.reset());

const T = 1_000_000;
const base = { joined: true, consented: true, connected: true };
const VOICE_ROSTER: FacilitatorRosterEntry[] = [
  { roleId: "account_manager", name: "Sam", ...base, voice: "voice", speaking: true },
  { roleId: "delivery_lead", name: "Jo", ...base, voice: "text_only" },
  { roleId: "client_sponsor", name: "Ana", ...base, voice: "none" },
  { roleId: "tech_lead", name: "Kim", ...base, voice: "off" },
];
const TEXT_ROSTER: FacilitatorRosterEntry[] = [
  { roleId: "account_manager", name: "Sam", ...base },
  { roleId: "delivery_lead", name: "Jo", ...base },
];

function ui(roster: FacilitatorRosterEntry[]): ConsoleStreamUi {
  const st: SessionState = { ...initialState(), status: "running", lastSeq: 1, roles: { account_manager: { kind: "player" } } };
  return { conn: "live", final: null, channel: "c1", scenes: [], characters: [], view: viewFromReset(st), notice: null, roster };
}

/** Every ancestor of `el` (itself included) that would announce a change: aria-live, or a status/alert/log role. */
const liveAncestors = (el: Element | null): Element[] => {
  const out: Element[] = [];
  for (let n = el; n; n = n.parentElement)
    if (n.hasAttribute("aria-live") || ["status", "alert", "log", "marquee", "timer"].includes(n.getAttribute("role") ?? "")) out.push(n);
  return out;
};

describe("VoicePanel", () => {
  it("the panel is absent in a text-only session", () => {
    const { container } = render(<LiveView ui={ui(TEXT_ROSTER)} clock={new FakeClock(T)} />);
    expect(screen.queryByRole("region", { name: CONSOLE_VOICE.heading })).toBeNull();
    expect(container.textContent).not.toMatch(/Speaking|Quiet|Voice on|Text only/);
    const alone = render(<VoicePanel roster={TEXT_ROSTER} />);
    expect(alone.container.innerHTML).toBe("");
  });

  it("lists every human seat with its voice state in words", () => {
    render(<VoicePanel roster={VOICE_ROSTER} />);
    const panel = screen.getByRole("region", { name: CONSOLE_VOICE.heading });
    const rows = within(panel).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    const cells = rows.map((r) => within(r).getAllByRole("cell").map((c) => c.textContent?.trim()));
    expect(cells[0]![0]).toContain("Voice on");
    expect(cells[1]![0]).toContain("Text only");
    expect(cells[2]![0]).toContain("Not chosen");
    expect(cells[3]![0]).toContain("Voice off");
    // The name sits in a bdi with the role label (untrusted text).
    expect(within(rows[0]!).getByRole("rowheader").textContent).toContain("Sam");
    expect(within(rows[0]!).getByRole("rowheader").querySelector("bdi")?.textContent).toBe("Sam");
  });

  it("speaking shows the word Speaking and an aria-hidden icon; a quiet voice seat shows Quiet", () => {
    render(<VoicePanel roster={VOICE_ROSTER} />);
    const panel = screen.getByRole("region", { name: CONSOLE_VOICE.heading });
    const [sam, jo] = within(panel).getAllByRole("row").slice(1);
    const speaking = within(sam!).getByText("Speaking");
    const icon = speaking.closest(".pill")!.querySelector("[aria-hidden='true']");
    expect(icon).not.toBeNull();
    expect(icon!.textContent!.trim()).not.toBe("");
    // A text-only seat never speaks by voice: no Speaking and no Quiet word for it.
    expect(within(jo!).queryByText("Speaking")).toBeNull();
    expect(within(jo!).queryByText("Quiet")).toBeNull();
    cleanup();
    render(<SpeakingIndicator speaking={false} />);
    expect(screen.getByText("Quiet")).toBeTruthy();
  });

  it("an AI seat is not listed", () => {
    render(<VoicePanel roster={[...VOICE_ROSTER, { roleId: "ai_seat", name: "Bot", ...base, ai: true, voice: "voice", speaking: true }]} />);
    const panel = screen.getByRole("region", { name: CONSOLE_VOICE.heading });
    expect(within(panel).getAllByRole("row").slice(1)).toHaveLength(4);
    expect(panel.textContent).not.toContain("Bot");
  });

  it("the speaking state is not in a live region", () => {
    const { container } = render(<LiveView ui={ui(VOICE_ROSTER)} clock={new FakeClock(T)} />);
    const panel = screen.getByRole("region", { name: CONSOLE_VOICE.heading });
    expect(liveAncestors(panel)).toEqual([]);
    expect(panel.querySelector("[aria-live], [role=status], [role=alert], [role=log]")).toBeNull();
    expect(liveAncestors(within(panel).getByText("Speaking", { selector: ".pill" }))).toEqual([]);
    expect(container.querySelectorAll(".voicepanel")).toHaveLength(1);
  });

  it("a newer roster frame replaces the voice words: nothing stale stays on screen", () => {
    const r = render(<LiveView ui={ui(VOICE_ROSTER)} clock={new FakeClock(T)} />);
    expect(screen.getByText("Speaking", { selector: ".pill" })).toBeTruthy();
    r.rerender(<LiveView ui={ui([{ roleId: "account_manager", name: "Sam", ...base, voice: "text_only" }, ...VOICE_ROSTER.slice(1)])} clock={new FakeClock(T)} />);
    const panel = screen.getByRole("region", { name: CONSOLE_VOICE.heading });
    expect(within(panel).queryByText("Speaking", { selector: ".pill" })).toBeNull();
    expect(within(within(panel).getAllByRole("row")[1]!).getAllByRole("cell")[0]!.textContent).toContain("Text only");
    r.rerender(<LiveView ui={ui(TEXT_ROSTER)} clock={new FakeClock(T)} />);
    expect(screen.queryByRole("region", { name: CONSOLE_VOICE.heading })).toBeNull();
  });
});

describe("Readiness voice column", () => {
  const SID = "abcd1234efgh5678";
  function mount(roster: unknown[]) {
    const f = fakeFetch(() => ({ status: 200, body: ok(readiness({ roster })) }));
    const t = fakeTimer();
    return render(<Readiness sessionId={SID} fetch={f.fetch} setTimer={t.setTimer} />);
  }
  const heads = () => screen.getAllByRole("columnheader").map((h) => h.textContent);

  it("Readiness shows the voice column only with voice entries", async () => {
    mount(VOICE_ROSTER);
    await screen.findByText(/Model:/);
    expect(heads()).toEqual(["Role", "Name", "Joined", "Consented", "Voice", "Connected", "Code"]);
    const rows = screen.getAllByRole("row").slice(1);
    const voiceCell = (i: number) => within(rows[i]!).getAllByRole("cell")[3]!.textContent;
    expect(voiceCell(0)).toContain("Voice on");
    expect(voiceCell(1)).toContain("Text only");
    expect(voiceCell(2)).toContain("Not chosen");
    expect(voiceCell(3)).toContain("Voice off");
  });

  it("a text-only roster keeps exactly the old columns", async () => {
    mount(TEXT_ROSTER);
    await screen.findByText(/Model:/);
    expect(heads()).toEqual(["Role", "Name", "Joined", "Consented", "Connected", "Code"]);
    expect(document.body.textContent).not.toMatch(/Voice on|Text only|Not chosen/);
  });

  it("an AI seat in a voice roster shows Not needed in the voice column", async () => {
    mount([...VOICE_ROSTER, { roleId: "ai_seat", ...base, ai: true }]);
    await screen.findByText(/Model:/);
    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[4]!).getAllByRole("cell")[3]!.textContent).toBe("Not needed");
  });
});

describe("client roster parsers keep voice and speaking", () => {
  it("parseReadiness keeps voice and speaking and drops voice: loud and speaking: 1", () => {
    const r = parseReadiness(readiness({
      roster: [
        { roleId: "a", ...base, voice: "voice", speaking: true },
        { roleId: "b", ...base, voice: "loud", speaking: 1 },
        { roleId: "c", ...base },
      ],
    }));
    expect(r?.roster).toEqual([
      { roleId: "a", ...base, voice: "voice", speaking: true },
      { roleId: "b", ...base },
      { roleId: "c", ...base },
    ]);
  });

  it("the console stream keeps voice and speaking, drops other values and unknown keys", () => {
    const f = fakeFetch();
    const hook = renderHook(() => useConsoleStream("s1", { EventSource: FakeEventSource, fetch: f.fetch }));
    const es = FakeEventSource.last();
    act(() => es.emit("joined", { channel: "c1", scenes: [] }));
    act(() => es.emit("roster", { entries: [
      { roleId: "a", ...base, voice: "voice", speaking: true, extra: "x" },
      { roleId: "b", ...base, voice: "loud", speaking: "yes" },
      { roleId: "c", name: "Ana", ...base, ai: true },
    ] }));
    expect(hook.result.current.roster).toEqual([
      { roleId: "a", ...base, voice: "voice", speaking: true },
      { roleId: "b", ...base },
      { roleId: "c", name: "Ana", ...base, ai: true },
    ]);
  });
});
