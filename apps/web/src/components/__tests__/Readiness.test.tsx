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
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "../console/ConfirmDialog";
import { Readiness } from "../console/Readiness";
import {
  fakeFetch,
  fakeTimer,
  ok,
  readiness,
  refused,
} from "../../lib/__tests__/fakes";

afterEach(cleanup);

const SID = "abcd1234efgh5678";
const READY = readiness({
  canStart: true,
  roster: [
    {
      roleId: "account_manager",
      name: "Sam",
      joined: true,
      consented: true,
      connected: true,
    },
    {
      roleId: "delivery_lead",
      name: "Jo",
      joined: true,
      consented: true,
      connected: true,
    },
  ],
});

type Answer = { status: number; body: unknown };
/** Routes by path tail; the readiness answer is whatever `current.readiness` holds. */
function mount(initial: unknown, routes: Record<string, Answer> = {}) {
  const current = { readiness: initial as unknown };
  const f = fakeFetch((url) => {
    const tail = url.split(`/${SID}`)[1] ?? "";
    if (tail === "/readiness")
      return { status: 200, body: ok(current.readiness) };
    return routes[tail] ?? { status: 200, body: ok({}) };
  });
  const t = fakeTimer();
  const r = render(
    <Readiness sessionId={SID} fetch={f.fetch} setTimer={t.setTimer} />,
  );
  const posts = () => f.calls.filter((c) => c.init.method === "POST");
  return { ...r, f, t, current, posts };
}
const ready = async () => {
  await screen.findByText(/Model:/);
};

