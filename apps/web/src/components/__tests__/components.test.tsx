// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppHeader } from "../AppHeader";
import { BriefPanel } from "../BriefPanel";
import { ConsentPanel } from "../ConsentPanel";
import { JoinForm } from "../JoinForm";
import { Roster } from "../Roster";
import { SayBox } from "../SayBox";
import { SceneStatus } from "../SceneStatus";
import { StatusChip } from "../StatusChip";
import { TitleBlock } from "../TitleBlock";
import { Transcript } from "../Transcript";
import { MESSAGES } from "../../lib/messages";
import { FakeClock, fakeFetch, ok, refused } from "../../lib/__tests__/fakes";

afterEach(cleanup);

const XSS = `<img src=x onerror="alert(1)"><script>alert(2)</script>`;
const noInlineStyles = (c: HTMLElement) => expect(c.querySelectorAll("[style]")).toHaveLength(0);

describe("text from the runtime is rendered as text", () => {
  it("a transcript line containing HTML renders as text", () => {
    const { container } = render(<Transcript lines={[{ seq: 1, ts: 1, roleId: "priya", text: XSS, sceneId: "s1" }]} selfRole="am" names={{}} playerRoles={new Set(["am"])} />);
    expect(screen.getByText(XSS)).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    noInlineStyles(container);
  });

  it("a display name with markup renders as text in the roster", () => {
    const { container } = render(<Roster entries={[{ roleId: "am", name: XSS, ready: true }, { roleId: "dl", ready: false }]} selfRole="am" />);
    expect(screen.getByText(XSS)).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    noInlineStyles(container);
  });

  it("a display name with markup renders as text in the transcript speaker", () => {
    const { container } = render(<Transcript lines={[{ seq: 1, ts: 1, roleId: "dl", text: "hi", sceneId: null }]} selfRole="am" names={{ dl: XSS }} playerRoles={new Set(["am", "dl"])} />);
    expect(screen.getByText(XSS)).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });

  it("brief, facts, updates and the consent notice render as text", () => {
    const { container } = render(
      <>
        <BriefPanel roleId="am" brief={XSS} privateFacts={[XSS]} injects={[{ seq: 1, content: XSS, sceneId: "s1" }]} />
        <ConsentPanel noticeVersion="v1" notice={XSS} given={false} onConsent={async () => ({ ok: true })} onWithdraw={async () => ({ ok: true })} />
      </>,
    );
    expect(screen.getAllByText(XSS)).toHaveLength(4);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    noInlineStyles(container);
  });
});

describe("Transcript", () => {
  it("names the speaker: you, a peer's display name, or the role; marks AI characters", () => {
    render(
      <Transcript
        lines={[
          { seq: 1, ts: 1, roleId: "am", text: "mine", sceneId: null },
          { seq: 2, ts: 2, roleId: "dl", text: "peer", sceneId: null },
          { seq: 3, ts: 3, roleId: "client_sponsor", text: "npc", sceneId: null },
        ]}
        selfRole="am" names={{ dl: "Jo" }} playerRoles={new Set(["am", "dl"])}
      />,
    );
    const items = screen.getAllByRole("listitem");
    expect(items[0]!.textContent).toContain("You");
    expect(items[1]!.textContent).toContain("Jo");
    expect(within(items[2]!).getByText("AI")).toBeTruthy();
    expect(items[2]!.textContent).toContain("Client sponsor");
  });
  it("says so when nothing has been said yet", () => {
    render(<Transcript lines={[]} selfRole="am" names={{}} playerRoles={new Set()} />);
    expect(screen.getByText(/Nothing has been said yet/)).toBeTruthy();
  });
});

describe("Roster", () => {
  it("shows each seat's name or role, marks you, and states readiness in words", () => {
    render(<Roster entries={[{ roleId: "am", name: "Sam", ready: true }, { roleId: "dl", name: "Jo", ready: false }, { roleId: "tech_lead", ready: false }]} selfRole="am" />);
    const items = screen.getAllByRole("listitem");
    expect(items[0]!.textContent).toContain("Sam");
    expect(items[0]!.textContent).toContain("(you)");
    expect(items[0]!.textContent).toContain("Ready");
    expect(items[1]!.textContent).toContain("Joined");
    expect(items[2]!.textContent).toContain("Tech lead");
    expect(items[2]!.textContent).toContain("Not joined");
  });
  it("an empty roster says it is loading", () => {
    render(<Roster entries={[]} selfRole="am" />);
    expect(screen.getByText(/No one is listed yet/)).toBeTruthy();
  });
});

