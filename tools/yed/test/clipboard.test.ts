// yed2 — REQUIREMENT 10: subtree copy/paste. Pure layer: copySubtree serializes the subtree
// under the caret; pasteSubtree parses clipboard text and splices it into a hole under the same
// laws typing obeys. A parse failure REFUSES — nothing lost, nothing half-applied.
import { describe, it, expect } from "vitest";
import { applyKey, copySubtree, pasteSubtree } from "../src/apply";
import { MAX_PASTE, pasteText } from "../src/paste";
import { initialState, parseSource, sourceOf, type Cursor, type EditorState } from "../src/state";
import { parseScript } from "./keys-util";

function type(script: string, from: EditorState = initialState()): EditorState {
  let s = from;
  for (const k of parseScript(script)) s = applyKey(s, "ch" in k ? { key: k.ch } : k);
  return s;
}

const at = (doc: EditorState["doc"], cursor: Cursor): EditorState =>
  ({ doc, cursor, refused: false, log: [] });

describe("yed2 copy — the caret's subtree, as file text", () => {
  it("a token copies its scalar", () => {
    const doc = parseSource("[1, 2]\n");
    expect(copySubtree(at(doc, { at: "token", path: [0], text: "1" }))).toBe("1");
  });
  it("a gap copies the container it closes", () => {
    const doc = parseSource("[1, {a: 2}]\n");
    expect(copySubtree(at(doc, { at: "after", path: [1], text: "" } as unknown as Cursor))).toBe("{a: 2}");
  });
  it("the root gap copies the whole document", () => {
    const doc = parseSource("[1, 2]\n");
    expect(copySubtree(at(doc, { at: "after", path: [] } as Cursor))).toBe("[1, 2]");
  });
  it("a hole has nothing to copy", () => {
    expect(copySubtree(type("["))).toBeNull();
  });
});

describe("yed2 paste — into a hole, under the typing laws", () => {
  it("the empty document takes the paste as the document", () => {
    const s = pasteSubtree(initialState(), "{a: 1}");
    expect(s.refused).toBe(false);
    expect(sourceOf(s.doc)).toBe("{a: 1}\n");
  });
  it("a flow seq hole takes a scalar", () => {
    const s = pasteSubtree(type("[1, "), "2");
    expect(s.refused).toBe(false);
    expect(sourceOf(s.doc)).toBe("[1, 2]\n");
  });
  it("a flow seq hole takes a container", () => {
    const s = pasteSubtree(type("[1, "), "{a: 2}");
    expect(s.refused).toBe(false);
    expect(sourceOf(s.doc)).toBe("[1, {a: 2}]\n");
  });
  it("a NAMED hole in a flow map takes the paste as the pair's value", () => {
    const s = pasteSubtree(type("{{k: "), "[1, 2]");
    expect(s.refused).toBe(false);
    expect(sourceOf(s.doc)).toBe("{k: [1, 2]}\n");
  });
  it("an UNNAMED hole in a flow map refuses — the same law typing obeys", () => {
    const s = pasteSubtree(type("{{"), "12");
    expect(s.refused).toBe(true);
    expect(sourceOf(s.doc)).toBe("{}\n");
  });
  it("an empty BLOCK child takes the paste as its whole value (`k:` + Enter, paste)", () => {
    const s = pasteSubtree(type("k:{Enter}"), "[1, 2]");
    expect(s.refused).toBe(false);
    expect(sourceOf(s.doc)).toBe("k: [1, 2]\n");
  });
  it("a scalar pastes as the OMNI value among block entries", () => {
    const s0 = type("- one{Enter}{ShiftTab}");
    const s = pasteSubtree(s0, "30");
    expect(s.refused).toBe(false);
    // the value KEEPS the row it was pasted at (meta.selfAt) — order is committed labour
    expect(sourceOf(s.doc)).toBe("- one\n30\n");
  });
  it("unparseable text REFUSES and loses nothing", () => {
    const s0 = type("[1, ");
    const s = pasteSubtree(s0, "{a: ");
    expect(s.refused).toBe(true);
    expect(s.doc).toBe(s0.doc);
    expect(s.cursor).toEqual(s0.cursor);
  });
  it("copy → paste round-trips a subtree between documents", () => {
    const src = parseSource("[1, {a: [2, 3]}]\n");
    const text = copySubtree(at(src, { at: "after", path: [1], text: "" } as unknown as Cursor));
    expect(text).toBe("{a: [2, 3]}");
    const s = pasteSubtree(type("[9, "), text!);
    expect(s.refused).toBe(false);
    expect(sourceOf(s.doc)).toBe("[9, {a: [2, 3]}]\n");
  });
});

