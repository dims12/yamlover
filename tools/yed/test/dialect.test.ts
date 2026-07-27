// yed2 — THE DIALECTS (dialect.ts): the same grammar, a different POLICY. Everything a dialect
// forbids REFUSES visibly (the watchdog's law holds per dialect — R1: a gate must never
// silently swallow), and everything it allows works exactly as in yamlover.
import { describe, it, expect } from "vitest";
import { applyKey, watchdog } from "../src/apply";
import { initialState, sourceOf, type EditorState } from "../src/state";
import type { DialectId } from "../src/dialect";
import { parseScript } from "./keys-util";

function type(script: string, dialect?: DialectId, from?: EditorState): EditorState {
  let s = from ?? initialState(dialect);
  for (const k of parseScript(script)) {
    s = applyKey(s, "ch" in k ? { key: k.ch } : k);
    watchdog(s);
  }
  return s;
}

const src = (s: EditorState): string => sourceOf(s.doc);

describe("json — strict: quoted keys, JSON scalars, flow only", () => {
  it('`{"a": 1}` enters', () => {
    const s = type('{{"a": 1}', "json");
    expect(s.refused).toBe(false);
    expect(src(s)).toBe("{a: 1}\n"); // spelling normalization is the serializer's (yamlover surface)
  });
  it("a BARE key refuses visibly", () => {
    const s = type("{{a: ", "json");
    expect(s.refused).toBe(true);
    expect(src(s)).toBe("{}\n"); // nothing half-applied — the text still rides the cursor
  });
  it("a bare scalar SPELLING refuses at the commit boundary", () => {
    const s = type("[abc{ArrowRight}", "json");
    expect(s.refused).toBe(true);
    expect(src(s)).toBe("[]\n");
  });
  it("`- ` stays TEXT (a number's sign), never an ordinal decision", () => {
    const s = type("- 1", "json");
    expect((s.cursor as { text: string }).text).toBe("- 1"); // still typing — no keyless entry decided
    expect((s.cursor as { ordinal?: boolean }).ordinal).not.toBe(true);
  });
  it("K&R spread still works (layout is not a language form)", () => {
    const s = type("[1{Enter}2]", "json");
    expect(src(s)).toBe("[\n  1,\n  2\n]\n");
  });
  it('`"k":` + Enter allocates the K&R row (flow context — spreadOrClose), and the pair lands', () => {
    const s = type('{{"k": {Enter}1}', "json");
    expect(s.refused).toBe(false);
    expect(src(s)).toBe("{\n  k: 1\n}\n");
  });
});

describe("json5 — identifier keys and json5 scalars", () => {
  it("`{a: 1}` enters (identifier keys are legal)", () => {
    const s = type("{{a: 1}", "json5");
    expect(s.refused).toBe(false);
    expect(src(s)).toBe("{a: 1}\n");
  });
  it("a NON-identifier bare key refuses", () => {
    const s = type("{{a-b: ", "json5");
    expect(s.refused).toBe(true);
  });
  it("hex numbers and single-quoted strings are scalars", () => {
    const s = type("[0xFF, 'a'{ArrowRight}", "json5");
    expect(s.refused).toBe(false);
    expect(src(s)).toBe("[0xFF, a]\n");
  });
});

describe("yamlover — the default dialect is untouched", () => {
  it("absent dialect ≡ explicit yamlover", () => {
    const a = type("- name: Eurasia{Enter}{ShiftTab}children:{Enter}- x{ArrowRight}");
    const b = type("- name: Eurasia{Enter}{ShiftTab}children:{Enter}- x{ArrowRight}", "yamlover");
    expect(src(a)).toBe("- name: Eurasia\n  children:\n    - x\n");
    expect(src(b)).toBe(src(a));
  });
});
