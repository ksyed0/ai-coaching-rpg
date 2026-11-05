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
import { NewSessionForm } from "../console/NewSessionForm";
import { fakeFetch, ok, refused } from "../../lib/__tests__/fakes";

afterEach(cleanup);

const SCENARIOS = [
  { id: "launch_day", title: "Launch day" },
  { id: "budget_cut", title: "Budget cut" },
];

function mount(create: { status: number; body: unknown }) {
  const f = fakeFetch((url) =>
    url.endsWith("/scenarios") ? { status: 200, body: ok(SCENARIOS) } : create,
  );
  return { f, ...render(<NewSessionForm fetch={f.fetch} />) };
}
const posts = (f: ReturnType<typeof fakeFetch>) =>
  f.calls.filter((c) => c.init.method === "POST");

describe("NewSessionForm", () => {
  it("offers a labelled scenario select and creates the session once", async () => {
    const m = mount({
      status: 200,
      body: ok({
        sessionId: "abcd1234efgh5678",
        modelLabel: "mock-model",
        codes: [{ roleId: "account_manager", code: "CODE-1" }],
      }),
    });
    const select = (await screen.findByLabelText(
      "Scenario",
    )) as HTMLSelectElement;
    await waitFor(() => expect(select.options).toHaveLength(2));
    fireEvent.change(select, { target: { value: "budget_cut" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    });
    await screen.findByText("CODE-1");
    expect(posts(m.f)).toHaveLength(1);
    expect(posts(m.f)[0]!.body).toEqual({ scenarioId: "budget_cut" });
    expect(posts(m.f)[0]!.init.headers).toMatchObject({
      "X-Requested-With": "scenecoach",
    });
    expect(
      screen.getByRole("link", { name: "Open session" }).getAttribute("href"),
    ).toBe("/console/abcd1234efgh5678");
    expect(screen.getByText("Model: mock-model")).toBeTruthy();
    expect(
      screen.getByText("These codes are shown once and cannot be shown again."),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "I have copied the codes" }),
    );
    expect(document.body.textContent).not.toContain("CODE-1");
    expect(screen.getByRole("link", { name: "Open session" })).toBeTruthy();
  });

  it("shows a polite starting message and a disabled button while pending, and does not double-submit", async () => {
    const m = mount({
      status: 200,
      body: ok({ sessionId: "abcd1234efgh5678", modelLabel: "m", codes: [] }),
    });
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Scenario") as HTMLSelectElement).options,
      ).toHaveLength(2),
    );
    m.f.hold();
    const form = screen
      .getByRole("button", { name: "Create session" })
      .closest("form")!;
    await act(async () => {
      fireEvent.submit(form);
    });
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(
      screen
        .getByText("Starting the session… this can take a moment.")
        .getAttribute("role"),
    ).toBe("status");
    expect(
      (screen.getByRole("button", { name: "Creating…" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await act(async () => {
      m.f.release();
    });
    await screen.findByRole("link", { name: "Open session" });
    expect(posts(m.f)).toHaveLength(1);
  });

  it("maps failures to plain messages and does not retry", async () => {
    const m = mount({
      status: 429,
      body: refused("capacity", "internal detail"),
    });
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Scenario") as HTMLSelectElement).options,
      ).toHaveLength(2),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    });
    await screen.findByText(
      "The maximum number of sessions is running. End one, then try again.",
    );
    expect(document.body.textContent).not.toContain("internal detail");
    expect(posts(m.f)).toHaveLength(1);
    expect(
      (
        screen.getByRole("button", {
          name: "Create session",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
});

describe("NewSessionForm: AI players on the created panel", () => {
  const ROLES = ["account_manager", "delivery_lead"];
  const created = {
    sessionId: "abcd1234efgh5678",
    modelLabel: "m",
    codes: [
      { roleId: "account_manager", code: "CODE-AM" },
      { roleId: "delivery_lead", code: "CODE-DL" },
    ],
  };
  type Opts = {
    /** Answer to every ai-roles post; default: a control service that keeps the AI set and returns codes only for roles that went back to human. */
    fail?: { status: number; body: unknown };
    /** The roster the one-shot readiness read answers; null = the read fails. */
    roster?: { roleId: string; name?: string; joined: boolean; ai?: true }[] | null;
    /** The first post is applied by the server but times out (ai_roles_unconfirmed). */
    timeoutFirst?: boolean;
    /** Roles another tab made AI: every answer after the first lists them too. */
    otherTabAi?: string[];
  };
  async function open(o: Opts = {}) {
    let ai: string[] = [];
    let posts = 0;
    const f = fakeFetch((url, body) => {
      if (url.endsWith("/scenarios")) return { status: 200, body: ok(SCENARIOS) };
      if (url.endsWith("/readiness")) {
        if (o.roster === null) return { status: 503, body: refused("unreachable", "") };
        const roster = (o.roster ?? ROLES.map((roleId) => ({ roleId, joined: false }))).map((e) => ({ consented: false, connected: false, ...e }));
        return { status: 200, body: ok({ launcherStatus: "running", status: "idle", modelLabel: "m", roster, canStart: false, missing: [], aiWaiting: [] }) };
      }
      if (url.endsWith("/ai-roles")) {
        if (o.fail) return o.fail;
        const roles = (body as { roles: string[] }).roles;
        const back = ai.filter((r) => !roles.includes(r));
        ai = roles;
        posts += 1;
        if (o.timeoutFirst && posts === 1) return { status: 504, body: refused("ai_roles_unconfirmed", "") };
        const answered = o.otherTabAi && posts > 1 ? [...roles, ...o.otherTabAi] : roles;
        return { status: 200, body: ok({ roles: answered, codes: back.map((r) => ({ roleId: r, code: `NEW-${r}` })) }) };
      }
      return { status: 200, body: ok(created) };
    });
    render(<NewSessionForm fetch={f.fetch} />);
    await waitFor(() => expect((screen.getByLabelText("Scenario") as HTMLSelectElement).options).toHaveLength(2));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    });
    await screen.findByText("CODE-AM");
    return f;
  }
  const aiPosts = (f: ReturnType<typeof fakeFetch>) => f.calls.filter((c) => c.url.endsWith("/ai-roles"));
  const reads = (f: ReturnType<typeof fakeFetch>) => f.calls.filter((c) => c.url.endsWith("/readiness"));
  /** Presses a switch; a switch to AI reads the roster first, so the dialog arrives after the click settles. */
  const press = async (name: string) => {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name }));
    });
  };
  const confirm = async (label = "Use AI player") => {
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: label }));
    });
  };

  it("the created panel shows a toggle per issued code; switching delivery_lead to AI hides its code and reads \"AI player\"", async () => {
    const f = await open();
    expect(screen.getAllByRole("button", { name: /^Make .* an AI player$/ })).toHaveLength(2);
    await press("Make Delivery lead an AI player");
    // Nobody has joined: the primary wording.
    const dlg = screen.getByRole("dialog");
    expect(within(dlg).getByText("Fill Delivery lead with an AI player?")).toBeTruthy();
    expect(within(dlg).getByRole("button", { name: "Use AI player" }).className).not.toContain("danger");
    await confirm();
    expect(aiPosts(f)[0]!.body).toEqual({ roles: ["delivery_lead"], includeInGroup: true });
    await waitFor(() => expect(document.body.textContent).not.toContain("CODE-DL"));
    expect(screen.getByText("CODE-AM")).toBeTruthy();
    const row = screen.getByText("AI player").closest("li")!;
    expect(row.textContent).toContain("Delivery lead");
    expect(screen.queryByRole("button", { name: "Copy code for Delivery lead" })).toBeNull();
    const back = within(row).getByRole("button", { name: "Make Delivery lead human" });
    await waitFor(() => expect(document.activeElement).toBe(back));
  });

  it("a seat someone has joined since gets the danger dialog naming them; the roster is read once, not polled", async () => {
    const f = await open({ roster: [{ roleId: "account_manager", joined: false }, { roleId: "delivery_lead", name: "Pat", joined: true }] });
    await press("Make Delivery lead an AI player");
    const dlg = screen.getByRole("dialog");
    expect(within(dlg).getByText("Replace Pat with an AI player in Delivery lead?")).toBeTruthy();
    expect(within(dlg).getByRole("button", { name: "Use AI player" }).className).toContain("danger");
    expect(reads(f)).toHaveLength(1);
  });

  it("a failed roster read falls back to the danger wording", async () => {
    await open({ roster: null });
    await press("Make Delivery lead an AI player");
    const dlg = screen.getByRole("dialog");
    expect(within(dlg).getByText("Fill Delivery lead with an AI player?")).toBeTruthy();
    expect(within(dlg).getByText(/They are signed out of the Delivery lead seat/)).toBeTruthy();
    expect(within(dlg).getByRole("button", { name: "Use AI player" }).className).toContain("danger");
  });

  it("a second switch posts the whole AI set, not only the toggled role", async () => {
    const f = await open();
    await press("Make Delivery lead an AI player");
    await confirm();
    await screen.findByRole("button", { name: "Make Delivery lead human" });
    await press("Make Account manager an AI player");
    await confirm();
    expect(aiPosts(f)[1]!.body).toEqual({ roles: ["delivery_lead", "account_manager"], includeInGroup: true });
  });

  it("Make human posts the set without it, shows the new code once under \"New code for Delivery lead\" and drops it on dismissal", async () => {
    const f = await open();
    await press("Make Delivery lead an AI player");
    await confirm();
    await press("Make Delivery lead human");
    expect(within(screen.getByRole("dialog")).getByText("Switch Delivery lead back to a human?")).toBeTruthy();
    await confirm("Switch to human");
    expect(aiPosts(f)[1]!.body).toEqual({ roles: [], includeInGroup: true });
    expect(await screen.findByRole("heading", { name: "New code for Delivery lead" })).toBeTruthy();
    expect(screen.getByText("NEW-delivery_lead")).toBeTruthy();
    expect(screen.getByText("CODE-AM")).toBeTruthy();
    expect(screen.queryByText("CODE-DL")).toBeNull();
    const dismiss = screen.getAllByRole("button", { name: "I have copied the codes" });
    fireEvent.click(dismiss[dismiss.length - 1]!);
    expect(document.body.textContent).not.toContain("NEW-delivery_lead");
    expect(screen.getByRole("button", { name: "Make Delivery lead an AI player" })).toBeTruthy();
  });

  it("a second switch to human accumulates into the panel and does not replace an uncopied code", async () => {
    await open();
    await press("Make Delivery lead an AI player");
    await confirm();
    await press("Make Account manager an AI player");
    await confirm();
    await press("Make Delivery lead human");
    await confirm("Switch to human");
    await screen.findByText("NEW-delivery_lead");
    await press("Make Account manager human");
    await confirm("Switch to human");
    await screen.findByRole("heading", { name: "New codes" });
    expect(screen.getByText("NEW-delivery_lead")).toBeTruthy();
    expect(screen.getByText("NEW-account_manager")).toBeTruthy();
  });

  it("DL back to human (code shown) then DL to AI again leaves no dead code", async () => {
    await open();
    await press("Make Delivery lead an AI player");
    await confirm();
    await press("Make Delivery lead human");
    await confirm("Switch to human");
    await screen.findByText("NEW-delivery_lead");
    await press("Make Delivery lead an AI player");
    await confirm();
    await waitFor(() => expect(document.body.textContent).not.toContain("NEW-delivery_lead"));
    expect(screen.queryByRole("heading", { name: /^New code/ })).toBeNull();
    expect(document.body.textContent).not.toContain("CODE-DL");
  });

  it("an unconfirmed answer resynchronises from one roster read: the applied AI role loses its code, and the next switch keeps it AI", async () => {
    const f = await open({
      timeoutFirst: true,
      roster: [{ roleId: "account_manager", joined: false }, { roleId: "delivery_lead", joined: false, ai: true }],
    });
    await press("Make Delivery lead an AI player");
    const readsBefore = reads(f).length;
    await confirm();
    await screen.findByText("The change may or may not have been made. Check the roster, then switch the role again.");
    expect(reads(f)).toHaveLength(readsBefore + 1);
    await waitFor(() => expect(document.body.textContent).not.toContain("CODE-DL"));
    expect(screen.getByRole("button", { name: "Make Delivery lead human" })).toBeTruthy();
    // The next switch posts the resynchronised set, so it cannot flip delivery_lead back to human.
    await press("Make Account manager an AI player");
    await confirm();
    expect(aiPosts(f)[1]!.body).toEqual({ roles: ["delivery_lead", "account_manager"], includeInGroup: true });
  });

  it("an unconfirmed answer whose roster read fails switches the switches off and points to Open session", async () => {
    // The first read (for the dialog wording) works; the one after the timeout fails.
    let n = 0;
    const f = fakeFetch((url) => {
      if (url.endsWith("/scenarios")) return { status: 200, body: ok(SCENARIOS) };
      if (url.endsWith("/readiness")) {
        n += 1;
        if (n > 1) return { status: 503, body: refused("unreachable", "") };
        return { status: 200, body: ok({ launcherStatus: "running", status: "idle", modelLabel: "m", roster: ROLES.map((roleId) => ({ roleId, joined: false, consented: false, connected: false })), canStart: false, missing: [], aiWaiting: [] }) };
      }
      if (url.endsWith("/ai-roles")) return { status: 504, body: refused("ai_roles_unconfirmed", "") };
      return { status: 200, body: ok(created) };
    });
    render(<NewSessionForm fetch={f.fetch} />);
    await waitFor(() => expect((screen.getByLabelText("Scenario") as HTMLSelectElement).options).toHaveLength(2));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    });
    await screen.findByText("CODE-AM");
    await press("Make Delivery lead an AI player");
    await confirm();
    await screen.findByText(/Open the session to see which roles are AI players/);
    for (const b of screen.getAllByRole("button", { name: /^Make / })) expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("link", { name: "Open session" })).toBeTruthy();
  });

  it("an error leaves the row as it was, shows the BFF copy and returns focus to the switch", async () => {
    await open({ fail: { status: 409, body: refused("ai_too_many", "At most 8 roles can be AI players.") } });
    await press("Make Delivery lead an AI player");
    await confirm();
    await screen.findByText("At most 8 roles can be AI players.");
    expect(screen.getByText("CODE-DL")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Make Delivery lead an AI player" }));
  });

  it("Cancel sends nothing and returns focus to the switch", async () => {
    const f = await open();
    const opener = screen.getByRole("button", { name: "Make Delivery lead an AI player" });
    await press("Make Delivery lead an AI player");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(aiPosts(f)).toHaveLength(0);
    expect(document.activeElement).toBe(opener);
  });

  it("dismissing the join codes keeps the role rows and their switches", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "I have copied the codes" }));
    expect(document.body.textContent).not.toContain("CODE-AM");
    expect(screen.getAllByRole("button", { name: /^Make .* an AI player$/ })).toHaveLength(2);
  });

  it("the created panel shows the checkbox after delivery_lead is switched to AI, and unchecking posts false", async () => {
    const f = await open();
    expect(screen.queryByRole("checkbox")).toBeNull();
    await press("Make Delivery lead an AI player");
    await confirm();
    const box = (await screen.findByRole("checkbox", { name: "Include AI players in group scores" })) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(document.getElementById(box.getAttribute("aria-describedby")!)!.textContent).toContain("You can change this until the start.");
    await act(async () => {
      fireEvent.click(box);
    });
    expect(aiPosts(f)[1]!.body).toEqual({ roles: ["delivery_lead"], includeInGroup: false });
    await waitFor(() => expect(box.disabled).toBe(false));
    expect(box.checked).toBe(false);
    expect(document.activeElement).toBe(box);
    // A later switch keeps the option the facilitator chose.
    await press("Make Account manager an AI player");
    await confirm();
    expect(aiPosts(f)[2]!.body).toEqual({ roles: ["delivery_lead", "account_manager"], includeInGroup: false });
  });


  it("the checkbox applies the roles the answer lists (another tab switched account_manager to AI), and a later post keeps them", async () => {
    const f = await open({ otherTabAi: ["account_manager"] });
    await press("Make Delivery lead an AI player");
    await confirm();
    const box = (await screen.findByRole("checkbox", { name: "Include AI players in group scores" })) as HTMLInputElement;
    await act(async () => {
      fireEvent.click(box);
    });
    await screen.findByRole("button", { name: "Make Account manager human" });
    await waitFor(() => expect(box.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(box);
    });
    expect(aiPosts(f)[2]!.body).toEqual({ roles: ["delivery_lead", "account_manager"], includeInGroup: true });
  });
});
