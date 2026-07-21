// @vitest-environment jsdom
// The projectional editor's CELL behaviour: hole typing materializes structure (quote pairing,
// `- ` / `k: ` shaping, `{` flow pairing, `*` pointer cells), Enter opens sibling holes, Backspace
// drops empty entries, Tab indents — and the op queue flushes the expected surgical batches.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, waitFor, fireEvent, act } from "@testing-library/react";
import { TocFilterCtx, useTocFilterSession } from "../../src/client/toc-filter-session";

const { editChunks, fetchNode, fetchAnnotations, queryTree, queryFilter } = vi.hoisted(() => ({
  editChunks: vi.fn(),
  fetchNode: vi.fn(),
  fetchAnnotations: vi.fn().mockResolvedValue([]),
  queryTree: vi.fn(),
  queryFilter: vi.fn(),
}));
vi.mock("../../src/client/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), editChunks, fetchNode, fetchAnnotations, queryTree, queryFilter }));

import { YamloverEditor } from "../../src/client/renderers/yamlover-editor/editor";
import { NodeView } from "../../src/client/NodeView";

const OMNI = {
  path: ":doc", type: "object", concrete: "dir/yamlover", title: null, description: null,
  value: {
    $yamloverMixed: {
      kind: "omni", value: "A Title", selfAt: 0,
      entries: [
        { key: "description", value: "the blurb" },
        { key: null, value: "chunk one" },
        { key: null, value: { $yamloverRef: { text: ":pets[1]", path: ":pets[1]" } } },
      ],
    },
  },
  comments: { "": { tag: "!!<*yamlover: $defs: chapter>" }, "[2]": { pointer: ":pets[1]" } },
};

const ARR = {
  path: ":d", type: "array", concrete: "yamlover", title: null, description: null,
  value: ["alpha", "beta"],
};

beforeEach(() => {
  editChunks.mockReset().mockResolvedValue({ ok: true });
  fetchNode.mockReset().mockResolvedValue(OMNI);
  // the reference cell's server-backed hints/filter: empty by default (operators-only dropdown)
  queryTree.mockReset().mockResolvedValue([]);
  queryFilter.mockReset().mockRejectedValue(new Error("no filter mock")); // pick Enter falls back to verbatim
});
afterEach(cleanup);

/** Mount and wait for the model fetch to settle. */
async function mount(path = ":doc") {
  const utils = render(<YamloverEditor path={path} onNavigate={() => {}} />);
  await waitFor(() => expect(utils.container.querySelector(".yed-row")).toBeTruthy());
  return utils;
}

/** Type into a contentEditable cell: set its text and fire input (per-keystroke fidelity is not
 *  needed — the classifier reads the full current text). */
function type(el: Element, text: string) {
  (el as HTMLElement).textContent = text;
  fireEvent.input(el);
}

/** Open a fresh entry hole via the ＋ tail affordance. */
function openHole(container: HTMLElement): HTMLElement {
  fireEvent.click(container.querySelector(".yed-tail")!);
  const holes = container.querySelectorAll<HTMLElement>(".yed-hole");
  return holes[holes.length - 1];
}

/** Put the collapsed caret at `offset` inside a cell (jsdom Range) — the query-cell key
 *  grammar (merges, scope steps) reads the caret position. */
function setCaret(el: HTMLElement, offset: number) {
  const sel = window.getSelection()!;
  const r = document.createRange();
  const t = el.firstChild ?? el;
  r.setStart(t, offset);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

describe("rendering — the cell tree mirrors the structure", () => {
  it("projects the omni shape: tag row, self-value, keyed row, dash rows, pointer, nesting classes", async () => {
    const { container } = await mount();
    const text = container.textContent!;
    expect(text).toContain("!!<");
    expect(text).toContain("*yamlover: $defs: chapter");
    expect(text).toContain("A Title");
    expect(container.querySelector(".k")!.textContent).toBe("description");
    expect(container.querySelectorAll(".yaml-dash")).toHaveLength(2);
    expect(text).toContain("*"); // the pointer sigil
    expect(container.querySelector(".yed-tail")).toBeTruthy(); // the append affordance
  });

  it("nested containers render compactly: first child ON the dash row, the rest inside .yed-indent", async () => {
    fetchNode.mockResolvedValue({
      path: ":d", type: "array", concrete: "yamlover", title: null, description: null,
      value: [{ $yamloverMixed: { kind: "mix", entries: [{ key: "name", value: "Rex" }, { key: "age", value: 4 }] } }],
    });
    const { container } = await mount(":d");
    const dashRow = container.querySelector(".yaml-dash")!.closest(".yed-row")!;
    expect(dashRow.querySelector(".k")!.textContent).toBe("name"); // `- name: Rex` — compact
    const region = container.querySelector(".yed-indent")!;
    expect(region.querySelector(".k")!.textContent).toBe("age"); // siblings of the first child indent below
  });
});

describe("hole typing — structure materializes as you type", () => {
  it("`\"` pairs the closing quote with an editable cell between", async () => {
    const { container } = await mount();
    const hole = openHole(container);
    type(hole, '"');
    const strings = container.querySelectorAll(".yed-row .s");
    // the fresh row: open quote, inner editable, close quote
    const row = strings[strings.length - 2].parentElement!;
    const qs = Array.from(row.querySelectorAll(".s")).map((s) => s.textContent);
    expect(qs.filter((t) => t === '"')).toHaveLength(2);
    expect(row.querySelector('.s[contenteditable="true"], .s[contenteditable]')).toBeTruthy();
  });

  it("`- ` shapes an ordinal entry: the dash appears, the hole becomes the value cell", async () => {
    const { container } = await mount();
    const before = container.querySelectorAll(".yaml-dash").length;
    const hole = openHole(container);
    type(hole, "- ");
    expect(container.querySelectorAll(".yaml-dash")).toHaveLength(before + 1);
    expect(container.querySelectorAll(".yed-hole").length).toBeGreaterThan(0); // the value hole remains
  });

  it("`k: ` shapes a keyed entry; committing INSERTS it keyed at its position — no reordering", async () => {
    const { container } = await mount();
    const hole = openHole(container);
    type(hole, "author: ");
    const keys = Array.from(container.querySelectorAll(".k")).map((k) => k.textContent);
    expect(keys).toContain("author");
    // the value hole follows; commit a scalar into it
    const valueHole = container.querySelector<HTMLElement>(".yed-hole:not(.yed-tail)")!;
    type(valueHole, "Bob");
    fireEvent.keyDown(valueHole, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":doc[3]", op: "insert", key: "author", yamlover: "Bob" }]), { timeout: 2000 });
    // authored order kept: `description` stays first, `author` stays where it was typed
    const after = Array.from(container.querySelectorAll(".k")).map((k) => k.textContent);
    expect(after[0]).toBe("description");
    expect(after[after.length - 1]).toBe("author");
  });

  it("`{` pairs the closing brace with an entry hole between (flow cells)", async () => {
    const { container } = await mount();
    const hole = openHole(container);
    type(hole, "{");
    const puncts = Array.from(container.querySelectorAll(".punct")).map((p) => p.textContent);
    expect(puncts).toContain("{");
    expect(puncts).toContain("}");
    expect(container.querySelectorAll(".yed-hole").length).toBeGreaterThan(0); // the inner cell
  });

  it("`*` opens a pointer cell (the shared query cells)", async () => {
    const { container } = await mount();
    const hole = openHole(container);
    type(hole, "*pets");
    const row = hole.closest(".yed-row") ?? container;
    expect(container.textContent).toContain("*");
    const editable = Array.from(container.querySelectorAll<HTMLElement>(".yed-ptrwrap .crumb-cell")).find((el) => el.textContent === "pets");
    expect(editable).toBeTruthy();
    void row;
  });

  it("`- ` + text + Enter appends an array element and opens the NEXT hole", async () => {
    const { container } = await mount();
    const hole = openHole(container);
    type(hole, "- ");
    const valueHole = container.querySelector<HTMLElement>(".yed-hole:not(.yed-tail)")!;
    type(valueHole, "fresh chunk");
    fireEvent.keyDown(valueHole, { key: "Enter" });
    expect(container.querySelectorAll(".yed-hole:not(.yed-tail)").length).toBeGreaterThan(0); // the follow-up hole
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":doc[3]", op: "insert", yamlover: "fresh chunk" }]), { timeout: 2000 });
  });

  it("a BARE token is REJECTED when the node already has its scalar line (one per block)", async () => {
    const { container } = await mount(); // the omni fixture's self-value is "A Title"
    const hole = openHole(container);
    type(hole, "fresh chunk");
    fireEvent.keyDown(hole, { key: "Enter" });
    expect(hole.className).toContain("edit-error");
    expect(editChunks).not.toHaveBeenCalled();
  });

  it("Backspace on an empty hole drops it silently", async () => {
    const { container } = await mount();
    const rows = container.querySelectorAll(".yed-row").length;
    const hole = openHole(container);
    expect(container.querySelectorAll(".yed-row").length).toBeGreaterThan(rows - 1);
    fireEvent.keyDown(hole, { key: "Backspace" });
    await waitFor(() => expect(container.querySelectorAll(".yed-hole:not(.yed-tail)")).toHaveLength(0));
    expect(editChunks).not.toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ op: "remove" })]));
  });
});

