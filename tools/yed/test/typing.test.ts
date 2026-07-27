// yed2 D2 GATE — the pure edit layer: keystrokes in, IR out, no DOM anywhere. Every case asserts
// the SERIALIZED document (the file that would be written) and that the editor never claimed an
// edit it refused.
import { describe, it, expect } from "vitest";
import { applyKey, copySubtree, watchdog } from "../src/apply";
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
    // both normalize to bare — the serializer's documented rule: quoting is REPRESENTATION, and
    // a simple string reads the same without it (either spelling round-trips)
    expect(src(s)).toBe("{name: Eurasia}\n");
  });
  it("a quoted key that NEEDS its quotes keeps them", () => {
    expect(src(type('{{"two words": 1}'))).toBe("{'two words': 1}\n");
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
    expect(s.cursor).toEqual({ at: "hole", path: [0, 1], index: 0, text: "", key: null });
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

describe("yed2 — a second colon is TEXT (YAML conformance ZCZ6)", () => {
  it("`key1: key2: value` keeps key1 and commits the VALUE-POSITION scalar", () => {
    // reported as a collapse to `key2: v…` — key1 was overwritten. YAML calls the one-line
    // nested mapping an ERROR (ZCZ6); our parser reads the rest of the line as a plain scalar,
    // and the editor now agrees: nothing collapses, nothing nests.
    const s = type("key1: key2: value{ArrowRight}");
    expect(s.refused).toBe(false);
    expect(src(s)).toBe("key1: 'key2: value'\n");
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
    expect(rung.cursor).toEqual({ at: "hole", path: [], index: 0, text: "", key: "a" }); // …the name survives
    expect(src(rung)).toBe("b: 1\n");
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

describe("yed2 — committed labour is never dropped", () => {
  it("Enter on an OMNI's value keeps its fields and descends to ADD more", () => {
    // reported: `Eurasia` / `- Europe` / `- Asia`, ↑↑ to the value, Enter erased the whole
    // list. The commit merges into the node — fields survive — and the descend opens the hole
    // AFTER the last field, ready for the next `- `.
    const s = type("Eurasia{Enter}- Europe{Enter}{ShiftTab}- Asia{ArrowRight}");
    expect(src(s)).toBe("Eurasia\n- Europe\n- Asia\n");
    const s2 = type("{ArrowUp}{ArrowUp}{Enter}", s);
    expect(src(s2)).toBe("Eurasia\n- Europe\n- Asia\n");   // nothing dropped
    expect(s2.cursor).toEqual({ at: "hole", path: [], index: 2, text: "", key: null });
    expect(src(type("- Africa{ArrowRight}", s2))).toBe("Eurasia\n- Europe\n- Asia\n- Africa\n");
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
    expect(src(s)).toBe("{}\n");
    expect(s.cursor).toEqual({ at: "hole", path: [], index: 0, text: "", key: "key" });
    // …and the ladder stays one-press-one-level: the NEXT press only un-names
    const s2 = applyKey(s, { key: "Backspace" });
    expect(s2.cursor).toMatchObject({ at: "hole", key: null, text: "key" });
  });
  it("deleting a committed VALUE keeps its key — the pair returns to a named hole", () => {
    const s0 = type("{{key: 12}");
    // a click on the token, its text cleared, then Backspace: the value goes, `key:` stays
    const s = applyKey({ ...s0, cursor: { at: "token", path: [0], text: "" } }, { key: "Backspace" });
    expect(src(s)).toBe("{}\n");
    expect(s.cursor).toEqual({ at: "hole", path: [], index: 0, text: "", key: "key" });
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
