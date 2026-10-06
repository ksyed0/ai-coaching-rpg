import { describe, expect, it } from "vitest";
import { cleanNpcReply } from "../npc-reply.js";

const role = { id: "cfo", name: "Helena Brandt" };
const others = [{ id: "client_sponsor", name: "Priya Raman" }, { id: "account_manager", name: "Sam Lee" }];
const clean = (s: string) => cleanNpcReply(s, role, others);

describe("cleanNpcReply", () => {
  it("leaves an ordinary reply untouched", () => {
    expect(clean("  The fixed fee is 45k.  ")).toEqual({ text: "The fixed fee is 45k.", cut: false });
  });
  it("cuts a reply that starts with another speaker's tag down to nothing", () => {
    expect(clean("[account_manager]: The fixed fee is 45k")).toEqual({ text: "", cut: true });
  });
  it("cuts at a tag after a line break and keeps the text before it", () => {
    expect(clean("The fixed fee is 45k.\n[client_sponsor]: Not in scope.\n[account_manager]: Then 45k.")).toEqual({ text: "The fixed fee is 45k.", cut: true });
    expect(clean("One.\r\n[ab]: two")).toEqual({ text: "One.", cut: true });
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
    for (const t of ["He wrote [sic] again.", "See [1] for details.", "See [1]: the appendix.", "Costs [approx] 45k: fine.", "A [b]c: d", "Steps:\n[A]: first\n[1]: second\n[b]: third", "Priya Raman said so: yes", "Ask Sam Lee: he knows."]) expect(clean(t)).toEqual({ text: t, cut: false });
  });
  it("catches look-alike brackets, colons, fullwidth letters and hidden characters", () => {
    expect(clean("Fine.\n［client_sponsor］：No.")).toEqual({ text: "Fine.", cut: true });
    expect(clean("Fine.\n【ａｃｃｏｕｎｔ】: No.").cut).toBe(true);
    expect(clean("Fine.\n[acc​ount]: No.")).toEqual({ text: "Fine.", cut: true });
    expect(clean("Fine.\n【xy】: no").text).toBe("Fine.");
  });
  it("handles very long input in linear time", () => {
    const long = "word ".repeat(400_000);
    const t = Date.now();
    expect(clean(long).cut).toBe(false);
    expect(clean(`${long}\n[ab]: x`).text.length).toBe(long.trim().length);
    expect(clean("[".repeat(300_000) + " ".repeat(300_000) + "[a]:").cut).toBe(false);
    expect(clean(" ".repeat(500_000) + "[a]:" + " ".repeat(500_000)).cut).toBe(false);
    expect(cleanNpcReply("ok. " + "x [y]: ".repeat(100_000), role, others).cut).toBe(false);
    expect(cleanNpcReply("<think>" + "a ".repeat(500_000), role).text).toBe("");
    expect(Date.now() - t).toBeLessThan(5_000);
  });

  it("cuts at known roles by name or id, with or without brackets, spaces and quotes", () => {
    expect(clean("Fine.\nPriya Raman: no")).toEqual({ text: "Fine.", cut: true });
    expect(clean("Fine.\nclient_sponsor: no").text).toBe("Fine.");
    expect(clean("Fine.\n[ client_sponsor ]: no").text).toBe("Fine.");
    expect(clean("Fine.\n[Sam Lee]: no").text).toBe("Fine.");
    expect(clean('Fine.\n"[client_sponsor]: no"').text).toBe("Fine.");
    expect(clean("Fine. priya   raman: no").text).toBe("Fine.");
    expect(clean("Fine.\nPRIYA RAMAN : no").text).toBe("Fine.");
    expect(clean("Fine.\n[A]: no", ).cut).toBe(false);
    expect(cleanNpcReply("Fine.\n[A]: no", role, [{ id: "A", name: "Ann" }])).toEqual({ text: "Fine.", cut: true });
  });
  it("cuts after sentence ends without a space, after a comma and after CJK full stops", () => {
    expect(clean("Fine.[client_sponsor]: no").text).toBe("Fine.");
    expect(clean("Fine, [client_sponsor]: no").text).toBe("Fine,");
    expect(clean("好的。[client_sponsor]: 不").text).toBe("好的。");
    expect(clean("好的！ [client_sponsor]: 不").text).toBe("好的！");
    expect(clean("好的。 Priya Raman: 不").text).toBe("好的。");
  });
  it("folds astral tag characters and fullwidth look-alikes", () => {
    const tagChars = String.fromCodePoint(0xe0041, 0xe0042);
    expect(clean(`Fine.\n[client${tagChars}_sponsor]: no`)).toEqual({ text: "Fine.", cut: true });
    expect(clean("Fine.\n［ｃｌｉｅｎｔ＿ｓｐｏｎｓｏｒ］：no").cut).toBe(true);
    expect(clean("Fine.\n［client_sponsor］：no").cut).toBe(true);
    expect(clean("😀 hi. [client_sponsor]: x").text).toBe("😀 hi.");
  });
  it("strips only this character's own id or name, not a bare title", () => {
    expect(clean("Finance: it is 45k")).toEqual({ text: "Finance: it is 45k", cut: false });
    expect(clean("CFO: it is 45k").text).toBe("it is 45k"); // equals this role's id
    expect(clean("Helena Brandt: yes").text).toBe("yes");
    expect(clean("[ cfo ]: yes").text).toBe("yes");
    expect(cleanNpcReply("Helena: hi", role, others).text).toBe("Helena: hi");
  });
  it("drops a leading think block (and an unclosed one means empty), but not one in the middle", () => {
    expect(clean("<think>plan the answer</think>\nIt is 45k.")).toEqual({ text: "It is 45k.", cut: false });
    expect(clean("<THINK>a\nb</Think>It is 45k.").text).toBe("It is 45k.");
    expect(clean("<think>never closed and long")).toEqual({ text: "", cut: false });
    expect(clean("<think>x</think>[client_sponsor]: y")).toEqual({ text: "", cut: true });
    expect(clean("Answer <think>keep</think> text").text).toBe("Answer <think>keep</think> text");
  });
});
