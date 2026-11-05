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
import { isolate } from "../../lib/console-view";
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
    // The joined seat's Remove button carries the name in its aria-label: an attribute value, never markup.
    expect(
      screen.getByRole("button", { name: `Remove ${XSS} from Account manager` }),
    ).toBeTruthy();
    expect(container.querySelector("[onerror]")).toBeNull();
    // The Remove button's aria-label legitimately holds the name inside an attribute value, so attribute values are blanked before
    // looking for markup: a name rendered as markup (not text) would still leave "<img" and an on* attribute behind.
    const markup = container.innerHTML.replace(/="[^"]*"/g, '=""');
    expect(markup).not.toContain("<img");
    const handlers = [...container.querySelectorAll("*")].flatMap((el) =>
      el.getAttributeNames().filter((n) => n.startsWith("on")),
    );
    expect(handlers).toEqual([]);
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

describe("Readiness: Remove", () => {
  const BOTH = readiness({
    roster: [
      { roleId: "account_manager", name: "Sam", joined: true, consented: true, connected: true },
      { roleId: "delivery_lead", joined: false, consented: false, connected: false },
      { roleId: "finance_lead", name: "Ana", joined: true, consented: true, connected: false },
    ],
  });

  it("the Remove button's label isolates a name that holds a bidi control, as the dialog copy does", async () => {
    mount(
      readiness({
        roster: [{ roleId: "account_manager", name: "Eve\u202E", joined: true, consented: true, connected: true }],
      }),
    );
    await ready();
    const btn = screen.getAllByRole("button", { name: /^Remove / })[0]!;
    expect(btn.getAttribute("aria-label")).toBe(`Remove ${isolate("Eve\u202E")} from Account manager`);
    expect(btn.getAttribute("aria-label")).toContain("\u2068");
  });

  it("Remove is offered only for joined seats before the start; its dialog names the person and the role; the new code is shown once", async () => {
    const m = mount(BOTH, {
      "/remove": { status: 200, body: ok({ roleId: "account_manager", code: "REMOVED-CODE-1" }) },
    });
    await ready();
    expect(screen.getByRole("button", { name: "Remove Sam from Account manager" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove Ana from Finance lead" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Remove .* from Delivery lead$/ })).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Remove Sam from Account manager" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Remove Sam from Account manager?" })).toBeTruthy();
    expect(dialog.textContent).toContain(
      "They are signed out of the Account manager seat and their code stops working. A new code for the seat is shown once. This affects the Account manager role only.",
    );
    expect(m.posts()).toHaveLength(0);
    m.current.readiness = readiness({
      roster: [
        { roleId: "account_manager", joined: false, consented: false, connected: false },
        { roleId: "delivery_lead", joined: false, consented: false, connected: false },
      ],
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    });
    await screen.findByText("REMOVED-CODE-1");
    expect(m.posts().map((c) => c.url)).toEqual([`/api/v1/console/sessions/${SID}/remove`]);
    expect(m.posts()[0]!.body).toEqual({ roleId: "account_manager" });
    expect(screen.getByRole("heading", { name: "New code for Account manager" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent!.split("REMOVED-CODE-1")).toHaveLength(2);
    // The seat is empty now, so its Remove button is gone; focus lands on the same row's Reissue button, not on the body.
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Remove Sam/ })).toBeNull());
    await waitFor(() =>
      expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe("Reissue code for Account manager"),
    );
  });

  it("the removal's code is cleared by 'I have copied the codes' and a second removal shows only its own code", async () => {
    let n = 0;
    const f = fakeFetch((url) => {
      if (url.endsWith("/readiness")) return { status: 200, body: ok(BOTH) };
      return { status: 200, body: ok({ roleId: "x", code: `RM-${++n}` }) };
    });
    render(<Readiness sessionId={SID} fetch={f.fetch} setTimer={fakeTimer().setTimer} />);
    await ready();
    const removeSam = async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove Sam from Account manager" }));
      await act(async () => {
        fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }));
      });
    };
    await removeSam();
    await screen.findByText("RM-1");
    await removeSam();
    await screen.findByText("RM-2");
    expect(document.body.textContent).not.toContain("RM-1");
    fireEvent.click(screen.getByRole("button", { name: "I have copied the codes" }));
    expect(document.body.textContent).not.toContain("RM-2");
    expect(screen.queryByRole("heading", { name: /^New code for/ })).toBeNull();
  });

  it("Remove is not offered once the session is running, ended or unreachable", async () => {
    for (const status of ["running", "ended", null] as const) {
      mount({ ...BOTH, status });
      await screen.findByText(/Model:/);
      expect(screen.queryByRole("button", { name: /^Remove / }), String(status)).toBeNull();
      cleanup();
    }
  });

  it("a nameless joined seat reads 'Remove the participant from <role>?'", async () => {
    mount(readiness({ roster: [{ roleId: "account_manager", joined: true, consented: false, connected: false }] }));
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Remove the participant from Account manager" }));
    expect(within(screen.getByRole("dialog")).getByRole("heading", { name: "Remove the participant from Account manager?" })).toBeTruthy();
  });

  it("cancelling Remove sends nothing and returns focus to its button", async () => {
    const m = mount(BOTH);
    await ready();
    const btn = screen.getByRole("button", { name: "Remove Sam from Account manager" });
    fireEvent.click(btn);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(m.posts()).toHaveLength(0);
    expect(document.activeElement).toBe(btn);
  });

  it('a 409 shows "A participant can only be removed before the start."', async () => {
    mount(BOTH, {
      "/remove": { status: 409, body: refused("conflict", "A participant can only be removed before the start.") },
    });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Remove Sam from Account manager" }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }));
    });
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("A participant can only be removed before the start."),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("heading", { name: /^New code for/ })).toBeNull();
  });

  // BUG-0022: focus after a refused Remove.
  const refusedRemove = { "/remove": { status: 409, body: refused("conflict", "A participant can only be removed before the start.") } };
  const confirmRemove = async () => {
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }));
    });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("only be removed before the start"));
  };

  it("a 409 whose Remove button is gone (the session started meanwhile) puts focus on the error message", async () => {
    const m = mount(BOTH, refusedRemove);
    await ready();
    const btn = screen.getByRole("button", { name: "Remove Sam from Account manager" });
    btn.focus();
    fireEvent.click(btn);
    m.current.readiness = readiness({ status: "running", roster: BOTH.roster });
    await act(async () => {
      m.t.fire();
    });
    await waitFor(() => expect(btn.isConnected).toBe(false));
    await confirmRemove();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("alert"));
    expect(screen.getByRole("alert").getAttribute("tabindex")).toBe("-1");
  });

  it("a 409 with its Remove button still there returns focus to that button, as before", async () => {
    mount(BOTH, refusedRemove);
    await ready();
    const btn = screen.getByRole("button", { name: "Remove Sam from Account manager" });
    btn.focus();
    fireEvent.click(btn);
    await confirmRemove();
    expect(document.activeElement).toBe(btn);
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

  it("with live set it makes no readiness request and shows the live roster and status", async () => {
    const f = fakeFetch(() => ({ status: 200, body: ok(READY) }));
    const t = fakeTimer();
    const live = {
      status: "running" as const,
      roster: [{ roleId: "account_manager", name: "Live Sam", joined: true, consented: true, connected: false }],
    };
    const r = render(<Readiness sessionId={SID} fetch={f.fetch} setTimer={t.setTimer} />);
    await ready();
    expect(f.calls).toHaveLength(1);
    r.rerender(<Readiness sessionId={SID} fetch={f.fetch} setTimer={t.setTimer} live={live} />);
    expect(t.pending).toBe(0);
    expect(f.calls).toHaveLength(1);
    expect(screen.getByText("Live Sam")).toBeTruthy();
    expect(screen.queryByText("Sam")).toBeNull();
    expect(screen.getByText(/Model: mock-model/)).toBeTruthy();
    expect(screen.getAllByText(/started/i).length).toBeGreaterThan(0);
  });

  // ---- US-0060: AI seats ----
  const AI_ROSTER = [
    { roleId: "account_manager", name: "Sam", joined: true, consented: true, connected: true },
    { roleId: "delivery_lead", joined: false, consented: false, connected: false },
    { roleId: "tech_lead", name: "Pat", joined: false, consented: false, connected: false, ai: true },
  ];

  it("the readiness row of an AI seat reads \"AI player\", \"Not needed\" and has no Reissue or Remove button", async () => {
    mount(readiness({ roster: [{ ...AI_ROSTER[2]!, joined: true, connected: true }, AI_ROSTER[0]!], canStart: true }));
    await ready();
    const row = screen.getByRole("row", { name: /Tech lead/ });
    expect(within(row).getByText("AI player")).toBeTruthy();
    expect(within(row).getByText("AI")).toBeTruthy();
    expect(within(row).getByText("Not needed")).toBeTruthy();
    expect(row.textContent).not.toContain("Pat");
    // The only button is the switch back to a human: no Reissue, no Remove.
    expect(within(row).getAllByRole("button").map((b) => b.textContent)).toEqual(["Make human"]);
    // A human row keeps its buttons and its Consented cell.
    const human = screen.getByRole("row", { name: /Account manager/ });
    expect(within(human).getByRole("button", { name: "Reissue code for Account manager" })).toBeTruthy();
    expect(within(human).queryByText("Not needed")).toBeNull();
  });

  it("the start reason says \"AI player not connected yet: Tech lead\" while aiWaiting holds tech_lead", async () => {
    mount(readiness({ roster: AI_ROSTER.slice(0, 1).concat([{ ...AI_ROSTER[2]! }]), aiWaiting: ["tech_lead"], missing: [] }));
    await ready();
    expect(document.getElementById("start-reason")!.textContent).toBe("AI player not connected yet: Tech lead");
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("with both a missing human and a missing AI role the reason lists them separately, split by the roster ai flag", async () => {
    // An older server puts every role in `missing`; the console splits it by the roster flag.
    mount(readiness({ roster: AI_ROSTER, missing: ["delivery_lead", "tech_lead"] }));
    await ready();
    const reason = document.getElementById("start-reason")!.textContent!;
    expect(reason).toBe("Waiting for: delivery_lead. AI player not connected yet: Tech lead");
  });

  it("a refused start lists the human and the AI player separately", async () => {
    const gate = { status: 409, body: { success: false, data: { started: false, reason: "seats_not_ready", missing: ["delivery_lead"], aiWaiting: ["tech_lead"] }, error: { code: "conflict", message: "x" } } };
    mount(readiness({ roster: AI_ROSTER, canStart: true, missing: [] }), { "/start": gate });
    await ready();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start" })); });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Not everyone has joined and consented yet. Waiting for: delivery_lead. AI player not connected yet: Tech lead"));
  });

  it("a refusal listing an AI role in missing (older server) moves it to its own sentence", async () => {
    const gate = { status: 409, body: { success: false, data: { started: false, reason: "seats_not_ready", missing: ["tech_lead"] }, error: { code: "conflict", message: "x" } } };
    mount(readiness({ roster: AI_ROSTER, canStart: true }), { "/start": gate });
    await ready();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start" })); });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Not everyone has joined and consented yet. AI player not connected yet: Tech lead"));
  });

  it("a refusal with reason ai_notice shows the BFF's message", async () => {
    const msg = "This server's consent notice does not mention AI players. AI players need notice v2 or later.";
    const gate = { status: 409, body: { success: false, data: { started: false, reason: "ai_notice" }, error: { code: "ai_notice", message: msg } } };
    mount(READY, { "/start": gate });
    await ready();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start" })); });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(msg));
    expect(screen.queryByText("The session has started.")).toBeNull();
  });

  it("no console screen renders a notice version as agreed", async () => {
    mount(readiness({ roster: AI_ROSTER, canStart: false }));
    await ready();
    expect(document.body.textContent).not.toMatch(/notice v\d|agreed/i);
  });

  it("a refusal naming only a human reads exactly the human sentence", async () => {
    const gate = { status: 409, body: { success: false, data: { started: false, reason: "seats_not_ready", missing: ["delivery_lead"], aiWaiting: [] }, error: { code: "conflict", message: "x" } } };
    mount(readiness({ roster: AI_ROSTER, canStart: true }), { "/start": gate });
    await ready();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start" })); });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Not everyone has joined and consented yet. Waiting for: delivery_lead"));
  });

  it("only humans waiting: the start reason is exactly the human sentence", async () => {
    mount(readiness({ roster: AI_ROSTER, missing: ["delivery_lead"] }));
    await ready();
    expect(document.getElementById("start-reason")!.textContent).toBe("Waiting for: delivery_lead");
  });
});