describe("yed2 pasteText — the clipboard layer: the sibling splice, the JSON5 sniff, the guards", () => {
  const among = (text: string, index: number): EditorState =>
    ({ doc: parseSource(text), cursor: { at: "hole", path: [], index, text: "", key: null }, refused: false, log: [] });

  it("a BLOCK document pasted among entries splices its top-level entries as SIBLINGS", () => {
    const s = pasteText(among("a: 1\nz: 9\n", 1), "b: 2\n- item\n");
    expect(s.refused).toBe(false);
    expect(sourceOf(s.doc)).toBe("a: 1\nb: 2\n- item\nz: 9\n");
    // the caret rests in the hole AFTER the spliced run
    expect(s.cursor).toEqual({ at: "hole", path: [], index: 3, text: "", key: null });
  });

  it("a spliced SELF value becomes the container's omni line at its pasted position", () => {
    const s = pasteText(among("a: 1\n", 1), "The Title\nb: 2\n");
    expect(s.refused).toBe(false);
    expect(sourceOf(s.doc)).toBe("a: 1\nThe Title\nb: 2\n");
  });

  it("a JSON blob pastes with its quoted keys and flow style intact", () => {
    const s = pasteText(among("a: 1\n", 1), '{\n  "b": [1, 2],\n}');
    expect(s.refused).toBe(false);
    // the authored `"b"` survives (EntryMeta.keyRaw), the seq keeps its one-line style
    expect(sourceOf(s.doc)).toContain('"b": [1, 2]');
  });

  it("a JSON5 blob (comments, trailing commas) rides the json5p SNIFF", () => {
    const s = pasteText(among("a: 1\n", 1), "{\n  // the count\n  b: 2,\n}");
    expect(s.refused).toBe(false);
    expect(sourceOf(s.doc)).toBe("a: 1\nb: 2\n");
  });

  it("normalization: CRLF and the trailing newline run are the shell's, not the value's", () => {
    const s = pasteText(among("a: 1\n", 1), "b: 2\r\nc: 3\r\n\r\n\r\n");
    expect(s.refused).toBe(false);
    expect(sourceOf(s.doc)).toBe("a: 1\nb: 2\nc: 3\n");
  });

  it("a `~` back edge REFUSES wholesale — dropping one would lose an entry", () => {
    const s0 = among("a: 1\n", 1);
    const s = pasteText(s0, "x: 1\n~kin: *: a\n");
    expect(s.refused).toBe(true);
    expect(s.doc).toBe(s0.doc);
  });

  it("an oversized paste refuses (the editor is not a bulk importer)", () => {
    const s = pasteText(among("a: 1\n", 1), "k: " + "x".repeat(MAX_PASTE));
    expect(s.refused).toBe(true);
  });

  it("BLOCK structure into a flow token refuses rather than being silently reshaped", () => {
    const s = pasteText(type("[1, "), "a: 1\nb: 2\n");
    expect(s.refused).toBe(true);
    expect(sourceOf(s.doc)).toBe("[1]\n");
  });

  it("the ONE-value laws still apply where no splice fits (the empty document)", () => {
    const s = pasteText(initialState(), "{a: 1}");
    expect(s.refused).toBe(false);
    expect(sourceOf(s.doc)).toBe("{a: 1}\n");
  });
});
