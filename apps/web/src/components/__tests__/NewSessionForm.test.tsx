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
  /** A control service that keeps the AI set it was sent and answers a fresh code for every human role. */
  async function open(fail?: { status: number; body: unknown }) {
    const f = fakeFetch((url, body) => {
      if (url.endsWith("/scenarios")) return { status: 200, body: ok(SCENARIOS) };
      if (url.endsWith("/ai-roles")) {
        if (fail) return fail;
        const roles = (body as { roles: string[] }).roles;
        return { status: 200, body: ok({ roles, codes: ROLES.filter((r) => !roles.includes(r)).map((r) => ({ roleId: r, code: `NEW-${r}` })) }) };
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
  const confirmUse = async () => {
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Use AI player" }));
    });
  };

  it("the created panel shows a toggle per issued code; switching delivery_lead to AI hides its code and reads \"AI player\"", async () => {
    const f = await open();
    expect(screen.getAllByRole("button", { name: /^Make .* an AI player$/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Make Delivery lead an AI player" }));
    // Nobody has joined a just-created session: the primary wording.
    expect(within(screen.getByRole("dialog")).getByText("Fill Delivery lead with an AI player?")).toBeTruthy();
    await confirmUse();
    expect(aiPosts(f)[0]!.body).toEqual({ roles: ["delivery_lead"] });
    await waitFor(() => expect(document.body.textContent).not.toContain("CODE-DL"));
    expect(document.body.textContent).not.toContain("NEW-delivery_lead");
    expect(screen.getByText("CODE-AM")).toBeTruthy();
    const row = screen.getByText("AI player").closest("li")!;
    expect(row.textContent).toContain("Delivery lead");
    expect(screen.queryByRole("button", { name: "Copy code for Delivery lead" })).toBeNull();
    const back = within(row).getByRole("button", { name: "Make Delivery lead human" });
    await waitFor(() => expect(document.activeElement).toBe(back));
  });

  it("a second switch posts the whole AI set, not only the toggled role", async () => {
    const f = await open();
    fireEvent.click(screen.getByRole("button", { name: "Make Delivery lead an AI player" }));
    await confirmUse();
    await screen.findByRole("button", { name: "Make Delivery lead human" });
    fireEvent.click(screen.getByRole("button", { name: "Make Account manager an AI player" }));
    await confirmUse();
    expect(aiPosts(f)[1]!.body).toEqual({ roles: ["delivery_lead", "account_manager"] });
  });

  it("Make human posts the set without it, shows the new code once under \"New code for Delivery lead\" and drops it on dismissal", async () => {
    const f = await open();
    fireEvent.click(screen.getByRole("button", { name: "Make Delivery lead an AI player" }));
    await confirmUse();
    fireEvent.click(await screen.findByRole("button", { name: "Make Delivery lead human" }));
    expect(within(screen.getByRole("dialog")).getByText("Switch Delivery lead back to a human?")).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Switch to human" }));
    });
    expect(aiPosts(f)[1]!.body).toEqual({ roles: [] });
    expect(await screen.findByRole("heading", { name: "New code for Delivery lead" })).toBeTruthy();
    expect(screen.getByText("NEW-delivery_lead")).toBeTruthy();
    // Only the switched role's code is shown; the other human keeps the code it was issued.
    expect(document.body.textContent).not.toContain("NEW-account_manager");
    expect(screen.getByText("CODE-AM")).toBeTruthy();
    expect(screen.queryByText("CODE-DL")).toBeNull();
    const dismiss = screen.getAllByRole("button", { name: "I have copied the codes" });
    fireEvent.click(dismiss[dismiss.length - 1]!);
    expect(document.body.textContent).not.toContain("NEW-delivery_lead");
    expect(screen.getByRole("button", { name: "Make Delivery lead an AI player" })).toBeTruthy();
  });

  it("an error leaves the row as it was, shows the BFF copy and returns focus to the switch", async () => {
    await open({ status: 409, body: refused("ai_too_many", "At most 8 roles can be AI players.") });
    fireEvent.click(screen.getByRole("button", { name: "Make Delivery lead an AI player" }));
    await confirmUse();
    await screen.findByText("At most 8 roles can be AI players.");
    expect(screen.getByText("CODE-DL")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Make Delivery lead an AI player" }));
  });

  it("Cancel sends nothing and returns focus to the switch", async () => {
    const f = await open();
    const opener = screen.getByRole("button", { name: "Make Delivery lead an AI player" });
    fireEvent.click(opener);
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
});