describe("Readiness: switching roles to AI players and back", () => {
  const HUMAN = (roleId: string, name: string) => ({ roleId, name, joined: true, consented: true, connected: true });
  const AI = (roleId: string) => ({ roleId, joined: true, consented: false, connected: true, ai: true as const });
  const ROSTER = [HUMAN("account_manager", "Pat"), AI("tech_lead"), { roleId: "delivery_lead", joined: false, consented: false, connected: false }];
  const aiPosts = (m: ReturnType<typeof mount>) => m.posts().filter((c) => c.url.endsWith("/ai-roles"));
  const sw = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

  it("Make AI player on a joined row opens the danger dialog \"Replace Pat with an AI player in Account manager?\" and Cancel sends nothing", async () => {
    const m = mount(readiness({ roster: ROSTER }));
    await ready();
    const opener = sw("Make Account manager an AI player");
    expect(opener.textContent).toBe("Make AI player");
    fireEvent.click(opener);
    const dlg = screen.getByRole("dialog");
    expect(within(dlg).getByText("Replace Pat with an AI player in Account manager?")).toBeTruthy();
    expect(within(dlg).getByRole("button", { name: "Use AI player" }).className).toContain("danger");
    fireEvent.click(within(dlg).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(aiPosts(m)).toHaveLength(0);
    expect(document.activeElement).toBe(opener);
  });

  it("a seat nobody has joined opens a primary dialog \"Fill Delivery lead with an AI player?\"", async () => {
    mount(readiness({ roster: ROSTER }));
    await ready();
    fireEvent.click(sw("Make Delivery lead an AI player"));
    const dlg = screen.getByRole("dialog");
    expect(within(dlg).getByText("Fill Delivery lead with an AI player?")).toBeTruthy();
    expect(within(dlg).getByRole("button", { name: "Use AI player" }).className).not.toContain("danger");
  });

  it("confirming posts {roles:[\"account_manager\"]...} with the current AI set kept, then refreshes the readiness", async () => {
    const m = mount(readiness({ roster: ROSTER }), {
      "/ai-roles": { status: 200, body: ok({ roles: ["tech_lead", "account_manager"], codes: [] }) },
    });
    await ready();
    const readsBefore = m.f.calls.filter((c) => c.url.endsWith("/readiness")).length;
    fireEvent.click(sw("Make Account manager an AI player"));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Use AI player" }));
    });
    expect(aiPosts(m)).toHaveLength(1);
    expect(aiPosts(m)[0]!.body).toEqual({ roles: ["tech_lead", "account_manager"], includeInGroup: true });
    expect(aiPosts(m)[0]!.init.headers).toMatchObject({ "X-Requested-With": "scenecoach" });
    await waitFor(() => expect(m.f.calls.filter((c) => c.url.endsWith("/readiness")).length).toBe(readsBefore + 1));
    expect(screen.queryByRole("dialog")).toBeNull();
    // The switch was not the only AI role: posting the toggled role alone would have dropped tech_lead.
    expect(document.body.textContent).not.toContain("New code for");
  });

  it("Make human posts the set without it and shows \"New code for Tech lead\" once", async () => {
    // The runtime returns codes only for roles whose flag changed.
    const m = mount(readiness({ roster: [...ROSTER, AI("cfo")] }), {
      "/ai-roles": { status: 200, body: ok({ roles: ["cfo"], codes: [{ roleId: "tech_lead", code: "TL-NEW" }] }) },
    });
    await ready();
    fireEvent.click(sw("Make Tech lead human"));
    const dlg = screen.getByRole("dialog");
    expect(within(dlg).getByText("Switch Tech lead back to a human?")).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(dlg).getByRole("button", { name: "Switch to human" }));
    });
    expect(aiPosts(m)[0]!.body).toEqual({ roles: ["cfo"], includeInGroup: true });
    await screen.findByRole("heading", { name: "New code for Tech lead" });
    expect(screen.getByText("TL-NEW")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "I have copied the codes" }));
    expect(document.body.textContent).not.toContain("TL-NEW");
  });

  it("an ai_too_many answer shows \"At most 8 roles can be AI players.\" and an ai_notice answer its notice copy; the state is unchanged", async () => {
    const m = mount(readiness({ roster: ROSTER }), {
      "/ai-roles": { status: 409, body: refused("ai_too_many", "At most 8 roles can be AI players.") },
    });
    await ready();
    fireEvent.click(sw("Make Delivery lead an AI player"));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Use AI player" }));
    });
    await screen.findByText("At most 8 roles can be AI players.");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sw("Make Delivery lead an AI player").disabled).toBe(false);
    expect(document.activeElement).toBe(sw("Make Delivery lead an AI player"));
    expect(aiPosts(m)).toHaveLength(1);
  });

  it("an ai_notice answer shows the notice copy", async () => {
    const notice = "This server's consent notice does not mention AI players. AI players need notice v2 or later.";
    const m = mount(readiness({ roster: ROSTER }), { "/ai-roles": { status: 409, body: refused("ai_notice", notice) } });
    await ready();
    fireEvent.click(sw("Make Delivery lead an AI player"));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Use AI player" }));
    });
    await screen.findByText(notice);
    expect(aiPosts(m)).toHaveLength(1);
  });

  it("with no message in the answer the client's own copy is used", async () => {
    const m = mount(readiness({ roster: ROSTER }), { "/ai-roles": { status: 409, body: refused("ai_no_human", "") } });
    await ready();
    fireEvent.click(sw("Make Delivery lead an AI player"));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Use AI player" }));
    });
    await screen.findByText("At least one role must stay human.");
    expect(aiPosts(m)).toHaveLength(1);
  });

  it("an unconfirmed answer (504) says the change may or may not have been made, leaves the row unchanged and refetches the roster", async () => {
    const m = mount(readiness({ roster: ROSTER }), { "/ai-roles": { status: 504, body: refused("ai_roles_unconfirmed", "") } });
    await ready();
    const reads = () => m.f.calls.filter((c) => c.url.endsWith("/readiness")).length;
    const before = reads();
    fireEvent.click(sw("Make Delivery lead an AI player"));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Use AI player" }));
    });
    await screen.findByText("The change may or may not have been made. Check the roster, then switch the role again.");
    expect(sw("Make Delivery lead an AI player")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Make Delivery lead human" })).toBeNull();
    await waitFor(() => expect(reads()).toBe(before + 1));
  });

  it("a role switched back to human (code shown) and then to AI again leaves no dead code on screen", async () => {
    const routes: Record<string, Answer> = {
      "/ai-roles": { status: 200, body: ok({ roles: [], codes: [{ roleId: "tech_lead", code: "TL-NEW" }] }) },
    };
    const m = mount(readiness({ roster: ROSTER }), routes);
    await ready();
    fireEvent.click(sw("Make Tech lead human"));
    m.current.readiness = readiness({ roster: [ROSTER[0]!, { roleId: "tech_lead", joined: false, consented: false, connected: false }, ROSTER[2]!] });
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Switch to human" }));
    });
    await screen.findByText("TL-NEW");
    routes["/ai-roles"] = { status: 200, body: ok({ roles: ["tech_lead"], codes: [] }) };
    fireEvent.click(await screen.findByRole("button", { name: "Make Tech lead an AI player" }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Use AI player" }));
    });
    expect(aiPosts(m)[1]!.body).toEqual({ roles: ["tech_lead"], includeInGroup: true });
    await waitFor(() => expect(document.body.textContent).not.toContain("TL-NEW"));
    expect(screen.queryByRole("heading", { name: "New code for Tech lead" })).toBeNull();
  });

  it("an answer that returns several codes shows every one once under \"New codes\"", async () => {
    mount(readiness({ roster: ROSTER }), {
      "/ai-roles": { status: 200, body: ok({ roles: [], codes: [{ roleId: "tech_lead", code: "TL-NEW" }, { roleId: "delivery_lead", code: "DL-NEW" }] }) },
    });
    await ready();
    fireEvent.click(sw("Make Tech lead human"));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Switch to human" }));
    });
    await screen.findByRole("heading", { name: "New codes" });
    expect(screen.getByText("TL-NEW")).toBeTruthy();
    expect(screen.getByText("DL-NEW")).toBeTruthy();
  });

  it("no toggle is rendered once status is running", async () => {
    mount(readiness({ status: "running", roster: ROSTER }));
    await ready();
    expect(screen.queryByRole("button", { name: /an AI player$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /human$/ })).toBeNull();
  });

  it("no toggle is rendered while the session is unreachable", async () => {
    mount(readiness({ status: null, roster: ROSTER }));
    await ready();
    expect(screen.queryByRole("button", { name: /AI player$|human$/ })).toBeNull();
  });

  it("an AI row has the switch back and still no Reissue or Remove", async () => {
    mount(readiness({ roster: ROSTER }));
    await ready();
    const row = screen.getByRole("row", { name: /Tech lead/ });
    expect(within(row).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Make Tech lead human"]);
    expect(row.textContent).not.toContain("Pat");
  });

  it("while the request is in flight every switch is disabled and nothing is posted twice", async () => {
    const m = mount(readiness({ roster: ROSTER }), { "/ai-roles": { status: 200, body: ok({ roles: ["tech_lead", "delivery_lead"], codes: [] }) } });
    await ready();
    fireEvent.click(sw("Make Delivery lead an AI player"));
    m.f.hold();
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Use AI player" }));
    });
    expect(sw("Make Account manager an AI player").disabled).toBe(true);
    expect(sw("Make Tech lead human").disabled).toBe(true);
    fireEvent.click(sw("Make Account manager an AI player"));
    // The dialog of the pending change stays; the click on the disabled switch opened nothing else.
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByText("Fill Delivery lead with an AI player?")).toBeTruthy();
    await act(async () => {
      m.f.release();
    });
    expect(aiPosts(m)).toHaveLength(1);
  });

  it("focus returns to the row's switch after a confirmed change (the roster re-renders under it)", async () => {
    const m = mount(readiness({ roster: ROSTER }), { "/ai-roles": { status: 200, body: ok({ roles: ["tech_lead", "delivery_lead"], codes: [] }) } });
    await ready();
    fireEvent.click(sw("Make Delivery lead an AI player"));
    m.current.readiness = readiness({ roster: [ROSTER[0]!, ROSTER[1]!, AI("delivery_lead")] });
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Use AI player" }));
    });
    const next = await screen.findByRole("button", { name: "Make Delivery lead human" });
    await waitFor(() => expect(document.activeElement).toBe(next));
  });
});