describe("Tab / Shift-Tab — structural moves", () => {
  it("Tab indents the second chunk under the first (scalar turns omni)", async () => {
    fetchNode.mockResolvedValue(ARR);
    const { container } = await mount(":d");
    const cells = container.querySelectorAll<HTMLElement>("[data-yed-cell]");
    const beta = Array.from(cells).find((c) => c.textContent === "beta")!;
    fireEvent.keyDown(beta, { key: "Tab" });
    expect(container.querySelector(".yed-indent")).toBeTruthy(); // beta now nested
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([
      { path: ":d[1]", op: "remove" },
      { path: ":d[0]", op: "emplace", yamlover: "alpha\n- beta" },
    ]), { timeout: 2000 });
  });

  it("Shift-Tab dedents back out", async () => {
    fetchNode.mockResolvedValue({
      path: ":d", type: "array", concrete: "yamlover", title: null, description: null,
      value: [{ $yamloverMixed: { kind: "mix", entries: [{ key: null, value: "x" }, { key: null, value: "y" }] } }],
    });
    const { container } = await mount(":d");
    const y = Array.from(container.querySelectorAll<HTMLElement>("[data-yed-cell]")).find((c) => c.textContent === "y")!;
    fireEvent.keyDown(y, { key: "Tab", shiftKey: true });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([
      { path: ":d[0][1]", op: "remove" },
      { path: ":d[1]", op: "insert", yamlover: "y" },
    ]), { timeout: 2000 });
  });
});

