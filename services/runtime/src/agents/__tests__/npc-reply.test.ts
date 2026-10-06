import { describe, expect, it } from "vitest";
import { cleanNpcReply } from "../npc-reply.js";

const role = { id: "cfo", name: "Helena Brandt" };
const clean = (s: string) => cleanNpcReply(s, role);

describe("cleanNpcReply", () => {
  it("leaves an ordinary reply untouched", () => {
    expect(clean("  The fixed fee is 45k.  ")).toEqual({ text: "The fixed fee is 45k.", cut: false });
  });
  it("cuts a reply that starts with another speaker's tag down to nothing", () => {
    expect(clean("[account_manager]: The fixed fee is 45k")).toEqual({ text: "", cut: true });
  });
  it("cuts at a tag after a line break and keeps the text before it", () => {
    expect(clean("The fixed fee is 45k.\n[client_sponsor]: Not in scope.\n[account_manager]: Then 45k.")).toEqual({ text: "The fixed fee is 45k.", cut: true });
    expect(clean("One.\r\n[a]: two")).toEqual({ text: "One.", cut: true });
    expect(clean("One. ⏎ not a break [a]: x").cut).toBe(false);
  });
  it("cuts at a tag after a sentence on the same line", () => {
    expect(clean("We are done. [client_sponsor]: Agreed.")).toEqual({ text: "We are done.", cut: true });
    expect(clean("Done! [client_sponsor] : Agreed.").text).toBe("Done!");
  });
  it("strips a prefix naming the character itself, without calling it a cut", () => {
    for (const p of ["[cfo]: ", "[Helena Brandt]: ", "cfo: ", "Helena Brandt: ", "[CFO] : "]) expect(clean(`${p}It is 45k.`)).toEqual({ text: "It is 45k.", cut: false });
  });
  it("strips the own prefix and then still cuts at another speaker", () => {
    expect(clean("[cfo]: It is 45k.\n[client_sponsor]: No.")).toEqual({ text: "It is 45k.", cut: true });
  });
  it("reproduces the observed raw-model reply", () => {
    const r = clean("The fixed fee is 45k ... \n[client_sponsor]: The module is not in scope; we will not pay for it.\n[account_manager]: Then the total cost is 45k.");
    expect(r).toEqual({ text: "The fixed fee is 45k ...", cut: true });
  });
  it("keeps square brackets that are not speaker tags", () => {
    for (const t of ["He wrote [sic] again.", "See [1] for details.", "See [1]: the appendix.", "Costs [approx] 45k: fine.", "A [b]c: d"]) expect(clean(t)).toEqual({ text: t, cut: false });
  });
  it("catches look-alike brackets, colons, fullwidth letters and hidden characters", () => {
    expect(clean("Fine.\n［client_sponsor］：No.")).toEqual({ text: "Fine.", cut: true });
    expect(clean("Fine.\n【ａｃｃｏｕｎｔ】: No.").cut).toBe(true);
    expect(clean("Fine.\n[acc​ount]: No.")).toEqual({ text: "Fine.", cut: true });
    expect(clean("Fine.\n【x】: no").text).toBe("Fine.");
  });
  it("handles very long input in linear time", () => {
    const long = "word ".repeat(400_000);
    let t = Date.now();
    expect(clean(long).cut).toBe(false);
    expect(clean(`${long}\n[a]: x`).text.length).toBe(long.trim().length);
    expect(clean("[".repeat(300_000) + " ".repeat(300_000) + "[a]:").cut).toBe(false);
    expect(Date.now() - t).toBeLessThan(3_000);
    t = 0;
  });
});
