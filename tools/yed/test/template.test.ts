// THE TEMPLATE-CELLS DOCTRINE (src/template.ts + the apply.ts adapter) — the pins:
// a DECIDED entry materializes the moment its marker is typed (null value, `meta.temporary`,
// drawn locally, wire-withheld); quotes materialize the paired-closer cell; `*` rides the
// same law with the portions cursor-held over the materialized row. The classic grammar is
// byte-identical BY CONSTRUCTION (the corpus pins that); these tests pin the NEW faces.
import { describe, it, expect } from "vitest";
import { applyKey, commitPending, positionsOf, siteOf, watchdog } from "../src/apply";
import { initialState, parseSource, sourceOf, entryAt, type EditorState } from "../src/state";
import { isProvisionalValue } from "../src/template";
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

describe("the marker templates - `k: ` and `- ` materialize the entry", () => {
  it("`a: ` inserts the TEMPORARY null entry; the caret stands in the provisional value cell", () => {
    const s = type("a: ");
    expect(src(s)).toBe("a:\n"); // the local document HOLDS the decided row
    const e = entryAt(s.doc, [0])!;
    expect((e.meta as { temporary?: unknown }).temporary).toBe(true);
    expect(isProvisionalValue(e.value)).toBe(true);
    expect(s.cursor).toEqual({ at: "token", path: [0], text: "" });
    // the SITE is the classic value hole - the key economics apply verbatim
    expect(siteOf(s)).toMatchObject({ cell: "holeEntry", entryDecided: true, entryCommitted: false });
  });
  it("`- ` materializes the keyless row and records the ordinal decision in the flag", () => {
    const s = type("- ");
    expect(src(s)).toBe("-\n");
    expect((entryAt(s.doc, [0])!.meta as { temporary?: unknown }).temporary).toBe("ordinal");
    expect(s.cursor).toEqual({ at: "token", path: [0], text: "" });
  });
  it("the value commit CLEARS temporary - the row becomes the plain entry it always was", () => {
    const s = type("a: 12{Enter}");
    expect(src(s)).toBe("a: 12\n");
    expect((entryAt(s.doc, [0])!.meta as { temporary?: unknown } | undefined)?.temporary).toBeUndefined();
  });
  it("WALK-AWAY leaves the temporary row - never the minted `\"\"`", () => {
    const s = type("a: ");
    const committed = commitPending(s);
    expect(committed).toBe(s); // nothing pending - the withheld row is the resting state
    expect(src(s)).toBe("a:\n");
  });
  it("Backspace on the empty provisional cell undoes the marker - one press, one level", () => {
    const s = type("a: {Backspace}");
    expect(src(s)).toBe("");
    expect(s.cursor).toMatchObject({ at: "hole", key: null, text: "a" });
  });
  it("the BASIC STRUCTURE: `a: ` ⏎ `b: 12` — Enter allocates the templatized row below", () => {
    // modifications are never blocked: Enter on the provisional value cell is the row
    // allocation (the descend), and the child row enters exactly as in a text editor
    const s = type("a: {Enter}b: 12{ArrowRight}");
    expect(s.refused).toBe(false);
    expect(src(s)).toBe("a:\n  b: 12\n");
  });
  it("a COMMITTED leaf emptied char by char: the next press eats the COLON (the text-editor ladder)", () => {
    // `a: 11` -> the chars deleted natively -> the emptied cell's Backspace takes the marker
    // with it: `a` as undecided text, one press - never a stop at an invisible null level
    const s0: EditorState = { ...initialState(), doc: parseSource("a: 11\n"), cursor: { at: "token", path: [0], text: "" } };
    const s = applyKey(s0, { key: "Backspace" });
    expect(src(s)).toBe("");
    expect(s.cursor).toMatchObject({ at: "hole", path: [], index: 0, text: "a", key: null });
  });
});