describe("the EMPTY document — a root hole with the full grammar", () => {
  const EMPTY = {
    path: ":n", type: "null", format: null, valueType: "null", concrete: "file/yamlover",
    documentPath: ":n", title: null, description: null, value: null, comments: {},
  };
  beforeEach(() => fetchNode.mockResolvedValue(EMPTY));

  it("opens as ONE empty hole (no `\"\"` token) and `12` + Enter emplaces the integer 12", async () => {
    const { container } = await mount(":n");
    expect(container.textContent).not.toContain('""'); // an empty doc is not an empty-string scalar
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    expect(hole).toBeTruthy();
    type(hole, "12");
    fireEvent.keyDown(hole, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":n", op: "emplace", yamlover: "12" }]), { timeout: 2000 });
    const cell = container.querySelector<HTMLElement>("[data-yed-cell]")!;
    expect(cell.textContent).toBe("12");
    expect(cell.className).toContain("n"); // a NUMBER token, not a string
  });

  it("`\"` makes the ROOT a quoted scalar; committing emplaces the quoted source", async () => {
    const { container } = await mount(":n");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, '"');
    const qs = Array.from(container.querySelectorAll(".s")).map((s) => s.textContent);
    expect(qs.filter((t) => t === '"')).toHaveLength(2); // paired quotes, cell between
    const inner = container.querySelector<HTMLElement>('.s[contenteditable]')!;
    type(inner, "hi");
    fireEvent.blur(inner);
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":n", op: "emplace", yamlover: '"hi"' }]), { timeout: 2000 });
  });

  /** The ENTRY's value hole — the root self-value hole renders above it, so take the last. */
  const lastHole = (container: HTMLElement): HTMLElement => {
    const holes = container.querySelectorAll<HTMLElement>(".yed-hole:not(.yed-tail)");
    return holes[holes.length - 1];
  };

  it("`- ` opens the document's first ordinal entry; committing INSERTS at [0]", async () => {
    const { container } = await mount(":n");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, "- ");
    expect(container.querySelectorAll(".yaml-dash")).toHaveLength(1);
    const valueHole = lastHole(container);
    type(valueHole, "hello");
    fireEvent.keyDown(valueHole, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":n[0]", op: "insert", yamlover: "hello" }]), { timeout: 2000 });
  });

  it("`k: ` opens the document's first keyed entry", async () => {
    const { container } = await mount(":n");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, "title: ");
    expect(container.querySelector(".k")!.textContent).toBe("title");
    const valueHole = lastHole(container);
    type(valueHole, "T");
    fireEvent.keyDown(valueHole, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":n[0]", op: "insert", key: "title", yamlover: "T" }]), { timeout: 2000 });
  });

  it("YAMLOVER_EDITOR.yamlover: `pets:` ↵ / `- ` / `name: ` / `Rex` ↵ — the canonical example types through", async () => {
    const { container } = await mount(":n");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, "pets:");
    fireEvent.keyDown(hole, { key: "Enter" }); // key_colon_enter → the value opens as a NESTED block
    expect(container.querySelector(".k")!.textContent).toBe("pets");
    const nested = container.querySelector<HTMLElement>(".yed-indent .yed-hole")!;
    expect(nested).toBeTruthy(); // the fresh hole sits on the next row, INDENTED
    expect(document.activeElement).toBe(nested);
    type(nested, "- ");
    const itemHole = container.querySelector<HTMLElement>(".yed-indent .yed-hole")!;
    type(itemHole, "name: ");
    // BUG 1: `name: ` continues on the SAME row as the dash (the compact form) — no extra row
    const dashRow = container.querySelector(".yaml-dash")!.closest(".yed-row")!;
    expect(dashRow.querySelector(".k")!.textContent).toBe("name");
    expect(dashRow.querySelector(".yed-hole")).toBeTruthy();
    const nameHole = lastHole(container);
    type(nameHole, "Rex");
    fireEvent.keyDown(nameHole, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([
      { path: ":n[0]", op: "insert", key: "pets", yamlover: "- name: Rex" },
    ]), { timeout: 2000 });
  });

  it("BUGS 1+2: `{` at the ROOT opens brace-style object editing on the FIRST press", async () => {
    const { container } = await mount(":n");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, "{");
    const puncts = Array.from(container.querySelectorAll(".punct")).map((p) => p.textContent);
    expect(puncts).toContain("{");
    expect(puncts).toContain("}"); // the closer projected immediately
    const inner = container.querySelector<HTMLElement>(".yed-hole")!;
    expect(document.activeElement).toBe(inner);
    type(inner, "a: ");
    const valueHole = lastHole(container);
    type(valueHole, "1");
    fireEvent.keyDown(valueHole, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":n[0]", op: "insert", key: "a", yamlover: "1" }]), { timeout: 2000 });
  });

  it("BUG 3: `[` at the ROOT opens bracket-style sequence editing — no dash", async () => {
    const { container } = await mount(":n");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, "[");
    const puncts = Array.from(container.querySelectorAll(".punct")).map((p) => p.textContent);
    expect(puncts).toContain("[");
    expect(puncts).toContain("]");
    expect(container.querySelector(".yaml-dash")).toBeNull(); // brackets, not a hyphen
    const inner = container.querySelector<HTMLElement>(".yed-hole")!;
    type(inner, "x");
    fireEvent.keyDown(inner, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":n[0]", op: "insert", yamlover: "x" }]), { timeout: 2000 });
  });

  it("`|` + Enter at the ROOT opens the focused block cell; Shift-Tab finishes it", async () => {
    const { container } = await mount(":n");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, "|");
    expect(container.querySelector("textarea.yed-blocktext")).toBeNull(); // header still typing
    fireEvent.keyDown(hole, { key: "Enter" }); // Enter allocates the cell
    const area = container.querySelector<HTMLTextAreaElement>("textarea.yed-blocktext")!;
    expect(document.activeElement).toBe(area); // the caret lands INSIDE the block, no mouse needed
    fireEvent.input(area, { target: { value: "line one\nline two" } });
    fireEvent.keyDown(area, { key: "Tab", shiftKey: true }); // any structural key leaves the prose
    // the typed `|` IS the authored header — the commit keeps it (THE REPRESENTATION RULE)
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([
      { path: ":n", op: "emplace", yamlover: "|\n  line one\n  line two" },
    ]), { timeout: 2000 });
    const next = container.querySelector<HTMLElement>(".yed-hole:not(.yed-tail)")!;
    expect(document.activeElement).toBe(next); // finished — the follow-up hole holds the caret
  });

  it("BUG 4: `|` keeps its projected header and commits the block as the scalar line (Ctrl+Enter)", async () => {
    const { container } = await mount(":n");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, "- ");
    const v = lastHole(container);
    type(v, "solid");
    fireEvent.keyDown(v, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":n[0]", op: "insert", yamlover: "solid" }]), { timeout: 2000 });
    fireEvent.keyDown(lastHole(container), { key: "Tab", shiftKey: true }); // out to the document level
    const next = lastHole(container);
    type(next, "|");
    fireEvent.keyDown(next, { key: "Enter" }); // the header resolves on Enter
    // the `|` header is PROJECTED and kept; the text edits below in the block area
    expect(Array.from(container.querySelectorAll(".punct")).some((p) => p.textContent?.startsWith("|"))).toBe(true);
    const area = container.querySelector<HTMLTextAreaElement>("textarea.yed-blocktext")!;
    expect(area).toBeTruthy();
    fireEvent.input(area, { target: { value: "multi-line\nself value" } });
    fireEvent.keyDown(area, { key: "Enter", ctrlKey: true }); // finish the block
    // typed after entry [0] → the self line is SAVED there (`at: 1`), not hoisted to the top
    await waitFor(() => expect(editChunks).toHaveBeenLastCalledWith([
      { path: ":n", op: "emplace", yamlover: "|\n  multi-line\n  self value", at: 1 },
    ]), { timeout: 2000 });
  });

  it("`>-` types WHOLLY before Enter — the folded header is projected and kept on commit", async () => {
    const { container } = await mount(":n");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, ">");
    expect(container.querySelector("textarea.yed-blocktext")).toBeNull(); // still typing the header
    type(hole, ">-"); // the chomping indicator lands in the hole, not past a stolen cell
    expect(container.querySelector("textarea.yed-blocktext")).toBeNull();
    fireEvent.keyDown(hole, { key: "Enter" });
    const area = container.querySelector<HTMLTextAreaElement>("textarea.yed-blocktext")!;
    expect(document.activeElement).toBe(area);
    expect(Array.from(container.querySelectorAll(".punct")).map((p) => p.textContent)).toContain(">-");
    fireEvent.input(area, { target: { value: "fold me\nplease" } });
    fireEvent.keyDown(area, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([
      { path: ":n", op: "emplace", yamlover: ">-\n  fold me\n  please" },
    ]), { timeout: 2000 });
  });

  it("Backspace in the EMPTIED fresh block steps back to the typed header in the hole", async () => {
    const { container } = await mount(":n");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, "|-");
    fireEvent.keyDown(hole, { key: "Enter" });
    const area = container.querySelector<HTMLTextAreaElement>("textarea.yed-blocktext")!;
    fireEvent.input(area, { target: { value: "" } }); // (typed and deleted again)
    fireEvent.keyDown(area, { key: "Backspace" });
    expect(container.querySelector("textarea.yed-blocktext")).toBeNull(); // the cell dismantled
    const back = container.querySelector<HTMLElement>(".yed-hole")!;
    expect(back.textContent).toBe("|-"); // the pre-Enter state — keep deleting or retype
    expect(document.activeElement).toBe(back);
    expect(editChunks).not.toHaveBeenCalled(); // nothing was ever committed
  });

  it("an EMPTIED entry block dismantles to its header hole on the entry row", async () => {
    const { container } = await mount(":n");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, "- ");
    const v = lastHole(container);
    type(v, ">");
    fireEvent.keyDown(v, { key: "Enter" });
    const area = container.querySelector<HTMLTextAreaElement>("textarea.yed-blocktext")!;
    fireEvent.keyDown(area, { key: "Backspace" }); // born empty — one press steps back
    expect(container.querySelector("textarea.yed-blocktext")).toBeNull();
    const back = lastHole(container);
    expect(back.textContent).toBe(">");
    expect(document.activeElement).toBe(back);
  });

  it("a PERSISTED block entry emptied + Backspace removes the entry", async () => {
    fetchNode.mockResolvedValue({
      path: ":d", type: "array", concrete: "yamlover", title: null, description: null,
      value: ["one\ntwo", "tail"],
    });
    const { container } = await mount(":d");
    const area = container.querySelector<HTMLTextAreaElement>("textarea.yed-blocktext")!;
    fireEvent.input(area, { target: { value: "" } });
    fireEvent.keyDown(area, { key: "Backspace" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":d[0]", op: "remove" }]), { timeout: 2000 });
    expect(container.querySelector("textarea.yed-blocktext")).toBeNull();
  });

  it("a PERSISTED block SELF-VALUE emptied + Backspace clears the line, a hole takes its place", async () => {
    fetchNode.mockResolvedValue({
      path: ":d", type: "object", concrete: "yamlover", title: null, description: null,
      value: { $yamloverMixed: { kind: "omni", value: "self one\nself two\n", selfAt: 0, entries: [{ key: "key", value: "val" }] } },
      comments: { "": { raw: "|\nself one\nself two" } },
    });
    const { container } = await mount(":d");
    const area = container.querySelector<HTMLTextAreaElement>("textarea.yed-blocktext")!;
    fireEvent.input(area, { target: { value: "" } });
    fireEvent.keyDown(area, { key: "Backspace" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":d", op: "emplace", yamlover: '""' }]), { timeout: 2000 });
    expect(container.querySelector("textarea.yed-blocktext")).toBeNull();
    expect(document.activeElement?.className ?? "").toContain("yed-hole"); // ready to retype
  });

  it("THE LEVEL RULE: `- scalar` ↵ descends — `- element` lands nested, the row keeps its shape", async () => {
    const { container } = await mount(":n");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, "- ");
    const v = lastHole(container);
    type(v, "scalar");
    fireEvent.keyDown(v, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":n[0]", op: "insert", yamlover: "scalar" }]), { timeout: 2000 });
    // the dash row KEEPS its shape: `- scalar` on one row, the fresh hole indented below
    const dashRow = container.querySelector(".yaml-dash")!.closest(".yed-row")!;
    expect(dashRow.textContent).toContain("scalar");
    const inside = container.querySelector<HTMLElement>(".yed-indent .yed-hole")!;
    expect(document.activeElement).toBe(inside);
    type(inside, "- ");
    const inner = lastHole(container);
    type(inner, "element");
    fireEvent.keyDown(inner, { key: "Enter" });
    // the entry was a plain scalar server-side — the first child re-emplaces the WHOLE omni
    await waitFor(() => expect(editChunks).toHaveBeenLastCalledWith([
      { path: ":n[0]", op: "emplace", yamlover: "scalar\n- element" },
    ]), { timeout: 2000 });
  });

  it("THE LEVEL RULE: Shift-Tab climbs back out to continue at the outer level", async () => {
    const { container } = await mount(":n");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, "- ");
    const v = lastHole(container);
    type(v, "one");
    fireEvent.keyDown(v, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":n[0]", op: "insert", yamlover: "one" }]), { timeout: 2000 });
    const inside = lastHole(container); // descended into `- one`
    fireEvent.keyDown(inside, { key: "Tab", shiftKey: true }); // climb out
    const outer = lastHole(container);
    expect(document.activeElement).toBe(outer);
    type(outer, "- ");
    const v2 = lastHole(container);
    type(v2, "two");
    fireEvent.keyDown(v2, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenLastCalledWith([{ path: ":n[1]", op: "insert", yamlover: "two" }]), { timeout: 2000 });
  });

  it("BUG 5: after `- name: Rex` ↵, `species: ` continues INSIDE the mapping, focus intact", async () => {
    const { container } = await mount(":n");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, "pets:");
    fireEvent.keyDown(hole, { key: "Enter" });
    const nested = container.querySelector<HTMLElement>(".yed-indent .yed-hole")!;
    type(nested, "- ");
    const itemHole = container.querySelector<HTMLElement>(".yed-indent .yed-hole")!;
    type(itemHole, "name: ");
    const nameHole = lastHole(container);
    type(nameHole, "Rex");
    fireEvent.keyDown(nameHole, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([
      { path: ":n[0]", op: "insert", key: "pets", yamlover: "- name: Rex" },
    ]), { timeout: 2000 });
    // NO parasitic wrap after the descend: `- name: Rex` still reads on ONE row
    const dashRow = container.querySelector(".yaml-dash")!.closest(".yed-row")!;
    expect(dashRow.querySelector(".k")?.textContent).toBe("name");
    expect(dashRow.textContent).toContain("Rex");
    // the level rule descended into Rex — Shift-Tab climbs to `name`'s level for its sibling
    fireEvent.keyDown(lastHole(container), { key: "Tab", shiftKey: true });
    expect(container.textContent).toContain("Rex"); // nothing disappears on the climb-out
    const speciesHole = lastHole(container);
    expect(document.activeElement).toBe(speciesHole);
    type(speciesHole, "species: ");
    const dogHole = lastHole(container);
    type(dogHole, "dog");
    fireEvent.keyDown(dogHole, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenLastCalledWith([
      { path: ":n:pets[0][1]", op: "insert", key: "species", yamlover: "dog" },
    ]), { timeout: 2000 });
  });

  it("BUG 5: `- ` `- ` collapses into ONE row — compact nested list editing (`- - `)", async () => {
    const { container } = await mount(":n");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, "- ");
    const inner = lastHole(container);
    type(inner, "- ");
    const dashes = container.querySelectorAll(".yaml-dash");
    expect(dashes).toHaveLength(2);
    expect(dashes[0].closest(".yed-row")).toBe(dashes[1].closest(".yed-row")); // both on ONE row
    expect(dashes[1].closest(".yed-row")!.querySelector(".yed-hole")).toBeTruthy();
  });

  it("BUG 2: Backspace from the closed quote steps back INSIDE without committing, down to dismantle", async () => {
    const { container } = await mount(":n");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, '"');
    const inner = container.querySelector<HTMLElement>('.s[contenteditable]')!;
    type(inner, "quoted");
    fireEvent.keyDown(inner, { key: '"' }); // → quoted_token_closed
    const after = container.querySelector<HTMLElement>(".yed-after")!;
    fireEvent.keyDown(after, { key: "Backspace" }); // back INSIDE the quotes — must NOT commit
    expect(editChunks).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(inner);
    // delete everything, then one more Backspace dismantles the quotes — same as the unclosed path
    type(inner, "");
    fireEvent.keyDown(inner, { key: "Backspace" });
    await waitFor(() => expect(container.querySelectorAll(".s")).toHaveLength(0));
    expect(container.querySelector(".yed-hole")).toBeTruthy();
    expect(editChunks).not.toHaveBeenCalled();
  });

  it("BUG 3: Backspace in the quoted key's empty value hole undoes ONLY the colon", async () => {
    const { container } = await mount(":n");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, '"');
    const inner = container.querySelector<HTMLElement>('.s[contenteditable]')!;
    type(inner, "value");
    fireEvent.keyDown(inner, { key: '"' });
    fireEvent.keyDown(container.querySelector<HTMLElement>(".yed-after")!, { key: ":" });
    expect(container.querySelector(".k")!.textContent).toBe('"value"');
    const valueHole = container.querySelector<HTMLElement>(".yed-hole:not(.yed-tail)")!;
    fireEvent.keyDown(valueHole, { key: "Backspace" });
    // the colon is undone: the quoted token returns (closed, caret after the quote), the key is gone
    await waitFor(() => expect(container.querySelector(".k")).toBeNull());
    expect(container.textContent).toContain("value"); // the text survived
    expect(container.querySelector(".yed-after")).toBeTruthy(); // back in quoted_token_closed
    expect(editChunks).not.toHaveBeenCalled();
  });

  it("Backspace in a plain key's empty value hole returns the key's TEXT to the hole", async () => {
    const { container } = await mount(":n");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, "name: ");
    expect(container.querySelector(".k")!.textContent).toBe("name");
    const valueHole = lastHole(container);
    fireEvent.keyDown(valueHole, { key: "Backspace" });
    await waitFor(() => expect(container.querySelector(".k")).toBeNull());
    const restored = container.querySelector<HTMLElement>(".yed-hole:not(.yed-tail)")!;
    expect(restored.textContent).toBe("name"); // ready to re-edit — only the colon vanished
  });

  it("BUG 4: a duplicate key is rejected with the error ring — keys are unique per node", async () => {
    const { container } = await mount(":n");
    // first `val: 12` lands
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, "val: ");
    const v1 = lastHole(container);
    type(v1, "12");
    fireEvent.keyDown(v1, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":n[0]", op: "insert", key: "val", yamlover: "12" }]), { timeout: 2000 });
    fireEvent.keyDown(lastHole(container), { key: "Tab", shiftKey: true }); // back to the key's level
    // the second `val: ` is refused — the text stays in the hole, red-ringed; no second key row
    const hole2 = lastHole(container);
    type(hole2, "val: ");
    expect(hole2.className).toContain("edit-error");
    expect(container.querySelectorAll(".k")).toHaveLength(1);
  });

  it("`pets: ` (space) keeps the value INLINE; Enter in the empty value hole then nests it", async () => {
    const { container } = await mount(":n");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, "pets: ");
    expect(container.querySelector(".yed-indent")).toBeNull(); // the value cell shares the row
    const valueHole = container.querySelector<HTMLElement>(".yed-hole:not(.yed-tail)")!;
    fireEvent.keyDown(valueHole, { key: "Enter" }); // value_hole + Enter → nested block
    const nested = container.querySelector<HTMLElement>(".yed-indent .yed-hole")!;
    expect(nested).toBeTruthy();
    expect(document.activeElement).toBe(nested);
  });

  it("YAMLOVER_EDITOR.yamlover: `- mon` / `12` / `12: tue` keep the order they were ENTERED in", async () => {
    const { container } = await mount(":n");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, "- ");
    const monHole = lastHole(container);
    type(monHole, "mon");
    fireEvent.keyDown(monHole, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":n[0]", op: "insert", yamlover: "mon" }]), { timeout: 2000 });
    fireEvent.keyDown(lastHole(container), { key: "Tab", shiftKey: true }); // climb out of `- mon`
    const selfHole = lastHole(container);
    type(selfHole, "12");
    fireEvent.keyDown(selfHole, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenLastCalledWith([{ path: ":n", op: "emplace", yamlover: "12", at: 1 }]), { timeout: 2000 });
    const keyedHole = lastHole(container);
    type(keyedHole, "12: ");
    const valueHole = lastHole(container);
    type(valueHole, "tue");
    fireEvent.keyDown(valueHole, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenLastCalledWith([{ path: ":n[1]", op: "insert", key: "12", yamlover: "tue" }]), { timeout: 2000 });
    // on screen: `- mon`, the bare `12`, then `12: tue` — exactly the entered order
    const rows = Array.from(container.querySelectorAll(".yed-row")).map((r) => r.textContent ?? "");
    expect(rows[0]).toContain("mon");
    expect(rows[1]).toContain("12");
    expect(rows[2]).toContain("tue");
  });

  it("YAMLOVER_EDITOR.yamlover: `12` + Enter commits AND allocates the next row (entry_hole, focused)", async () => {
    const { container } = await mount(":n");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, "12");
    fireEvent.keyDown(hole, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":n", op: "emplace", yamlover: "12" }]), { timeout: 2000 });
    // one Enter: the token became the self-value row and a fresh entry_hole holds the caret
    expect(container.textContent).toContain("12");
    const freshHole = container.querySelector<HTMLElement>(".yed-hole:not(.yed-tail)")!;
    expect(freshHole).toBeTruthy();
    expect(document.activeElement).toBe(freshHole);
  });

  it("`- ` fixes the dash IN PLACE — the entry row is the FIRST row, no leftover above it", async () => {
    const { container } = await mount(":n");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, "- ");
    const rows = container.querySelectorAll(".yed-row");
    expect(rows[0].querySelector(".yaml-dash")).toBeTruthy(); // the dash row replaced the hole row
    expect(rows[0].querySelector(".yed-hole")).toBeTruthy(); // with its value cell on the SAME row
  });

  it("`k: ` fixes the key IN PLACE — the keyed row is the FIRST row with its value cell beside it", async () => {
    const { container } = await mount(":n");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, "january: ");
    const rows = container.querySelectorAll(".yed-row");
    expect(rows[0].querySelector(".k")?.textContent).toBe("january");
    expect(rows[0].querySelector(".yed-hole")).toBeTruthy(); // the value cell shares the row
  });

  it("YAMLOVER_EDITOR.yamlover: the CLOSING quote jumps the caret AFTER it (quoted_token_closed)", async () => {
    const { container } = await mount(":n");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, '"');
    const inner = container.querySelector<HTMLElement>('.s[contenteditable]')!;
    type(inner, "hi");
    fireEvent.keyDown(inner, { key: '"' });
    // nothing committed yet — the caret sits in the after-quote cell, awaiting `:` or Enter
    const after = container.querySelector<HTMLElement>(".yed-after")!;
    expect(after).toBeTruthy();
    expect(document.activeElement).toBe(after);
    expect(editChunks).not.toHaveBeenCalled();
    // Enter commits it as the scalar it reads as — quotes KEPT
    fireEvent.keyDown(after, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":n", op: "emplace", yamlover: '"hi"' }]), { timeout: 2000 });
  });

  it("YAMLOVER_EDITOR.yamlover: `\"value\":` makes a QUOTED KEY — `\"value\": 12` lands as typed", async () => {
    const { container } = await mount(":n");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, '"');
    const inner = container.querySelector<HTMLElement>('.s[contenteditable]')!;
    type(inner, "value");
    fireEvent.keyDown(inner, { key: '"' }); // close the quote
    const after = container.querySelector<HTMLElement>(".yed-after")!;
    fireEvent.keyDown(after, { key: ":" }); // → the quoted string becomes the KEY
    expect(container.querySelector(".k")!.textContent).toBe('"value"'); // shown quoted, as authored
    const valueHole = container.querySelector<HTMLElement>(".yed-hole:not(.yed-tail)")!;
    expect(document.activeElement).toBe(valueHole);
    type(valueHole, "12");
    fireEvent.keyDown(valueHole, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":n[0]", op: "insert", key: '"value"', yamlover: "12" }]), { timeout: 2000 });
  });

  it("YAMLOVER_EDITOR.yamlover: `\"value` + Enter keeps the QUOTED concrete (the self line shows its quotes)", async () => {
    const { container } = await mount(":n");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, '"');
    const inner = container.querySelector<HTMLElement>('.s[contenteditable]')!;
    type(inner, "value");
    fireEvent.keyDown(inner, { key: "Enter" }); // no closing quote typed — commit as-is
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":n", op: "emplace", yamlover: '"value"' }]), { timeout: 2000 });
    // the committed self line still PROJECTS its quotes — never silently unquoted
    const quotes = Array.from(container.querySelectorAll(".s")).filter((s) => s.textContent === '"');
    expect(quotes.length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).toContain("value");
  });

  it("YAMLOVER_EDITOR.yamlover: Backspace in a fresh quote/pointer cell dismantles it (empty_cell_of_origin)", async () => {
    const { container } = await mount(":n");
    let hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, '"');
    const inner = container.querySelector<HTMLElement>('.s[contenteditable]')!;
    fireEvent.keyDown(inner, { key: "Backspace" });
    await waitFor(() => expect(container.querySelectorAll(".s")).toHaveLength(0)); // the quotes are gone
    expect(editChunks).not.toHaveBeenCalled(); // nothing was ever persisted
    // the root hole is back; now the same for a pointer
    hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, "*");
    const raw = await waitFor(() => {
      const el = container.querySelector<HTMLElement>(".yed-ptrwrap .crumb-cell");
      expect(el).toBeTruthy();
      return el!;
    });
    setCaret(raw, 0); // Backspace at the empty cell's start, at the ladder's floor → dismantle
    fireEvent.keyDown(raw, { key: "Backspace" });
    await waitFor(() => expect(container.textContent).not.toContain("*"));
    expect(container.querySelector(".yed-hole")).toBeTruthy();
  });

  it("YAMLOVER_EDITOR.yamlover: `- january` Enter `31` — the 31 is the node's own scalar line, as-is", async () => {
    const { container } = await mount(":n");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, "- ");
    const valueHole = lastHole(container);
    type(valueHole, "january");
    fireEvent.keyDown(valueHole, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":n[0]", op: "insert", yamlover: "january" }]), { timeout: 2000 });
    // the level rule descended into `- january` — Shift-Tab climbs out to the DOCUMENT level,
    // where a BARE 31 is the document's own scalar line (not another array element)
    fireEvent.keyDown(lastHole(container), { key: "Tab", shiftKey: true });
    const next = lastHole(container);
    type(next, "31");
    fireEvent.keyDown(next, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenLastCalledWith([{ path: ":n", op: "emplace", yamlover: "31", at: 1 }]), { timeout: 2000 });
    const rows = container.querySelectorAll(".yed-row");
    expect(rows[0].querySelector(".yaml-dash")).toBeTruthy(); // `- january`
    expect(rows[0].textContent).toContain("january");
    expect(rows[1].textContent).toContain("31"); // the bare self line, at the position it was typed
    expect(rows[1].querySelector(".yaml-dash")).toBeNull(); // no marker — entered as-is
  });

  it("`*` makes the ROOT a pointer cell; Enter commits (blur CANCELS — breadcrumb semantics)", async () => {
    const { container } = await mount(":n");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, "*pets");
    const cell = Array.from(container.querySelectorAll<HTMLElement>(".yed-ptrwrap .crumb-cell")).find((el) => el.textContent === "pets");
    expect(cell).toBeTruthy();
    fireEvent.keyDown(cell!, { key: "Enter" }); // the dangling filter (rejected mock) hands the query back verbatim
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":n", op: "emplace", yamlover: "*pets" }]), { timeout: 2000 });
  });
});

