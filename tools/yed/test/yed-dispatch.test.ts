// THE GRAMMAR TABLE, executable — every (site, key) → intent transition of dispatch.ts asserted
// as data. This is the file YAMLOVER_EDITOR.yo mirrors: a grammar change edits BOTH or the
// review catches it. Pure — no DOM, no React; it runs in a plain node environment.
import { describe, it, expect } from "vitest";
import { interpret, type Site, type Intent } from "../src/grammar/dispatch";

/** A site, tersely: defaults are a decided, uncommitted entry with the caret alone in an empty
 *  cell (both edges at once) — override what a row cares about. */
function site(cell: Site["cell"], container: Site["container"], over: Partial<Site> = {}): Site {
  return {
    cell, container,
    textEmpty: true, caretAtStart: true, caretAtEnd: true,
    entryDecided: true, entryCommitted: false,
    ...over,
  };
}

const kind = (k: string, s: Site, shift = false): string | null => {
  const i = interpret({ key: k, shift }, s);
  return i ? i.kind : null;
};

describe("the dispatch table — one meaning per (site, key)", () => {
  it("a token cell inside a flow container", () => {
    const t = (c: Site["container"]) => site("token", c, { textEmpty: false });
    expect(kind(",", t("flowSeq"))).toBe("nextElement");
    expect(kind(",", t("flowMap"))).toBe("nextElement");
    expect(kind("]", t("flowSeq"))).toBe("closeToken");
    expect(kind("}", t("flowMap"))).toBe("closeToken");
    expect(kind("}", t("flowSeq"))).toBe("refuse"); // the WRONG closer rings, visibly
    expect(kind("]", t("flowMap"))).toBe("refuse");
    expect(kind("Enter", t("flowSeq"))).toBe("nextElement"); // with text: the element takes its row
    expect((interpret({ key: "Enter" }, t("flowSeq")) as Extract<Intent, { kind: "nextElement" }>).spread).toBe(true);
    expect(kind("Enter", site("token", "flowSeq"))).toBe("spreadOrClose"); // empty: allocate the row
    expect(kind("Backspace", t("flowSeq"))).toBe("join"); // head of the first line — the join spot
    expect(kind("ArrowLeft", t("flowSeq"))).toBe("move");
    expect(kind("ArrowRight", t("flowSeq"))).toBe("move");
    expect(kind("Tab", t("flowSeq"))).toBe("move"); // no indent levels inside a token
  });

  it("an ATOM the caret stands ON (a pointer) — deletable, walkable, not editable in place", () => {
    const a = (c: Site["container"]) => site("atom", c, { entryCommitted: true });
    expect(kind("Backspace", a("block"))).toBe("removeLevel");    // the ladder: the value goes
    expect(kind("Backspace", a("flowSeq"))).toBe("removeLevel");
    expect(kind(",", a("flowSeq"))).toBe("nextElement");
    expect(kind(",", a("block"))).toBe("refuse");                 // in block rows a comma is just typing — it rings
    expect(kind("]", a("flowSeq"))).toBe("closeToken");
    expect(kind("}", a("flowSeq"))).toBe("refuse");               // the wrong closer rings
    expect(kind("Enter", a("block"))).toBe("pick");               // open the reference for editing
    expect(kind("Enter", a("flowSeq"))).toBe("pick");
    expect(kind("x", a("block"))).toBe("refuse");                 // typing into an atom RINGS
    expect(kind("ArrowLeft", a("block"))).toBe("move");
    expect(kind("ArrowRight", a("block"))).toBe("move");
    expect(kind("Tab", a("block"))).toBe("move");
  });

  it("the PICK cell — a pointer's raw being edited (atom Enter opened it)", () => {
    const p = (c: Site["container"], over: Partial<Site> = {}) => site("pick", c, { entryCommitted: true, ...over });
    expect(kind("Enter", p("block", { textEmpty: false }))).toBe("commit");   // parses-or-refuses
    expect(kind("Enter", p("block"))).toBe("commit");                          // empty commits → refuses (no target)
    expect(kind("Backspace", p("block"))).toBe("removeLevel");                 // the emptied reference goes
    expect(kind("Backspace", p("block", { textEmpty: false, caretAtStart: true }))).toBe("move");
    expect(kind(",", p("flowSeq", { textEmpty: false }))).toBe("nextElement"); // commit, next element
    expect(kind(",", p("block", { textEmpty: false }))).toBeNull();            // block rows: a comma is text (a quoted key portion)
    expect(kind("]", p("flowSeq", { textEmpty: false }))).toBe("closeToken");
    expect(kind("}", p("flowSeq", { textEmpty: false }))).toBe("refuse");      // the wrong closer rings
    expect(kind("Tab", p("flowSeq"))).toBe("move");
    expect(kind("Tab", p("block"))).toBe("indent");
    expect(kind("Tab", p("block"), true)).toBe("dedent");
    expect(kind("ArrowLeft", p("block", { textEmpty: false, caretAtStart: true }))).toBe("move");
    expect(kind("ArrowRight", p("block", { textEmpty: false, caretAtEnd: true }))).toBe("move");
    expect(kind("x", p("block"))).toBeNull();                                  // printables: native raw editing
  });

  it("a KEY cell inside a token", () => {
    const k = site("key", "flowMap", { textEmpty: false });
    expect(kind("Enter", k)).toBe("keyCommit"); // commit the key; the pair takes its own row
    expect(kind(",", k)).toBeNull();            // part of the key's text
    expect(kind("ArrowRight", k)).toBe("move");
    // an EMPTIED key + Backspace un-names the pair — `{: 12}` → `{12}` — so the delete ladder
    // continues through it (the jam the reported two-element document hit)
    expect(kind("Backspace", site("key", "flowMap"))).toBe("undoMarker");
  });

  it("holes — the classifier runs first (cells.tsx), the table handles the rest", () => {
    expect(kind("Enter", site("holeEntry", "block", { textEmpty: false }))).toBe("commit");
    expect(kind("Enter", site("holeEntry", "block"))).toBe("nop");       // never a DOM newline
    expect(kind("Enter", site("holeValue", "block"))).toBe("nestValue"); // the value becomes a block
    expect(kind("Enter", site("holeValue", "flowSeq"))).toBe("spreadOrClose"); // flow: the row
    expect(kind("Tab", site("holeEntry", "block"))).toBe("indent");
    expect(kind("Tab", site("holeEntry", "block"), true)).toBe("dedent");
    expect(kind("Tab", site("holeValue", "flowSeq"))).toBe("move");
  });

  it("Enter at the HEAD of a committed block row opens the sibling BEFORE it", () => {
    const t = (over: Partial<Site> = {}) => site("token", "block", { textEmpty: false, entryCommitted: true, ...over });
    expect(kind("Enter", t({ caretAtStart: true, caretAtEnd: false }))).toBe("siblingBefore");
    // mid-text and end-of-text keep THE LEVEL RULE's descend (commit)
    expect(kind("Enter", t({ caretAtStart: false, caretAtEnd: false }))).toBe("commit");
    expect(kind("Enter", t({ caretAtStart: false, caretAtEnd: true }))).toBe("commit");
    // inside a flow token Enter keeps its own meaning — the element takes its row
    expect(kind("Enter", site("token", "flowSeq", { textEmpty: false, caretAtStart: true, caretAtEnd: false }))).toBe("nextElement");
    // a hole's typed text is not a row yet — its Enter still commits
    expect(kind("Enter", site("holeEntry", "block", { textEmpty: false, caretAtStart: true, caretAtEnd: false }))).toBe("commit");
  });

  it("Backspace on an empty cell — ONE PRESS, ONE LEVEL", () => {
    expect(kind("Backspace", site("holeValue", "block", { entryDecided: true }))).toBe("undoMarker");
    expect(kind("Backspace", site("holeValue", "block", { entryDecided: false }))).toBe("removeLevel");
    expect(kind("Backspace", site("holeValue", "block", { entryCommitted: true }))).toBe("removeLevel");
    expect(kind("Backspace", site("token", "block", { textEmpty: false, caretAtStart: true }))).toBe("move");
  });

  it("the gap past a closer", () => {
    const g = (over: Partial<Site> = {}) => site("gapClose", "block", over);
    expect(kind("Backspace", g({ tokenEmpty: true }))).toBe("reopenToken"); // `[]` reopens inside
    expect(kind("Backspace", g({ tokenEmpty: false }))).toBe("move");       // else: step inside
    expect(kind(",", g({ outer: "seq" }))).toBe("nextElement");
    expect(kind("]", g({ outer: "seq" }))).toBe("closeToken");
    expect(kind(":", g())).toBe("tokenKey");                 // `[256, 256]: …` — the token as a key
    expect(kind(":", g({ outer: "map" }))).toBe("tokenKey"); // `{{}: 12}` too
    expect(kind(":", g({ outer: "seq" }))).toBe("refuse");   // a sequence has no keys — it RINGS
    expect(kind("Enter", g({ outer: "seq" }))).toBe("siblingAfter");
    expect(kind("Enter", g())).toBe("siblingAfter"); // in a BLOCK container too: `m: {}` + Enter
    expect(kind("ArrowRight", g())).toBe("move"); // universal navigation: gaps never swallow arrows
    expect(kind("ArrowLeft", g())).toBe("move");
    expect(kind("x", g())).toBeNull(); // an unknown key passes through — never silently eaten
  });

  it("vertical arrows cross only from an edge line", () => {
    expect(kind("ArrowUp", site("token", "block", { caretFirstLine: false }))).toBeNull();
    expect(kind("ArrowUp", site("token", "block", { caretFirstLine: true }))).toBe("move");
    expect(kind("ArrowDown", site("token", "block", { caretLastLine: false }))).toBeNull();
  });

  it("printable characters are NEVER the table's — text belongs to cells", () => {
    for (const c of ["a", "1", "-", '"', "{", "["]) {
      expect(kind(c, site("holeEntry", "block")), `"${c}" must reach the classifier`).toBeNull();
      expect(kind(c, site("token", "block", { textEmpty: false })), `"${c}" must reach the cell`).toBeNull();
    }
  });
});