describe("SayBox", () => {
  it("the say box is disabled while paused and after the end", () => {
    const onSay = vi.fn(async () => ({ ok: true as const }));
    const { rerender } = render(<SayBox disabledReason={null} onSay={onSay} />);
    const box = () => screen.getByLabelText("Say something") as HTMLInputElement;
    const button = () => screen.getByRole("button", { name: "Say" }) as HTMLButtonElement;
    expect(box().disabled).toBe(false);
    fireEvent.change(box(), { target: { value: "typed before the pause" } });
    rerender(<SayBox disabledReason={MESSAGES.paused} onSay={onSay} />);
    expect(box().disabled).toBe(true);
    expect(button().disabled).toBe(true);
    expect(screen.getByText(MESSAGES.paused)).toBeTruthy();
    rerender(<SayBox disabledReason={MESSAGES.sessionEnded} onSay={onSay} />);
    expect(box().disabled).toBe(true);
    expect(button().disabled).toBe(true);
    // A submit that slips through (Enter in a stale form) sends nothing.
    fireEvent.submit(box().form!);
    expect(onSay).not.toHaveBeenCalled();
  });

  it("sends the trimmed line once, clears the box on success and keeps it with the message on a refusal", async () => {
    let answer: { ok: true } | { ok: false; message: string } = { ok: false, message: "The scene has changed." };
    let release!: () => void;
    const onSay = vi.fn(() => new Promise<typeof answer>((r) => { release = () => r(answer); }));
    render(<SayBox disabledReason={null} onSay={onSay} />);
    const box = screen.getByLabelText("Say something") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "  hello  " } });
    fireEvent.submit(box.form!);
    fireEvent.submit(box.form!);
    expect(onSay).toHaveBeenCalledTimes(1);
    expect(onSay).toHaveBeenCalledWith("hello");
    expect(box.disabled).toBe(true);
    await act(async () => release());
    expect(box.value).toBe("  hello  ");
    expect(screen.getByRole("alert").textContent).toBe("The scene has changed.");
    answer = { ok: true };
    fireEvent.submit(box.form!);
    await act(async () => release());
    expect(box.value).toBe("");
    // Blank lines are not sent.
    fireEvent.change(box, { target: { value: "   " } });
    fireEvent.submit(box.form!);
    expect(onSay).toHaveBeenCalledTimes(2);
  });
});

describe("SceneStatus", () => {
  const scene = { id: "s2", title: "Client call", goal: "Agree the plan.", timeBoxMinutes: 10 };
  const T = 7_000_000;

  it("the timer shows the remaining time from enteredAt, pausedMs, pausedSince and timeBoxMinutes using an injected clock and freezes while paused", () => {
    const clock = new FakeClock(T + 2 * 60_000);
    const view = { paused: false, pausedSince: null, scene: { id: "s2", enteredAt: T, pausedMs: 60_000 } };
    const { rerender, unmount } = render(<SceneStatus scene={scene} index={1} count={3} view={view} clock={clock} />);
    const timer = () => screen.getByRole("timer").textContent;
    expect(timer()).toBe("09:00"); // 10 min box, 2 min since entry, 1 min of it paused
    act(() => clock.tick(18_000));
    expect(timer()).toBe("08:42");
    // Paused 30 s ago: the timer shows the time at the pause start and does not move.
    const paused = { paused: true, pausedSince: clock.t - 30_000, scene: view.scene };
    rerender(<SceneStatus scene={scene} index={1} count={3} view={paused} clock={clock} />);
    expect(timer()).toBe("09:12");
    act(() => clock.tick(5 * 60_000));
    expect(timer()).toBe("09:12");
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.getByText(/Scene 2 of 3: Client call/)).toBeTruthy();
    expect(screen.getByText(/Agree the plan\./)).toBeTruthy();
    expect(clock.listeners).toBe(1);
    unmount();
    expect(clock.listeners).toBe(0);
  });

  it("without a scene it shows no timer", () => {
    render(<SceneStatus scene={undefined} index={-1} count={0} view={{ paused: false, pausedSince: null, scene: null }} clock={new FakeClock(0)} />);
    expect(screen.queryByRole("timer")).toBeNull();
    expect(screen.getByText(/Between scenes/)).toBeTruthy();
  });
});