describe("pointer cell — the SHARED query cells (pick mode): scope ladder, dropdown, reduction", () => {
  const PETS = {
    path: ":doc", type: "object", concrete: "yamlover", title: null, description: null,
    value: { pets: [{ name: "Rex" }, { name: "Whiskers" }] },
  };
  const TREE = (path: string, label: string) => ({ path, label, type: "object", format: null, concrete: null, hasChildren: false, children: [] });
  const FILTER = (matches: string[]) => ({ root: TREE(":", "r"), matches, truncated: false });
  beforeEach(() => fetchNode.mockResolvedValue(PETS));

  const pointerCell = (container: HTMLElement): HTMLElement =>
    container.querySelector<HTMLElement>(".yed-ptrwrap .crumb-cell")!;

  it("a bare `*`: candidates are the HOLDER's children (`?` at the holder); the dropdown shows TOC rows", async () => {
    queryTree.mockResolvedValue([TREE(":doc:pets", "pets")]);
    const { container } = await mount(":doc");
    type(openHole(container), "*");
    await waitFor(() => expect(pointerCell(container)).toBeTruthy());
    await waitFor(() => expect(queryTree).toHaveBeenCalledWith("?", ":doc")); // bare scope, at = the holder
    // the dropdown is PORTALED to the body (never clipped by a scrolling ancestor)
    await waitFor(() => expect(document.querySelector(".crumb-dd .tree-label")?.textContent).toBe("pets"));
  });

  it("`:` in the empty first cell CLIMBS the scope ladder (the chip shows it); Backspace steps down", async () => {
    const { container } = await mount(":doc");
    type(openHole(container), "*");
    await waitFor(() => expect(pointerCell(container)).toBeTruthy());
    const cell = pointerCell(container);
    fireEvent.keyDown(cell, { key: ":" });
    expect(container.querySelector(".yed-scope")?.textContent).toBe(":");
    fireEvent.keyDown(cell, { key: ":" });
    expect(container.querySelector(".yed-scope")?.textContent).toBe("::");
    await waitFor(() => expect(queryTree).toHaveBeenCalledWith(":: ?", ":doc"));
    setCaret(cell, 0);
    fireEvent.keyDown(cell, { key: "Backspace" });
    expect(container.querySelector(".yed-scope")?.textContent).toBe(":");
  });

  it("Enter REDUCES the typed query to the first match, spelled in the chosen scope: bare op + advance", async () => {
    queryFilter.mockResolvedValue(FILTER([":doc:pets[1]"]));
    const { container } = await mount(":doc");
    type(openHole(container), "*");
    await waitFor(() => expect(pointerCell(container)).toBeTruthy());
    const cell = pointerCell(container);
    type(cell, "pets[1]"); // bare scope — relative to the holder :doc
    fireEvent.keyDown(cell, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([
      { path: ":doc[1]", op: "insert", yamlover: "*pets[1]" },
    ]), { timeout: 2000 });
    expect(container.querySelectorAll(".yed-hole:not(.yed-tail)").length).toBeGreaterThan(0); // advanced
  });

  it("free text with NO match still commits verbatim (dangling allowed — hints are never validators)", async () => {
    queryFilter.mockResolvedValue(FILTER([]));
    const { container } = await mount(":doc");
    type(openHole(container), "*");
    await waitFor(() => expect(pointerCell(container)).toBeTruthy());
    const cell = pointerCell(container);
    fireEvent.keyDown(cell, { key: ":" }); // → document scope `*:`
    type(cell, "nowhere[7]");
    fireEvent.keyDown(cell, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([
      { path: ":doc[1]", op: "insert", yamlover: "*:nowhere[7]" },
    ]), { timeout: 2000 });
  });

  it("UNPARSABLE free text keeps the typed text on screen with the error ring (no silent revert)", async () => {
    queryFilter.mockRejectedValue(new Error("400"));
    const { container } = await mount(":doc");
    type(openHole(container), "*");
    await waitFor(() => expect(pointerCell(container)).toBeTruthy());
    const cell = pointerCell(container);
    type(cell, "a[x]"); // malformed index — not a pointer the wire can carry
    fireEvent.keyDown(cell, { key: "Enter" });
    await waitFor(() => expect(container.querySelector(".yed-ptr-error")).toBeTruthy(), { timeout: 2000 });
    expect(container.querySelector(".yed-ptrwrap")!.textContent).toContain("a[x]"); // the text stands
    expect(editChunks).not.toHaveBeenCalled();
  });

  it("a TOC pick (the session's onPick) lands the picked path IN THE CELLS, spelled in the current scope", async () => {
    queryFilter.mockResolvedValue(FILTER([":doc:pets[0]:name"]));
    let session!: import("../../src/client/toc-filter-session").TocFilterSession;
    function Host() {
      session = useTocFilterSession();
      return (
        <TocFilterCtx.Provider value={session}>
          <YamloverEditor path=":doc" onNavigate={() => {}} />
        </TocFilterCtx.Provider>
      );
    }
    const { container } = render(<Host />);
    await waitFor(() => expect(container.querySelector(".yed-row")).toBeTruthy());
    type(openHole(container), "*");
    await waitFor(() => expect(pointerCell(container)).toBeTruthy());
    await waitFor(() => expect(session.active).toBe(true)); // editing a reference claims the TOC filter
    act(() => session.pick(":doc:pets[0]:name")); // a TOC row click routes here
    const cells = () => Array.from(container.querySelectorAll<HTMLElement>(".yed-ptrwrap .crumb-cell")).map((c) => c.textContent);
    await waitFor(() => expect(cells()).toEqual(["pets[0]", "name"])); // spelled relative (bare scope)
    // the pick INSERTED, not committed — Enter commits the reduced pointer
    fireEvent.keyDown(pointerCell(container), { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([
      { path: ":doc[1]", op: "insert", yamlover: "*pets[0]:name" },
    ]), { timeout: 2000 });
    await waitFor(() => expect(session.active).toBe(false)); // the commit released the TOC filter
  });

  it("ROOT pointer: commits and STAYS (no entry — no advance)", async () => {
    queryFilter.mockResolvedValue(FILTER([]));
    fetchNode.mockResolvedValue({
      path: ":n", type: "null", format: null, valueType: "null", concrete: "file/yamlover",
      documentPath: ":n", title: null, description: null, value: null, comments: {},
    });
    const { container } = await mount(":n");
    type(container.querySelector<HTMLElement>(".yed-hole")!, "*");
    await waitFor(() => expect(pointerCell(container)).toBeTruthy());
    const cell = pointerCell(container);
    fireEvent.keyDown(cell, { key: ":" }); // document scope
    type(cell, "pets[1]");
    fireEvent.keyDown(cell, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([
      { path: ":n", op: "emplace", yamlover: "*:pets[1]" },
    ]), { timeout: 2000 });
    expect(container.querySelector(".yed-hole")).toBeNull(); // stays on the pointer row
  });

  it("re-editing a committed SPACED-canonical pointer: unchanged Enter advances without an op", async () => {
    fetchNode.mockResolvedValue({
      path: ":d", type: "array", concrete: "yamlover", title: null, description: null,
      value: [{ $yamloverRef: { text: ": pets[1]", path: null } }],
      comments: { "[0]": { pointer: ": pets[1]" } },
    });
    const { container } = await mount(":d");
    const cell = pointerCell(container);
    expect(cell.textContent).toBe("pets[1]"); // the cells spell the body; the chip carries the `:`
    expect(container.querySelector(".yed-scope")?.textContent).toBe(":");
    fireEvent.focus(cell);
    fireEvent.keyDown(cell, { key: "Enter" }); // the dangling filter (rejected mock) hands the query back
    await waitFor(() => expect(container.querySelectorAll(".yed-hole:not(.yed-tail)").length).toBe(1), { timeout: 2000 });
    expect(editChunks).not.toHaveBeenCalled(); // nothing re-emitted
  });
});

describe("paste — valid yamlover source materializes structure", () => {
  const clip = (text: string) => ({
    clipboardData: { getData: (t: string) => (t === "text/plain" ? text : "<b>markup</b>"), files: [], items: [] },
  });
  const EMPTY = {
    path: ":n", type: "null", format: null, valueType: "null", concrete: "file/yamlover",
    documentPath: ":n", title: null, description: null, value: null, comments: {},
  };

  it("multi-line paste into an entry hole splices SIBLINGS: ordered inserts, rows render, hole follows", async () => {
    const { container } = await mount(":doc"); // the OMNI doc — 3 committed entries
    const dashes = container.querySelectorAll(".yaml-dash").length;
    const hole = openHole(container);
    fireEvent.paste(hole, clip("- name: Rex\n  species: dog\n- name: Tom"));
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([
      { path: ":doc[3]", op: "insert", yamlover: "name: Rex\nspecies: dog" },
      { path: ":doc[4]", op: "insert", yamlover: "name: Tom" },
    ]), { timeout: 2000 });
    expect(container.querySelectorAll(".yaml-dash").length).toBe(dashes + 2);
    expect(document.activeElement?.className ?? "").toContain("yed-hole"); // continue typing below
  });

  it("multi-line paste into a VALUE hole becomes the entry's value (one keyed insert)", async () => {
    fetchNode.mockResolvedValue(EMPTY);
    const { container } = await mount(":n");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, "pets: ");
    const valueHole = container.querySelector<HTMLElement>(".yed-hole:not(.yed-tail)")!;
    fireEvent.paste(valueHole, clip("- Rex\n- Tom"));
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([
      { path: ":n[0]", op: "insert", key: "pets", yamlover: "- Rex\n- Tom" },
    ]), { timeout: 2000 });
  });

  it("a parse error refuses with the error ring — nothing mutates", async () => {
    const { container } = await mount(":doc");
    const hole = openHole(container);
    fireEvent.paste(hole, clip("a: [unclosed\nb: 2"));
    expect(hole.className).toContain("edit-error");
    expect(editChunks).not.toHaveBeenCalled();
  });

  it("anchors/!!set paste mid-document SUCCEEDS with the extras dropped from the ops", async () => {
    const { container } = await mount(":doc");
    const hole = openHole(container);
    fireEvent.paste(hole, clip("boss: &: chief\n  name: Rex"));
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([
      { path: ":doc[3]", op: "insert", key: "boss", yamlover: "name: Rex" }, // no `&` anywhere
    ]), { timeout: 2000 });
  });

  it("single-line paste behaves exactly like typing (the live grammar classifies)", async () => {
    const { container } = await mount(":doc");
    const dashes = container.querySelectorAll(".yaml-dash").length;
    const hole = openHole(container);
    fireEvent.paste(hole, clip("- "));
    expect(container.querySelectorAll(".yaml-dash").length).toBe(dashes + 1); // ordinal materialized
    expect(editChunks).not.toHaveBeenCalled(); // nothing committed yet — same as typing
  });

  it("whole-document paste into the EMPTY editor: per-entry inserts (the root takes no payload emplace)", async () => {
    fetchNode.mockResolvedValue(EMPTY);
    const { container } = await mount(":n");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    const text = "pets:\n  - name: Rex\n    species: dog\n  - name: Whiskers\n    species: cat\nafter: 1";
    fireEvent.paste(hole, clip(text));
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([
      { path: ":n[0]", op: "insert", key: "pets", yamlover: "- name: Rex\n  species: dog\n- name: Whiskers\n  species: cat" },
      { path: ":n[1]", op: "insert", key: "after", yamlover: "1" },
    ]), { timeout: 2000 });
    expect(Array.from(container.querySelectorAll(".k")).map((k) => k.textContent))
      .toEqual(["pets", "name", "species", "name", "species", "after"]);
  });

  it("the LEGACY `\"\"` scalar fresh file takes a whole-document paste too (clear + inserts)", async () => {
    fetchNode.mockResolvedValue({
      path: ":n", type: "string", format: null, valueType: "string", concrete: "file/yamlover",
      documentPath: ":n", title: null, description: null, value: "", comments: { "": { raw: '""' } },
    });
    const { container } = await mount(":n");
    const cell = container.querySelector<HTMLElement>("[data-yed-cell]")!; // the root scalar cell
    fireEvent.paste(cell, clip("pets:\n- name: Rex"));
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([
      { path: ":n", op: "emplace", yamlover: '""' },
      { path: ":n[0]", op: "insert", key: "pets", yamlover: "- name: Rex" },
    ]), { timeout: 2000 });
    expect(Array.from(container.querySelectorAll(".k")).map((k) => k.textContent)).toEqual(["pets", "name"]);
  });

  it("multi-line structure into a FLOW hole refuses; a non-empty hole guards its typed text", async () => {
    fetchNode.mockResolvedValue(EMPTY);
    const { container } = await mount(":n");
    type(container.querySelector<HTMLElement>(".yed-hole")!, "{");
    const inner = container.querySelector<HTMLElement>(".yed-hole")!;
    fireEvent.paste(inner, clip("a: 1\nb: 2"));
    expect(inner.className).toContain("edit-error");
    expect(editChunks).not.toHaveBeenCalled();
  });

  it("a non-empty hole refuses a multi-line paste — the typed text survives", async () => {
    const { container } = await mount(":doc");
    const hole = openHole(container);
    type(hole, "abc");
    fireEvent.paste(hole, clip("x: 1\ny: 2"));
    expect(hole.className).toContain("edit-error");
    expect(hole.textContent).toBe("abc");
    expect(editChunks).not.toHaveBeenCalled();
  });

  it("EditableCell paste is sanitized plain text (the HTML flavour never lands)", async () => {
    const { container } = await mount(":doc"); // the OMNI doc
    const cell = Array.from(container.querySelectorAll<HTMLElement>("[data-yed-cell]"))
      .find((el) => el.textContent === "chunk one")!;
    fireEvent.paste(cell, clip(" extended"));
    // jsdom's caret sits at position 0 (no layout) — assert content, not order
    expect(cell.textContent).toContain(" extended");
    expect(cell.textContent).toContain("chunk one");
    expect(cell.innerHTML).not.toContain("<b>"); // the text/html flavour never lands
  });
});

