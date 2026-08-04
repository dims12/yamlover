// PORTION ENTRY - the decomposed reference: entering a pointer is the key-value gesture
// repeated (`:` commits a portion, opens the next), the scope ladder climbs in the empty
// first cell, and the whole reference stays in the CURSOR until the joined raw parses on
// commit (cursor-level commits - the document never holds a half-typed reference).
import { describe, it, expect } from "vitest";
import { applyKey, focusPortion, refRawOf, refFromRaw, watchdog } from "../src/apply";
import { joinPortions, portionsOfRaw, splitPortions } from "../src/grammar/portions";
import { initialState, parseSource, sourceOf, type EditorState } from "../src/state";
import { parseScript } from "./keys-util";

function type(script: string, from: EditorState = initialState()): EditorState {
  let s = from;
  for (const k of parseScript(script)) {
    s = applyKey(s, "ch" in k ? { key: k.ch } : k);
    watchdog(s);
  }
  return s;
}

const src = (s: EditorState): string => sourceOf(s.doc);

describe("portions - the pure spelling (raw <-> cells)", () => {
  it("decomposes a bare raw: one cell per step, indices as bare digits", () => {
    expect(portionsOfRaw("pets: 1")).toEqual({ ladder: 0, portions: ["pets", "1"] });
    expect(portionsOfRaw("pets[1]: name")).toEqual({ ladder: 0, portions: ["pets", "1", "name"] });
  });
  it("reads the scope ladder off the opener", () => {
    expect(portionsOfRaw(": humans: 0")).toEqual({ ladder: 1, portions: ["humans", "0"] });
    expect(portionsOfRaw(":: tags: genre")).toEqual({ ladder: 2, portions: ["tags", "genre"] });
  });
  it("keeps `..` its own cell and folds a relindex onto its portion", () => {
    expect(portionsOfRaw("..: x")).toEqual({ ladder: 0, portions: ["..", "x"] });
    expect(portionsOfRaw("..[.-1]")).toEqual({ ladder: 0, portions: ["..[.-1]"] });
  });
  it("joins back under the ladder - the canonical spaced colon form", () => {
    expect(joinPortions(["pets", "1"], 0)).toBe("pets: 1");
    expect(joinPortions(["humans", "0"], 1)).toBe(": humans: 0");
    expect(joinPortions([""], 0)).toBe(""); // empty cells drop; nothing = the bare scope
    expect(joinPortions([""], 2)).toBe("::");
  });
  it("splits tolerantly mid-edit (unterminated quotes own the rest)", () => {
    expect(splitPortions("a: b")).toEqual(["a", "b"]);
    expect(splitPortions("a: 'x: y'")).toEqual(["a", "'x: y'"]);
    expect(splitPortions("a: 'unterm")).toEqual(["a", "'unterm"]);
  });
  it("refFromRaw seeds the LAST cell as active; refRawOf folds the live text back in", () => {
    const seeded = refFromRaw("pets: 1");
    expect(seeded).toEqual({ ref: { ladder: 0, portions: ["pets", "1"], active: 1 }, text: "1" });
    expect(refRawOf({ text: "10", ref: seeded.ref })).toBe("pets: 10");
  });
});

