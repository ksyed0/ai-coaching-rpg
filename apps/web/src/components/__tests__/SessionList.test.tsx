// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SessionList } from "../console/SessionList";
import { fakeFetch, ok, refused } from "../../lib/__tests__/fakes";

afterEach(cleanup);

const LIST = [
  {
    sessionId: "aaaaaaaa11111111",
    scenarioId: "launch_day",
    status: "running",
    modelLabel: "m",
  },
  {
    sessionId: "bbbbbbbb22222222",
    scenarioId: "launch_day",
    status: "stopped",
  },
  { sessionId: "cccccccc33333333", scenarioId: "budget_cut", status: "ended" },
];

function mount(
  list: unknown = LIST,
  restart?: { status: number; body: unknown },
) {
  let current = list;
  const f = fakeFetch((url) => {
    if (url.endsWith("/restart"))
      return (
        restart ?? {
          status: 200,
          body: ok({
            sessionId: "bbbbbbbb22222222",
            launcherStatus: "running",
          }),
        }
      );
    return { status: 200, body: ok(current) };
  });
  return {
    f,
    set: (v: unknown) => {
      current = v;
    },
    ...render(<SessionList fetch={f.fetch} />),
  };
}

describe("SessionList", () => {
  it("lists a short id, the scenario and a status chip in words", async () => {
    mount();
    await screen.findByText("aaaaaaaa");
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText("Running")).toBeTruthy();
    expect(within(rows[1]!).getByText("Stopped")).toBeTruthy();
    expect(within(rows[2]!).getByText("Ended")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "New session" }).getAttribute("href"),
    ).toBe("/console/new");
    expect(screen.queryByText("No sessions yet")).toBeNull();
  });

  it("keeps 'No sessions yet' when there are none", async () => {
    mount([]);
    await screen.findByText("No sessions yet");
  });

  it("Restart appears only for stopped sessions and calls restart; returned codes are shown once", async () => {
    const m = mount(LIST, {
      status: 200,
      body: ok({
        sessionId: "bbbbbbbb22222222",
        launcherStatus: "running",
        codes: [{ roleId: "account_manager", code: "RESTART-CODE" }],
      }),
    });
    await screen.findByText("aaaaaaaa");
    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]!).queryByRole("button")).toBeNull();
    expect(
      within(rows[0]!)
        .getByRole("link", { name: /^Open/ })
        .getAttribute("href"),
    ).toBe("/console/aaaaaaaa11111111");
    expect(
      within(rows[1]!)
        .getByRole("link", { name: /^Open/ })
        .getAttribute("href"),
    ).toBe("/console/bbbbbbbb22222222");
    expect(within(rows[2]!).queryByRole("button")).toBeNull();
    expect(within(rows[2]!).queryByRole("link")).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Restart/ })).toHaveLength(1);
    m.set(
      LIST.map((s) =>
        s.status === "stopped" ? { ...s, status: "running" } : s,
      ),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Restart/ }));
    });
    await screen.findByText("RESTART-CODE");
    const post = m.f.calls.find((c) => c.init.method === "POST")!;
    expect(post.url).toBe("/api/v1/console/sessions/bbbbbbbb22222222/restart");
    expect(post.init.headers).toMatchObject({
      "X-Requested-With": "scenecoach",
    });
    await waitFor(() =>
      expect(
        screen.queryAllByRole("button", { name: /^Restart/ }),
      ).toHaveLength(0),
    ); // list reloaded
    fireEvent.click(
      screen.getByRole("button", { name: "I have copied the codes" }),
    );
    expect(document.body.textContent).not.toContain("RESTART-CODE");
  });

  it("a restart without codes shows no panel; a refusal reads plainly; a failed list offers Try again", async () => {
    mount(LIST, { status: 409, body: refused("conflict", "x") });
    await screen.findByText("aaaaaaaa");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Restart/ }));
    });
    await screen.findByText(
      "That action is not possible in the session's current state.",
    );
    expect(screen.queryByText(/shown once/)).toBeNull();
    cleanup();
    const down = fakeFetch(() => ({
      status: 502,
      body: refused("launcher_unavailable", "x"),
    }));
    render(<SessionList fetch={down.fetch} />);
    await screen.findByText("The session service is not reachable. Try again.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("renders ids and scenarios as text only", async () => {
    const XSS = `<img src=x onerror="alert(1)">`;
    const { container } = mount([
      { sessionId: "dddddddd44444444", scenarioId: XSS, status: "running" },
    ]);
    await screen.findByText(XSS);
    expect(container.querySelector("img")).toBeNull();
  });
});