describe("Readiness", () => {
  it("shows the short session id and the model label as text", async () => {
    mount(READY);
    await ready();
    expect(screen.getByText("Session abcd1234")).toBeTruthy();
    expect(screen.getByText("Model: mock-model")).toBeTruthy();
  });

  it("Start is disabled and names the missing roles", async () => {
    mount(readiness({ missing: ["delivery_lead"], canStart: false }));
    await ready();
    const start = screen.getByRole("button", {
      name: "Start",
    }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(screen.getByText("Waiting for: delivery_lead")).toBeTruthy();
    expect(start.getAttribute("aria-describedby")).toBe("start-reason");
  });

  it("Start is disabled with 'Nobody has joined yet' for an empty roster", async () => {
    mount(readiness({ roster: [], missing: [], canStart: false }));
    await ready();
    expect(
      (screen.getByRole("button", { name: "Start" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getAllByText("Nobody has joined yet").length).toBeGreaterThan(
      0,
    );
  });

  it("Start posts, shows the success message and refreshes", async () => {
    const m = mount(READY, {
      "/start": { status: 200, body: ok({ started: true }) },
    });
    await ready();
    const start = screen.getByRole("button", { name: "Start" });
    expect((start as HTMLButtonElement).disabled).toBe(false);
    m.current.readiness = { ...READY, status: "running", canStart: false };
    await act(async () => {
      fireEvent.click(start);
    });
    await screen.findByText("The session has started.");
    expect(m.posts().map((c) => c.url)).toEqual([
      `/api/v1/console/sessions/${SID}/start`,
    ]);
    expect(m.posts()[0]!.init.headers).toMatchObject({
      "X-Requested-With": "scenecoach",
    });
  });

  it("a 409 already-started on Start is shown as started", async () => {
    mount(READY, {
      "/start": {
        status: 409,
        body: refused("conflict", "The session has already started."),
      },
    });
    await ready();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    await screen.findByText("The session has started.");
    expect(
      screen.queryByRole("alert", { name: "" })?.textContent ?? "",
    ).not.toMatch(/not possible/);
  });

  it("a 409 not-ready on Start shows the plain reason; a 504 shows the neutral timeout text", async () => {
    const gate = {
      status: 409,
      body: {
        success: false,
        data: {
          started: false,
          reason: "seats_not_ready",
          missing: ["delivery_lead"],
        },
        error: { code: "conflict", message: "x" },
      },
    };
    mount(READY, { "/start": gate });
    await ready();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Not everyone has joined and consented yet. Waiting for: delivery_lead",
      ),
    );
    expect(screen.queryByText("The session has started.")).toBeNull();
    cleanup();
    mount(READY, {
      "/start": { status: 504, body: refused("start_timeout", "x") },
    });
    await ready();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "The session did not confirm the start. Check the lobby, then try again.",
      ),
    );
  });

  it("roster state is announced as text (not colour alone)", async () => {
    mount(readiness());
    await ready();
    const row = (name: string) =>
      within(screen.getByRole("row", { name: new RegExp(name) }));
    const am = row("Account manager");
    expect(am.getAllByText(/^(✓ )?Yes$/)).toHaveLength(3);
    const dl = row("Delivery lead");
    expect(dl.getAllByText(/No$/)).toHaveLength(3);
    for (const h of ["Role", "Name", "Joined", "Consented", "Connected"])
      expect(screen.getByRole("columnheader", { name: h })).toBeTruthy();
    expect(dl.getByText("—")).toBeTruthy(); // no name yet
  });

  it("all text from names is rendered as text (an <img onerror> display name stays inert)", async () => {
    const XSS = `<img src=x onerror="alert(1)">`;
    const { container } = mount(
      readiness({
        roster: [
          {
            roleId: "account_manager",
            name: XSS,
            joined: true,
            consented: false,
            connected: true,
          },
        ],
        modelLabel: XSS,
      }),
    );
    await ready();
    expect(screen.getByText(XSS)).toBeTruthy();
    expect(screen.getByText(`Model: ${XSS}`)).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).not.toContain("<img");
  });

  it("Reissue confirmation names the role and says the old code stops working", async () => {
    const m = mount(readiness(), {
      "/reissue": {
        status: 200,
        body: ok({ roleId: "delivery_lead", code: "NEW-CODE-9" }),
      },
    });
    await ready();
    fireEvent.click(
      screen.getByRole("button", { name: "Reissue code for Delivery lead" }),
    );
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(/Delivery lead/, { selector: "h2" }),
    ).toBeTruthy();
    expect(dialog.textContent).toContain(
      "The old code and this person's seat stop working. The new code is shown once.",
    );
    expect(m.posts()).toHaveLength(0);
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Reissue code" }),
      );
    });
    await screen.findByText("NEW-CODE-9");
    expect(m.posts()[0]!.body).toEqual({ roleId: "delivery_lead" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByText("These codes are shown once and cannot be shown again."),
    ).toBeTruthy();
  });

  it("cancelling the reissue sends nothing", async () => {
    const m = mount(readiness());
    await ready();
    fireEvent.click(
      screen.getByRole("button", { name: "Reissue code for Account manager" }),
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Cancel",
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(m.posts()).toHaveLength(0);
  });

  it("Reissue all asks for confirmation that says every code, credential and consent is cleared, and is disabled once the session has started", async () => {
    const m = mount(readiness(), {
      "/reissue-all": {
        status: 200,
        body: ok({
          codes: [
            { roleId: "account_manager", code: "ONE-1" },
            { roleId: "delivery_lead", code: "TWO-2" },
          ],
        }),
      },
    });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Reissue all codes" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toMatch(
      /Every code, credential and consent is cleared/,
    );
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Reissue all codes" }),
      );
    });
    await screen.findByText("ONE-1");
    expect(screen.getByText("TWO-2")).toBeTruthy();
    expect(m.posts()[0]!.body).toEqual({});
    cleanup();
    mount(readiness({ status: "running" }));
    await ready();
    expect(
      (
        screen.getByRole("button", {
          name: "Reissue all codes",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  const roleButton = () =>
    screen.getAllByRole("button", {
      name: /^Reissue code for/,
    })[0] as HTMLButtonElement;

  it("per-role Reissue is enabled while idle or running and disabled when ended, stopped or unreachable", async () => {
    for (const [data, enabled] of [
      [readiness(), true],
      [readiness({ status: "running" }), true],
      [readiness({ status: "ended" }), false],
      [readiness({ status: null }), false],
      [
        readiness({
          launcherStatus: "stopped",
          status: null,
          roster: READY.roster,
        }),
        false,
      ],
    ] as const) {
      mount(data);
      await screen.findByText(/Model:/);
      expect(roleButton().disabled, JSON.stringify(data.status)).toBe(!enabled);
      cleanup();
    }
  });

  it("while running, the confirmation says the next joiner takes over the seat and keeps its consent, and sends the same reissue request", async () => {
    const m = mount(readiness({ status: "running" }), {
      "/reissue": {
        status: 200,
        body: ok({ roleId: "account_manager", code: "REBIND-7" }),
      },
    });
    await ready();
    fireEvent.click(roleButton());
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain(
      "The old code stops working. The next person who joins with the new code takes over this seat and keeps its existing consent. The new code is shown once.",
    );
    expect(dialog.textContent).not.toContain("seat stop working");
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Reissue code" }),
      );
    });
    await screen.findByText("REBIND-7");
    expect(m.posts()[0]!.body).toEqual({ roleId: "account_manager" });
    expect(m.posts()[0]!.url).toContain(`/${SID}/reissue`);
  });

  it("the unreachable state is shown for launcherStatus running with status null", async () => {
    mount(readiness({ status: null, roster: [], canStart: false }));
    await screen.findByText(
      "The session cannot be reached right now. Reconnecting…",
    );
    expect(screen.queryByText("This session has ended.")).toBeNull();
  });

  it("the kept-lobby note is shown while idle", async () => {
    mount(readiness());
    await ready();
    expect(
      screen.getByText(
        "Codes issued earlier are not shown again. Reissue a role to get a new code.",
      ),
    ).toBeTruthy();
    cleanup();
    mount(readiness({ status: "running" }));
    await ready();
    expect(screen.queryByText(/Codes issued earlier/)).toBeNull();
  });

  it("a stopped session says so and offers Restart, which shows returned codes once", async () => {
    const m = mount(
      readiness({ launcherStatus: "stopped", status: null, roster: [] }),
      {
        "/restart": {
          status: 200,
          body: ok({
            sessionId: SID,
            launcherStatus: "running",
            modelLabel: "m",
            codes: [{ roleId: "account_manager", code: "RST-77" }],
          }),
        },
      },
    );
    await screen.findByText("The session service stopped this session.");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    });
    await screen.findByText("RST-77");
    expect(m.posts()[0]!.url).toBe(`/api/v1/console/sessions/${SID}/restart`);
  });

  it("an ended session says so, has no Start and stops polling", async () => {
    const m = mount(readiness({ status: "ended" }));
    await screen.findByText("This session has ended.");
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    expect(m.t.pending).toBe(0);
  });

  it("shows Reconnecting over the last good value when a poll fails, and a signed-out page with a link", async () => {
    const m = mount(READY);
    await ready();
    m.f.calls.length = 0;
    m.current.readiness = null; // not a readiness shape: a failed poll
    await act(async () => {
      m.t.fire();
    });
    await screen.findByText("Reconnecting… The page keeps trying by itself.");
    expect(screen.getByText("Model: mock-model")).toBeTruthy();
    cleanup();
    const f = fakeFetch(() => ({
      status: 401,
      body: refused("unauthorized", "x"),
    }));
    render(
      <Readiness
        sessionId={SID}
        fetch={f.fetch}
        setTimer={fakeTimer().setTimer}
      />,
    );
    await screen.findByText(/You have been signed out\./);
    expect(
      screen.getByRole("link", { name: "Sign in again." }).getAttribute("href"),
    ).toBe("/console");
  });
});