describe("NodeView — the create flow opens the fresh node IN the editor", () => {
  const FRESH = {
    path: ":New%20node.yamlover", type: "string", format: null, valueType: "string",
    concrete: "file/yamlover", documentPath: ":New%20node.yamlover",
    title: null, description: null, value: "", comments: { "": { raw: '""' } },
  };

  it("navigating + unlockSignal in ONE render still loads the node and mounts the editor", async () => {
    // the regression: the unlock re-run's cleanup cancels the navigation's in-flight fetch, and
    // the pause guard then skipped the refetch — the pane sat on "…" forever (no toolbar).
    fetchNode.mockImplementation((p: string) => Promise.resolve(p === ":doc" ? OMNI : FRESH));
    const noop = () => {};
    const { container, rerender } = render(
      <NodeView path=":doc" format={"yamlover" as never} unlockSignal={0} onFormat={noop} onNavigate={noop} />,
    );
    await waitFor(() => expect(container.querySelector(".nodehead")).toBeTruthy());
    // the app's create handler: navigate(newPath) + setUnlockSignal(s => s + 1) — one batch
    rerender(
      <NodeView path=":New%20node.yamlover" format={"yamlover" as never} unlockSignal={1} onFormat={noop} onNavigate={noop} />,
    );
    await waitFor(() => {
      expect(container.querySelector(".nodehead")).toBeTruthy(); // the toolbar is back
      expect(container.querySelector(".code.yed")).toBeTruthy(); // and the page is the EDITOR
    }, { timeout: 2000 });
    // the fresh empty scalar renders as an (empty) editable cell
    expect(container.querySelector(".yed [data-yed-cell]")).toBeTruthy();
  });

  it("a BARE directory (concrete `dir`) unlocks into the editor too (concrete derivation)", async () => {
    // the REAL empty-dir projection: value {} / type object / concrete dir / valueType null
    fetchNode.mockResolvedValue({
      path: ":d", type: "object", format: null, valueType: null, concrete: "dir",
      documentPath: ":d", title: null, description: null, value: {}, comments: {},
    });
    const noop = () => {};
    const { container } = render(
      <NodeView path=":d" format={"yamlover" as never} unlockSignal={1} onFormat={noop} onNavigate={noop} />,
    );
    await waitFor(() => expect(container.querySelector(".code.yed")).toBeTruthy(), { timeout: 2000 });
    expect(container.querySelector(".yed-hole")).toBeTruthy(); // the empty dir opens on the root hole
  });
});

