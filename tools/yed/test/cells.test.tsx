// @vitest-environment jsdom
// yed2 D1 GATE — the recursive projection: every cell framed and TITLED with its kind, the same
// closed set at every depth, the gap visible, the active cell marked. EditorView is pure over its
// props, so the test hands it a state and reads the DOM.
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { EditorView } from "../src/page";
import { defaultRegistry, type CellRegistry } from "../src/cells";
import { parseSource, initialState, type EditorState, type Node } from "../src/state";
import { applyKey, positionsOf } from "../src/apply";
import { parseScript } from "./keys-util";

afterEach(cleanup);

const stateFor = (src: string): EditorState => ({
  doc: parseSource(src), cursor: { at: "after", path: [] }, refused: false, log: [],
});

const kindsOf = (c: HTMLElement): string[] =>
  Array.from(c.querySelectorAll("[data-kind]")).map((el) => el.getAttribute("data-kind")!);

describe("yed2 cells — the projection is visible", () => {
  it("renders {a: [1, {b: 2}]} with titled, nested cells of the closed set", () => {
    const state = stateFor("a: {q: [1, 2], b: 2}\n");
    const { container } = render(<EditorView state={state} setState={() => {}} />);
    const kinds = kindsOf(container);
    // the closed set only, and the nesting is present (a map inside the block root, a seq inside it)
    expect(new Set(kinds)).toEqual(new Set(["block", "key", "map", "seq", "token", "gap"]));
    expect(kinds.filter((k) => k === "token")).toHaveLength(3); // 1, 2, 2
    expect(kinds.filter((k) => k === "gap")).toHaveLength(2);   // after the seq, after the map
    // every framed cell carries its visible caption
    for (const cell of Array.from(container.querySelectorAll(".y2-cell"))) {
      expect(cell.querySelector(".y2-tag")?.textContent).toBeTruthy();
    }
  });

  it("the ACTIVE cell is marked, and a typed state shows the hole", () => {
    let state = initialState();
    for (const k of parseScript("[1, ")) state = applyKey(state, "ch" in k ? { key: k.ch } : k);
    const { container } = render(<EditorView state={state} setState={() => {}} />);
    expect(container.querySelector(".y2-cell.y2-hole.y2-active")).toBeTruthy();
    expect(container.querySelector("[data-testid=y2-source]")?.textContent).toContain("[1]");
  });

  it("the legend lights EXACTLY the keys that ACT — a dry-run, not the grammar's claim", () => {
    let state = initialState();
    for (const k of parseScript("[1")) state = applyKey(state, "ch" in k ? { key: k.ch } : k);
    const { container } = render(<EditorView state={state} setState={() => {}} />);
    const caps = Array.from(container.querySelectorAll(".y2-keycap"));
    const byLabel = Object.fromEntries(caps.map((c) => [c.textContent, c.className]));
    expect(byLabel["]"]).toContain("y2-on");   // closes the seq — acts
    expect(byLabel[","]).toContain("y2-on");   // commits, opens the next element — acts
    expect(byLabel["}"]).toContain("y2-off");  // could only RING (the wrong closer) — not "enabled"
    expect(byLabel[":"]).toContain("y2-on");   // plain text in the hole (`1:30` is a scalar)
  });

  it("↑ at the TOP and ↓ at the BOTTOM are GREY — a key that can only refuse is not enabled", () => {
    // reported: jumping ↑/↓ inside [ { } ] rang red at the edges while the keycaps showed on
    let state = initialState();
    for (const k of parseScript("[{Enter}{{{Enter}")) state = applyKey(state, "ch" in k ? { key: k.ch } : k);
    const { container } = render(<EditorView state={state} setState={() => {}} />);
    const byLabel = Object.fromEntries(Array.from(container.querySelectorAll(".y2-keycap")).map((c) => [c.textContent, c.className]));
    expect(byLabel["↑"]).toContain("y2-off"); // no row above the hole — pressing could only ring
    expect(byLabel["↓"]).toContain("y2-on");  // the closer row below — acts
  });

  it("EVERY cursor state renders its cell — `- name: Eurasia` + Enter keeps a visible hole", () => {
    // reported: after the descend into the committed scalar the hole had NO cell — focus fell on
    // the floor. The law: the caret can never stand where the projection draws nothing.
    let state = initialState();
    for (const k of parseScript("- name: Eurasia{Enter}")) state = applyKey(state, "ch" in k ? { key: k.ch } : k);
    expect(state.cursor.at).toBe("hole");
    const { container } = render(<EditorView state={state} setState={() => {}} />);
    expect(container.querySelector(".y2-cell.y2-hole.y2-active .y2-input")).toBeTruthy();
    expect(container.querySelector("[data-testid=y2-source]")?.textContent).toContain("- name: Eurasia");
  });

  it("the `- ` decision is VISIBLE on the hole, and block rows draw their markers", () => {
    let state = initialState();
    for (const k of parseScript("- a{Enter}{ShiftTab}- ")) state = applyKey(state, "ch" in k ? { key: k.ch } : k);
    const { container } = render(<EditorView state={state} setState={() => {}} />);
    const hole = container.querySelector(".y2-cell.y2-hole");
    expect(hole?.querySelector(".y2-punct")?.textContent).toBe("- "); // the ordinal decision, drawn
    const doc = container.querySelector("[data-testid=y2-doc]")!;
    const dashes = Array.from(doc.querySelectorAll(".y2-punct")).filter((p) => p.textContent === "- ");
    expect(dashes.length).toBe(2); // the committed keyless row's marker + the hole's own
  });

  it("the REGISTRY plugs a cell by FORMAT — the prose/math seam, format before kind", () => {
    const state = stateFor("a: hello\n");
    // what the engine's walk stamps on a format-carrying node
    const v = (state.doc.root as Node).entries![0].value as Node;
    v.meta = { ...(v.meta ?? {}), derivedFormat: "text/x-test" } as Node["meta"];
    const reg: CellRegistry = {
      ...defaultRegistry,
      byFormat: { "text/x-test": ({ node }) => <span data-testid="custom-cell">FMT:{String((node as { value?: unknown }).value)}</span> },
    };
    const { getByTestId, container } = render(<EditorView state={state} setState={() => {}} cells={reg} />);
    expect(getByTestId("custom-cell").textContent).toBe("FMT:hello");
    expect(container.querySelector(".y2-cell[data-kind=token]")).toBeNull(); // the format cell REPLACED the kind cell
  });

  it("a refused state rings the active cell", () => {
    let state = initialState();
    for (const k of parseScript("{{12}")) state = applyKey(state, "ch" in k ? { key: k.ch } : k);
    expect(state.refused).toBe(true);
    const { container } = render(<EditorView state={state} setState={() => {}} />);
    expect(container.querySelector(".y2-refused")).toBeTruthy();
    expect(container.querySelector("[data-testid=y2-cursor]")?.textContent).toContain("REFUSED");
  });

  it("a DERIVED-anchor member (meta.anchorKey) shows the dimmed `&key` chip — decoration, not a cell", () => {
    const state = stateFor("- Alice\n- 42\n");
    const entries = (state.doc.root as Node).entries!;
    entries[0] = { ...entries[0], meta: { anchorKey: "anyfile01" } } as never;
    const { container } = render(<EditorView state={state} setState={() => {}} />);
    const chip = container.querySelector(".y2-anchor-derived")!;
    expect(chip.textContent).toBe("&anyfile01 ");
    expect(chip.getAttribute("tabindex")).toBeNull(); // read-only chrome — the walk never lands here
    expect(container.querySelectorAll(".y2-dash")).toHaveLength(2); // the rows stay positional
  });

  it("the ＋ tail opens the trailing hole; it hides while that hole is open and off flow roots", () => {
    const state = stateFor("a: 1\n");
    let latest = state;
    const { container, rerender } = render(<EditorView state={state} setState={(s) => { latest = s; }} />);
    const tail = container.querySelector<HTMLButtonElement>(".y2-tail")!;
    expect(tail, "the non-empty block root draws the ＋ tail").toBeTruthy();
    fireEvent.click(tail);
    expect(latest.cursor).toEqual({ at: "hole", path: [], index: 1, text: "", key: null });
    rerender(<EditorView state={latest} setState={() => {}} />);
    expect(container.querySelector(".y2-tail")).toBeNull(); // the hole is open — never doubled
    cleanup();
    const flow = render(<EditorView state={stateFor("[1, 2]\n")} setState={() => {}} />);
    expect(flow.container.querySelector(".y2-tail")).toBeNull(); // flow appends through its own grammar
  });
});

