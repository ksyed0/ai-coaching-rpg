import { describe, expect, it } from "vitest";
import { cleanNpcReply } from "../npc-reply.js";
import { expectLinear } from "../../__tests__/scaling.js";

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
  it("handles very long input in linear time (the cost grows no faster than the input: 8x the input costs far less than 64x)", () => {
    // The sizes below are the full workload at scale 8; scale 1 is an eighth of it. No absolute time bound: see __tests__/scaling.ts.
    const n = (full: number, s: number) => Math.round((full * s) / 8);
    expectLinear((s) => {
      const long = "word ".repeat(n(400_000, s));
      expect(clean(long).cut).toBe(false);
      expect(clean(`${long}\n[ab]: x`).text.length).toBe(long.trim().length);
      expect(clean("[".repeat(n(300_000, s)) + " ".repeat(n(300_000, s)) + "[a]:").cut).toBe(false);
      expect(clean(" ".repeat(n(500_000, s)) + "[a]:" + " ".repeat(n(500_000, s))).cut).toBe(false);
      expect(cleanNpcReply("ok. " + "x [y]: ".repeat(n(100_000, s)), role, others).cut).toBe(false);
      expect(cleanNpcReply("<think>" + "a ".repeat(n(500_000, s)), role).text).toBe("");
    });
  }, 120_000);

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

describe("separator before commentary", () => {
  const role = { id: "cfo", name: "Helena Brandt" };
  it("cuts at a standalone 3+ asterisk or dash separator that is followed by text, without flagging other speakers", () => {
    expect(cleanNpcReply("Give me the number. *** I am asking for the total price.", role)).toEqual({ text: "Give me the number.", cut: false });
    expect(cleanNpcReply("Give me the number.\n----\nExplanation of my intent", role)).toEqual({ text: "Give me the number.", cut: false });
    expect(cleanNpcReply("Fixed fee? ***** And more", role).text).toBe("Fixed fee?");
  });
  it("keeps single and double dashes, em dashes, **bold**, numbers like 5*3 and a trailing separator with nothing after it", () => {
    for (const t of ["Six weeks - not seven", "Six weeks \u2014 not seven", "That is **firm**, not soft.", "Use -- the number", "5*3 is 15, 48-45 is 3", "I want x*** that", "Done. ***", "a --- b"]) {
      if (t === "a --- b") { expect(cleanNpcReply(t, role).text).toBe("a"); continue; }
      expect(cleanNpcReply(t, role).text).toBe(t);
    }
  });
});
