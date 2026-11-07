// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelfRatingForm } from "../SelfRatingForm";

const KEY = "scenecoach-report-draft";
const FORM = {
  criteria: [{ id: "c1", name: "Listening" }, { id: "c2", name: "Framing" }],
  scale: [
    { level: 1, label: "Emerging", meaning: "Rarely shown" },
    { level: 2, label: "Developing", meaning: "Sometimes shown" },
    { level: 3, label: "Proficient", meaning: "Usually shown" },
    { level: 4, label: "Exemplary", meaning: "Consistently shown" },
  ],
  existing: {} as Record<string, { level: number | "na" | null; note?: string }>,
};
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const okView = { success: true, error: null, data: { state: "self_assess", ...FORM, availableUntil: "2027-01-01T00:00:00.000Z" } };
const failure = (status: number, state?: string, headers?: Record<string, string>) =>
  json(status, { success: false, data: state ? { state } : null, error: { code: "x", message: "ignored server text" } }, headers);

function setup(opts: { fetch?: () => Promise<Response>; form?: typeof FORM; onSaved?: (v: unknown) => void; onRefused?: () => void } = {}) {
  const fetchFn = vi.fn((_u: RequestInfo | URL, _i?: RequestInit) => (opts.fetch ?? (async () => json(200, okView)))());
  const onSaved = opts.onSaved ?? vi.fn();
  const onRefused = opts.onRefused ?? vi.fn();
  render(<SelfRatingForm form={opts.form ?? FORM} fetch={fetchFn as unknown as typeof fetch} onSaved={onSaved} onRefused={onRefused} />);
  return { fetchFn, onSaved: onSaved as ReturnType<typeof vi.fn>, onRefused: onRefused as ReturnType<typeof vi.fn> };
}
const group = (name: string) => screen.getByRole("group", { name });
const pick = (crit: string, label: RegExp | string) => fireEvent.click(within(group(crit)).getByRole("radio", { name: label }));
const save = async () => { await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Save my ratings|Saving/ })); }); };
const stored = () => sessionStorage.getItem(KEY);
const body = (f: ReturnType<typeof vi.fn>) => JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string);

