// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioPanel } from "../console/AudioPanel";
import type { VoicePanelEntry } from "../console/VoicePanel";
import { fakeFetch, ok, refused } from "../../lib/__tests__/fakes";

const SID = "abcd1234efgh5678";
const BASE = `/api/v1/console/sessions/${SID}/audio`;
const created: string[] = [];
const revoked: string[] = [];
let n = 0;

beforeEach(() => {
  created.length = 0;
  revoked.length = 0;
  n = 0;
  URL.createObjectURL = ((_b: Blob) => { const u = `blob:test/${++n}`; created.push(u); return u; }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((u: string) => { revoked.push(u); }) as typeof URL.revokeObjectURL;
  HTMLMediaElement.prototype.play = vi.fn(async () => undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type Clip = { role: string; segment: string; startMs: number; endMs: number; status: string; audio: string; text?: string };
const clip = (o: Partial<Clip> = {}): Clip => ({ role: "delivery_lead", segment: "s1", startMs: 42_000, endMs: 52_000, status: "transcribed", audio: "available", text: "Move the deadline", ...o });
const list = (clips: Clip[], o: Record<string, unknown> = {}) => ({ recordingStopped: true, clips, textUnavailable: false, tooLongForText: false, ...o });
const TWO = [
  clip(),
  clip({ segment: "s2", startMs: 70_000, endMs: 80_000, status: "empty", text: undefined }),
  clip({ role: "account_manager", segment: "s3", startMs: 55_000, endMs: 65_000, text: "Agreed" }),
];
const ROSTER = [
  { roleId: "delivery_lead", name: "Dana", voice: "voice" as const },
  { roleId: "account_manager", name: "Sam", voice: "voice" as const },
];

type Answer = { status: number; body: unknown };
type Handler = (url: string, body: unknown) => Answer | undefined;
function mount(h: Handler, roster: readonly VoicePanelEntry[] = ROSTER) {
  const f = fakeFetch((url, body) => h(url, body) ?? { status: 404, body: refused("not_found", "x") });
  const r = render(<AudioPanel sessionId={SID} fetch={f.fetch} roster={roster} />);
  return { ...r, f };
}
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
const wav = (): Response => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "audio/wav" } });
const plays = (m: ReturnType<typeof mount>) => m.f.calls.filter((c) => c.url.startsWith(`${BASE}/play`));
const deletes = (m: ReturnType<typeof mount>) => m.f.calls.filter((c) => c.url === `${BASE}/delete`);
const lists = (m: ReturnType<typeof mount>) => m.f.calls.filter((c) => c.url === BASE);

describe("AudioPanel: list", () => {
  it("loads the list on mount and groups clips by seat with the roster name, then times and text", async () => {
    mount((u) => (u === BASE ? { status: 200, body: ok(list(TWO)) } : undefined));
    expect(await screen.findByRole("heading", { level: 2, name: "Recordings" })).toBeTruthy();
    expect(screen.getByText("Each play is logged.")).toBeTruthy();
    const groups = screen.getAllByRole("heading", { level: 3 });
    expect(groups.map((g) => g.textContent)).toEqual(["Dana (Delivery lead)", "Sam (Account manager)"]);
    expect(groups[0]!.querySelector("bdi")?.textContent).toBe("Dana");
    expect(screen.getByText("0:42")).toBeTruthy();
    expect(screen.getByText("1:10")).toBeTruthy();
    expect(screen.getByText("Move the deadline")).toBeTruthy();
    expect(screen.getByText("No transcript")).toBeTruthy();
  });

  it("names a seat by its role label when the roster is empty (after a reload)", async () => {
    mount((u) => (u === BASE ? { status: 200, body: ok(list(TWO)) } : undefined), []);
    await screen.findByRole("heading", { level: 2, name: "Recordings" });
    expect(screen.getAllByRole("heading", { level: 3 }).map((g) => g.textContent)).toEqual(["Delivery lead", "Account manager"]);
  });

  it("a clip whose audio is not available says Audio deleted and has no play button", async () => {
    mount((u) => (u === BASE ? { status: 200, body: ok(list([clip(), clip({ segment: "s2", audio: "deleted", startMs: 90_000, endMs: 95_000 })])) } : undefined));
    await screen.findByText("Audio deleted");
    expect(screen.getAllByRole("button", { name: /^Play /i })).toHaveLength(1);
  });

  it("renders nothing when control has no audio and the roster has no voice seat", async () => {
    const m = mount((u) => (u === BASE ? { status: 200, body: ok(list([])) } : undefined), [{ roleId: "delivery_lead", name: "Dana" }]);
    await waitFor(() => expect(lists(m)).toHaveLength(1));
    await flush();
    expect(m.container.innerHTML).toBe("");
  });

  it("shows No recordings when control has none but the roster has a voice seat", async () => {
    mount((u) => (u === BASE ? { status: 200, body: ok(list([])) } : undefined));
    expect(await screen.findByText("No recordings.")).toBeTruthy();
  });

  it("shows the transcript notices and keeps the clips", async () => {
    mount((u) => (u === BASE ? { status: 200, body: ok(list([clip()], { textUnavailable: true })) } : undefined));
    expect(await screen.findByText("Transcripts are unavailable right now.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Play / })).toBeTruthy();
    cleanup();
    mount((u) => (u === BASE ? { status: 200, body: ok(list([clip()], { tooLongForText: true })) } : undefined));
    expect(await screen.findByText("The transcript is too long to show. The clips are still listed.")).toBeTruthy();
  });

  it("a list failure shows an alert and a retry that reloads", async () => {
    let fail = true;
    const m = mount((u) => (u === BASE ? (fail ? { status: 503, body: refused("unavailable", "x") } : { status: 200, body: ok(list(TWO)) }) : undefined));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Recordings are not available right now. Try again.");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Move the deadline");
    expect(lists(m)).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("account_required shows the sign-in sentence and no list", async () => {
    mount((u) => (u === BASE ? { status: 403, body: refused("account_required", "x") } : undefined));
    expect(await screen.findByText("Sign in with your own account to hear or delete recordings.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Play|Delete/ })).toBeNull();
  });

  it("session_live (409) shows the still-ending sentence with a Retry", async () => {
    let live = true;
    const m = mount((u) => (u === BASE ? (live ? { status: 409, body: refused("session_live", "x") } : { status: 200, body: ok(list(TWO)) }) : undefined));
    expect(await screen.findByText("The session is still ending. Try again in a moment.")).toBeTruthy();
    live = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Move the deadline");
    expect(lists(m)).toHaveLength(2);
  });
});

describe("AudioPanel: play", () => {
  function withPlay(onPlay: (u: string) => Response | Promise<Response>) {
    const f = fakeFetch((u) => (u === BASE ? { status: 200, body: ok(list(TWO)) } : { status: 404, body: refused("not_found", "x") }));
    const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input);
      if (u.startsWith(`${BASE}/play`)) { f.calls.push({ url: u, init: init ?? {}, body: undefined }); return onPlay(u); }
      return f.fetch(input, init);
    }) as typeof fetch;
    render(<AudioPanel sessionId={SID} fetch={wrapped} roster={ROSTER} />);
    return f;
  }
  const pcalls = (f: ReturnType<typeof fakeFetch>) => f.calls.filter((c) => c.url.startsWith(`${BASE}/play`));

  it("fetches the clip into an object URL and plays it in one labelled audio element", async () => {
    const f = withPlay(() => wav());
    const btns = await screen.findAllByRole("button", { name: /^Play / });
    fireEvent.click(btns[0]!);
    await waitFor(() => expect(document.querySelectorAll("audio")).toHaveLength(1));
    const a = document.querySelector("audio")!;
    expect(a.getAttribute("src")).toBe("blob:test/1");
    expect(a.getAttribute("aria-label")).toMatch(/Dana.*0:42/);
    expect(pcalls(f)[0]!.url).toBe(`${BASE}/play?role=delivery_lead&segment=s1`);
    await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
  });

  it("stops the current clip, revokes its URL and keeps one audio element when another is played", async () => {
    withPlay(() => wav());
    const btns = await screen.findAllByRole("button", { name: /^Play / });
    fireEvent.click(btns[0]!);
    await waitFor(() => expect(created).toHaveLength(1));
    fireEvent.click(screen.getAllByRole("button", { name: /^Play / })[1]!);
    await waitFor(() => expect(created).toHaveLength(2));
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(revoked).toEqual(["blob:test/1"]);
    expect(document.querySelectorAll("audio")).toHaveLength(1);
    expect(document.querySelector("audio")!.getAttribute("src")).toBe("blob:test/2");
  });

  it("ignores a second click while a fetch is in flight: one request", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const f = withPlay(async () => { await gate; return wav(); });
    const btns = await screen.findAllByRole("button", { name: /^Play / });
    fireEvent.click(btns[0]!);
    fireEvent.click(btns[0]!);
    fireEvent.click(btns[1]!);
    await flush();
    expect(pcalls(f)).toHaveLength(1);
    release();
    await waitFor(() => expect(created).toHaveLength(1));
    expect(pcalls(f)).toHaveLength(1);
  });

  it("revokes the current URL when the panel unmounts", async () => {
    withPlay(() => wav());
    fireEvent.click((await screen.findAllByRole("button", { name: /^Play / }))[0]!);
    await waitFor(() => expect(created).toHaveLength(1));
    cleanup();
    expect(revoked).toEqual(["blob:test/1"]);
  });

  it("a clip that answers audio_deleted flips to Audio deleted without a reload", async () => {
    const f = withPlay(() => new Response(JSON.stringify(refused("audio_deleted", "x")), { status: 410, headers: { "Content-Type": "application/json" } }));
    const btns = await screen.findAllByRole("button", { name: /^Play / });
    fireEvent.click(btns[0]!);
    await screen.findByText("Audio deleted");
    expect(screen.getAllByRole("button", { name: /^Play / })).toHaveLength(2);
    expect(f.calls.filter((c) => c.url === BASE)).toHaveLength(1);
    expect(document.querySelectorAll("audio")).toHaveLength(0);
  });

  it("another play failure shows an alert with the fixed sentence", async () => {
    withPlay(() => new Response(JSON.stringify(refused("busy", "x")), { status: 503, headers: { "Content-Type": "application/json" } }));
    fireEvent.click((await screen.findAllByRole("button", { name: /^Play / }))[0]!);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The recordings are busy. Try again in a moment.");
  });
});

describe("AudioPanel: delete", () => {
  type St = { clips: Clip[]; list: number };
  function deleteMount(answerDelete: (body: unknown) => Answer, after?: (st: St) => void, roster = ROSTER) {
    const st: St = { clips: TWO.map((c) => ({ ...c })), list: 0 };
    const m = mount((u, body) => {
      if (u === BASE) { st.list++; return { status: 200, body: ok(list(st.clips)) }; }
      if (u === `${BASE}/delete`) { const a = answerDelete(body); after?.(st); return a; }
      return undefined;
    }, roster);
    return { m, st };
  }
  const DONE = (deleted: number) => ({ status: 200, body: ok({ state: "done", deleted, done: 1, pending: [] }) });

  it("a seat button opens an inline confirmation naming count and duration, with reasons defaulting to Facilitator decision", async () => {
    deleteMount(() => DONE(2));
    const b = await screen.findByRole("button", { name: /Delete audio for Dana/ });
    fireEvent.click(b);
    const box = screen.getByRole("group", { name: "Confirm delete" });
    expect(within(box).getByText("This permanently deletes 2 clips from Dana (0 min 20 s). It cannot be undone.")).toBeTruthy();
    expect((within(box).getByRole("radio", { name: "Facilitator decision" }) as HTMLInputElement).checked).toBe(true);
    expect((within(box).getByRole("radio", { name: "Participant asked" }) as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Delete all audio confirms for the session, and Cancel returns focus to the opener without calling", async () => {
    const { m } = deleteMount(() => DONE(3));
    const b = await screen.findByRole("button", { name: "Delete all audio" });
    fireEvent.click(b);
    expect(screen.getByText("This permanently deletes 3 clips (0 min 30 s). It cannot be undone.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Confirm delete" })).toBeNull();
    expect(document.activeElement).toBe(b);
    expect(deletes(m)).toHaveLength(0);
  });

  it("confirming a seat delete sends the role scope and chosen reason, then reloads and says Deleted", async () => {
    const { m, st } = deleteMount(() => DONE(2), (s) => { for (const c of s.clips) if (c.role === "delivery_lead") c.audio = "deleted"; });
    fireEvent.click(await screen.findByRole("button", { name: /Delete audio for Dana/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Participant asked" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete audio" }));
    await waitFor(() => expect(deletes(m)).toHaveLength(1));
    expect(deletes(m)[0]!.body).toEqual({ scope: { kind: "role", role: "delivery_lead" }, reason: "participant_request" });
    await screen.findByText("Deleted 2 clips.");
    expect(st.list).toBe(2);
    expect(screen.getAllByText("Audio deleted")).toHaveLength(2);
  });

  it("the default reason is facilitator and the session scope is sent for Delete all audio", async () => {
    const { m } = deleteMount(() => DONE(3));
    fireEvent.click(await screen.findByRole("button", { name: "Delete all audio" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete audio" }));
    await waitFor(() => expect(deletes(m)).toHaveLength(1));
    expect(deletes(m)[0]!.body).toEqual({ scope: { kind: "session" }, reason: "facilitator" });
  });

  it("focus returns to the seat's button after a delete, or the heading when the group has no button left", async () => {
    deleteMount(() => DONE(1), (s) => { for (const c of s.clips) if (c.role === "account_manager") c.audio = "deleted"; });
    fireEvent.click(await screen.findByRole("button", { name: /Delete audio for Sam/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete audio" }));
    await screen.findByText("Deleted 1 clip.");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "Recordings" })));
    cleanup();
    deleteMount(() => ({ status: 503, body: refused("busy", "x") }));
    const b = await screen.findByRole("button", { name: /Delete audio for Dana/ });
    fireEvent.click(b);
    fireEvent.click(screen.getByRole("button", { name: "Delete audio" }));
    await screen.findByRole("alert");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: /Delete audio for Dana/ })));
  });

  it("pending: reloads, lists what is unfinished in plain words with Retry, and never shows a success state", async () => {
    const { m, st } = deleteMount(
      () => ({ status: 503, body: { success: false, data: { state: "pending", deleted: 1, done: 0, pending: [{ reason: "busy" }, { reason: "store_unsafe" }] }, error: { code: "delete_pending", message: "x" }, meta: { version: "1.0", timestamp: "x" } } }),
      (s) => { s.clips[0]!.audio = "deleted"; },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Delete all audio" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete audio" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Some recordings could not be deleted yet.");
    expect(alert.textContent).toContain("try again");
    expect(alert.textContent).toContain("needs the operator");
    expect(st.list).toBe(2);
    expect(screen.getAllByText("Audio deleted")).toHaveLength(1);
    expect(screen.queryByText(/^Deleted \d/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/Deleted 1 clip/);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(deletes(m)).toHaveLength(2));
    expect(deletes(m)[1]!.body).toEqual(deletes(m)[0]!.body);
  });

  it("pending with an unknown reason string falls back to a generic phrase", async () => {
    deleteMount(() => ({ status: 503, body: { success: false, data: { state: "pending", deleted: 0, done: 0, pending: [{ reason: "weird_new_thing" }] }, error: { code: "delete_pending", message: "x" }, meta: { version: "1.0", timestamp: "x" } } }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete all audio" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete audio" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("try again later");
    expect(alert.textContent).not.toContain("weird_new_thing");
  });

  it("a delete timeout reloads the list and shows the timeout sentence", async () => {
    const { st } = deleteMount(() => ({ status: 504, body: refused("timeout", "x") }), (s) => { s.clips[0]!.audio = "deleted"; });
    fireEvent.click(await screen.findByRole("button", { name: "Delete all audio" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete audio" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("took too long");
    await waitFor(() => expect(st.list).toBe(2));
    await screen.findByText("Audio deleted");
  });

  it("live: shows the still-ending sentence with a Retry button", async () => {
    deleteMount(() => ({ status: 409, body: { success: false, data: { deleted: 0, done: 0, pending: [] }, error: { code: "session_live", message: "x" }, meta: { version: "1.0", timestamp: "x" } } }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete all audio" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete audio" }));
    await waitFor(() => expect(screen.getAllByText("The session is still ending. Try again in a moment.").length).toBeGreaterThan(0));
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("account_required on delete shows the sign-in sentence and no list", async () => {
    deleteMount(() => ({ status: 403, body: refused("account_required", "x") }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete all audio" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete audio" }));
    expect(await screen.findByText("Sign in with your own account to hear or delete recordings.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Play|Delete/ })).toBeNull();
  });

  it("messages use role=status and errors role=alert", async () => {
    deleteMount(() => DONE(3));
    fireEvent.click(await screen.findByRole("button", { name: "Delete all audio" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete audio" }));
    const text = await screen.findByText("Deleted 3 clips.");
    expect(text.closest("[role=status]")).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// A2b-2 Task 7: no axe or a11y lint exists for console components in this repo, so keyboard reachability is asserted here. jsdom has no
// Tab key, so "reachable by Tab" is checked the way the browser decides it: a native control, tabIndex not negative, not disabled, not
// hidden, with an accessible name, and focus() lands on it, in document order.
describe("AudioPanel: keyboard and roles", () => {
  const TABBABLE = "button, input, select, textarea, a[href], audio[controls], [tabindex]";
  const tabbable = (root: ParentNode) => Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter((e) => e.tabIndex >= 0 && !(e as HTMLButtonElement).disabled && !e.hidden);
  const name = (e: HTMLElement) => e.getAttribute("aria-label") ?? ((e as HTMLInputElement).labels?.[0]?.textContent ?? e.textContent)?.trim() ?? "";

  it("every control is a focusable, named native control: Play per clip, Delete per seat, Delete all audio", async () => {
    const m = mount((u) => (u === BASE ? { status: 200, body: ok(list(TWO)) } : undefined));
    await screen.findByRole("heading", { level: 2, name: "Recordings" });
    const stops = tabbable(m.container);
    const buttons = Array.from(m.container.querySelectorAll<HTMLElement>("button"));
    expect(buttons.length).toBeGreaterThanOrEqual(4);
    for (const b of buttons) expect(stops).toContain(b);
    for (const e of stops) {
      expect(name(e)).not.toBe("");
      e.focus();
      expect(document.activeElement).toBe(e);
    }
    expect(m.container.querySelector("[tabindex]:not([tabindex='0']):not([tabindex='-1'])")).toBeNull();
  });

  it("the delete confirmation's radios, Delete audio and Cancel are all tabbable, and the group is named", async () => {
    const m = mount((u) => (u === BASE ? { status: 200, body: ok(list(TWO)) } : undefined));
    fireEvent.click(await screen.findByRole("button", { name: "Delete all audio" }));
    const box = screen.getByRole("group", { name: "Confirm delete" });
    const stops = tabbable(box);
    expect(stops.map(name)).toEqual(expect.arrayContaining(["Facilitator decision", "Participant asked", "Delete audio", "Cancel"].map((n) => expect.stringContaining(n))));
    expect(stops.length).toBeGreaterThanOrEqual(4);
    for (const e of stops) { e.focus(); expect(document.activeElement).toBe(e); }
    expect(m.container.contains(box)).toBe(true);
  });

  it("a list failure is announced by role=alert and its Retry is tabbable; a notice uses role=status", async () => {
    const m = mount(() => ({ status: 502, body: refused("generic", "x") }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toBe("");
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(tabbable(m.container)).toContain(retry);
    cleanup();
    mount((u) => (u === BASE ? { status: 200, body: ok(list([], { })) } : undefined));
    expect(await screen.findByRole("status")).toBeTruthy();
  });
});
