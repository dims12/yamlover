// yed2 D2 GATE — the pure edit layer: keystrokes in, IR out, no DOM anywhere. Every case asserts
// the SERIALIZED document (the file that would be written) and that the editor never claimed an
// edit it refused.
import { describe, it, expect } from "vitest";
import { applyKey, applyText, blockBodyOf, blockEditText, blockTextFrom, commitPending, copySubtree, pasteSubtree, positionsOf, watchdog } from "../src/apply";
import { initialState, parseSource, sourceOf, type EditorState } from "../src/state";
import { parseScript } from "./keys-util";

/** Type a script from the empty document — THE WATCHDOG runs after every keystroke: in every
 *  state these tests pass through, every advertised key must respond (a dead key throws). */
function type(script: string, from: EditorState = initialState()): EditorState {
  let s = from;
  for (const k of parseScript(script)) {
    s = applyKey(s, "ch" in k ? { key: k.ch } : k);
    watchdog(s);
  }
  return s;
}

const src = (s: EditorState): string => sourceOf(s.doc);

describe("yed2 typing — flow", () => {
  it("a flow seq with commas", () => {
    expect(src(type("[1, 2]"))).toBe("[1, 2]\n");
  });
  it("a flow map with a named pair", () => {
    expect(src(type("{{key: 12}"))).toBe("{key: 12}\n");
  });
  it("two pairs", () => {
    expect(src(type("{{a: 1, b: 2}"))).toBe("{a: 1, b: 2}\n");
  });
  it("nesting", () => {
    expect(src(type("[[1], [2, 3]]"))).toBe("[[1], [2, 3]]\n");
  });
  it("Enter spreads to K&R", () => {
    expect(src(type("[1{Enter}2]"))).toBe("[\n  1,\n  2\n]\n");
  });
  it("Enter inside a nested token spreads the WHOLE token", () => {
    expect(src(type("{{p: [1{Enter}2]"))).toBe("{\n  p: [\n    1,\n    2\n  ]\n}\n");
  });
  it("the reported document", () => {
    expect(src(type("[{{key: 12}, {{key: 13}]"))).toBe("[{key: 12}, {key: 13}]\n");
  });
  it("PER-CONTAINER LAYOUT: a token typed inside a spread one defaults to ONE LINE", () => {
    // [ Enter { … } , { … } ] — the outer is K&R, the inners stay tight until THEIR OWN Enter
    expect(src(type("[{Enter}{{a: 1}, {{b: 2}]"))).toBe("[\n  {a: 1},\n  {b: 2}\n]\n");
  });
  it("…and spreading an inner spreads its ancestors too (a one-liner cannot hold a multi-liner)", () => {
    expect(src(type("{{p: [1{Enter}2]"))).toBe("{\n  p: [\n    1,\n    2\n  ]\n}\n");
  });
  it("an empty map and an empty seq stay distinct", () => {
    expect(src(type("{{}"))).toBe("{}\n");
    expect(src(type("[]"))).toBe("[]\n");
  });
});

describe("yed2 quoted tokens", () => {
  it("a QUOTED KEY names the pair — the reported `{\"name\": \"Eurasia\"}`", () => {
    const s = type('{{"name": "Eurasia"}');
    expect(s.refused).toBe(false);
    // the KEY keeps its authored quotes (EntryMeta.keyRaw — representation is committed
    // labour); the simple string VALUE still normalizes to bare (either spelling reads back)
    expect(src(s)).toBe('{"name": Eurasia}\n');
  });
  it("a quoted key that NEEDS its quotes keeps them — in the AUTHORED style", () => {
    expect(src(type('{{"two words": 1}'))).toBe('{"two words": 1}\n');
  });
  it("quoted VALUES in a seq (simple strings normalize to bare)", () => {
    expect(src(type('["a", "b"]'))).toBe("[a, b]\n");
  });
  it("a value that NEEDS its quotes keeps them", () => {
    expect(src(type('["a b"]'))).toBe("['a b']\n");
  });
});

describe("yed2 refusals — visible, and nothing half-applied", () => {
  it("moving away NEVER drops pending text — it refuses and stays", () => {
    // reported as `{"key": value` + Right vanishing (that exact text now COMMITS — quoted keys
    // are recognized); the law is pinned with text that still cannot land: an unnamed element in
    // a `{`. The hole lives only in the cursor, so a move that cannot commit must refuse.
    const s = type("{{12{ArrowRight}");
    expect(s.refused).toBe(true);
    expect(s.cursor.at).toBe("hole");
    expect((s.cursor as { text: string }).text).toBe("12"); // still there, still fixable
  });
  it("`}` on an unnamed element in a `{` refuses and keeps everything", () => {
    const s = type("{{12}");
    expect(s.refused).toBe(true);
    expect(src(s)).toBe("{}\n");            // the document did not take the invalid close
    expect(s.cursor.at).toBe("hole");       // the text is still there to fix
    expect((s.cursor as { text: string }).text).toBe("12");
  });
  it("…and naming the pair afterwards continues normally", () => {
    expect(src(type("{{12: 3}"))).toBe("{12: 3}\n");
  });
  it("the wrong closer refuses", () => {
    const s = type("[1]");
    expect(src(s)).toBe("[1]\n");
    const bad = type("[1}");
    expect(bad.refused).toBe(true);
    expect(src(bad)).toBe("[]\n"); // the `1` is still pending in the cursor, not lost
  });
  it("a comma on an untouched hole refuses", () => {
    expect(type("[,").refused).toBe(true);
  });
});

describe("yed2 — THE WATCHDOG: every key the LEGEND lights up must RESPOND", () => {
  // The keycaps are drawn from `interpret` (the grammar); the effects live in applyIntent. The
  // reported Tab bug was a SEAM between the two: the grammar claimed the key, the applier had no
  // case, the browser default ran. watchdog() pins the invariant one keystroke deep — a changed
  // document, a moved caret, or a visible refusal. NEVER a dead key. (type() also runs it after
  // every keystroke of every script in this file.)
  const STATES = ["", "[", "[1, ", "{{", "{{key: ", "- ", "k:{Enter}", "[1]",
    "- name: Eurasia{Enter}{ShiftTab}children:{Enter}{ShiftTab}", "[{Enter}1, 2]",
    "- name: Eurasia{Enter}{ShiftTab}children:{Enter}{ShiftTab}{ArrowUp}"];
  for (const script of STATES) {
    it(`state ${JSON.stringify(script)} — no enabled keycap is dead`, () => {
      watchdog(type(script)); // type() already watched every intermediate state
    });
  }
});

describe("yed2 — Tab and Shift-Tab are inverses (THE LEVEL RULE)", () => {
  it("a mistaken climb is undone by Tab — the hole returns INSIDE the previous sibling", () => {
    const s = type("- name: Eurasia{Enter}{ShiftTab}children:{Enter}{ShiftTab}{Tab}- name: Europe{ArrowRight}");
    expect(s.refused).toBe(false);
    expect(src(s)).toBe("- name: Eurasia\n  children:\n    - name: Europe\n");
  });
  it("Tab with nothing before the hole refuses — visibly, never a fall-through", () => {
    const s = type("children:{Enter}{Tab}");
    expect(s.refused).toBe(true);
    expect(s.cursor).toMatchObject({ at: "hole", path: [0], index: 0 });
  });
  it("the reported LOCK: ⇤ then ↑ from an empty children WALKS BACK INSIDE it", () => {
    // `children:` ⏎ ⇤ ↑ stranded the caret with the empty value unreachable — the empty block
    // container had no position and no cell. Now it has an `into` slot: ↑ lands the hole back
    // inside children, and typing simply continues.
    const s = type("- name: Eurasia{Enter}{ShiftTab}children:{Enter}{ShiftTab}{ArrowUp}");
    expect(s.cursor).toEqual({ at: "hole", path: [0, 1], index: 0, text: "", key: null, head: true }); // the walked-in VACANT-HEAD face
    const s2 = type("- name: Europe{ArrowRight}", s);
    expect(src(s2)).toBe("- name: Eurasia\n  children:\n    - name: Europe\n");
  });
});

