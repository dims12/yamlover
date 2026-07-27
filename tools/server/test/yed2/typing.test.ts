// yed2 D2 GATE — the pure edit layer: keystrokes in, IR out, no DOM anywhere. Every case asserts
// the SERIALIZED document (the file that would be written) and that the editor never claimed an
// edit it refused.
import { describe, it, expect } from "vitest";
import { applyKey } from "../../src/client/yed2/apply";
import { initialState, sourceOf, type EditorState } from "../../src/client/yed2/state";
import { parseScript } from "./keys-util";

/** Type a script from the empty document. */
function type(script: string, from: EditorState = initialState()): EditorState {
  let s = from;
  for (const k of parseScript(script)) {
    s = applyKey(s, "ch" in k ? { key: k.ch } : k);
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

describe("yed2 refusals — visible, and nothing half-applied", () => {
  it("moving away NEVER drops pending text — it refuses and stays", () => {
    // reported: `{"key": value` then Right made the text disappear (the hole lives only in the
    // cursor, so an uncommittable move abandoned it). It refuses now, visibly.
    const s = type('{{"key": v{ArrowRight}');
    expect(s.refused).toBe(true);
    expect(s.cursor.at).toBe("hole");
    expect((s.cursor as { text: string }).text).toBe('"key": v'); // still there, still fixable
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
