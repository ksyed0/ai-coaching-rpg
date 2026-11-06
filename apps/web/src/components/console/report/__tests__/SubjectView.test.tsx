// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { fakeFetch, ok, refused } from "../../../../lib/__tests__/fakes";
import { SubjectView } from "../SubjectView";
import { BASE, SID, criterion, subjectView } from "./fixtures";

afterEach(cleanup);

const PATH = `${BASE}/subjects/account_manager`;
const STALE = "Someone changed this. Reload the level and try again.";

function mount(view: unknown, writes: (url: string, body: unknown) => { status: number; body: unknown } = () => ({ status: 200, body: ok({}) }), author: string | null = "kamal") {
  const f = fakeFetch((url, body) => (body !== undefined ? writes(url, body) : url === PATH ? { status: 200, body: ok(view) } : { status: 404, body: refused("not_found", "x") }));
  render(<SubjectView sessionId={SID} subject="account_manager" author={author} fetch={f.fetch} />);
  return f;
}
const posts = (f: ReturnType<typeof fakeFetch>) => f.calls.filter((c) => c.init.method === "POST");

describe("SubjectView", () => {
  it("shows each criterion's level, status, rationale and evidence as text", async () => {
    mount(subjectView({ criteria: [criterion({ selfLevel: 2, flags: ["thin evidence"] })] }));
    expect(await screen.findByRole("heading", { name: "Clarity" })).toBeTruthy();
    expect(screen.getByText("Level 3")).toBeTruthy();
    expect(screen.getByText("Needs review")).toBeTruthy();
    expect(screen.getByText("Self-rating: level 2")).toBeTruthy();
    expect(screen.getByText("Stated the plan.")).toBeTruthy();
    expect(screen.getByText("We start Monday.")).toBeTruthy();
    expect(screen.getByText("thin evidence")).toBeTruthy();
  });

  it("Save is disabled until a reason is typed", async () => {
    const f = mount(subjectView());
    fireEvent.click(await screen.findByRole("button", { name: "Edit Clarity" }));
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("New level"), { target: { value: "4" } });
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason (required)"), { target: { value: "   " } });
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason (required)"), { target: { value: "Heard it twice." } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(posts(f)).toHaveLength(1));
    // `expect` is the level shown when the form opened, sent behind the scenes
    expect(posts(f)[0]!.url).toBe(`${PATH}/edit`);
    expect(posts(f)[0]!.body).toEqual({ criterion: "clarity", level: 4, reason: "Heard it twice.", expect: "3", by: "kamal" });
  });

  it("a stale edit keeps the typed reason and comment and shows the stale sentence", async () => {
    mount(subjectView(), (url) => (url.endsWith("/edit") ? { status: 409, body: refused("stale", "SERVER TEXT") } : { status: 200, body: ok({}) }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit Clarity" }));
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Check the second scene." } });
    fireEvent.change(screen.getByLabelText("New level"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Reason (required)"), { target: { value: "Only once." } });
    fireEvent.change(screen.getByLabelText("Rationale (optional)"), { target: { value: "Said it late." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(STALE)).toBeTruthy();
    expect(screen.queryByText("SERVER TEXT")).toBeNull();
    expect((screen.getByLabelText("Reason (required)") as HTMLTextAreaElement).value).toBe("Only once.");
    expect((screen.getByLabelText("Rationale (optional)") as HTMLTextAreaElement).value).toBe("Said it late.");
    expect((screen.getByLabelText("Comment") as HTMLTextAreaElement).value).toBe("Check the second scene.");
  });

  it("a \"<b>\" in a comment stays literal text", async () => {
    const f = mount(subjectView({ comments: [{ visibility: "internal", text: "<b>bold</b> & <i>x</i>" }] }));
    const shown = await screen.findByText("<b>bold</b> & <i>x</i>");
    expect(shown.querySelector("b")).toBeNull();
    expect(document.querySelector(".report-subject b")).toBeNull();
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "<b>new</b>" } });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    await waitFor(() => expect(posts(f)).toHaveLength(1));
    expect(posts(f)[0]!.body).toEqual({ text: "<b>new</b>", by: "kamal" });
  });

  it("accepts a criterion and the summary, and writes stay disabled without a valid name", async () => {
    const f = mount(subjectView());
    fireEvent.click(await screen.findByRole("button", { name: "Accept Clarity" }));
    await waitFor(() => expect(posts(f)).toHaveLength(1));
    expect(posts(f)[0]).toMatchObject({ url: `${PATH}/accept`, body: { criterion: "clarity", by: "kamal" } });
    fireEvent.click(screen.getByRole("button", { name: "Accept the summary" }));
    await waitFor(() => expect(posts(f)).toHaveLength(2));
    expect(posts(f)[1]!.body).toEqual({ summary: true, by: "kamal" });
    cleanup();

    mount(subjectView(), undefined, null);
    expect(((await screen.findByRole("button", { name: "Accept Clarity" })) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Edit Clarity" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Add comment" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