describe("yed2 vertical walk — ↑/↓ move by ROWS", () => {
  it("↑ lands on the PREVIOUS ROW's value, not this row's key; the top edge refuses", () => {
    const s = type("key1: 12{Enter}{ShiftTab}key2: 13{ArrowRight}");
    const up = type("{ArrowUp}", s);
    expect(up.cursor).toEqual({ at: "token", path: [0], text: "12", caret: "end" });
    expect(type("{ArrowUp}", up).refused).toBe(true);          // the document's top — visibly
    const down = type("{ArrowDown}", up);
    expect(down.cursor).toMatchObject({ at: "token", path: [1], text: "13" });
  });
});

describe("yed2 — THE CONVERSION LADDER (Backspace at a block value's start)", () => {
  it("keyed → ordered → the SCALAR value; a taken scalar slot refuses", () => {
    const s = type("- value1{Enter}{ShiftTab}key2: value2{ArrowRight}");
    expect(src(s)).toBe("- value1\nkey2: value2\n");
    // the caret stands at the START of the committed value2 (a click + Home)
    const at = (st: EditorState, path: number[], text: string): EditorState =>
      ({ ...st, cursor: { at: "token", path, text }, refused: false });
    const u1 = applyKey(at(s, [1], "value2"), { key: "Backspace" }, { atStart: true, atEnd: false });
    expect(src(u1)).toBe("- value1\n- value2\n");            // the name went, the value stayed
    const u2 = applyKey(at(u1, [1], "value2"), { key: "Backspace" }, { atStart: true, atEnd: false });
    expect(src(u2)).toBe("- value1\nvalue2\n");              // now the container's OWN value — ON ITS ROW
    expect(u2.cursor).toEqual({ at: "token", path: [], text: "value2", caret: "start" });
    // the slot is taken — converting value1 too refuses, visibly
    const u3 = applyKey(at(u2, [0], "value1"), { key: "Backspace" }, { atStart: true, atEnd: false });
    expect(u3.refused).toBe(true);
    expect(src(u3)).toBe("- value1\nvalue2\n");
  });
});

describe("yed2 — ORDER is committed labour (meta.selfAt)", () => {
  it("a trailing scalar KEEPS its row: `key1: value1` then `scalar` serializes in typed order", () => {
    const s = type("key1: value1{Enter}{ShiftTab}scalar{ArrowRight}");
    expect(src(s)).toBe("key1: value1\nscalar\n");
  });
});

describe("yed2 — a colon in the VALUE place extends the key path (FLAT rows)", () => {
  // The FILE grammar reads the bare `key1: key2: value` line as a FLAT row
  // (docs/language/flattening), and the cells mirror it: `k2: ` typed in a NAMED value hole
  // PIVOTS — the entry lands holding a fresh block mapping and the same hole continues inside
  // it as the next segment, wearing the yamlover/key/flat concrete so the serializer re-emits
  // the authored fold. The QUOTE face is the escape for a literal `a: b` string — exactly the
  // spelling the file itself requires.
  it("`key1: key2: value` builds the flat chain and the file keeps the fold", () => {
    const s = type("key1: key2: value{ArrowRight}");
    expect(s.refused).toBe(false);
    expect(src(s)).toBe("key1: key2: value\n");
  });
  it("`a: a: a: 12` — the model is the NESTED chain, segments after the first flat-marked", () => {
    const s = type("a: a: a: 12{ArrowRight}");
    expect(src(s)).toBe("a: a: a: 12\n");
    const root = s.doc.root as unknown as { entries: { key: string; meta?: { keyConcrete?: string }; value: { kind: string; value?: unknown; entries?: unknown[] } }[] };
    const e1 = root.entries[0];
    expect(e1.key).toBe("a");
    expect(e1.meta?.keyConcrete).toBeUndefined(); // the FIRST segment owns the line, spells normally
    const e2 = (e1.value.entries as typeof root.entries)[0];
    expect(e2.key).toBe("a");
    expect(e2.meta?.keyConcrete).toBe("yamlover/key/flat");
    const e3 = (e2.value.entries as typeof root.entries)[0];
    expect(e3.key).toBe("a");
    expect(e3.meta?.keyConcrete).toBe("yamlover/key/flat");
    expect(e3.value).toMatchObject({ kind: "scalar", value: 12 });
  });
  it("the caret ends on the LEAF token; the walk crosses the fold cell by cell", () => {
    const s = type("a: b: 12{ArrowRight}");
    expect(s.cursor).toMatchObject({ at: "token", path: [0, 0], text: "12" });
    const l1 = type("{ArrowLeft}", s);
    expect(l1.cursor).toMatchObject({ at: "key", path: [0, 0], text: "b" });
    const l2 = type("{ArrowLeft}", l1);
    expect(l2.cursor).toMatchObject({ at: "hole", path: [0], index: 0, head: true }); // a's head slot
    const l3 = type("{ArrowLeft}", l2);
    expect(l3.cursor).toMatchObject({ at: "key", path: [0], text: "a" });
  });
  it("Backspace unwinds the pivot symmetrically — the ladder back to the empty document", () => {
    const s = type("a: b: "); // the pivot armed: the provisional segment `b` inside `a`'s chain
    expect(src(s)).toBe("a: b:\n"); // the fold spells even the provisional chain
    const b1 = type("{Backspace}", s); // the pivot undone — `b` back as hole TEXT (one press, one level)
    expect(b1.cursor).toMatchObject({ at: "hole", path: [0], index: 0, key: null, text: "b" });
    const b2 = type("{Backspace}", applyText(b1, "")); // level removed — a's provisional value cell again
    expect(b2.cursor).toMatchObject({ at: "token", path: [0], text: "" });
    const b3 = type("{Backspace}", b2); // un-named — `a` back as hole text
    expect(b3.cursor).toMatchObject({ at: "hole", path: [], index: 0, key: null, text: "a" });
    expect(src(b3)).toBe("");
    expect(type("{Backspace}", applyText(b3, "")).refused).toBe(true); // the bottom, visibly
  });
  it("the QUOTE face is the escape — the literal string still enters, quoted", () => {
    const s = type("key1: 'key2: value'{ArrowRight}");
    expect(src(s)).toBe("key1: 'key2: value'\n");
  });
  it("the LEVEL RULE holds at the leaf: Enter descends into the committed value's fields", () => {
    const s = type("a: b: 12{Enter}sub: x{ArrowRight}");
    expect(src(s)).toBe("a: b: 12\n  sub: x\n"); // the field ONE step under the row — the flat key indents like a normal key
  });
  it("`c:` + Enter in the chain DESCENDS — the segment opens its block, never a null commit", () => {
    // the reported dead end: the bare-colon text committed `c` as a NULL leaf and the level
    // rule descended INTO the scalar, where every commit refused beside an empty token cell
    const s = type("a: b: c:{Enter}");
    expect(s.cursor).toMatchObject({ at: "hole", path: [0, 0, 0], index: 0, key: null });
    expect(src(s)).toBe("a: b: c: {}\n"); // the empty container's spelling, as in nested descends
    const done = type("12{ArrowRight}", s);
    expect(src(done)).toBe("a: b: c: 12\n");
  });
  it("`c: ` + Enter (the spaced spelling) reaches the same block", () => {
    const s = type("a: b: c: {Enter}12{ArrowRight}");
    expect(src(s)).toBe("a: b: c: 12\n");
  });
  it("a blur-committed NULL leaf is revivable — write-once lets the value land", () => {
    // `a: b: c:` + blur is the file's own reading (a null leaf); descending into it and
    // typing the value must not be a wall: null-and-childless still takes its scalar
    const blurred = commitPending(type("a: b: c:"))!;
    expect(src(blurred)).toBe("a: b: c:\n");
    const revived = type("{Enter}12{ArrowRight}", blurred);
    expect(src(revived)).toBe("a: b: c: 12\n");
  });
});