beforeEach(() => sessionStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("SelfRatingForm", () => {
  it("one fieldset and legend per criterion with radios for each scale level and Not observed", () => {
    setup();
    const sets = document.querySelectorAll("fieldset");
    expect(sets).toHaveLength(2);
    for (const name of ["Listening", "Framing"]) {
      const g = group(name);
      expect(g.querySelector("legend")?.textContent).toBe(name);
      expect(within(g).getAllByRole("radio")).toHaveLength(5);
      for (const t of ["Emerging", "Rarely shown", "Exemplary", "Not observed"]) expect(within(g).getByText(new RegExp(t))).toBeTruthy();
    }
  });

  it("the form says the report appears once the facilitator releases it", () => {
    setup();
    expect(screen.getByText(/appears once the facilitator releases it/)).toBeTruthy();
  });

  it("the draft is written only after a field is touched and restored after a reload", () => {
    setup();
    expect(stored()).toBeNull();
    pick("Listening", /Proficient/);
    fireEvent.change(within(group("Listening")).getByRole("textbox"), { target: { value: "my note" } });
    expect(JSON.parse(stored()!).ratings.c1).toEqual({ level: 3, note: "my note" });
    cleanup();
    setup();
    expect((within(group("Listening")).getByRole("radio", { name: /Proficient/ }) as HTMLInputElement).checked).toBe(true);
    expect((within(group("Listening")).getByRole("textbox") as HTMLTextAreaElement).value).toBe("my note");
  });

  it("existing ratings from the server pre-fill when there is no draft", () => {
    setup({ form: { ...FORM, existing: { c1: { level: 2, note: "earlier" }, c2: { level: "na" } } } });
    expect((within(group("Listening")).getByRole("radio", { name: /Developing/ }) as HTMLInputElement).checked).toBe(true);
    expect((within(group("Listening")).getByRole("textbox") as HTMLTextAreaElement).value).toBe("earlier");
    expect((within(group("Framing")).getByRole("radio", { name: /Not observed/ }) as HTMLInputElement).checked).toBe(true);
    expect(stored()).toBeNull(); // pre-fill alone is not a touch
  });

  it("a saved-but-retry answer says to reload, keeps the form mounted and clears the draft", async () => {
    const { onSaved } = setup({ fetch: async () => json(200, { success: true, error: null, data: { saved: true, state: "retry" } }) });
    pick("Listening", /Proficient/);
    expect(stored()).not.toBeNull();
    await save();
    expect(screen.getByRole("status").textContent).toBe("Saved. Reload to see it.");
    expect(onSaved).not.toHaveBeenCalled();
    expect(stored()).toBeNull();
    expect(screen.getByRole("button", { name: "Save my ratings" })).toBeTruthy();
  });

  it("a stored draft wins over the server's ratings", () => {
    sessionStorage.setItem(KEY, JSON.stringify({ ratings: { c1: { level: 4, note: "draft" } } }));
    setup({ form: { ...FORM, existing: { c1: { level: 1, note: "server" } } } });
    expect((within(group("Listening")).getByRole("radio", { name: /Exemplary/ }) as HTMLInputElement).checked).toBe(true);
    expect((within(group("Listening")).getByRole("textbox") as HTMLTextAreaElement).value).toBe("draft");
  });

  it("sends only touched criteria; Not observed is level null", async () => {
    const { fetchFn } = setup();
    pick("Listening", /Not observed/);
    fireEvent.change(within(group("Listening")).getByRole("textbox"), { target: { value: "why" } });
    await save();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("/api/v1/report/self-ratings");
    expect((init as RequestInit).method).toBe("PUT");
    expect(body(fetchFn)).toEqual({ ratings: [{ criterion: "c1", level: null, note: "why" }] });
  });

  it('Save disables the button, sets aria-busy and shows "Saving…"', async () => {
    let release!: (r: Response) => void;
    setup({ fetch: () => new Promise<Response>((r) => { release = r; }) });
    pick("Listening", /Emerging/);
    await save();
    const btn = screen.getByRole("button", { name: /Saving/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("aria-busy")).toBe("true");
    expect(screen.getAllByText("Saving…").length).toBeGreaterThan(0);
    await act(async () => { release(json(200, okView)); });
    await waitFor(() => expect((screen.getByRole("button", { name: "Save my ratings" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("saved shows a status message and clears the draft", async () => {
    const { onSaved } = setup();
    pick("Listening", /Emerging/);
    expect(stored()).not.toBeNull();
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(okView.data));
    expect(screen.getByRole("status").textContent).toMatch(/saved/i);
    expect(stored()).toBeNull();
  });

  it("an edit typed while a save is in flight keeps the draft and is not reported as saved (BUG-0034)", async () => {
    let release!: (r: Response) => void;
    const { fetchFn, onSaved } = setup({ fetch: () => new Promise<Response>((r) => { release = r; }) });
    pick("Listening", /Emerging/);
    await save();
    expect(body(fetchFn)).toEqual({ ratings: [{ criterion: "c1", level: 1 }] });
    // The inputs stay enabled while the save is pending: the participant changes a rating and types a note.
    pick("Listening", /Exemplary/);
    fireEvent.change(within(group("Framing")).getByRole("textbox"), { target: { value: "typed during the save" } });
    await act(async () => { release(json(200, okView)); });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const draft = JSON.parse(stored() ?? "null");
    expect(draft.ratings.c1.level).toBe(4);
    expect(draft.ratings.c2.note).toBe("typed during the save");
    const status = screen.getByRole("status").textContent ?? "";
    expect(status).not.toMatch(/ratings are saved/);
    expect(status).toMatch(/not been sent yet/);
    // The form still shows the newer text, and the next save sends it.
    expect((within(group("Framing")).getByRole("textbox") as HTMLTextAreaElement).value).toBe("typed during the save");
  });

  it("after such a save, pressing Save again sends the newer edit and then clears the draft", async () => {
    let release!: (r: Response) => void;
    let n = 0;
    const { fetchFn } = setup({ fetch: () => (n++ === 0 ? new Promise<Response>((r) => { release = r; }) : Promise.resolve(json(200, okView))) });
    pick("Listening", /Emerging/);
    await save();
    pick("Listening", /Exemplary/);
    await act(async () => { release(json(200, okView)); });
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/not been sent yet/));
    await save();
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/ratings are saved/));
    expect(JSON.parse((fetchFn.mock.calls[1]![1] as RequestInit).body as string)).toEqual({ ratings: [{ criterion: "c1", level: 4 }] });
    expect(stored()).toBeNull();
  });

  it("a note of only spaces on a rated criterion is sent without a note, and a real note is sent trimmed", async () => {
    const { fetchFn } = setup();
    pick("Listening", /Proficient/);
    fireEvent.change(within(group("Listening")).getByRole("textbox"), { target: { value: "   " } });
    pick("Framing", /Emerging/);
    fireEvent.change(within(group("Framing")).getByRole("textbox"), { target: { value: "  padded  " } });
    await save();
    expect(body(fetchFn)).toEqual({ ratings: [{ criterion: "c1", level: 3 }, { criterion: "c2", level: 1, note: "padded" }] });
  });

  it("busy shows \"Busy, try again\" and keeps the draft (Review Focus 5)", async () => {
    const { onSaved } = setup({ fetch: async () => failure(503, "busy", { "Retry-After": "2" }) });
    pick("Listening", /Emerging/);
    await save();
    expect((await screen.findByRole("alert")).textContent).toContain("Busy, try again");
    expect(stored()).not.toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("closed shows the closed message, clears the stored draft and keeps what was typed in the form fields in memory (Review Focus 1)", async () => {
    setup({ fetch: async () => failure(409, "closed") });
    pick("Listening", /Proficient/);
    fireEvent.change(within(group("Listening")).getByRole("textbox"), { target: { value: "typed" } });
    await save();
    expect((await screen.findByRole("alert")).textContent).toContain("Ratings for this review are closed.");
    expect(stored()).toBeNull();
    expect((within(group("Listening")).getByRole("radio", { name: /Proficient/ }) as HTMLInputElement).checked).toBe(true);
    expect((within(group("Listening")).getByRole("textbox") as HTMLTextAreaElement).value).toBe("typed");
    // Further typing does not bring the stored draft back.
    fireEvent.change(within(group("Listening")).getByRole("textbox"), { target: { value: "typed more" } });
    expect(stored()).toBeNull();
  });

  it("a 404 (refused link) clears the stored draft and tells the page", async () => {
    const { onRefused } = setup({ fetch: async () => failure(404) });
    pick("Listening", /Proficient/);
    await save();
    await waitFor(() => expect(onRefused).toHaveBeenCalled());
    expect(stored()).toBeNull();
  });

  it("413 and 429 show their fixed messages (429 branches on status and shows Retry-After)", async () => {
    const { fetchFn } = setup({ fetch: async () => failure(413, "too_large") });
    pick("Listening", /Proficient/);
    await save();
    expect((await screen.findByRole("alert")).textContent).toContain("That is too large to save.");
    cleanup();
    sessionStorage.clear();
    setup({ fetch: async () => failure(429, undefined, { "Retry-After": "42" }) });
    pick("Listening", /Proficient/);
    await save();
    const a = await screen.findByRole("alert");
    expect(a.textContent).toContain("Too many saves");
    expect(a.textContent).toContain("42 seconds");
    expect(stored()).not.toBeNull();
    expect(fetchFn).toHaveBeenCalled();
  });

  it("the error summary takes focus", async () => {
    setup({ fetch: async () => failure(503, "busy") });
    pick("Listening", /Proficient/);
    await save();
    const a = await screen.findByRole("alert");
    await waitFor(() => expect(document.activeElement).toBe(a));
  });

  it("unavailable storage still lets the form work", async () => {
    const boom = () => { throw new Error("blocked"); };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(boom);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(boom);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(boom);
    const { fetchFn, onSaved } = setup();
    pick("Listening", /Proficient/);
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(body(fetchFn).ratings).toHaveLength(1);
  });

  it("the note counter stops at 1,500 characters", () => {
    setup();
    const box = within(group("Listening")).getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "x".repeat(1600) } });
    expect(box.value).toHaveLength(1500);
    expect(within(group("Listening")).getByText("1,500 / 1,500")).toBeTruthy();
  });

  it("evaluator data never appears (the component receives none)", () => {
    const { container } = render(<SelfRatingForm form={FORM} onSaved={() => {}} />);
    expect(container.textContent).not.toMatch(/evaluator|rationale|evidence/i);
  });

  it("participant text is rendered as text, never markup", () => {
    const evil = "<img src=x onerror=alert(1)>";
    sessionStorage.clear();
    const { container } = render(<SelfRatingForm form={{ ...FORM, existing: { c1: { level: 1, note: evil } } }} onSaved={() => {}} />);
    expect(container.querySelector("img")).toBeNull();
    expect((within(group("Listening")).getByRole("textbox") as HTMLTextAreaElement).value).toBe(evil);
  });

  it("a note without a level blocks the save: no request, draft and note kept, summary names the criterion and takes focus", async () => {
    const { fetchFn, onSaved } = setup();
    fireEvent.change(within(group("Framing")).getByRole("textbox"), { target: { value: "only a note" } });
    await save();
    const a = await screen.findByRole("alert");
    expect(a.textContent).toContain("Choose a rating or Not observed for: Framing.");
    await waitFor(() => expect(document.activeElement).toBe(a));
    expect(fetchFn).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(JSON.parse(stored()!).ratings.c2.note).toBe("only a note");
    expect((within(group("Framing")).getByRole("textbox") as HTMLTextAreaElement).value).toBe("only a note");
    pick("Framing", /Developing/);
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(body(fetchFn)).toEqual({ ratings: [{ criterion: "c2", level: 2, note: "only a note" }] });
  });

  it("a whitespace-only note with no level is not blocking and is not sent", async () => {
    const { fetchFn, onSaved } = setup();
    fireEvent.change(within(group("Framing")).getByRole("textbox"), { target: { value: "   " } });
    pick("Listening", /Proficient/);
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(body(fetchFn)).toEqual({ ratings: [{ criterion: "c1", level: 3 }] });
  });

  it("a real note with no level still blocks", async () => {
    const { fetchFn } = setup();
    fireEvent.change(within(group("Framing")).getByRole("textbox"), { target: { value: " real note " } });
    await save();
    expect((await screen.findByRole("alert")).textContent).toContain("Choose a rating or Not observed for: Framing.");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("a partial draft falls back per criterion to the server's rating, and an untouched server rating is not sent", async () => {
    sessionStorage.setItem(KEY, JSON.stringify({ ratings: { c1: { level: 4, note: "from draft" } } }));
    const { fetchFn } = setup({ form: { ...FORM, existing: { c2: { level: 3, note: "from server" } } } });
    expect((within(group("Listening")).getByRole("radio", { name: /Exemplary/ }) as HTMLInputElement).checked).toBe(true);
    expect((within(group("Framing")).getByRole("radio", { name: /Proficient/ }) as HTMLInputElement).checked).toBe(true);
    expect((within(group("Framing")).getByRole("textbox") as HTMLTextAreaElement).value).toBe("from server");
    await save();
    expect(body(fetchFn)).toEqual({ ratings: [{ criterion: "c1", level: 4, note: "from draft" }] });
  });

  it("ids like constructor and __proto__ do not pick up inherited values", () => {
    const form = { criteria: [{ id: "constructor", name: "Ctor" }, { id: "__proto__", name: "Proto" }], scale: FORM.scale, existing: {} };
    setup({ form });
    for (const n of ["Ctor", "Proto"]) {
      expect(within(group(n)).getAllByRole("radio").every((r) => !(r as HTMLInputElement).checked)).toBe(true);
      expect((within(group(n)).getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    }
  });
});