describe("sync", () => {
  it("scalar edits coalesce (keep-last) into one emplace", async () => {
    fetchNode.mockResolvedValue(ARR);
    const { container } = await mount(":d");
    const alpha = Array.from(container.querySelectorAll<HTMLElement>("[data-yed-cell]")).find((c) => c.textContent === "alpha")!;
    type(alpha, "alp");
    fireEvent.blur(alpha);
    const alpha2 = Array.from(container.querySelectorAll<HTMLElement>("[data-yed-cell]")).find((c) => c.textContent === "alp")!;
    type(alpha2, "alphax");
    fireEvent.blur(alpha2);
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":d[0]", op: "emplace", yamlover: "alphax" }]), { timeout: 2000 });
    expect(editChunks).toHaveBeenCalledTimes(1); // one coalesced batch, one flush
  });

  it("pending ops flush on unmount (lock / navigation)", async () => {
    fetchNode.mockResolvedValue(ARR);
    const { container, unmount } = await mount(":d");
    const alpha = Array.from(container.querySelectorAll<HTMLElement>("[data-yed-cell]")).find((c) => c.textContent === "alpha")!;
    type(alpha, "changed");
    fireEvent.blur(alpha);
    unmount(); // before the 500ms debounce elapses
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":d[0]", op: "emplace", yamlover: "changed" }]));
  });

  it("a failed flush keeps the queue and retries on the next flush", async () => {
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    editChunks.mockRejectedValueOnce(new Error("boom"));
    fetchNode.mockResolvedValue(ARR);
    const { container, unmount } = await mount(":d");
    const alpha = Array.from(container.querySelectorAll<HTMLElement>("[data-yed-cell]")).find((c) => c.textContent === "alpha")!;
    type(alpha, "kept");
    fireEvent.blur(alpha);
    await waitFor(() => expect(editChunks).toHaveBeenCalledTimes(1)); // the debounced flush fails
    expect(alert).toHaveBeenCalled();
    unmount(); // the unmount flush retries the SAME batch
    await waitFor(() => expect(editChunks).toHaveBeenCalledTimes(2));
    expect(editChunks).toHaveBeenLastCalledWith([{ path: ":d[0]", op: "emplace", yamlover: "kept" }]);
    alert.mockRestore();
  });
});