describe("yed2 — the walk follows the VISUAL order", () => {
  it("↑ visits value4 → scalar → value2 → value1 — the value line at ITS row, not first", () => {
    const s = type("key1: value1{Enter}{ShiftTab}- value2{Enter}{ShiftTab}scalar{Enter}{ShiftTab}- value4{ArrowRight}");
    expect(src(s)).toBe("key1: value1\n- value2\nscalar\n- value4\n");
    const u1 = type("{ArrowUp}", s);
    expect(u1.cursor).toMatchObject({ at: "token", path: [], text: "scalar" });
    const u2 = type("{ArrowUp}", u1);
    expect(u2.cursor).toMatchObject({ at: "token", path: [1], text: "value2" });
    const u3 = type("{ArrowUp}", u2);
    expect(u3.cursor).toMatchObject({ at: "token", path: [0], text: "value1" });
    expect(type("{ArrowUp}", u3).refused).toBe(true); // the top, visibly
  });
});

describe("yed2 — the UPWARD conversion (retyping a value line with its marker)", () => {
  const base = (): EditorState =>
    type("key1: value1{Enter}{ShiftTab}scalar2{Enter}{ShiftTab}key3: value3{ArrowRight}");
  it("the base document reads back in typed order", () => {
    expect(src(base())).toBe("key1: value1\nscalar2\nkey3: value3\n");
  });
  it("`scalar2` retyped as `key2: scalar2` becomes a KEYED row, in place", () => {
    const t = { ...base(), cursor: { at: "token", path: [], text: "key2: scalar2" }, refused: false } as EditorState;
    const c = applyKey(t, { key: "ArrowRight" }, { atStart: false, atEnd: true });
    expect(c.refused).toBe(false);
    expect(src(c)).toBe("key1: value1\nkey2: scalar2\nkey3: value3\n");
    watchdog(c);
  });
  it("`scalar2` retyped as `- scalar2` becomes an ORDERED row, in place", () => {
    const t = { ...base(), cursor: { at: "token", path: [], text: "- scalar2" }, refused: false } as EditorState;
    const c = applyKey(t, { key: "ArrowRight" }, { atStart: false, atEnd: true });
    expect(c.refused).toBe(false);
    expect(src(c)).toBe("key1: value1\n- scalar2\nkey3: value3\n");
    watchdog(c);
  });
});

describe("yed2 — an empty flow container is never a wall", () => {
  it("the reported K&R sequence: [ ⏎ { ⏎ ↓ , { ⏎ builds the two-element seq", () => {
    // ↓ from inside the spread `{` lands on its CLOSER row (not the document's end), where `,`
    // opens the outer seq's next element
    const s1 = type("[{Enter}{{{Enter}{ArrowDown}");
    expect(s1.cursor).toEqual({ at: "after", path: [0] });
    const s = type(",{{{Enter}", s1);
    expect(src(s)).toBe("[\n  {},\n  {}\n]\n");
    expect(s.cursor).toEqual({ at: "hole", path: [1], index: 0, text: "", key: null });
  });
  it("arrows reach INSIDE `{}` in a K&R seq, and it fills", () => {
    // reported: [ {}, {} ] entered, then the brackets were unreachable
    const s0 = type("[{Enter}{{}, {{}]");
    expect(src(s0)).toBe("[\n  {},\n  {}\n]\n");
    let s: EditorState = { ...s0, cursor: { at: "after", path: [0] }, refused: false };
    s = applyKey(s, { key: "ArrowLeft" });
    expect(s.cursor).toEqual({ at: "hole", path: [0], index: 0, text: "", key: null });
    s = type("key: 12", s);
    s = applyKey(s, { key: "}" });
    expect(src(s)).toBe("[\n  {key: 12},\n  {}\n]\n");
    watchdog(s);
  });
});

describe("yed2 — pointer ATOMS: walkable, deletable, never editable", () => {
  const load = (text: string): EditorState =>
    ({ doc: parseSource(text), cursor: { at: "hole", path: [], index: 0, text: "", key: null }, refused: false, log: [] });
  it("arrows reach the atom; it deletes down the ladder; the watchdog stays green", () => {
    let s = load("a: *x\nb: 1\n");
    s = { ...s, cursor: { at: "token", path: [1], text: "1" } };
    s = applyKey(s, { key: "ArrowLeft" }, { atStart: true, atEnd: false }); // ← onto b's key
    s = applyKey(s, { key: "ArrowLeft" }, { atStart: true, atEnd: true });  // ← onto the ATOM
    expect(s.cursor).toEqual({ at: "ptr", path: [0] });
    watchdog(s);
    const rung = applyKey(s, { key: "Backspace" });                          // the value goes…
    // …the name survives — as its PROVISIONAL row (drawn locally, withheld from the wire)
    expect(rung.cursor).toEqual({ at: "token", path: [0], text: "" });
    expect(src(rung)).toBe("a:\nb: 1\n");
  });
  it("typing into the atom RINGS and changes nothing", () => {
    let s = load("a: *x\n");
    s = { ...s, cursor: { at: "ptr", path: [0] } };
    const t = applyKey(s, { key: "z" });
    expect(t.refused).toBe(true);
    expect(src(t)).toBe("a: *x\n");
    expect(t.cursor).toEqual({ at: "ptr", path: [0] });
  });
  it("Ctrl+C on the atom copies its authored spelling", () => {
    let s = load("a: *x\n");
    s = { ...s, cursor: { at: "ptr", path: [0] } };
    expect(copySubtree(s)).toBe("*x");
  });
});

describe("yed2 — REFERENCE ENTRY: `*` in a hole commits a pointer", () => {
  const load = (text: string): EditorState =>
    ({ doc: parseSource(text), cursor: { at: "hole", path: [], index: 0, text: "", key: null }, refused: false, log: [] });
  it("a keyed pointer — `k: *pets: 1` ⏎ — lands as a ref entry, SPACED canonical, caret on the atom then the sibling hole", () => {
    const s = type("k: *pets: 1{Enter}");
    expect(src(s)).toBe("k: *pets: 1\n");
    // THE SIBLING RULE: a reference holds no children — Enter opened the hole AFTER it
    expect(s.cursor).toEqual({ at: "hole", path: [], index: 1, text: "", key: null });
    expect(s.refused).toBe(false);
  });
  it("an ordinal pointer — `- *x` — and a flow element pointer both land", () => {
    expect(src(type("- *x{Enter}"))).toBe("- *x\n");
    expect(src(type("[*x, 2]"))).toBe("[*x, 2]\n");
  });
  it("the typed spelling normalizes to the spaced canonical raw", () => {
    expect(src(type("k: *:pets:1{Enter}"))).toBe("k: *: pets: 1\n");
  });
  it("`k:` ⏎ then `*x` — the descend's empty container takes the pointer as the WHOLE value", () => {
    const s = type("k:{Enter}*x{Enter}");
    expect(src(s)).toBe("k: *x\n");
  });
  it("`*` alone and garbage refuse — the ring, the text stands, nothing lands", () => {
    const alone = type("k: *{Enter}");
    expect(alone.refused).toBe(true);
    // the DECIDED row stands as its temporary entry (drawn locally, withheld from the wire);
    // the `*` decision rides the materialized PICK over it - the text was never lost
    expect(src(alone)).toBe("k:\n");
    expect(alone.cursor).toMatchObject({ at: "pick", path: [0], text: "", ref: { ladder: 0, portions: [""], active: 0 } });
    const garbage = type("k: *::{Enter}");
    expect(garbage.refused).toBe(true);
    expect(src(garbage)).toBe("k:\n");
  });
  it("a BARE pointer lands as the KEYLESS member it is — a pointer has no self-value form", () => {
    // `*x` at the fresh root: not the document's own value (the parser refuses a top-level
    // pointer) but the first member — `- *x`, the chapter pointer-array shape
    const s = type("*x{Enter}");
    expect(s.refused).toBe(false);
    expect(src(s)).toBe("- *x\n");
  });
  it("a bare pointer among entries inserts the keyless member (no omni diversion)", () => {
    let s = ({ doc: parseSource("a: 1\n"), cursor: { at: "hole", path: [], index: 1, text: "", key: null }, refused: false, log: [] }) as EditorState;
    s = type("*x{Enter}", s);
    expect(src(s)).toBe("a: 1\n- *x\n");
    expect(s.refused).toBe(false);
  });
  it("RETARGET: Enter on the atom opens PICK with the raw; edit; Enter commits the new target", () => {
    let s = load("a: *x\nb: 1\n");
    s = { ...s, cursor: { at: "ptr", path: [0] } };
    s = applyKey(s, { key: "Enter" });
    // the raw decomposes into PORTION cells - one portion here, the caret in it
    expect(s.cursor).toEqual({ at: "pick", path: [0], text: "x", ref: { ladder: 0, portions: ["x"], active: 0 }, caret: "end" });
    watchdog(s);
    // retype the raw wholesale (the controlled input's onChange path)
    s = applyKey({ ...s, cursor: { ...s.cursor, text: "pets: 1" } as never }, { key: "Enter" });
    expect(src(s)).toBe("a: *pets: 1\nb: 1\n");
    // the retarget committed back onto... Enter walks the sibling rule to the hole after `a`
    expect(s.cursor).toEqual({ at: "hole", path: [], index: 1, text: "", key: null });
  });
  it("PICK with an UNCHANGED raw commits as a no-op — no document change, no refusal", () => {
    let s = load("a: *x\n");
    s = { ...s, cursor: { at: "pick", path: [0], text: "x" } };
    const before = src(s);
    s = applyKey(s, { key: "Enter" });
    expect(src(s)).toBe(before);
    expect(s.refused).toBe(false);
  });
  it("PICK garbage refuses the commit AND the move — nothing is ever lost", () => {
    let s = load("a: *x\n");
    s = { ...s, cursor: { at: "pick", path: [0], text: "::" } };
    const committed = applyKey(s, { key: "Enter" });
    expect(committed.refused).toBe(true);
    expect(src(committed)).toBe("a: *x\n");
    expect(committed.cursor).toMatchObject({ at: "pick", text: "::" });
    const moved = applyKey(s, { key: "ArrowRight" }, { atStart: false, atEnd: true });
    expect(moved.refused).toBe(true);
    expect(moved.cursor).toMatchObject({ at: "pick", text: "::" });
  });
  it("PICK emptied + Backspace removes the reference — the name survives", () => {
    let s = load("a: *x\n");
    s = { ...s, cursor: { at: "pick", path: [0], text: "" } };
    s = applyKey(s, { key: "Backspace" });
    // the surviving name is its PROVISIONAL row (the template-cells law): the entry stands
    // locally with the empty value cell, withheld from the wire until a value lands
    expect(src(s)).toBe("a:\n");
    expect(s.cursor).toEqual({ at: "token", path: [0], text: "" });
    watchdog(s);
  });
  it("json dialects have no `*` sigil — the star is a plain illegal token and rings at commit", () => {
    const s = type("{{k: *x{Enter}", { ...initialState(), dialect: "json" } as EditorState);
    expect(s.refused).toBe(true);
    expect(src(s)).toBe("{}\n");
  });
});