describe("Readiness: a new code replaces an undismissed one", () => {
  const reissueFlow = async (name: string) => {
    fireEvent.click(screen.getByRole("button", { name }));
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: /^Reissue/,
        }),
      );
    });
  };

  it("reissuing the same role twice shows the second code and not the first", async () => {
    let n = 0;
    const f = fakeFetch((url) => {
      if (url.endsWith("/readiness"))
        return { status: 200, body: ok(readiness()) };
      return {
        status: 200,
        body: ok({ roleId: "delivery_lead", code: `CODE-${++n}` }),
      };
    });
    render(
      <Readiness
        sessionId={SID}
        fetch={f.fetch}
        setTimer={fakeTimer().setTimer}
      />,
    );
    await ready();
    await reissueFlow("Reissue code for Delivery lead");
    await screen.findByText("CODE-1");
    await reissueFlow("Reissue code for Delivery lead");
    await screen.findByText("CODE-2");
    expect(document.body.textContent).not.toContain("CODE-1");
  });

  it("Reissue all twice shows the second set only", async () => {
    let n = 0;
    const f = fakeFetch((url) => {
      if (url.endsWith("/readiness"))
        return { status: 200, body: ok(readiness()) };
      n++;
      return {
        status: 200,
        body: ok({
          codes: [
            { roleId: "account_manager", code: `ALL-A${n}` },
            { roleId: "delivery_lead", code: `ALL-B${n}` },
          ],
        }),
      };
    });
    render(
      <Readiness
        sessionId={SID}
        fetch={f.fetch}
        setTimer={fakeTimer().setTimer}
      />,
    );
    await ready();
    await reissueFlow("Reissue all codes");
    await screen.findByText("ALL-A1");
    await reissueFlow("Reissue all codes");
    await screen.findByText("ALL-A2");
    expect(screen.getByText("ALL-B2")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/ALL-[AB]1/);
  });

  it("reissuing role A then role B shows B's code only (the panel shows the latest issue)", async () => {
    const f = fakeFetch((url, body) => {
      if (url.endsWith("/readiness"))
        return { status: 200, body: ok(readiness()) };
      const roleId = (body as { roleId: string }).roleId;
      return { status: 200, body: ok({ roleId, code: `FOR-${roleId}` }) };
    });
    render(
      <Readiness
        sessionId={SID}
        fetch={f.fetch}
        setTimer={fakeTimer().setTimer}
      />,
    );
    await ready();
    await reissueFlow("Reissue code for Account manager");
    await screen.findByText("FOR-account_manager");
    await reissueFlow("Reissue code for Delivery lead");
    await screen.findByText("FOR-delivery_lead");
    expect(document.body.textContent).not.toContain("FOR-account_manager");
  });
});