describe("THE REPRESENTATION RULE — block scalars reproduce the authored concrete", () => {
  it("a clip `|` document shows its header and lines with NO parasitic trailing blank", async () => {
    fetchNode.mockResolvedValue({
      path: ":d", type: "string", concrete: "yamlover", title: null, description: null,
      value: "A blockl-\nfdfd\ndfdf\ndf\n", comments: { "": { raw: "|\nA blockl-\nfdfd\ndfdf\ndf" } },
    });
    const { container } = await mount(":d");
    expect(container.querySelector(".punct")!.textContent).toBe("|");
    const area = container.querySelector<HTMLTextAreaElement>("textarea.yed-blocktext")!;
    expect(area.value).toBe("A blockl-\nfdfd\ndfdf\ndf"); // the chomped \n is NOT an extra line
  });

  it("a `|-` document keeps its authored header — edits re-emit `|-`", async () => {
    fetchNode.mockResolvedValue({
      path: ":d", type: "string", concrete: "yamlover", title: null, description: null,
      value: "one\ntwo", comments: { "": { raw: "|-\none\ntwo" } },
    });
    const { container } = await mount(":d");
    expect(container.querySelector(".punct")!.textContent).toBe("|-");
    const area = container.querySelector<HTMLTextAreaElement>("textarea.yed-blocktext")!;
    fireEvent.input(area, { target: { value: "one\ntwo\nthree" } });
    fireEvent.keyDown(area, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([
      { path: ":d", op: "emplace", yamlover: "|-\n  one\n  two\n  three" },
    ]), { timeout: 2000 });
  });

  it("a self line typed BETWEEN entries is saved at its position — order kept", async () => {
    fetchNode.mockResolvedValue({
      path: ":n", type: "null", format: null, valueType: "null", concrete: "file/yamlover",
      documentPath: ":n", title: null, description: null, value: null, comments: {},
    });
    const { container } = await mount(":n");
    const lastHole = () => {
      const hs = container.querySelectorAll<HTMLElement>(".yed-hole:not(.yed-tail)");
      return hs[hs.length - 1];
    };
    // `- solid` ↵ — entry [0]; the level rule descends, Shift-Tab climbs back out
    type(container.querySelector<HTMLElement>(".yed-hole")!, "- ");
    const v = lastHole();
    type(v, "solid");
    fireEvent.keyDown(v, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":n[0]", op: "insert", yamlover: "solid" }]), { timeout: 2000 });
    fireEvent.keyDown(lastHole(), { key: "Tab", shiftKey: true });
    // `|` ↵ + block text — the self line, typed AFTER entry [0]: the emplace carries `at: 1`
    const bh = lastHole();
    type(bh, "|");
    fireEvent.keyDown(bh, { key: "Enter" });
    const area = container.querySelector<HTMLTextAreaElement>("textarea.yed-blocktext")!;
    fireEvent.input(area, { target: { value: "A block-scalar self-value\nmulti-line text" } });
    fireEvent.keyDown(area, { key: "Tab" });
    await waitFor(() => expect(editChunks).toHaveBeenLastCalledWith([
      { path: ":n", op: "emplace", yamlover: "|\n  A block-scalar self-value\n  multi-line text", at: 1 },
    ]), { timeout: 2000 });
    // `- recommended` ↵ — the self line consumes no index: the next entry is [1]
    type(lastHole(), "- ");
    const v2 = lastHole();
    type(v2, "recommended");
    fireEvent.keyDown(v2, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenLastCalledWith([
      { path: ":n[1]", op: "insert", yamlover: "recommended" },
    ]), { timeout: 2000 });
  });

  it("a block SELF-VALUE renders header + lines and keeps its header on edit", async () => {
    fetchNode.mockResolvedValue({
      path: ":d", type: "object", concrete: "yamlover", title: null, description: null,
      value: { $yamloverMixed: { kind: "omni", value: "self one\nself two\n", selfAt: 0, entries: [{ key: "key", value: "val" }] } },
      comments: { "": { raw: "|\nself one\nself two" } },
    });
    const { container } = await mount(":d");
    expect(Array.from(container.querySelectorAll(".punct")).map((p) => p.textContent)).toContain("|");
    const area = container.querySelector<HTMLTextAreaElement>("textarea.yed-blocktext")!;
    expect(area.value).toBe("self one\nself two");
    fireEvent.input(area, { target: { value: "self one\nself two\nself three" } });
    fireEvent.keyDown(area, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([
      { path: ":d", op: "emplace", yamlover: "|\n  self one\n  self two\n  self three" },
    ]), { timeout: 2000 });
  });
});