describe("yed2 — BLOCK-SCALAR BIRTH: a `|`/`>` header + Enter allocates the block cell", () => {
  const load = (text: string, index = 0): EditorState =>
    ({ doc: parseSource(text), cursor: { at: "hole", path: [], index, text: "", key: null }, refused: false, log: [] });
  const land = (s: EditorState): EditorState => {
    const c = commitPending(s);
    expect(c, "the block body did not land").not.toBeNull();
    return c!;
  };
  it("a NAMED hole: `k: |` ⏎ opens the textarea; the body commits under the authored header", () => {
    let s = type("k: |{Enter}");
    expect(s.cursor).toEqual({ at: "token", path: [0], text: "|\n" });
    expect(src(s)).toBe("k: ''\n"); // the document stays valid while the body is pending
    watchdog(s);
    s = applyText(s, blockTextFrom("|", "line one\nline two"));
    s = land(s);
    expect(src(s)).toBe("k: |\n  line one\n  line two\n");
  });
  it("an ORDINAL hole: `- |-` ⏎ births the keyless block", () => {
    let s = type("- |-{Enter}");
    expect(s.cursor).toEqual({ at: "token", path: [0], text: "|-\n" });
    s = applyText(s, blockTextFrom("|-", "chunk"));
    s = land(s);
    expect(src(s)).toBe("- |-\n  chunk\n");
  });
  it("the EMPTY container takes the block as its WHOLE value (`k:` ⏎ `>` ⏎)", () => {
    let s = type("k:{Enter}>{Enter}");
    expect(s.cursor).toEqual({ at: "token", path: [0], text: ">\n" });
    s = applyText(s, blockTextFrom(">", "folded prose"));
    s = land(s);
    expect(src(s)).toBe("k: >\n  folded prose\n");
  });
  it("among ENTRIES the block is the OMNI self line at its authored row", () => {
    let s = load("a: 1\n", 1);
    s = type("|-{Enter}", s);
    expect(s.cursor).toEqual({ at: "token", path: [], text: "|-\n" });
    s = applyText(s, blockTextFrom("|-", "the value"));
    s = land(s);
    expect(src(s)).toBe("a: 1\n|-\n  the value\n"); // selfAt 1 — the value line at its typed row
  });
  it("an EMPTY body exits as the bare header — `k: |-` round-trips", () => {
    const s = land(type("k: |-{Enter}"));
    expect(src(s)).toBe("k: |-\n");
  });
  it("in FLOW the header is plain text (the flow grammar owns Enter — no block cell by construction)", () => {
    const flow = type("[|{Enter}");
    expect(flow.refused).toBe(false);
    expect(src(flow)).toBe('[\n  ""\n]\n'); // `|` reparses as the "" it spells; Enter is the flow row
    expect(flow.cursor).toMatchObject({ at: "hole", index: 1 });
  });
  it("a digit-indicator header refuses, visibly (no edit-text form yet)", () => {
    const digit = type("k: |2{Enter}");
    expect(digit.refused).toBe(true);
    expect(src(digit)).toBe("k:\n"); // the decided row stands as its (withheld) temporary entry
  });
});

describe("yed2 — TOKEN-AS-KEY: `:` past a flow token's closer names the pair", () => {
  it("the 0012 shape: `{{}: 12}` — the inner token becomes the key, bytes exact", () => {
    const s = type("{{{{}: 12}");
    expect(src(s)).toBe("{{}: 12}\n");
  });
  it("a seq token keys a BLOCK row: `[256, 256]: v`", () => {
    // the root stays block: type the token in an entry hole below an existing row
    let s = ({ doc: parseSource("a: 1\n"), cursor: { at: "hole", path: [], index: 1, text: "", key: null }, refused: false, log: [] }) as EditorState;
    s = type("[256, 256]: v{Enter}", s);
    expect(src(s)).toBe("a: 1\n[256, 256]: v\n");
  });
  it("the ROOT token undoes the root decision: `{}` + `:` names the document's first pair", () => {
    const s = type("{{}: 12{Enter}");
    expect(src(s)).toBe("{}: 12\n");
  });
  it("`:` in a SEQUENCE refuses (a seq has no keys) and a SPREAD token refuses too", () => {
    const seq = type("[[1]:");
    expect(seq.refused).toBe(true);
    // a spread token has no one-line spelling: `[` ⏎ `1` `]` — K&R — then `:` at its gap
    let s = type("[{Enter}1]");
    s = applyKey(s, { key: ":" });
    expect(s.refused).toBe(true);
    expect(src(s)).toBe("[\n  1\n]\n");
  });
});

describe("yed2 — an EMPTIED key never traps the caret", () => {
  it("committing `: value1` un-names the pair; the caret lands on the value and arrows walk on", () => {
    const s = type("key1: value1{ArrowRight}");
    const k = { ...s, cursor: { at: "key", path: [0], text: "" }, refused: false } as EditorState;
    const moved = applyKey(k, { key: "ArrowRight" }, { atStart: true, atEnd: true });
    expect(moved.refused).toBe(false);
    expect(src(moved)).toBe("- value1\n");
    expect(moved.cursor).toMatchObject({ at: "token", path: [0], text: "value1" });
    watchdog(moved);
  });
});

