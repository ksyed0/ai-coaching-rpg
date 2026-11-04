// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AiPlayersPanel } from "../console/AiPlayersPanel";
import { fakeFetch, ok, refused } from "../../lib/__tests__/fakes";

afterEach(cleanup);

const CH = "11111111-2222-3333-4444-555555555555";
type Answer = { status: number; body: unknown };

function mount(over: Partial<React.ComponentProps<typeof AiPlayersPanel>> = {}, routes: Record<string, Answer> = {}) {
  const f = fakeFetch((url) => {
    const tail = url.split("/ai-roles/")[1] ?? "";
    return routes[tail] ?? { status: 200, body: ok({ done: true }) };
  });
  const r = render(<AiPlayersPanel sessionId="s1" channel={CH} aiRoles={["tech_lead"]} running fetch={f.fetch} {...over} />);
  return { f, ...r };
}
const hintBox = () => screen.getByLabelText("Hint for the AI player for Tech lead (optional, only you see it)") as HTMLInputElement;
const promptBtn = () => screen.getByRole("button", { name: "Prompt the AI player for Tech lead" }) as HTMLButtonElement;
const posts = (f: ReturnType<typeof fakeFetch>, tail: string) => f.calls.filter((c) => c.url.endsWith(tail));
const send = async () => {
  await act(async () => {
    fireEvent.click(promptBtn());
  });
};