describe("portion entry - typing a reference IS the key-value gesture, many times", () => {
  it("`k: *pets` `:` `1` Enter - `:` splits the portion, Enter joins and commits", () => {
    const s = type("k: *pets: 1{Enter}");
    expect(src(s)).toBe("k: *pets: 1\n");
    expect(s.refused).toBe(false);
  });
  it("the cursor holds the portions while typing - the document stays untouched", () => {
    const s = type("k: *pets: 1");
    expect(src(s)).toBe(""); // cursor-level commits: nothing landed yet
    expect(s.cursor).toMatchObject({ at: "hole", key: "k", text: "1", ref: { ladder: 0, portions: ["pets", ""], active: 1 } });
  });
  it("`:` in the EMPTY FIRST cell climbs the scope ladder; Backspace descends it", () => {
    let s = type("k: *::");
    expect(s.cursor).toMatchObject({ at: "hole", ref: { ladder: 2 } });
    s = type("{Backspace}", s);
    expect(s.cursor).toMatchObject({ at: "hole", ref: { ladder: 1 } });
    s = type("tags{Enter}", s);
    expect(src(s)).toBe("k: *: tags\n");
  });
  it("Backspace on the emptied floor undoes the `*` decision - back to the plain hole", () => {
    let s = type("k: *");
    expect(s.cursor).toMatchObject({ at: "hole", ref: { ladder: 0 } });
    s = type("{Backspace}", s);
    expect(s.cursor).toMatchObject({ at: "hole", key: "k", text: "" });
    expect((s.cursor as { ref?: unknown }).ref).toBeUndefined();
    expect(src(s)).toBe("");
  });
  it("Backspace at a later portion's head MERGES it into the previous one, caret at the join", () => {
    let s = type("k: *pets: 1");
    s = applyKey(s, { key: "Backspace" }, { atStart: true, atEnd: false });
    expect(s.cursor).toMatchObject({ at: "hole", text: "pets1", caret: 4, ref: { portions: ["pets1"], active: 0 } });
  });
  it("`[` in an empty portion folds an INDEX onto the previous one - `pets` `:` `[` spells `pets[|]`", () => {
    let s = type("k: *pets:");
    s = applyKey(s, { key: "[" });
    expect(s.cursor).toMatchObject({ at: "hole", text: "pets[]", caret: 5, ref: { portions: ["pets[]"], active: 0 } });
    // the index typed inside the pair (the DOM inserts at the caret - the onChange path),
    // then Enter: the join normalizes to the canonical bare-digit portion
    s = applyKey({ ...s, cursor: { ...s.cursor, text: "pets[1]" } as never }, { key: "Enter" });
    expect(src(s)).toBe("k: *pets: 1\n");
  });
  it("an UNPARSEABLE join refuses the commit - the ring, the portions stand", () => {
    const s = type("k: *::{Enter}"); // `::` alone names nothing the wire can carry
    expect(s.refused).toBe(true);
    expect(src(s)).toBe("");
    expect(s.cursor).toMatchObject({ at: "hole", ref: { ladder: 2 } });
  });
  it("the arrows walk BETWEEN portions commitlessly", () => {
    let s = type("k: *pets: 1");
    s = applyKey(s, { key: "ArrowLeft" }, { atStart: true, atEnd: false });
    expect(s.cursor).toMatchObject({ text: "pets", caret: "end", ref: { portions: ["pets", "1"], active: 0 } });
    s = applyKey(s, { key: "ArrowRight" }, { atStart: false, atEnd: true });
    expect(s.cursor).toMatchObject({ text: "1", caret: "start", ref: { active: 1 } });
  });
  it("focusPortion (a click on an idle cell) moves the active cell, the leaving text stands", () => {
    let s = type("k: *pets: 1");
    s = focusPortion(s, 0);
    expect(s.cursor).toMatchObject({ text: "pets", ref: { portions: ["pets", "1"], active: 0 } });
  });
});

describe("portion retarget - Enter on the atom opens the decomposed raw", () => {
  const load = (text: string): EditorState =>
    ({ doc: parseSource(text), cursor: { at: "ptr", path: [0] }, refused: false, log: [] });
  it("the raw decomposes; editing one portion and committing respells the whole reference", () => {
    let s = load("a: *pets: 1\n");
    s = applyKey(s, { key: "Enter" });
    expect(s.cursor).toMatchObject({ at: "pick", text: "1", ref: { ladder: 0, portions: ["pets", "1"], active: 1 } });
    s = applyKey({ ...s, cursor: { ...s.cursor, text: "2" } as never }, { key: "Enter" });
    expect(src(s)).toBe("a: *pets: 2\n");
  });
  it("a document-scoped raw seeds its ladder", () => {
    let s = load("a: *: humans: 0\n");
    s = applyKey(s, { key: "Enter" });
    expect(s.cursor).toMatchObject({ at: "pick", ref: { ladder: 1, portions: ["humans", "0"], active: 1 } });
  });
  it("the emptied single portion + Backspace removes the reference (the floor)", () => {
    let s = load("k: *x\n");
    s = applyKey(s, { key: "Enter" });
    s = applyKey({ ...s, cursor: { ...s.cursor, text: "" } as never }, { key: "Backspace" }, { atStart: true, atEnd: true });
    // the reference went; the NAME survives as the named hole (one press, one level)
    expect(src(s)).toBe("");
    expect(s.cursor).toEqual({ at: "hole", path: [], index: 0, text: "", key: "k" });
  });
});