describe("yed2 — Enter on a committed KEY descends into the value's HEAD (the way back in)", () => {
  // reported: with `a:` holding entries, the self value 12 (and a `&` bookmark) could not be
  // entered any more — every keystroke walked committed cells ("all keystrokes are just
  // jumping"). Enter on the key now re-opens the typing flow's own landing: a hole at the head.
  const DOC = "a:\n  - b\n  c: 12\n";
  const atKey = (): EditorState =>
    ({ ...initialState(), doc: parseSource(DOC), cursor: { at: "key", path: [0], text: "a" } }) as EditorState;

  it("the SELF VALUE: Enter on `a`, type 12, Enter — the omni forms, value leading", () => {
    let s = applyKey(atKey(), { key: "Enter" });
    expect(s.refused).toBe(false);
    expect(s.cursor).toEqual({ at: "hole", path: [0], index: 0, text: "", key: null });
    s = type("12{ArrowRight}", s); // commit the scalar without descending
    expect(src(s)).toBe("a: 12\n  - b\n  c: 12\n");
  });

  it("the BOOKMARK: Enter on `a`, `&`, the portions, Enter — the anchor lands on `a`", () => {
    let s = applyKey(atKey(), { key: "Enter" });
    s = applyText(s, "&");
    expect(s.cursor).toMatchObject({ at: "hole", path: [0], index: 0, anchor: true });
    s = applyKey(s, { key: ":" });
    s = type("p", s);
    s = applyKey(s, { key: "Enter" });
    expect(s.refused).toBe(false);
    expect(src(s)).toBe("a:\n  &: p\n  - b\n  c: 12\n");
  });

  it("a NEW FIRST entry: Enter on `a`, type `d: 1` — it lands before `- b`", () => {
    let s = applyKey(atKey(), { key: "Enter" });
    s = type("d: 1{ArrowRight}", s);
    expect(src(s)).toBe("a:\n  d: 1\n  - b\n  c: 12\n");
  });

  it("a SCALAR entry's key: Enter on `c` opens the fields hole (the omni-in-waiting)", () => {
    const s0 = { ...initialState(), doc: parseSource(DOC), cursor: { at: "key", path: [0, 1], text: "c" } } as EditorState;
    const s = applyKey(s0, { key: "Enter" });
    expect(s.refused).toBe(false);
    expect(s.cursor).toEqual({ at: "hole", path: [0, 1], index: 0, text: "", key: null });
    const t = type("unit: cm{ArrowRight}", s);
    expect(src(t)).toBe("a:\n  - b\n  c: 12\n    unit: cm\n");
  });

  it("a POINTER entry's key: Enter opens the SIBLING hole (a reference holds no children)", () => {
    const s0 = { ...initialState(), doc: parseSource("p: *q\nq: 1\n"), cursor: { at: "key", path: [0], text: "p" } } as EditorState;
    const s = applyKey(s0, { key: "Enter" });
    expect(s.refused).toBe(false);
    expect(s.cursor).toEqual({ at: "hole", path: [], index: 1, text: "", key: null });
  });

  it("a FLOW key keeps the walk — the value cell is next, flow has no block holes", () => {
    const s0 = { ...initialState(), doc: parseSource("{key: 12}\n"), cursor: { at: "key", path: [0], text: "key" } } as EditorState;
    const s = applyKey(s0, { key: "Enter" });
    expect(s.refused).toBe(false);
    expect(s.cursor.at).not.toBe("hole");
  });

  it("the RENAME still commits on the way down", () => {
    const s0 = { ...initialState(), doc: parseSource(DOC), cursor: { at: "key", path: [0], text: "renamed" } } as EditorState;
    const s = applyKey(s0, { key: "Enter" });
    expect(s.refused).toBe(false);
    expect(src(s)).toBe("renamed:\n  - b\n  c: 12\n");
    expect(s.cursor).toEqual({ at: "hole", path: [0], index: 0, text: "", key: null });
  });
});

describe("yed2 — a KEY cell walks vertically (key_cell_editing's up/down rows)", () => {
  // reported: editing the `pats` key in a nested document, Up/Down did nothing — the key
  // branch short-circuited into flowCommon, which has no vertical arrows, so the advertised
  // focus_prev/focus_next rows were dead keys. One line, so Up/Down always leave the cell.
  const DOC = "human1:\n  name: Alice\n  age: 30\n  pats:\n    - name: Rex\n      species: dog\n    - name: Whiskers\n      species: cat\n";
  it("ArrowUp from the `pats` key moves to the previous focusable; ArrowDown to the next", () => {
    const s0: EditorState = { ...initialState(), doc: parseSource(DOC) };
    const inKey = { ...s0, cursor: { at: "key", path: [0, 2], text: "pats", caret: "end" } } as EditorState;
    const up = applyKey(inKey, { key: "ArrowUp" });
    expect(up.refused).toBe(false);
    // up: the previous visual row — `age: 30`, represented by its value
    expect(up.cursor).toEqual({ at: "token", path: [0, 1], text: "30", caret: "end" });
    const down = applyKey(inKey, { key: "ArrowDown" });
    expect(down.refused).toBe(false);
    // down: the NEXT visual row — `- name: Rex` — not two rows down (`pats:` holds no value,
    // so its row has no anchor of its own; the walk must not skip past the first row below)
    expect(down.cursor).toEqual({ at: "token", path: [0, 2, 0, 0], text: "Rex", caret: "end" });
    watchdog(up); watchdog(down);
  });
  it("the container row is a ROW for everyone: ↓ from the `age` key stops at `pats:`, ↑ from Rex stops there too", () => {
    const s0: EditorState = { ...initialState(), doc: parseSource(DOC) };
    // reported: from inside the `age` key, ↓ jumped clean over the `pats:` row to Rex —
    // a bare container key's row had no anchor, so the walk never saw it, from either side
    const fromAgeKey = { ...s0, cursor: { at: "key", path: [0, 1], text: "age", caret: "end" } } as EditorState;
    const down = applyKey(fromAgeKey, { key: "ArrowDown" });
    expect(down.cursor).toEqual({ at: "key", path: [0, 2], text: "pats", caret: "end" });
    const fromRex = { ...s0, cursor: { at: "token", path: [0, 2, 0, 0], text: "Rex", caret: "end" } } as EditorState;
    const up = applyKey(fromRex, { key: "ArrowUp" });
    expect(up.cursor).toEqual({ at: "key", path: [0, 2], text: "pats", caret: "end" });
    watchdog(down); watchdog(up);
  });
});