describe("yed2 cells — a BLOCK container's & anchors are HEAD rows, and the colon's right is a way in", () => {
  // reported: a container's bookmark rendered inline inside its FIRST CHILD's row
  // (`name: Bubbles  &: …`), reading as the child's own — misplaced-or-wrong-node confusion.
  // In block form anchor rows sit at the block's HEAD, exactly where the serializer writes them.
  const DOC = "pet:\n  &: humans: pets\n  name: Bubbles\n  species: fish\n";

  it("the anchors row precedes the child rows — inside the container's block, its own row", () => {
    const { container } = render(<EditorView state={stateFor(DOC)} setState={() => {}} />);
    const anchorsCell = container.querySelector(".y2-cell[data-kind=anchors]")!;
    expect(anchorsCell).toBeTruthy();
    // its row is a sibling BEFORE the child entries' rows, not inside any child's row
    const row = anchorsCell.closest(".y2-row")!;
    expect(row.textContent).not.toContain("Bubbles");
    const rows = Array.from(row.parentElement!.children);
    const nameRow = rows.find((r) => r.textContent!.includes("name"))!;
    expect(rows.indexOf(row)).toBeLessThan(rows.indexOf(nameRow));
  });

  it("a LEADING self value keeps its row first; the anchors row follows it", () => {
    const { container } = render(<EditorView state={stateFor("a: 12\n  &: c\n  - b\n")} setState={() => {}} />);
    const anchorsRow = container.querySelector(".y2-cell[data-kind=anchors]")!.closest(".y2-row")!;
    const rows = Array.from(anchorsRow.parentElement!.children);
    const selfRow = rows.find((r) => r.textContent!.includes("12"))!;
    const bRow = rows.find((r) => r.textContent!.includes("b"))!;
    expect(rows.indexOf(selfRow)).toBeLessThan(rows.indexOf(anchorsRow));
    expect(rows.indexOf(anchorsRow)).toBeLessThan(rows.indexOf(bRow));
  });

  it("the WALK agrees: key → anchors → children for an anchored block container", () => {
    const state = stateFor(DOC);
    expect(positionsOf(state.doc)).toEqual([
      { at: "key", path: [0] },
      { at: "anchors", path: [0] },
      { at: "key", path: [0, 0] },
      { at: "token", path: [0, 0] },
      { at: "key", path: [0, 1] },
      { at: "token", path: [0, 1] },
    ]);
  });

  it("a click RIGHT OF THE COLON opens the container's head hole (the Enter-on-key landing)", () => {
    const state = stateFor("pet:\n  name: Bubbles\n");
    let latest = state;
    const { container } = render(<EditorView state={state} setState={(s) => { latest = s; }} />);
    // the key row of the wrapped block — mousedown on the row itself (the blank), not the key cell
    const keyRow = container.querySelector(".y2-k")!.closest(".y2-row")!;
    fireEvent.mouseDown(keyRow);
    expect(latest.cursor).toEqual({ at: "hole", path: [0], index: 0, text: "", key: null });
  });
});