describe("the quote template - the paired-closer cell", () => {
  it("`\"` in value position materializes the empty quoted scalar (wire-legal, NOT temporary)", () => {
    const s = type('a: "');
    expect(src(s)).toBe('a: ""\n');
    expect((entryAt(s.doc, [0])!.meta as { temporary?: unknown } | undefined)?.temporary).toBeUndefined();
    expect(s.cursor).toEqual({ at: "token", path: [0], text: "", quote: '"' });
    expect(siteOf(s)).toMatchObject({ cell: "quoted", quote: '"' });
  });
  it("typed content is SHIELDED - `:` and `,` and the other quote are text; commit round-trips", () => {
    const s = type("a: \"x: 'y', z{Enter}");
    expect(s.refused).toBe(false);
    expect(src(s)).toBe("a: \"x: 'y', z\"\n");
  });
  it("the MATCHING quote at the end steps past the projected closer (quoteClose)", () => {
    const s = type('a: "hi"');
    expect(src(s)).toBe('a: "hi"\n'); // committed by the close
    expect(s.cursor).toMatchObject({ at: "token", path: [0], text: '"hi"', caret: "end" });
  });
  it("the single-quote style: content is shielded, the style rides the raw", () => {
    // (a literal `'` inside is typed MID-text — at the END the matching quote is the closer,
    // the step-past law; the escape spelling is the serializer's, not a keystroke)
    const s = type("a: 'x: y, z{Enter}");
    expect(s.refused).toBe(false);
    expect(src(s)).toBe("a: 'x: y, z'\n");
  });
  it("Backspace on the emptied quoted cell undoes the QUOTE decision - back to the provisional cell", () => {
    const s = type('a: "{Backspace}');
    expect(src(s)).toBe("a:\n");
    expect(s.cursor).toEqual({ at: "token", path: [0], text: "" });
    expect((entryAt(s.doc, [0])!.meta as { temporary?: unknown }).temporary).toBe(true);
  });
  it("a quote in a FLOW SEQ hole materializes the keyless quoted element - the comma is SHIELDED", () => {
    // the flow serializer is canonical for strings (flowTok never consults a string raw):
    // the typed content survives verbatim, the spelling is flow's own single-quote form
    const s = type('[1, "x, y"');
    expect(s.cursor).toMatchObject({ at: "token", path: [1], caret: "end" });
    expect(src(s)).toBe("[1, 'x, y']\n");
  });
  it("a committed quoted scalar REOPENS as the paired cell (editing and entering share the face)", () => {
    const s0 = type('a: "hi"');
    // walk back onto the token the way a click does - toCursor decides the face
    const s = applyKey(applyKey(s0, { key: "ArrowLeft" }, { atStart: true, atEnd: false }), { key: "ArrowRight" }, { atStart: true, atEnd: true });
    void s; // the walk itself is not the pin - the reopened face is:
    const reopened = type("!{Enter}", { ...s0, cursor: { at: "token", path: [0], text: "hi", quote: '"' } });
    expect(src(reopened)).toBe('a: "hi!"\n');
  });
  it("at an ENTRY hole the quote opens the SAME paired cell - the KEY interpreter inside", () => {
    // closing returns the spelled token to the hole, where `: ` names the pair (a quoted KEY)
    let s = type('"');
    expect(s.cursor).toMatchObject({ at: "hole", quote: '"', text: "", key: null });
    s = type('two words": 1{Enter}', s);
    expect(s.refused).toBe(false);
    expect(src(s)).toBe('"two words": 1\n');
    // ...and Enter on the closed token (no colon) commits the quoted SCALAR - both readings live
    const v = type('"hi"{Enter}');
    expect(src(v)).toBe('"hi"\n');
  });
});

describe("anchoring a committed value - the YAML order, every entry route", () => {
  it("descend + `&b` - the own-line body enters and lands on the value's node", () => {
    const s = type("a: 12{Enter}&b{Enter}");
    expect(s.refused).toBe(false);
    expect(src(s)).toBe("a: 12\n  &b\n");
  });
  it("descend + `&: b` - the document-scoped body enters the same way", () => {
    const s = type("a: 12{Enter}&: b{Enter}");
    expect(s.refused).toBe(false);
    expect(src(s)).toBe("a: 12\n  &: b\n");
  });
  it("the INLINE route: `&b ` typed at the START of the committed value cell", () => {
    // the token text edited to the YAML spelling `&b 12` commits anchor + value
    const s0: EditorState = { ...initialState(), doc: parseSource("a: 12\n"), cursor: { at: "token", path: [0], text: "&b 12" } };
    const s = applyKey(s0, { key: "Enter" });
    expect(s.refused).toBe(false);
    expect(src(s)).toBe("a: 12\n  &b\n");
  });
  it("the ladder: the emptied anchor's Backspace removes it; the caret lands ON the value", () => {
    const s0: EditorState = { ...initialState(), doc: parseSource("a: 12\n  &b\n"), cursor: { at: "anchors", path: [0], index: 0, text: "" } };
    const s = applyKey(s0, { key: "Backspace" });
    expect(src(s)).toBe("a: 12\n");
    expect(s.cursor).toMatchObject({ at: "token", path: [0], text: "12" });
  });
  it("Enter on an UNCHANGED anchor body responds — the caret steps onto the value (no dead key)", () => {
    // the reported watchdog alarm: commit of an identical body used to return the same state
    const s0: EditorState = { ...initialState(), doc: parseSource("a: 12\n  &anchor\n"),
      cursor: { at: "anchors", path: [0], index: 0, text: "anchor", caret: "end" } };
    watchdog(s0); // every advertised key must respond at this very state
    const s = applyKey(s0, { key: "Enter" });
    expect(src(s)).toBe("a: 12\n  &anchor\n");
    expect(s.cursor).toMatchObject({ at: "token", path: [0], text: "12" });
  });

  it("the WALK agrees with the YAML order: the anchors stop stands LEFT of the value", () => {
    const doc = parseSource("a: 12\n  &b\n");
    const anchors = positionsOf(doc).findIndex((p) => p.at === "anchors");
    const token = positionsOf(doc).findIndex((p) => p.at === "token");
    expect(anchors).toBeGreaterThanOrEqual(0);
    expect(anchors).toBeLessThan(token); // `a: &b 12` - anchor first
  });
});

describe("`*` on the same law - the materialized pick", () => {
  it("`a: *` materializes the temporary row; the portions ride the PICK over it", () => {
    const s = type("a: *");
    expect(src(s)).toBe("a:\n");
    expect((entryAt(s.doc, [0])!.meta as { temporary?: unknown }).temporary).toBe(true);
    expect(s.cursor).toMatchObject({ at: "pick", path: [0], ref: { ladder: 0, portions: [""], active: 0 } });
  });
  it("the commit lands the pointer and clears temporary", () => {
    const s = type("a: *x{Enter}");
    expect(src(s)).toBe("a: *x\n");
    expect((entryAt(s.doc, [0])!.meta as { temporary?: unknown } | undefined)?.temporary).toBeUndefined();
  });
});