describe("yed2 — committed labour is never dropped", () => {
  it("Enter on an OMNI's value keeps its fields and opens the hole RIGHT AFTER the value line", () => {
    // reported once: `Eurasia` / `- Europe` / `- Asia`, ↑↑ to the value, Enter erased the whole
    // list. The commit merges into the node — fields survive. Reported again: the descend hole
    // opened after the LAST field; it must open at the value line's own row (`selfAt`), like Enter
    // at a line's end in any text editor — the production editor's enterInto agrees.
    const s = type("Eurasia{Enter}- Europe{Enter}{ShiftTab}- Asia{ArrowRight}");
    expect(src(s)).toBe("Eurasia\n- Europe\n- Asia\n");
    const s2 = type("{ArrowUp}{ArrowUp}{Enter}", s);
    expect(src(s2)).toBe("Eurasia\n- Europe\n- Asia\n");   // nothing dropped
    expect(s2.cursor).toEqual({ at: "hole", path: [], index: 0, text: "", key: null });
    expect(src(type("- Africa{ArrowRight}", s2))).toBe("Eurasia\n- Africa\n- Europe\n- Asia\n");
  });

  it("the reported `1` / `- 2` / `- 3`: Enter after the `1` opens the new row right below it", () => {
    const s0 = type("1{Enter}- 2{Enter}{ShiftTab}- 3{ArrowRight}");
    expect(src(s0)).toBe("1\n- 2\n- 3\n");
    // the caret stands at the end of the committed `1` (a click + End)
    const s = applyKey({ ...s0, cursor: { at: "token", path: [], text: "1" } }, { key: "Enter" }, { atStart: false, atEnd: true });
    expect(s.refused).toBe(false);
    expect(s.cursor).toEqual({ at: "hole", path: [], index: 0, text: "", key: null }); // after `1`, before `- 2`
    expect(src(type("- x{ArrowRight}", s))).toBe("1\n- x\n- 2\n- 3\n");
  });

  it("Backspace after Enter's descend STEPS BACK onto the value — never deletes it", () => {
    // reported: `key1: value` ⏎ ⌫ erased the whole value. The descend hole sits under the
    // scalar; the scalar IS content — the press steps the caret back onto it, caret at the end,
    // and only further presses eat characters.
    const s = type("key1: value{Enter}{Backspace}");
    expect(src(s)).toBe("key1: value\n");
    expect(s.cursor).toEqual({ at: "token", path: [0], text: "value", caret: "end" });
  });
  it("Backspace on an empty `[` keeps the NAMED key (`{key: [` + Backspace → `key: ` hole)", () => {
    const s = type("{{key: [{Backspace}");
    // the surviving name is its PROVISIONAL pair — drawn locally (`{key: null}`), wire-pruned
    expect(src(s)).toBe("{key: null}\n");
    expect(s.cursor).toEqual({ at: "token", path: [0], text: "" });
    // …and the ladder stays one-press-one-level: the NEXT press only un-names
    const s2 = applyKey(s, { key: "Backspace" });
    expect(s2.cursor).toMatchObject({ at: "hole", key: null, text: "key" });
  });
  it("Enter at the HEAD of a committed row opens the sibling hole BEFORE it — the row pushes down", () => {
    // reported: `- 1` / `- 2`, caret before the `1`, Enter — the new space must open BEFORE
    // `- 1` (the text-editor gesture), not descend after it
    const s0 = type("- 1{Enter}{ShiftTab}- 2{ArrowRight}");
    expect(src(s0)).toBe("- 1\n- 2\n");
    const s = applyKey({ ...s0, cursor: { at: "token", path: [0], text: "1" } }, { key: "Enter" }, { atStart: true, atEnd: false });
    expect(s.refused).toBe(false);
    expect(src(s)).toBe("- 1\n- 2\n"); // nothing committed yet — the hole is the cursor's
    expect(s.cursor).toEqual({ at: "hole", path: [], index: 0, text: "", key: null });
    expect(src(type("- 0{ArrowRight}", s))).toBe("- 0\n- 1\n- 2\n");
    // …while Enter mid-text keeps THE LEVEL RULE's descend
    const mid = applyKey({ ...s0, cursor: { at: "token", path: [0], text: "1" } }, { key: "Enter" }, { atStart: false, atEnd: false });
    expect(mid.cursor).toEqual({ at: "hole", path: [0], index: 0, text: "", key: null });
    // …and the ROOT token has no row above it — the level rule stands there too
    const r0 = type("12{Enter}");
    const r = applyKey({ ...r0, cursor: { at: "token", path: [], text: "12" } }, { key: "Enter" }, { atStart: true, atEnd: false });
    expect(r.cursor).toEqual({ at: "hole", path: [], index: 0, text: "", key: null });
    expect(src(r)).toBe("12\n");
  });

  it("deleting a committed leaf VALUE eats the marker too — the text editor's expectation", () => {
    const s0 = type("{{key: 12}");
    // a click on the token, its text cleared, then Backspace: the emptied LEAF value's press
    // takes the colon with it — the pair returns to the UNDECIDED text (`key`), one press
    // (the chars were the value's level, deleted one by one; a named null row would charge
    // an extra press for a level the eye cannot see)
    const s = applyKey({ ...s0, cursor: { at: "token", path: [0], text: "" } }, { key: "Backspace" });
    expect(src(s)).toBe("{}\n");
    expect(s.cursor).toEqual({ at: "hole", path: [], index: 0, text: "key", key: null });
  });
});

describe("yed2 unwinding — one press, one level, to the empty document", () => {
  /** Backspace until empty, with the jam detector: no (doc, cursor) state may repeat. */
  function unwind(s: EditorState, maxSteps = 60): EditorState {
    const seen = new Set<string>();
    for (let i = 0; i < maxSteps; i++) {
      if (src(s) === "" && s.cursor.at === "hole" && s.cursor.path.length === 0 && s.cursor.text === "") return s;
      const state = JSON.stringify([src(s), s.cursor]);
      expect(seen.has(state), `JAMMED after ${i} steps at ${state}`).toBe(false);
      seen.add(state);
      // a text-bearing cursor clears one whole cell (the browser's char deletes, compressed)
      if ("text" in s.cursor && s.cursor.text !== "") {
        s = { ...s, cursor: { ...s.cursor, text: "" } } as EditorState;
        continue;
      }
      s = applyKey(s, { key: "Backspace" });
    }
    expect.fail(`did not reach the empty document in ${maxSteps} steps — at ${JSON.stringify(src(s))}`);
  }

  for (const script of ["[1, 2]", "{{key: 12}", "[{{key: 12}, {{key: 13}]", "[1{Enter}2]", "{{p: [1{Enter}2]", "[[1], [2, 3]]", "{{}", "[]"]) {
    it(`${JSON.stringify(script)} unwinds`, () => {
      unwind(type(script));
    });
  }
});

describe("yed2 typing — the identity-meta law (tags survive structural edits)", () => {
  const meta = (s: EditorState) => ((s.doc.root as { meta?: Record<string, unknown> }).meta ?? {});

  it("Backspace clearing a TAGGED root keeps its identity meta — and the caret lands in the hole", () => {
    const s0: EditorState = { ...initialState(), doc: parseSource("!!<*yamlover: $defs: recipe>\n!!yo\nserves: 4\n") };
    // walk onto the token and unwind: value, key, then the last level clears the root
    let s: EditorState = { ...s0, cursor: { at: "token", path: [0], text: "" } };
    s = applyKey(s, { key: "Backspace" }); // token → the key survives as a named hole? (ladder)
    for (let i = 0; i < 10 && sourceOf(s.doc) !== ""; i++) s = applyKey(s, { key: "Backspace" });
    expect(sourceOf(s.doc)).toBe(""); // the editor's empty document
    expect(meta(s).yo).toBe(true);
    expect(meta(s).schema).toBeDefined();
    // the caret sits in the root hole — the KEY survived down the ladder as the hole's text
    // (the provisional row serialized `serves:` until its marker was undone — one press, one level)
    expect(s.cursor).toMatchObject({ at: "hole", path: [], index: 0, text: "serves" });
  });

  it("typing [ into an EMPTY tagged root keeps the tag on the flow root", () => {
    const s0: EditorState = {
      ...initialState(),
      doc: { root: { kind: "mapping", entries: [], meta: { yo: true } }, source: { concrete: "yamlover", uri: "<t>" } } as unknown as EditorState["doc"],
    };
    const s = applyKey(s0, { key: "[" });
    const m = meta(s);
    expect(m.yo).toBe(true);
    expect(m.style).toBe("flow"); // the bracket's own representation meta rides along
  });

  it("paste over a tagged EMPTY container: an untagged clipboard keeps the target tag", () => {
    const empty: EditorState = {
      ...initialState(),
      doc: { root: { kind: "mapping", entries: [], meta: { yo: true } }, source: { concrete: "yamlover", uri: "<t>" } } as unknown as EditorState["doc"],
    };
    const s = pasteSubtree(empty, "a: 1\nb: 2");
    expect(s.refused).toBe(false);
    expect(meta(s).yo).toBe(true); // the island's identity survived the paste
    expect(sourceOf(s.doc)).toBe("!!yo\na: 1\nb: 2\n");
  });

  it("paste over a tagged EMPTY container: a TAGGED clipboard wins", () => {
    const empty: EditorState = {
      ...initialState(),
      doc: { root: { kind: "mapping", entries: [], meta: { yo: true } }, source: { concrete: "yamlover", uri: "<t>" } } as unknown as EditorState["doc"],
    };
    const s = pasteSubtree(empty, "!!<*a: b>\nx: 1");
    expect(s.refused).toBe(false);
    expect(meta(s).schema).toBeDefined(); // the clipboard's own tag
    expect(meta(s).yo).toBe(true);        // …and the target's mark it did not contradict
  });
});

