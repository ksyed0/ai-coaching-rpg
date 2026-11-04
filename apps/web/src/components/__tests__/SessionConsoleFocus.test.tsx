// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialState } from "@acr/events";
import { SessionConsole } from "../console/SessionConsole";
import { FakeClock, FakeEventSource, fakeFetch, fakeTimer, ok, readiness } from "../../lib/__tests__/fakes";
import { MESSAGES } from "../../lib/messages";
import type { EventSourceCtor } from "../../lib/use-session";

// BUG-0022: where keyboard focus goes when a confirmation closes and the control that opened it can no longer take it.

beforeEach(() => FakeEventSource.reset());
afterEach(cleanup);

const SID = "abcd1234efgh5678";
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

async function live() {
  const f = fakeFetch((url) =>
    url.endsWith("/readiness") ? { status: 200, body: ok(readiness({ status: "running" })) } : { status: 200, body: ok({}) },
  );
  render(
    <SessionConsole
      sessionId={SID}
      deps={{ EventSource: FakeEventSource as unknown as EventSourceCtor, fetch: f.fetch, setTimer: fakeTimer().setTimer, clock: new FakeClock(1_000_000) }}
    />,
  );
  await screen.findByText(/Model:/);
  await flush();
  const es = FakeEventSource.last();
  await act(async () => es.emit("joined", { channel: "c1", scenes: [] }));
  await act(async () =>
    es.emit("reset", { state: { ...initialState(), status: "running", lastSeq: 1, roles: {} } }),
  );
  return es;
}
const endButton = () => screen.getByRole("button", { name: "End session" });
const openEnd = () => {
  endButton().focus();
  fireEvent.click(endButton());
  return screen.getByRole("dialog");
};
const banner = () => screen.getByText("The session has ended.");

describe("focus after a confirmation when its opener is gone", () => {
  it("End session: the ended final arrives under the open dialog, focus goes to the final banner", async () => {
    const es = await live();
    openEnd();
    await act(async () => es.emit("ended", {}));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(banner());
    expect(banner().getAttribute("tabindex")).toBe("-1");
  });

  it("End session: the dialog closes first and the final follows, focus still ends on the final banner", async () => {
    const es = await live();
    const dialog = openEnd();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "End session" }));
    });
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(endButton()); // the opener is still there until the final arrives
    await act(async () => es.emit("ended", {}));
    expect(screen.queryByRole("button", { name: "End session" })).toBeNull();
    expect(document.activeElement).toBe(banner());
  });

  it("End session: focus the user put elsewhere is not taken by the final", async () => {
    const es2 = await live();
    const other = document.createElement("input");
    document.body.append(other);
    other.focus();
    await act(async () => es2.emit("ended", {}));
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  it("a page that starts with the session already ended leaves focus alone", async () => {
    const f = fakeFetch((url) =>
      url.endsWith("/readiness") ? { status: 200, body: ok(readiness({ status: "ended" })) } : { status: 200, body: ok({}) },
    );
    render(
      <SessionConsole
        sessionId={SID}
        deps={{ EventSource: FakeEventSource as unknown as EventSourceCtor, fetch: f.fetch, setTimer: fakeTimer().setTimer, clock: new FakeClock(1_000_000) }}
      />,
    );
    await screen.findByText(/Model:/);
    await flush();
    expect(document.activeElement).toBe(document.body);
  });

  it("a connection drop under an open dialog: closing it puts focus on the reconnecting message", async () => {
    const es = await live();
    const opener = endButton();
    const dialog = openEnd();
    await act(async () => es.emit("reconnecting", {}));
    expect((opener as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    const msg = screen.getByText(MESSAGES.consoleReconnecting);
    expect(document.activeElement).toBe(msg);
    expect(msg.getAttribute("tabindex")).toBe("-1");
  });

  it("the connection is fine and the opener is there: focus returns to the opener, as before", async () => {
    await live();
    const dialog = openEnd();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(endButton());
  });
});