describe("yed2 cells — identity decorations are VISIBLE chrome", () => {
  const decorTexts = (c: HTMLElement): string[] =>
    Array.from(c.querySelectorAll(".y2-decor")).map((el) => el.textContent!.trim());

  it("a tagged node shows its decorations in every shape — the TAG as its editable cell", () => {
    const state = stateFor("- !!<*yamlover: $defs: recipe> !!yo 5\n- !!<format: text/x-latex> 'e = mc^2'\n");
    const { container } = render(<EditorView state={state} setState={() => {}} />);
    const tags = Array.from(container.querySelectorAll(".y2-tagtext")).map((el) => el.textContent);
    expect(tags).toContain("*yamlover: $defs: recipe");
    expect(tags).toContain("format: text/x-latex");
    expect(decorTexts(container)).toContain("!!yo"); // the semantic mark stays chrome
  });

  it("a !!yo container root and its & anchors render as chrome", () => {
    const state = stateFor("!!yo\nserves: 4\n  &: recipes: main\n");
    const { container } = render(<EditorView state={state} setState={() => {}} />);
    const decors = decorTexts(container);
    expect(decors).toContain("!!yo");
    expect(decors.some((d) => d.includes("&"))).toBe(true);
  });

  it("untagged cells render NO decor, and decor is content chrome — not the debug caption", () => {
    const state = stateFor("a: 1\n");
    const { container } = render(<EditorView state={state} setState={() => {}} />);
    expect(container.querySelectorAll(".y2-decor")).toHaveLength(0);
    // the tagged twin: the decor span must not live inside a .y2-tag caption (debug-only)
    const tagged = stateFor("!!yo\na: 1\n");
    const { container: c2 } = render(<EditorView state={tagged} setState={() => {}} />);
    const decor = c2.querySelector(".y2-decor")!;
    expect(decor).toBeTruthy();
    expect(decor.closest(".y2-tag")).toBeNull();
  });

  it("an EMPTIED tagged root keeps its decor face over the hole", () => {
    const state: EditorState = {
      doc: { root: { kind: "mapping", entries: [], meta: { yo: true } }, source: { concrete: "yamlover", uri: "<t>" } } as unknown as EditorState["doc"],
      cursor: { at: "hole", path: [], index: 0, text: "", key: null }, refused: false, log: [],
    };
    const { container } = render(<EditorView state={state} setState={() => {}} />);
    expect(container.querySelector(".y2-decor")?.textContent?.trim()).toBe("!!yo");
  });
});