describe("yed2 typing — the editable !!<…> TAG cell", () => {
  const tagCursorOn = (s: EditorState, path: number[]): EditorState =>
    ({ ...s, cursor: { at: "tag", path, text: "" } }) as EditorState;

  it("typing !!< in an entry hole materializes the tag cell; the committed tag stamps the entry", () => {
    let s = type("!!<");
    expect(s.cursor).toMatchObject({ at: "tag", path: [0], text: "" });
    expect(src(s)).toBe("- ''\n"); // the eager empty entry, the same law as `{` / `[`
    for (const ch of "*a: b") s = applyKey(s, { key: ch });
    s = applyKey(s, { key: "Enter" }); // commit — the caret steps onto the value
    expect(s.refused).toBe(false);
    expect(src(s)).toBe("- !!<*a: b> ''\n");
    expect(s.cursor.at).toBe("token");
  });

  it("editing an EXISTING tag re-spells it; a parse failure refuses and loses nothing", () => {
    const s0: EditorState = { ...initialState(), doc: parseSource("- !!<*a: b> 5\n") };
    let s = { ...s0, cursor: { at: "tag" as const, path: [0], text: "*x: y" } };
    const ok1 = applyKey(s, { key: "Enter" });
    expect(ok1.refused).toBe(false);
    expect(src(ok1)).toBe("- !!<*x: y> 5\n");
    // an unparseable tag refuses — the text stays in the cell to fix
    s = { ...s0, cursor: { at: "tag" as const, path: [0], text: ">>>bad" } };
    const bad = applyKey(s, { key: "Enter" });
    expect(bad.refused).toBe(true);
    expect(bad.cursor).toMatchObject({ at: "tag", text: ">>>bad" });
    expect(src(bad)).toBe("- !!<*a: b> 5\n"); // untouched
  });

  it("Backspace on the emptied tag cell DROPS the tag; the node and its value stay", () => {
    const s0: EditorState = { ...initialState(), doc: parseSource("- !!<*a: b> 5\n") };
    const s = applyKey(tagCursorOn(s0, [0]), { key: "Backspace" });
    expect(s.refused).toBe(false);
    expect(src(s)).toBe("- 5\n");
    expect(s.cursor).toMatchObject({ at: "token", path: [0], text: "5" });
  });

  it("the tag cell is IN the walk: ← from the value lands on the tag, ← again walks out", () => {
    const s0: EditorState = { ...initialState(), doc: parseSource("- one\n- !!<*a: b> 5\n") };
    let s: EditorState = { ...s0, cursor: { at: "token", path: [1], text: "5", caret: "start" } };
    s = applyKey(s, { key: "ArrowLeft" });
    expect(s.cursor).toMatchObject({ at: "tag", path: [1], text: "*a: b" });
    s = applyKey(s, { key: "ArrowLeft" });
    expect(s.cursor).toMatchObject({ at: "token", path: [0] });
  });

  it("a ROOT tag edits too (the data island's own tag)", () => {
    const s0: EditorState = { ...initialState(), doc: parseSource("!!<*a: b>\nx: 1\n") };
    const s = applyKey({ ...s0, cursor: { at: "tag", path: [], text: "*yamlover: $defs: recipe" } }, { key: "Enter" });
    expect(s.refused).toBe(false);
    expect(src(s)).toBe("!!<*yamlover: $defs: recipe>\nx: 1\n");
  });
});

describe("yed2 typing — the editable & ANCHOR rows", () => {
  it("editing an anchor row re-spells it; the walk reaches the stop LEFT of the value (YAML order)", () => {
    const s0: EditorState = { ...initialState(), doc: parseSource("a: 1\n  &: p: q\n") };
    // ← from the value's start walks onto the anchors stop — `a: &… 1`, the anchor before it
    let s = applyKey({ ...s0, cursor: { at: "token", path: [0], text: "1", caret: "start" } }, { key: "ArrowLeft" }, { atStart: true, atEnd: false });
    expect(s.cursor).toMatchObject({ at: "anchors", path: [0], index: 0, text: ": p: q" });
    // retype the body and commit
    s = { ...s, cursor: { ...s.cursor, text: ": p: r" } as EditorState["cursor"] };
    s = applyKey(s, { key: "Enter" });
    expect(s.refused).toBe(false);
    expect(src(s)).toBe("a: 1\n  &: p: r\n");
  });

  it("an unparseable anchor body refuses and loses nothing", () => {
    const s0: EditorState = { ...initialState(), doc: parseSource("a: 1\n  &: p: q\n") };
    const s = applyKey({ ...s0, cursor: { at: "anchors", path: [0], index: 0, text: ": p: 3" } }, { key: "Enter" });
    expect(s.refused).toBe(true); // a position claim — makeAnchor rejects it
    expect(src(s)).toBe("a: 1\n  &: p: q\n");
    expect(s.cursor).toMatchObject({ at: "anchors", text: ": p: 3" }); // still there to fix
  });

  it("Backspace on the emptied row REMOVES that anchor; the last one removes the stop", () => {
    const s0: EditorState = { ...initialState(), doc: parseSource("a: 1\n  &: p: q\n") };
    const s = applyKey({ ...s0, cursor: { at: "anchors", path: [0], index: 0, text: "" } }, { key: "Backspace" });
    expect(s.refused).toBe(false);
    expect(src(s)).toBe("a: 1\n");
    expect(s.cursor).toMatchObject({ at: "token", path: [0] }); // landed on the node
  });

  it("the ADD slot appends a fresh anchor", () => {
    const s0: EditorState = { ...initialState(), doc: parseSource("a: 1\n  &: p: q\n") };
    const s = applyKey({ ...s0, cursor: { at: "anchors", path: [0], index: 1, text: ": x: y" } }, { key: "Enter" });
    expect(s.refused).toBe(false);
    expect(src(s)).toBe("a: 1\n  &: p: q\n  &: x: y\n");
  });
});