describe("AiPlayersPanel", () => {
  it("the panel lists tech_lead with the AI pill and a disabled Prompt button before the start", () => {
    mount({ running: false });
    expect(screen.getByRole("heading", { name: "AI players" }).className).toBe("s");
    const row = screen.getByText("Tech lead").closest("li")!;
    expect(within(row).getByText("AI")).toBeTruthy();
    expect(promptBtn().textContent).toBe("Prompt AI player");
    expect(promptBtn().disabled).toBe(true);
  });

  it("Prompt is disabled while the channel is null", () => {
    mount({ channel: null });
    expect(promptBtn().disabled).toBe(true);
  });

  it("no panel when aiRoles is empty", () => {
    mount({ aiRoles: [] });
    expect(screen.queryByRole("heading", { name: "AI players" })).toBeNull();
  });

  it("Prompt posts {channel, hint} to .../ai-roles/tech_lead/prompt and announces \"Prompt sent. The AI player will answer shortly.\"", async () => {
    const m = mount();
    fireEvent.change(hintBox(), { target: { value: "push back" } });
    expect(screen.getByText("9 of 300")).toBeTruthy();
    await send();
    expect(posts(m.f, "/ai-roles/tech_lead/prompt")).toHaveLength(1);
    const p = posts(m.f, "/ai-roles/tech_lead/prompt")[0]!;
    expect(p.url).toBe("/api/v1/console/sessions/s1/ai-roles/tech_lead/prompt");
    expect(p.body).toEqual({ channel: CH, hint: "push back" });
    expect(p.init.headers).toMatchObject({ "X-Requested-With": "scenecoach" });
    const status = await screen.findByText("Prompt sent. The AI player will answer shortly.");
    expect(status.closest("[aria-live='polite']")).toBeTruthy();
    expect(hintBox().value).toBe("");
    expect(document.activeElement).toBe(promptBtn());
  });

  it("an empty hint is not sent at all", async () => {
    const m = mount();
    await send();
    expect(posts(m.f, "/prompt")[0]!.body).toEqual({ channel: CH });
  });

  it("a 301-code-point hint is refused in the page without a request; 300 code points (emoji count once) go", async () => {
    const m = mount();
    fireEvent.change(hintBox(), { target: { value: "\u{1F600}".repeat(301) } });
    expect(screen.getByText("301 of 300")).toBeTruthy();
    await send();
    expect(screen.getByRole("alert").textContent).toBe("The hint is too long: at most 300 characters.");
    expect(m.f.calls).toHaveLength(0);
    fireEvent.change(hintBox(), { target: { value: "\u{1F600}".repeat(300) } });
    await send();
    expect(posts(m.f, "/prompt")).toHaveLength(1);
  });

  it("an ai_busy answer shows its copy, keeps the hint and keeps focus on the button", async () => {
    mount({}, { "tech_lead/prompt": { status: 409, body: refused("ai_busy", "The AI player is already answering. Wait a moment, then try again.") } });
    fireEvent.change(hintBox(), { target: { value: "keep" } });
    await send();
    await screen.findByText("The AI player is already answering. Wait a moment, then try again.");
    expect(hintBox().value).toBe("keep");
    expect(screen.queryByText("Prompt sent. The AI player will answer shortly.")).toBeNull();
    expect(document.activeElement).toBe(promptBtn());
  });

  it("without a message the client's own copy is used; an unknown code gets the generic text, never the server's words", async () => {
    mount({}, { "tech_lead/prompt": { status: 502, body: refused("ai_run_failed", "") } });
    await send();
    await screen.findByText("The prompt was recorded, but the AI player could not start. Try again.");
    cleanup();
    mount({}, { "tech_lead/prompt": { status: 409, body: refused("weird_code", "secret internals") } });
    await send();
    await screen.findByRole("alert");
    expect(document.body.textContent).not.toContain("secret internals");
  });

  it("is disabled while the request is in flight and posts once", async () => {
    const m = mount();
    m.f.hold();
    await send();
    expect(promptBtn().disabled).toBe(true);
    fireEvent.click(promptBtn());
    await act(async () => {
      m.f.release();
    });
    expect(posts(m.f, "/prompt")).toHaveLength(1);
    expect(promptBtn().disabled).toBe(false);
    expect(document.activeElement).toBe(promptBtn());
  });

  it("Show recent turns lists \"prompt\", \"spoke\" and \"Hint: push back\" and a skipped/timeout entry as \"skipped: the model took too long\"", async () => {
    const m = mount({}, {
      "tech_lead/intents": {
        status: 200,
        body: ok({
          entries: [
            { ts: 1_700_000_000_000, sceneId: "s1", trigger: "prompt", outcome: "spoken", hint: "push back" },
            { ts: 1_700_000_060_000, sceneId: "s1", trigger: "nudge", outcome: "skipped", reason: "timeout" },
            { ts: 1_700_000_120_000, sceneId: null, trigger: "reply", outcome: "dropped" },
            { ts: 1_700_000_180_000, sceneId: null, trigger: "reply", outcome: "skipped", reason: "model_failed" },
            { ts: 1_700_000_240_000, sceneId: null, trigger: "reply", outcome: "skipped", reason: "unusable" },
            { ts: 1_700_000_300_000, sceneId: null, trigger: "reply", outcome: "skipped", reason: "budget" },
          ],
        }),
      },
    });
    const toggle = screen.getByRole("button", { name: "Show recent turns for Tech lead" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(posts(m.f, "/intents")).toHaveLength(1);
    expect(posts(m.f, "/intents")[0]!.body).toEqual({});
    await screen.findByText("Hint: push back");
    expect(screen.getByText("prompt")).toBeTruthy();
    expect(screen.getByText("spoke")).toBeTruthy();
    expect(screen.getByText("quiet-time nudge")).toBeTruthy();
    expect(screen.getByText("skipped: the model took too long")).toBeTruthy();
    expect(screen.getByText("dropped: the moment had passed")).toBeTruthy();
    expect(screen.getByText("skipped: the model did not answer")).toBeTruthy();
    expect(screen.getByText("skipped: the reply was empty or unusable")).toBeTruthy();
    expect(screen.getByText("skipped: the model budget is used up")).toBeTruthy();
    expect(screen.getAllByText("reply").length).toBe(4);
    // Closing it again does not post; no polling.
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(posts(m.f, "/intents")).toHaveLength(1);
  });

  it("a recent-turns failure shows the failure and an empty log says so", async () => {
    mount({}, { "tech_lead/intents": { status: 200, body: ok({ entries: [] }) } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show recent turns for Tech lead" }));
    });
    await screen.findByText("No turns yet.");
  });

  it("a hint with \"<b>x</b>\" renders as text", async () => {
    mount({}, { "tech_lead/intents": { status: 200, body: ok({ entries: [{ ts: 1, sceneId: null, trigger: "prompt", outcome: "spoken", hint: "<b>x</b>" }] }) } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show recent turns for Tech lead" }));
    });
    await screen.findByText("Hint: <b>x</b>");
    expect(screen.queryByText("x")).toBeNull();
  });

  it("isolates a hint with a bidi control", async () => {
    mount({}, { "tech_lead/intents": { status: 200, body: ok({ entries: [{ ts: 1, sceneId: null, trigger: "prompt", outcome: "spoken", hint: "a‮b" }] }) } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show recent turns for Tech lead" }));
    });
    await waitFor(() => expect(document.body.textContent).toContain("Hint: ⁨a‮b⁩"));
  });

  it("each AI role has its own labelled controls", () => {
    mount({ aiRoles: ["tech_lead", "cfo"] });
    expect(screen.getByRole("button", { name: "Prompt the AI player for Cfo" })).toBeTruthy();
    expect(screen.getByLabelText("Hint for the AI player for Cfo (optional, only you see it)")).toBeTruthy();
  });
});