describe("yed2 cells — the renderer-parity round (the read view is the standard)", () => {
  it("scalar TONES: every value type carries its renderer color class on the cell", () => {
    const state = stateFor("s: hi\nn: 5\nb: true\nx: null\n");
    const { container } = render(<EditorView state={state} setState={() => {}} />);
    for (const tone of ["y2-s", "y2-n", "y2-b", "y2-null"]) {
      expect(container.querySelector(`.y2-cell.y2-token.${tone}`), tone).toBeTruthy();
    }
  });

  it("the DASH is the renderer's scaled mark — inside a span still reading `- `", () => {
    const state = stateFor("- 1\n- 2\n");
    const { container } = render(<EditorView state={state} setState={() => {}} />);
    const dashes = Array.from(container.querySelectorAll(".y2-punct")).filter((p) => p.textContent === "- ");
    expect(dashes.length).toBe(2);
    for (const d of dashes) expect(d.querySelector(".y2-dash")?.textContent).toBe("-");
  });

  it("a `|` BLOCK scalar renders the renderer's shape: header on the key row, body rows one step in", () => {
    const state = stateFor("k: |\n  line one\n  line two\n");
    const { container } = render(<EditorView state={state} setState={() => {}} />);
    // no single-line collapse: the body is two indented rows, the header rides the key's row
    const tokenCell = container.querySelector(".y2-cell.y2-token")!;
    const rows = Array.from(tokenCell.querySelectorAll(".y2-row"));
    expect(rows[0].textContent).toContain("k: ");
    expect(rows[0].textContent).toContain("|");
    const bodyRows = rows.filter((r) => r.classList.contains("y2-indent"));
    expect(bodyRows.map((r) => r.textContent)).toEqual(["line one", "line two"]);
    expect(tokenCell.querySelector("input")).toBeNull(); // read face — no input
  });

  it("a keyed OMNI's field rows sit one step in below `key: value`; a ROOT omni stays flat", () => {
    const keyed = stateFor("k: v\n  - sub\n");
    const { container } = render(<EditorView state={keyed} setState={() => {}} />);
    const omni = container.querySelector(".y2-cell.y2-omni")!;
    const rows = Array.from(omni.querySelectorAll(":scope > .y2-cell > .y2-rows > .y2-row"));
    expect(rows[0].textContent).toContain("k: ");
    expect(rows[0].textContent).toContain("v");
    expect(rows[1].classList.contains("y2-indent")).toBe(true);
    cleanup();
    const root = stateFor("v\n- sub\n");
    const { container: c2 } = render(<EditorView state={root} setState={() => {}} />);
    const omni2 = c2.querySelector(".y2-cell.y2-omni")!;
    const rows2 = Array.from(omni2.querySelectorAll(":scope > .y2-cell > .y2-rows > .y2-row"));
    expect(rows2.some((r) => r.classList.contains("y2-indent"))).toBe(false);
  });

  it("COMMENTS and blank lines are read-only chrome rows — drawn, never focusable, never a position", () => {
    const src = "# banner\n\na: 1\t# note\n\n# about b\nb: 2\n";
    const state = stateFor(src);
    const { container } = render(<EditorView state={state} setState={() => {}} />);
    const comments = Array.from(container.querySelectorAll(".y2-comment")).map((el) => el.textContent);
    expect(comments).toContain("# banner");
    expect(comments).toContain("# note");
    expect(comments).toContain("# about b");
    expect(container.querySelectorAll(".y2-blankline").length).toBeGreaterThanOrEqual(2);
    // no comment element is focusable or stamped as a position
    for (const el of Array.from(container.querySelectorAll(".y2-comment, .y2-comment-row, .y2-blankline"))) {
      expect(el.getAttribute("tabindex")).toBeNull();
      expect(el.getAttribute("data-at")).toBeNull();
      expect(el.getAttribute("data-path")).toBeNull();
    }
  });

  it("the caret walk is COMMENT-BLIND: positions equal with and without comments", async () => {
    const { positionsOf } = await import("../src/apply");
    const commented = parseSource("# banner\n\na: 1\t# note\n\n# about b\nb: 2\n");
    const bare = parseSource("a: 1\nb: 2\n");
    expect(positionsOf(commented)).toEqual(positionsOf(bare));
  });

  it("a TAGGED ROOT's chrome stands on its own line — the body returns to column 0 (the RootDeco law)", () => {
    // reported: the whole document body hung at the tag's right edge (a giant left margin) —
    // inline chrome before the root omni's inline-block anchored every row at the tag column
    const state = stateFor("!!<*yamlover: $defs: chapter>\nThe Title\ndescription: blurb\n- chunk one\n");
    const { container } = render(<EditorView state={state} setState={() => {}} />);
    const tagCell = container.querySelector(".y2-cell.y2-tag")!;
    expect(tagCell).toBeTruthy();
    // the tag's row holds ONLY chrome — never the title or any body row
    const tagRow = tagCell.closest(".y2-row")!;
    expect(tagRow.textContent).not.toContain("The Title");
    expect(tagRow.textContent).not.toContain("description");
    // and the title's row does not carry the tag
    const title = Array.from(container.querySelectorAll(".y2-v")).find((el) => el.textContent === "The Title")!;
    expect(title.closest(".y2-row")?.textContent).not.toContain("$defs");
  });

  it("a container's TAIL comment renders after its last entry", () => {
    const state = stateFor("a: 1\n# the end\n");
    const { container } = render(<EditorView state={state} setState={() => {}} />);
    const doc = container.querySelector("[data-testid=y2-doc]")!;
    expect(Array.from(doc.querySelectorAll(".y2-comment")).map((el) => el.textContent)).toContain("# the end");
  });
});