describe("JoinForm", () => {
  function fill() {
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Sam" } });
    fireEvent.change(screen.getByLabelText("Your join code"), { target: { value: "K7QM-4TXP" } });
  }

  it("a double-click on Join sends one request (disabled while pending)", async () => {
    const f = fakeFetch(() => ({ status: 200, body: ok({ sessionId: "sess-1", roleId: "am" }) }));
    f.hold();
    const navigate = vi.fn();
    const { container } = render(<JoinForm sessionId="sess-1" roleId="am" fetch={f.fetch} navigate={navigate} />);
    fill();
    const button = screen.getByRole("button", { name: "Join" }) as HTMLButtonElement;
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.submit(button.form!);
    expect(f.calls).toHaveLength(1);
    expect(button.disabled).toBe(true);
    await act(async () => f.release());
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("/api/v1/join");
    expect(f.calls[0]!.body).toEqual({ sessionId: "sess-1", role: "am", joinCode: "K7QM-4TXP", displayName: "Sam" });
    expect(new Headers(f.calls[0]!.init.headers).get("X-Requested-With")).toBe("scenecoach");
    expect(navigate).toHaveBeenCalledWith("/session/sess-1");
    noInlineStyles(container);
  });

  it("every join refusal shows the same neutral message; a bad name and a busy server have their own", async () => {
    let answer = { status: 401, body: refused("join_refused", "server text") };
    const f = fakeFetch(() => answer);
    const navigate = vi.fn();
    render(<JoinForm sessionId="sess-1" roleId="am" fetch={f.fetch} navigate={navigate} />);
    fill();
    const submit = async () => { await act(async () => { fireEvent.submit(screen.getByRole("button", { name: "Join" }).closest("form")!); }); };
    await submit();
    expect(screen.getByRole("alert").textContent).toBe(MESSAGES.joinRefused);
    answer = { status: 400, body: refused("bad_name", "x") };
    await submit();
    expect(screen.getByRole("alert").textContent).toBe(MESSAGES.badName);
    answer = { status: 503, body: refused("busy", "x") };
    await submit();
    expect(screen.getByRole("alert").textContent).toBe(MESSAGES.unavailable);
    answer = { status: 403, body: refused("forbidden", "x") };
    await submit();
    expect(screen.getByRole("alert").textContent).toBe(MESSAGES.generic);
    expect(navigate).not.toHaveBeenCalled();
    // The button is usable again after a refusal.
    expect((screen.getByRole("button", { name: "Join" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("labels its controls and shows the role it joins as", () => {
    render(<JoinForm sessionId="sess-1" roleId="account_manager" fetch={fakeFetch().fetch} navigate={vi.fn()} />);
    expect((screen.getByLabelText("Your name") as HTMLInputElement).maxLength).toBe(60);
    expect((screen.getByLabelText("Your join code") as HTMLInputElement).autocomplete).toBe("off");
    expect(screen.getByText("Account manager")).toBeTruthy();
  });

  it("an empty name or code is not sent", async () => {
    const f = fakeFetch();
    render(<JoinForm sessionId="sess-1" roleId="am" fetch={f.fetch} navigate={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "   " } });
    fireEvent.change(screen.getByLabelText("Your join code"), { target: { value: "C" } });
    await act(async () => { fireEvent.submit(screen.getByRole("button", { name: "Join" }).closest("form")!); });
    expect(f.calls).toHaveLength(0);
    expect(screen.getByRole("alert").textContent).toBe(MESSAGES.badName);
  });
});

describe("ConsentPanel", () => {
  it("agrees only once the box is ticked, then offers withdrawal", async () => {
    const onConsent = vi.fn(async () => ({ ok: true as const }));
    const onWithdraw = vi.fn(async () => ({ ok: false as const, message: "The session has already started." }));
    const { rerender } = render(<ConsentPanel noticeVersion="v1" notice="Notice text" given={false} onConsent={onConsent} onWithdraw={onWithdraw} />);
    const confirm = screen.getByRole("button", { name: "I agree" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("I have read this notice and agree to take part."));
    expect(confirm.disabled).toBe(false);
    await act(async () => { fireEvent.click(confirm); });
    expect(onConsent).toHaveBeenCalledTimes(1);
    rerender(<ConsentPanel noticeVersion="v1" notice="Notice text" given onConsent={onConsent} onWithdraw={onWithdraw} />);
    expect(screen.getByText(/You agreed to notice v1/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Leave and withdraw consent" })); });
    expect(onWithdraw).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toBe("The session has already started.");
  });

  it("shows a refused consent's message", async () => {
    render(<ConsentPanel noticeVersion="v1" notice="n" given={false} onConsent={async () => ({ ok: false, message: "The notice has changed." })} onWithdraw={async () => ({ ok: true })} />);
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "I agree" })); });
    expect(screen.getByRole("alert").textContent).toBe("The notice has changed.");
  });
});

describe("header, title and status", () => {
  it("the header carries the SceneCoach.ai wordmark, the status in words and the role", () => {
    const { container } = render(<AppHeader status="running" roleId="account_manager" />);
    expect(container.querySelector("header")).toBeTruthy();
    expect(container.textContent).toContain("SceneCoach.ai");
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("Account manager")).toBeTruthy();
    noInlineStyles(container);
  });
  it("each status has a label", () => {
    for (const [s, label] of [["lobby", "Lobby"], ["paused", "Paused"], ["ended", "Ended"], ["connecting", "Connecting"], ["reconnecting", "Reconnecting"]] as const) {
      const { unmount } = render(<StatusChip status={s} />);
      expect(screen.getByText(label)).toBeTruthy();
      unmount();
    }
  });
  it("the title block is the page heading with its lede", () => {
    render(<TitleBlock title="Join your session" lede="Confirm who you are." />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Join your session");
    expect(screen.getByText("Confirm who you are.")).toBeTruthy();
  });
});