describe("Readiness: the group-score option", () => {
  const LABEL = "Include AI players in group scores";
  const HINT =
    "On: what the AI players say can count as team evidence in the group report, always marked AI. Off: their lines are context only. AI players never get an individual score. You can change this until the start.";
  const HUMAN = (roleId: string, name: string) => ({ roleId, name, joined: true, consented: true, connected: true });
  const AI = (roleId: string) => ({ roleId, joined: true, consented: false, connected: true, ai: true as const });
  const HUMANS = [HUMAN("account_manager", "Pat"), { roleId: "delivery_lead", joined: false, consented: false, connected: false }, HUMAN("tech_lead", "Lee")];
  const WITH_AI = [HUMAN("account_manager", "Pat"), { roleId: "delivery_lead", joined: false, consented: false, connected: false }, AI("tech_lead")];
  const aiPosts = (m: ReturnType<typeof mount>) => m.posts().filter((c) => c.url.endsWith("/ai-roles"));
  const box = () => screen.getByRole("checkbox", { name: LABEL }) as HTMLInputElement;

  it("no checkbox while every role is human", async () => {
    mount(readiness({ roster: HUMANS, includeInGroup: true }));
    await ready();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("with tech_lead AI the checkbox \"Include AI players in group scores\" is checked and described by the hint", async () => {
    mount(readiness({ roster: WITH_AI, includeInGroup: true }));
    await ready();
    expect(box().checked).toBe(true);
    const hint = document.getElementById(box().getAttribute("aria-describedby")!)!;
    expect(hint.textContent).toBe(HINT);
    expect(hint.className).toContain("muted");
  });

  it("unchecking posts {roles:[\"tech_lead\"], includeInGroup:false} and stays unchecked after the answer", async () => {
    const m = mount(readiness({ roster: WITH_AI, includeInGroup: true }), {
      "/ai-roles": { status: 200, body: ok({ roles: ["tech_lead"], includeInGroup: false, codes: [] }) },
    });
    await ready();
    m.current.readiness = readiness({ roster: WITH_AI, includeInGroup: false });
    await act(async () => {
      fireEvent.click(box());
    });
    expect(aiPosts(m)).toHaveLength(1);
    expect(aiPosts(m)[0]!.body).toEqual({ roles: ["tech_lead"], includeInGroup: false });
    await waitFor(() => expect(m.f.calls.filter((c) => c.url.endsWith("/readiness")).length).toBeGreaterThan(1));
    await waitFor(() => expect(box().disabled).toBe(false));
    expect(box().checked).toBe(false);
    expect(document.activeElement).toBe(box());
  });

  it("switching delivery_lead to AI while unchecked posts includeInGroup false", async () => {
    const m = mount(readiness({ roster: WITH_AI, includeInGroup: false }), {
      "/ai-roles": { status: 200, body: ok({ roles: ["tech_lead", "delivery_lead"], includeInGroup: false, codes: [] }) },
    });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Make Delivery lead an AI player" }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Use AI player" }));
    });
    expect(aiPosts(m)[0]!.body).toEqual({ roles: ["tech_lead", "delivery_lead"], includeInGroup: false });
  });

  it("a failed post shows the AI error copy and the checkbox shows the readiness value again", async () => {
    const m = mount(readiness({ roster: WITH_AI, includeInGroup: true }), {
      "/ai-roles": { status: 409, body: refused("ai_started", "") },
    });
    await ready();
    await act(async () => {
      fireEvent.click(box());
    });
    await screen.findByText("Roles can no longer be changed: the session has started.");
    expect(aiPosts(m)).toHaveLength(1);
    await waitFor(() => expect(box().disabled).toBe(false));
    expect(box().checked).toBe(true);
  });

  it("running with AI roles shows \"AI players in group scores: off\" and no checkbox", async () => {
    mount(readiness({ status: "running", roster: WITH_AI, includeInGroup: false }));
    await ready();
    expect(screen.getByText("AI players in group scores: off")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
