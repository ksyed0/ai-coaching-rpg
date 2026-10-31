// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