describe("scalar_committed recovery — a mistyped committed token restructures into `key: value`", () => {
  const EMPTY = {
    path: ":n", type: "null", format: null, valueType: "null", concrete: "file/yamlover",
    documentPath: ":n", title: null, description: null, value: null, comments: {},
  };

  it("the `species>` ↵ trap: the SELF cell re-edited to `species: 12` becomes a keyed entry", async () => {
    fetchNode.mockResolvedValue(EMPTY);
    const { container } = await mount(":n");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, "species>");
    fireEvent.keyDown(hole, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":n", op: "emplace", yamlover: "species>" }]), { timeout: 2000 });
    // the level rule descended: `species>` is now the omni SELF line — re-edit it
    const self = container.querySelector<HTMLElement>('[data-yed-cell$=":self"]')!;
    expect(self.textContent).toBe("species>");
    type(self, "species: 12");
    fireEvent.keyDown(self, { key: "Enter" });
    // the restructure: the scalar line leaves, a keyed entry takes its place
    await waitFor(() => expect(editChunks).toHaveBeenLastCalledWith([
      { path: ":n", op: "emplace", yamlover: '""' },
      { path: ":n[0]", op: "insert", key: "species", yamlover: "12" },
    ]), { timeout: 2000 });
    expect(container.querySelector(".k")?.textContent).toBe("species");
    expect(container.textContent).not.toContain("species>");
  });

  it("a bare `species:` in the self cell opens the VALUE hole; the value inserts keyed", async () => {
    fetchNode.mockResolvedValue(EMPTY);
    const { container } = await mount(":n");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, "species>");
    fireEvent.keyDown(hole, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalled(), { timeout: 2000 });
    const self = container.querySelector<HTMLElement>('[data-yed-cell$=":self"]')!;
    type(self, "species:");
    fireEvent.keyDown(self, { key: "Enter" });
    expect(container.querySelector(".k")?.textContent).toBe("species");
    const value = document.activeElement as HTMLElement;
    expect(value.classList.contains("yed-hole")).toBe(true); // the value hole holds the caret
    type(value, "12");
    fireEvent.keyDown(value, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenLastCalledWith(expect.arrayContaining([
      { path: ":n[0]", op: "insert", key: "species", yamlover: "12" },
    ])), { timeout: 2000 });
  });

  it("a committed ENTRY token re-edited to `k: 1` is REPLACED by the keyed mapping", async () => {
    fetchNode.mockResolvedValue(ARR);
    const { container } = await mount(":d");
    const alpha = Array.from(container.querySelectorAll<HTMLElement>("[data-yed-cell]")).find((c) => c.textContent === "alpha")!;
    type(alpha, "k: 1");
    fireEvent.keyDown(alpha, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([
      { path: ":d[0]", op: "replace", yamlover: "k: 1" },
    ]), { timeout: 2000 });
    expect(container.querySelector(".k")?.textContent).toBe("k");
  });

  it("a DUPLICATE key in the self cell is rejected with the text kept (error ring)", async () => {
    fetchNode.mockResolvedValue(EMPTY);
    const { container } = await mount(":n");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, "species>");
    fireEvent.keyDown(hole, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalled(), { timeout: 2000 });
    // add a real `species` field first
    const fresh = container.querySelector<HTMLElement>(".yed-hole:not(.yed-tail)")!;
    type(fresh, "species: ");
    const v = container.querySelector<HTMLElement>(".yed-hole:not(.yed-tail)")!;
    type(v, "1");
    fireEvent.keyDown(v, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenLastCalledWith(expect.arrayContaining([
      expect.objectContaining({ key: "species" }),
    ])), { timeout: 2000 });
    const self = container.querySelector<HTMLElement>('[data-yed-cell$=":self"]')!;
    type(self, "species: 12");
    fireEvent.keyDown(self, { key: "Enter" });
    expect(self.textContent).toBe("species: 12"); // rejected — the text stays for the user to fix
    expect(container.textContent).toContain("species>" === self.textContent ? "x" : "1"); // the original field survives
  });
});

describe("loaded representation + recovery — the `species>` FILE case", () => {
  const DOC = (value: unknown, comments: object = {}) => ({
    path: ":n", type: "string", concrete: "file/yamlover", documentPath: ":n",
    title: null, description: null, value, comments,
  });

  it("a bare-authored `species>` loads BARE — never re-derived into a quoted token", async () => {
    fetchNode.mockResolvedValue(DOC("species>"));
    const { container } = await mount(":n");
    const cell = container.querySelector<HTMLElement>("[data-yed-cell]")!;
    expect(cell.textContent).toBe("species>"); // the file says `species>`, the cell says `species>`
  });

  it("the loaded token edits into `species>: 12` — the KVP restructure fires", async () => {
    fetchNode.mockResolvedValue(DOC("species>"));
    const { container } = await mount(":n");
    const cell = container.querySelector<HTMLElement>("[data-yed-cell]")!;
    type(cell, "species>: 12");
    fireEvent.keyDown(cell, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([
      { path: ":n", op: "emplace", yamlover: '""' },
      { path: ":n[0]", op: "insert", key: "species>", yamlover: "12" },
    ]), { timeout: 2000 });
    expect(container.querySelector(".k")?.textContent).toBe("species>");
  });

  it("a QUOTED key form `\"species>\": 12` restructures too, keeping the quoted key", async () => {
    fetchNode.mockResolvedValue(DOC("species>"));
    const { container } = await mount(":n");
    const cell = container.querySelector<HTMLElement>("[data-yed-cell]")!;
    type(cell, '"species>": 12');
    fireEvent.keyDown(cell, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([
      { path: ":n", op: "emplace", yamlover: '""' },
      { path: ":n[0]", op: "insert", key: '"species>"', yamlover: "12" },
    ]), { timeout: 2000 });
  });

  it("a NON-BREAKING space after the colon (real-browser contentEditable) still classifies", async () => {
    fetchNode.mockResolvedValue(DOC("species>"));
    const { container } = await mount(":n");
    const cell = container.querySelector<HTMLElement>("[data-yed-cell]")!;
    type(cell, "species>: 12");
    fireEvent.keyDown(cell, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([
      { path: ":n", op: "emplace", yamlover: '""' },
      { path: ":n[0]", op: "insert", key: "species>", yamlover: "12" },
    ]), { timeout: 2000 });
  });

  it("an authored-QUOTED string opens as a QUOTE-MODE cell — projected quotes, inner text edits", async () => {
    fetchNode.mockResolvedValue(DOC("true", { "": { raw: '"true"' } }));
    const { container } = await mount(":n");
    const row = container.querySelector(".yed-row")!;
    const quotes = Array.from(row.querySelectorAll(".s")).filter((s) => s.textContent === '"');
    expect(quotes).toHaveLength(2); // the quotes are PROJECTIONS, not editable characters
    const inner = row.querySelector<HTMLElement>("[data-yed-cell]")!;
    expect(inner.textContent).toBe("true"); // the cell edits the INNER text
  });
});

describe("LIVE keyed trigger on committed tokens — `abc` + `: ` restructures like a fresh hole", () => {
  it("the user's flow: open a scalar FILE, click in, append `: ` — KVP mode opens, value inserts", async () => {
    fetchNode.mockResolvedValue({
      path: ":n", type: "string", concrete: "file/yamlover", documentPath: ":n",
      title: null, description: null, value: "abc", comments: {},
    });
    const { container } = await mount(":n");
    const cell = container.querySelector<HTMLElement>("[data-yed-cell]")!;
    expect(cell.textContent).toBe("abc");
    type(cell, "abc: "); // typing `:` then space — NO Enter needed
    // the restructure happened LIVE: key cell + focused value hole
    expect(container.querySelector(".k")?.textContent).toBe("abc");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    expect(document.activeElement).toBe(hole);
    type(hole, "12");
    fireEvent.keyDown(hole, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([
      { path: ":n", op: "emplace", yamlover: '""' },
      { path: ":n[0]", op: "insert", key: "abc", yamlover: "12" },
    ]), { timeout: 2000 });
  });

  it("a committed ENTRY token grows `: ` live — replaced with `key: \"\"`, the value emplaces over it", async () => {
    fetchNode.mockResolvedValue(ARR);
    const { container } = await mount(":d");
    const alpha = Array.from(container.querySelectorAll<HTMLElement>("[data-yed-cell]")).find((c) => c.textContent === "alpha")!;
    type(alpha, "alpha: ");
    expect(container.querySelector(".k")?.textContent).toBe("alpha");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    expect(document.activeElement).toBe(hole);
    type(hole, "1");
    fireEvent.keyDown(hole, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([
      { path: ":d[0]", op: "replace", yamlover: 'alpha: ""' },
      { path: ":d[0]:alpha", op: "emplace", yamlover: "1" },
    ]), { timeout: 2000 });
  });

  it("the SELF-VALUE cell restructures live too", async () => {
    fetchNode.mockResolvedValue(OMNI);
    const { container } = await mount(":doc");
    const self = container.querySelector<HTMLElement>('[data-yed-cell$=":self"]')!;
    expect(self.textContent).toBe("A Title");
    type(self, "title: ");
    // the self line left; a keyed `title` entry took its position with the value hole focused
    expect(Array.from(container.querySelectorAll(".k")).map((k) => k.textContent)).toContain("title");
    expect(container.textContent).not.toContain("A Title");
  });
});