describe("ConfirmDialog", () => {
  function Harness({ onConfirm = () => {} }: { onConfirm?: () => void }) {
    const [open, setOpen] = useState(false);
    const [opener, setOpener] = useState<HTMLElement | null>(null);
    return (
      <>
        <button
          type="button"
          onClick={(e) => {
            setOpener(e.currentTarget);
            setOpen(true);
          }}
        >
          Open it
        </button>
        {open ? (
          <ConfirmDialog
            title="Sure?"
            description="This cannot be undone."
            confirmLabel="Do it"
            opener={opener}
            onConfirm={onConfirm}
            onCancel={() => setOpen(false)}
          />
        ) : null}
      </>
    );
  }

  it("ConfirmDialog traps focus, closes on Escape and returns focus", () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open it" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Sure?" })).toBeTruthy();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const confirm = screen.getByRole("button", { name: "Do it" });
    expect(document.activeElement).toBe(cancel); // first action
    confirm.focus();
    fireEvent.keyDown(confirm, { key: "Tab" }); // last -> first
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true }); // first -> last
    expect(document.activeElement).toBe(confirm);
    fireEvent.keyDown(confirm, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("returns focus to the opener after Cancel and after confirming, and Confirm calls back once", () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    const opener = screen.getByRole("button", { name: "Open it" });
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(opener);
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole("button", { name: "Do it" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