describe("yed2 typing — the `&` ENTRY face (the FIRST bookmark, docs/server/yamlover-editor anchor_entry)", () => {
  it("`&` in a hole opens the portion face; the body commits an own-line anchor on the CONTAINER", () => {
    // a hole INSIDE `a`'s block (the fields region of the scalar 1) — the container is `a`
    const s0: EditorState = { ...initialState(), doc: parseSource("a: 1\n") };
    let s = applyText({ ...s0, cursor: { at: "hole", path: [0], index: 0, text: "", key: null } }, "&");
    expect(s.cursor).toMatchObject({ at: "hole", path: [0], index: 0, anchor: true, ref: { ladder: 0, portions: [""], active: 0 } });
    // `:` in the empty first cell CLIMBS the ladder (document scope), then the portions type
    s = applyKey(s, { key: ":" });
    expect(s.cursor).toMatchObject({ anchor: true, ref: { ladder: 1 } });
    s = type("p:q", s);
    // the committed cells ride ref.portions; the ACTIVE cell's live text is cursor.text
    expect(s.cursor).toMatchObject({ anchor: true, text: "q", ref: { portions: ["p", ""], active: 1 } });
    s = applyKey(s, { key: "Enter" });
    expect(s.refused).toBe(false);
    expect(src(s)).toBe("a: 1\n  &: p: q\n");
    // the caret is the RESTORED hole at its own index — the bookmark is a decoration, not an entry
    expect(s.cursor).toEqual({ at: "hole", path: [0], index: 0, text: "", key: null });
  });

  it("Backspace on the emptied floor UNDOES the `&` decision — the plain hole returns, doc untouched", () => {
    const s0: EditorState = { ...initialState(), doc: parseSource("a: 1\n") };
    let s = applyText({ ...s0, cursor: { at: "hole", path: [0], index: 0, text: "", key: null } }, "&");
    s = applyKey(s, { key: "Backspace" });
    expect(s.refused).toBe(false);
    expect(src(s)).toBe("a: 1\n");
    expect(s.cursor).toEqual({ at: "hole", path: [0], index: 0, text: "", key: null });
  });

  it("a POSITION body refuses with the ring — the portions stand to fix", () => {
    const s0: EditorState = { ...initialState(), doc: parseSource("a: 1\n") };
    let s = applyText({ ...s0, cursor: { at: "hole", path: [0], index: 0, text: "", key: null } }, "&");
    s = applyKey(s, { key: ":" });
    s = type("p:3", s);
    s = applyKey(s, { key: "Enter" });
    expect(s.refused).toBe(true); // a bookmark may not claim a position
    expect(src(s)).toBe("a: 1\n");
    expect(s.cursor).toMatchObject({ at: "hole", anchor: true, text: "3" }); // still the face
  });

  it("the trailing `-` portion spells ORDINAL membership (`: -`)", () => {
    const s0: EditorState = { ...initialState(), doc: parseSource("a: 1\n") };
    let s = applyText({ ...s0, cursor: { at: "hole", path: [0], index: 0, text: "", key: null } }, "&");
    s = applyKey(s, { key: ":" });
    s = type("p:-", s);
    s = applyKey(s, { key: "Enter" });
    expect(s.refused).toBe(false);
    expect(src(s)).toBe("a: 1\n  &: p: -\n");
  });

  it("`[` on the anchor face is INERT — a bookmark may not fold an index", () => {
    const s0: EditorState = { ...initialState(), doc: parseSource("a: 1\n") };
    let s = applyText({ ...s0, cursor: { at: "hole", path: [0], index: 0, text: "", key: null } }, "&");
    s = type("p:", s); // a committed portion, the next cell empty — the fold's own site
    const before = s.cursor;
    s = applyKey(s, { key: "[" });
    // no fold: the `[` lands as portion TEXT (native), never `p[|]`
    expect(s.cursor).toMatchObject({ anchor: true, text: "[" });
    expect((before as { ref?: { portions: string[] } }).ref?.portions).toEqual(["p", ""]);
  });

  it("a bookmark at the DOCUMENT ROOT serializes (the empty-doc shortcut must not swallow it)", () => {
    let s = applyText(initialState(), "&");
    s = applyKey(s, { key: ":" });
    s = type("p", s);
    s = applyKey(s, { key: "Enter" });
    expect(s.refused).toBe(false);
    // the empty BLOCK mapping has no block spelling, so the root flows to `{}` and the
    // root anchor takes its own line — the shortcut swallowing the anchor was the bug
    expect(src(s)).toBe("{}\n&: p\n");
    expect(s.cursor).toEqual({ at: "hole", path: [], index: 0, text: "", key: null });
  });

  it("the SECOND bookmark appends through the same gesture", () => {
    const s0: EditorState = { ...initialState(), doc: parseSource("a: 1\n  &: p: q\n") };
    let s = applyText({ ...s0, cursor: { at: "hole", path: [0], index: 0, text: "", key: null } }, "&");
    s = applyKey(s, { key: ":" });
    s = type("x:y", s);
    s = applyKey(s, { key: "Enter" });
    expect(s.refused).toBe(false);
    expect(src(s)).toBe("a: 1\n  &: p: q\n  &: x: y\n");
  });

  it("json5/json dialects: `&` stays text and refuses at the scalar gate", () => {
    let s = type("{{k: ", initialState("json5"));
    s = applyText(s, "&x");
    // no `&` face — plain text in the provisional value cell (the pair materialized on `k: `)
    expect(s.cursor).toMatchObject({ at: "token", text: "&x" });
    expect((s.cursor as { anchor?: true }).anchor).toBeUndefined();
    s = applyKey(s, { key: "Enter" });
    expect(s.refused).toBe(true); // not a json5 scalar spelling
  });

  it("`&` in the VALUE place opens the bookmark face ON THE ENTRY'S OWN NODE", () => {
    // bookmarks are ENTERED, not spelled: `a: &` materializes a's value (the descend's empty
    // container) and the `&` decision continues INSIDE it — the bookmark belongs to `a`
    // (`a:` + its own `&: path` line). The old inline back door (`&'p: q' 1` typed as
    // literal text) yields to the face; the inline spelling remains a PARSE form.
    let s = type("a: &");
    expect(s.cursor).toMatchObject({ at: "hole", path: [0], anchor: true, ref: { portions: [""] } });
    s = type("shared{Enter}", s);
    expect(s.refused).toBe(false);
    // the EMPTY anchored mapping takes the serializer's `{}` spelling; entries later replace it
    expect(src(s)).toBe("a: {}\n  &shared\n");
  });
});

describe("yed2 typing — BLOCK scalars (| and >): multi-line editing, style stable", () => {

  it("entering a block token loads the REPARSEABLE spelling (header + re-indented body)", () => {
    const s0: EditorState = { ...initialState(), doc: parseSource("k: |\n  line one\n  line two\n") };
    const s = applyKey({ ...s0, cursor: { at: "key", path: [0], text: "k", caret: "end" } }, { key: "ArrowRight" });
    expect(s.cursor).toMatchObject({ at: "token", path: [0], text: "|\n  line one\n  line two" });
  });

  it("Enter INSIDE a block token is the textarea's newline — the grammar stands aside", () => {
    const s0: EditorState = {
      ...initialState(),
      doc: parseSource("k: |\n  line one\n  line two\n"),
      cursor: { at: "token", path: [0], text: "|\n  line one\n  line two" },
    };
    const s = applyKey(s0, { key: "Enter" });
    expect(s).toBe(s0); // unhandled — native newline in the textarea
    watchdog(s0);       // and the state stays lawful
  });

  it("an UNTOUCHED enter-then-leave keeps raw byte-identical (zero diff on disk)", () => {
    const s0: EditorState = { ...initialState(), doc: parseSource("k: |\n  line one\n  line two\nm: 1\n") };
    const before = src(s0);
    const entered = applyKey({ ...s0, cursor: { at: "key", path: [0], text: "k", caret: "end" } }, { key: "ArrowRight" });
    const left = applyKey(entered, { key: "ArrowDown" }, { atStart: false, atEnd: true, firstLine: false, lastLine: true });
    expect(left.refused).toBe(false);
    expect(src(left)).toBe(before);
  });

  it("a BODY edit commits with the authored header preserved — `|` stays `|`, `>` stays `>`", () => {
    const s0: EditorState = {
      ...initialState(),
      doc: parseSource("k: |\n  line one\n  line two\nm: 1\n"),
      cursor: { at: "token", path: [0], text: blockTextFrom("|", "line one\nline 2!") },
    };
    const s = applyKey(s0, { key: "ArrowDown" }, { atStart: false, atEnd: true, firstLine: false, lastLine: true });
    expect(s.refused).toBe(false);
    expect(src(s)).toBe("k: |\n  line one\n  line 2!\nm: 1\n");
    const folded: EditorState = {
      ...initialState(),
      doc: parseSource("k: >\n  these three lines\n  fold into\n  one\nm: 1\n"),
      cursor: { at: "token", path: [0], text: blockTextFrom(">", "these three lines\nfold into\ntwo") },
    };
    const s2 = applyKey(folded, { key: "ArrowDown" }, { atStart: false, atEnd: true, firstLine: false, lastLine: true });
    expect(s2.refused).toBe(false);
    expect(src(s2)).toBe("k: >\n  these three lines\n  fold into\n  two\nm: 1\n");
  });

  it("vertical arrows leave only from EDGE lines; inside they stay native", () => {
    const s0: EditorState = {
      ...initialState(),
      doc: parseSource("k: |\n  line one\n  line two\n"),
      cursor: { at: "token", path: [0], text: "|\n  line one\n  line two" },
    };
    const mid = applyKey(s0, { key: "ArrowDown" }, { atStart: false, atEnd: false, firstLine: true, lastLine: false });
    expect(mid).toBe(s0); // not an edge line — the browser moves the caret
  });

  it("the helpers round-trip: blockEditText ⇄ blockBodyOf ⇄ blockTextFrom", () => {
    const doc = parseSource("k: |-\n  a\n\n  b\n");
    const node = (doc.root as import("../src/state").Node).entries![0].value;
    const text = blockEditText(node)!;
    expect(text).toBe("|-\n  a\n\n  b");
    const parts = blockBodyOf(text)!;
    expect(parts).toEqual({ header: "|-", body: "a\n\nb" });
    expect(blockTextFrom(parts.header, parts.body)).toBe(text);
  });

  it("positionsOf sees a block scalar as ONE token position — nothing extra to draw", () => {
    const doc = parseSource("k: |\n  line one\n  line two\n");
    expect(positionsOf(doc)).toEqual([{ at: "key", path: [0] }, { at: "token", path: [0] }]);
  });
});
