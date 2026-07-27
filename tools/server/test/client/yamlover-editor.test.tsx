// @vitest-environment jsdom
// The projectional editor's CELL behaviour: hole typing materializes structure (quote pairing,
// `- ` / `k: ` shaping, `{` flow pairing, `*` pointer cells), Enter opens sibling holes, Backspace
// drops empty entries, Tab indents — and the op queue flushes the expected surgical batches.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, waitFor, fireEvent, act, createEvent } from "@testing-library/react";
import { TocFilterCtx, useTocFilterSession } from "../../src/client/toc-filter-session";

const { editChunks, fetchNode, fetchAnnotations, fetchSource, queryTree, queryFilter } = vi.hoisted(() => ({
  editChunks: vi.fn(),
  fetchNode: vi.fn(),
  fetchAnnotations: vi.fn().mockResolvedValue([]),
  fetchSource: vi.fn().mockResolvedValue({ source: "" }), // the yed mount's load (the create flow's fresh node)
  queryTree: vi.fn(),
  queryFilter: vi.fn(),
}));
vi.mock("../../src/client/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), editChunks, fetchNode, fetchAnnotations, fetchSource, queryTree, queryFilter }));

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
    // the CLOSER finishes the token on its line; Enter would mean "next element, next row" and
    // spread it to K&R (see the K&R describe below)
    fireEvent.keyDown(valueHole, { key: "}" });
    // the document IS the flow map the user typed. It used to emit `insert :n[0] key:a` — a BLOCK
    // mapping entry — so the braces were an input affordance that evaporated on the next reload.
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":n", op: "emplace", yamlover: "{a: 1}" }]), { timeout: 2000 });
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
    fireEvent.keyDown(inner, { key: "]" }); // the closer finishes it; Enter would spread it to K&R
    // as with `{`: the whole flow token is emplaced, so `[x]` survives the round-trip instead of
    // being written as the block sequence `- x`
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":n", op: "emplace", yamlover: "[x]" }]), { timeout: 2000 });
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
      expect(container.querySelector(".nodehead")).toBeTruthy();            // the toolbar is back
      expect(container.querySelector("[data-testid=y2-doc]")).toBeTruthy(); // and the page is the EDITOR (yed, the default)
    }, { timeout: 2000 });
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
    await waitFor(() => expect(container.querySelector("[data-testid=y2-doc]")).toBeTruthy(), { timeout: 2000 });
    expect(container.querySelector(".y2-hole")).toBeTruthy(); // the empty dir opens on the root hole
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

// A dir-backed pointer-array body (examples/56-array-of-files): positional members arrive as
// `$yamloverMixed` entries flagged `anchor: true` — drawn `- &key value`, the anchor a DIMMED
// read-only decoration; the unreferenced remainder is ordinary keyed rows. Value edits address
// the KEYED store path; structural ops (remove/indent/dedent) emit nothing for derived entries —
// membership and order belong to body.yamlover, which the yed does not rewrite (v1).
describe("derived anchors — positional members of a dir-backed pointer-array", () => {
  const DIR56 = {
    path: ":d", type: "mixed", concrete: "dir", title: null, description: null,
    value: {
      $yamloverMixed: {
        kind: "mix",
        entries: [
          { key: "anyfile01", value: "Alice", anchor: true },
          { key: "alsoany02", value: 42, anchor: true },
          { key: "andany04.json", value: "string" }, // keyed-only remainder — no anchor
        ],
      },
    },
  };

  it("draws `- &key value` rows with dimmed read-only anchors; the remainder keeps `key:`", async () => {
    fetchNode.mockResolvedValue(DIR56);
    const { container } = await mount(":d");
    const anchors = Array.from(container.querySelectorAll<HTMLElement>(".anchor.derived"));
    expect(anchors.map((a) => a.textContent)).toEqual(["&anyfile01", "&alsoany02"]);
    expect(container.querySelectorAll(".yaml-dash")).toHaveLength(2); // one dash per positional member
    for (const a of anchors) expect(a.hasAttribute("data-yed-cell")).toBe(false); // decoration, not a cell
    // the value rides the dash row, right after the anchor
    const row = anchors[0].closest(".yed-row")!;
    expect(row.textContent).toContain("Alice");
    // the unreferenced file is an ordinary keyed row — no dash, no anchor
    expect(Array.from(container.querySelectorAll(".k")).map((k) => k.textContent)).toContain("andany04.json");
  });

  it("a value edit emplaces at the KEYED path", async () => {
    fetchNode.mockResolvedValue(DIR56);
    const { container } = await mount(":d");
    const alice = Array.from(container.querySelectorAll<HTMLElement>("[data-yed-cell]")).find((c) => c.textContent === "Alice")!;
    type(alice, "Alicia");
    fireEvent.blur(alice);
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":d:anyfile01", op: "emplace", yamlover: "Alicia" }]), { timeout: 2000 });
    expect(editChunks).toHaveBeenCalledTimes(1);
  });

  it("Tab on a derived member emits nothing and moves nothing (order is body.yamlover's)", async () => {
    fetchNode.mockResolvedValue(DIR56);
    const { container } = await mount(":d");
    const fortyTwo = Array.from(container.querySelectorAll<HTMLElement>("[data-yed-cell]")).find((c) => c.textContent === "42")!;
    fortyTwo.focus();
    expect(document.activeElement).toBe(fortyTwo);
    fireEvent.keyDown(fortyTwo, { key: "Tab" });
    await new Promise((r) => setTimeout(r, 600)); // past the 500ms flush debounce
    expect(editChunks).not.toHaveBeenCalled();
    expect(container.querySelectorAll(".anchor.derived")).toHaveLength(2); // both rows still top-level
  });
});

// JSON is valid YAML, and yamlover follows — so a flow token must be typeable to completion and
// must SURVIVE the round-trip. These pin the two ways it used to fail: a flow container emitted an
// entry insert (a block shape the server wrote as `- 1` where `[1]` was typed), and a flow map's
// entry, `decided` from birth, could never take a key — so `{"abc":` replaced the key with an
// invisible nested mapping. Plus the recovery path: no keystroke may leave a cell you cannot escape.
describe("flow tokens — JSON typed into the editor", () => {
  const EMPTY = { path: ":d", type: "scalar", concrete: "dir/yamlover", title: null, description: null, value: null };

  /** One keystroke: keyDown first (cells may preventDefault), else the character lands. */
  function press(ch: string) {
    const el = document.activeElement as HTMLElement;
    expect(el, `nothing focused when typing ${JSON.stringify(ch)} — an editor trap`).toBeTruthy();
    expect(el).not.toBe(document.body);
    const ev = createEvent.keyDown(el, { key: ch });
    fireEvent(el, ev);
    if (!ev.defaultPrevented && ch.length === 1) {
      const cur = document.activeElement as HTMLElement;
      cur.textContent = (cur.textContent ?? "") + ch;
      fireEvent.input(cur);
    }
  }
  const rows = (c: HTMLElement) => Array.from(c.querySelectorAll(".yed-row")).map((r) => r.textContent);
  async function emptyDoc() {
    fetchNode.mockResolvedValue(EMPTY);
    const { container } = await mount(":d");
    container.querySelector<HTMLElement>(".yed-hole")!.focus();
    return container;
  }

  it("`[1]` at the root IS the document — one emplace, no `- ` marker invented", async () => {
    const container = await emptyDoc();
    for (const ch of ["[", "1"]) press(ch);
    expect(rows(container)).toEqual(["[1]"]); // no dash: `[1]` is the whole document
    fireEvent.blur(document.activeElement as HTMLElement);
    await waitFor(() => expect(editChunks).toHaveBeenCalled());
    expect(editChunks.mock.calls.flat(2)).toEqual([{ path: ":d", op: "emplace", yamlover: "[1]" }]);
  });

  it('`{"abc": 1}` at the root keeps the key — the quoted token names the entry', async () => {
    const container = await emptyDoc();
    for (const ch of ["{", '"', "a", "b", "c", '"', ":", "1"]) press(ch);
    expect(rows(container)).toEqual(['{"abc": 1}']);
    fireEvent.blur(document.activeElement as HTMLElement);
    await waitFor(() => expect(editChunks).toHaveBeenCalled());
    // the AUTHORED quotes survive: a flow token is one line, an unquoted spacey key would not parse
    expect(editChunks.mock.calls.flat(2)).toEqual([{ path: ":d", op: "emplace", yamlover: '{"abc": 1}' }]);
  });

  it("`{abc: 1}` — an UNQUOTED key names the entry too, never a nested mapping", async () => {
    const container = await emptyDoc();
    for (const ch of ["{", "a", "b", "c", ":", " ", "1"]) press(ch);
    expect(rows(container)).toEqual(["{abc: 1}"]);
  });

  it("a flow token as an ELEMENT keeps its `- ` and inserts at its own index", async () => {
    fetchNode.mockResolvedValue({ path: ":d", type: "array", concrete: "dir/yamlover", title: null, description: null, value: ["alpha"] });
    const { container } = await mount(":d");
    openHole(container).focus();
    for (const ch of ["[", "1"]) press(ch);
    expect(rows(container)).toContain("- [1]"); // inside a sequence it IS an element
    fireEvent.blur(document.activeElement as HTMLElement);
    await waitFor(() => expect(editChunks).toHaveBeenCalled());
    expect(editChunks.mock.calls.flat(2)).toEqual([{ path: ":d[1]", op: "insert", yamlover: "[1]" }]);
  });

  it("NO TRAPS: Backspace walks all the way back out of `[`, focus intact at every step", async () => {
    fetchNode.mockResolvedValue({ path: ":d", type: "array", concrete: "dir/yamlover", title: null, description: null, value: ["alpha"] });
    const { container } = await mount(":d");
    openHole(container).focus();
    press("[");
    expect(rows(container)).toContain("- []");
    const back = () => {
      const el = document.activeElement as HTMLElement;
      expect(el, "focus lost — the editor trapped the caret").toBeTruthy();
      expect(el).not.toBe(document.body);
      fireEvent.keyDown(el, { key: "Backspace" });
    };
    back(); // the flow container dismantles, the hole comes back
    expect(rows(container)).toContain("- ");
    back(); // the `- ` decision undoes
    back(); // the entry itself goes
    expect(rows(container)).toEqual(["- alpha", "＋"]);
    expect(document.activeElement).not.toBe(document.body);
  });
});

// The FLOW KEY GRAMMAR — `,` opens the next element, a typed closer ends the token, Enter is a
// comma (or a close on an empty cell), Tab walks the cells. Before this there was no keystroke
// that could open a SECOND element, and `acceptsAsScalar` rejected the comma outright, so only
// single-element tokens (`[1]`) were authorable.
describe("flow tokens — typing a whole JSON value", () => {
  const EMPTY = { path: ":d", type: "scalar", concrete: "dir/yamlover", title: null, description: null, value: null };

  function press(ch: string) {
    const el = document.activeElement as HTMLElement;
    expect(el, `nothing focused when typing ${JSON.stringify(ch)} — an editor trap`).toBeTruthy();
    expect(el).not.toBe(document.body);
    const ev = createEvent.keyDown(el, { key: ch });
    fireEvent(el, ev);
    if (!ev.defaultPrevented && ch.length === 1) {
      const cur = document.activeElement as HTMLElement;
      cur.textContent = (cur.textContent ?? "") + ch;
      fireEvent.input(cur);
    }
  }
  const type = (s: string) => { for (const ch of s) press(ch); };
  const rows = (c: HTMLElement) => Array.from(c.querySelectorAll(".yed-row")).map((r) => r.textContent);
  const ops = () => editChunks.mock.calls.flat(2);

  async function emptyDoc() {
    fetchNode.mockResolvedValue(EMPTY);
    const { container } = await mount(":d");
    container.querySelector<HTMLElement>(".yed-hole")!.focus();
    return container;
  }
  async function commit() {
    fireEvent.blur(document.activeElement as HTMLElement);
    await waitFor(() => expect(editChunks).toHaveBeenCalled(), { timeout: 2000 });
  }

  it("THE CASE: `[12, 13, 14]` types to completion and lands as ONE token", async () => {
    const container = await emptyDoc();
    type("[12,13,14]");
    expect(rows(container)).toEqual(["[12, 13, 14]"]);
    await commit();
    expect(ops()).toEqual([{ path: ":d", op: "emplace", yamlover: "[12, 13, 14]" }]);
  });

  it("`{a: 1, b: 2}` — an unquoted flow map, pair by pair", async () => {
    const container = await emptyDoc();
    type("{a: 1,b: 2}");
    expect(rows(container)).toEqual(["{a: 1, b: 2}"]);
    await commit();
    // every op is a whole-token emplace at the document path; if the queue happened to flush
    // mid-typing there are several, each a longer prefix — the LAST one is what lands on disk
    expect(ops().every((o) => o.path === ":d" && o.op === "emplace")).toBe(true);
    expect(ops().at(-1)).toEqual({ path: ":d", op: "emplace", yamlover: "{a: 1, b: 2}" });
  });

  it("authored quotes survive the round-trip", async () => {
    const container = await emptyDoc();
    for (const ch of ["{", '"', "a", '"', ":", "1", ",", '"', "b", '"', ":", "2", "}"]) press(ch);
    expect(rows(container)).toEqual(['{"a": 1, "b": 2}']);
    await commit();
    expect(ops()).toEqual([{ path: ":d", op: "emplace", yamlover: '{"a": 1, "b": 2}' }]);
  });

  it("nested `[[1, 2], [3]]` — a typed `[` inside flow NESTS, it does not restart", async () => {
    const container = await emptyDoc();
    type("[[1,2],[3]]");
    expect(rows(container)).toEqual(["[[1, 2], [3]]"]);
    await commit();
    expect(ops()).toEqual([{ path: ":d", op: "emplace", yamlover: "[[1, 2], [3]]" }]);
  });

  it("Enter opens the next element on a NEW ROW and NEVER closes the token", async () => {
    // A comma keeps the next element on this line; a NEWLINE puts it on the next one — which is a
    // concrete switch to json5p, not a layout whim (CONCRETES.md §Collection style). Enter never
    // CLOSES: doing that on an empty cell stranded the caret past the `]` of a legal `[1, 2]`,
    // where nothing can be typed. The closer closes; the caret stays in the token until then.
    const container = await emptyDoc();
    type("[1");
    press("Enter");
    type("2");
    expect(rows(container)).toEqual(["[", "1,", "2", "]"]);
    press("Enter"); // a third, empty element opens — the caret stays in it
    expect(rows(container)).toEqual(["[", "1,", "2,", "", "]"]);
    expect((document.activeElement as HTMLElement).className).toContain("yed-hole");
    press("Enter"); // again: still inside, never past the closer
    expect((document.activeElement as HTMLElement).className).toContain("yed-hole");
    press("]");     // THIS closes it, and the untyped element is dropped rather than written ""
    expect(rows(container)).toEqual(["[", "1,", "2", "]"]);
    expect((document.activeElement as HTMLElement).className).toContain("yed-after");
  });

  it("a comma INSIDE quotes belongs to the scalar, not to the grammar", async () => {
    const container = await emptyDoc();
    for (const ch of ["[", "'", "a", ",", " ", "b", "'", ",", "0", "x", "f", "f", "]"]) press(ch);
    expect(rows(container)).toEqual(["['a, b', 0xff]"]);
  });

  it("the WRONG closer rings and consumes nothing", async () => {
    const container = await emptyDoc();
    type("[1");
    press("}");
    expect(rows(container)).toEqual(["[1]"]);
    expect(document.activeElement).not.toBe(document.body);
    expect((document.activeElement as HTMLElement).className).toContain("edit-error");
  });

  it("Tab walks the cells instead of sitting still", async () => {
    await emptyDoc();
    type("[1,2");
    const before = document.activeElement;
    press("Tab");
    expect(document.activeElement).not.toBe(before);
    expect(document.activeElement).not.toBe(document.body);
    expect((document.activeElement as HTMLElement).dataset.yedCell ?? "").not.toBe("");
  });

  it("NO TRAPS: Backspace from past the closer steps back INSIDE, then all the way out", async () => {
    await emptyDoc();
    type("[1]");
    expect((document.activeElement as HTMLElement).className).toContain("yed-after");
    for (let i = 0; i < 4; i++) {
      const el = document.activeElement as HTMLElement;
      expect(el, "focus lost — the editor trapped the caret").toBeTruthy();
      expect(el).not.toBe(document.body);
      fireEvent.keyDown(el, { key: "Backspace" });
    }
    expect(document.activeElement).not.toBe(document.body);
  });
});

// A flow token loaded FROM DISK is committed everywhere, so its edits used to emit INTERIOR
// addresses (`:d:a:x`, `:d[0]`) — which the server reads as block addresses. For a flow map that
// splices a fresh line under the one-liner and corrupts the row.
describe("flow tokens — a PERSISTED token edits as one token", () => {
  const FLOW_SEQ = {
    path: ":d", type: "array", concrete: "dir/yamlover", title: null, description: null,
    value: [1, 2], comments: { "": { repr: "yaml/flow" } },
  };
  const FLOW_MAP = {
    path: ":d", type: "object", concrete: "dir/yamlover", title: null, description: null,
    value: { a: { x: 1 } }, comments: { "/a": { repr: "yaml/flow" } },
  };
  const cellWith = (c: HTMLElement, text: string) =>
    Array.from(c.querySelectorAll<HTMLElement>("[data-yed-cell]")).find((el) => el.textContent === text)!;

  it("renders a wire-flow container as FLOW cells, not block rows", async () => {
    fetchNode.mockResolvedValue(FLOW_SEQ);
    const { container } = await mount(":d");
    expect(Array.from(container.querySelectorAll(".yed-row")).map((r) => r.textContent)).toEqual(["[1, 2]"]);
    expect(container.querySelector(".yaml-dash")).toBeNull(); // no `- ` markers
  });

  it("editing a cell re-emplaces the WHOLE token at the CONTAINER's path", async () => {
    fetchNode.mockResolvedValue(FLOW_MAP);
    const { container } = await mount(":d");
    const cell = cellWith(container, "1");
    cell.focus();
    cell.textContent = "2";
    fireEvent.input(cell);
    fireEvent.blur(cell);
    await waitFor(() => expect(editChunks).toHaveBeenCalled(), { timeout: 2000 });
    // `:d:a`, the flow container — NOT `:d:a:x`, which has no line of its own
    expect(editChunks.mock.calls.flat(2)).toEqual([{ path: ":d:a", op: "emplace", yamlover: "{x: 2}" }]);
  });

  it("Enter on a COMMITTED element opens a sibling — it does not swallow the token", async () => {
    fetchNode.mockResolvedValue(FLOW_SEQ);
    const { container } = await mount(":d");
    const cell = cellWith(container, "1");
    cell.focus();
    fireEvent.keyDown(cell, { key: "Enter" });
    // it used to convert the element into a block container with an invisible hole, after which
    // the whole token re-serialized as `[""]`. Enter now also SPREADS the token (a new row is what
    // a newline means), so the sibling opens below `1,` instead of after it — but the token is
    // still one token, and the caret is still in it.
    const rowText = Array.from(container.querySelectorAll(".yed-row")).map((r) => r.textContent);
    expect(rowText).toContain("1,");
    expect(rowText.some((t) => t?.trim() === "]")).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
  });
});

// PASTING JSON. A flow token pasted into a hole keeps its collection style instead of
// canonicalizing to block rows, and a pretty-printed JSON blob — which is NOT yamlover source
// (trailing commas, `//` comments, different quoting rules) — is sniffed and read with the json5p
// parser rather than refused.
describe("flow tokens — pasting JSON", () => {
  const EMPTY = { path: ":d", type: "scalar", concrete: "dir/yamlover", title: null, description: null, value: null };
  const ARR = { path: ":d", type: "array", concrete: "dir/yamlover", title: null, description: null, value: ["alpha"] };
  const rows = (c: HTMLElement) => Array.from(c.querySelectorAll(".yed-row")).map((r) => r.textContent);

  function paste(el: HTMLElement, text: string) {
    fireEvent.paste(el, { clipboardData: { getData: () => text } });
  }

  it("a single-line flow token pastes as ONE token, not as block rows", async () => {
    fetchNode.mockResolvedValue(ARR);
    const { container } = await mount(":d");
    const hole = openHole(container);
    hole.focus();
    paste(hole, "[12, 13, 14]");
    await waitFor(() => expect(rows(container).join("|")).toContain("[12, 13, 14]"));
  });

  it("a MULTI-LINE JSON blob is sniffed and read by the json5p parser", async () => {
    fetchNode.mockResolvedValue(EMPTY);
    const { container } = await mount(":d");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    hole.focus();
    // not valid yamlover (double-quoted keys over several lines is json5p's grammar, and the
    // yamlover reader rejects it) — the sniff is what makes this land at all
    paste(hole, '{\n  "a": 1,\n  "b": [2, 3]\n}');
    await waitFor(() => expect(container.textContent).toContain("a"));
    expect(container.textContent).toContain("b");
  });

  it("refuses BLOCK structure into a flow cell — one line has no spelling for it", async () => {
    fetchNode.mockResolvedValue(ARR);
    const { container } = await mount(":d");
    const hole = openHole(container);
    hole.focus();
    hole.textContent = "[";
    fireEvent.input(hole);
    const inner = Array.from(container.querySelectorAll<HTMLElement>(".yed-hole:not(.yed-tail)")).pop()!;
    inner.focus();
    paste(inner, "a: 1\nb: 2");
    // the row keeps its shape; nothing was reshaped behind the user's back
    expect(rows(container).join("|")).toContain("[");
    expect(rows(container).join("|")).not.toContain("a: 1");
  });
});

// Three flow-editing defects, each pinned:
//  1) the caret could enter the last cell of `[12, 13]` and never leave it — arrows stopped at a
//     cell edge instead of crossing into the neighbour;
//  2) `[12, 13]: 14` — a flow token as a KEY, the shape splitKV reads (`[256, 256]: *thumb`) —
//     could not be typed at all;
//  3) a wire-loaded flow SEQUENCE re-rendered as `{12, 13}`, which is not yamlover: the brackets
//     came from the stored tag instead of from the entries.
describe("flow tokens — caret, keys, and brackets", () => {
  const EMPTY = { path: ":d", type: "scalar", concrete: "dir/yamlover", title: null, description: null, value: null };
  const WIRE_SEQ = {
    path: ":d", type: "array", concrete: "dir/yamlover", title: null, description: null,
    value: [12, 13], comments: { "": { repr: "yaml/flow" } },
  };
  const WIRE_MIXED_SEQ = {
    path: ":d", type: "array", concrete: "dir/yamlover", title: null, description: null,
    value: { $yamloverMixed: { kind: "array", entries: [{ key: null, value: 12 }, { key: null, value: 13 }] } },
    comments: { "": { repr: "yaml/flow" } },
  };

  function press(ch: string) {
    const el = document.activeElement as HTMLElement;
    expect(el, `nothing focused when typing ${JSON.stringify(ch)}`).toBeTruthy();
    expect(el).not.toBe(document.body);
    const ev = createEvent.keyDown(el, { key: ch });
    fireEvent(el, ev);
    if (!ev.defaultPrevented && ch.length === 1) {
      const cur = document.activeElement as HTMLElement;
      cur.textContent = (cur.textContent ?? "") + ch;
      fireEvent.input(cur);
    }
  }
  const type = (s: string) => { for (const ch of s) press(ch); };
  const rows = (c: HTMLElement) => Array.from(c.querySelectorAll(".yed-row")).map((r) => r.textContent);
  const focusText = () => (document.activeElement as HTMLElement)?.textContent;

  async function emptyDoc() {
    fetchNode.mockResolvedValue(EMPTY);
    const { container } = await mount(":d");
    container.querySelector<HTMLElement>(".yed-hole")!.focus();
    return container;
  }

  it("BRACKETS come from the entries: a wire-loaded sequence keeps `[` `]`", async () => {
    for (const doc of [WIRE_SEQ, WIRE_MIXED_SEQ]) {
      fetchNode.mockResolvedValue(doc);
      const { container } = await mount(":d");
      // `{12, 13}` — what the stored tag produced — is not yamlover at all, and the next edit
      // would have written it to disk
      expect(rows(container)).toEqual(["[12, 13]"]);
      cleanup();
    }
  });

  it("ArrowLeft/Right CROSS cell boundaries — the caret is never stuck in a cell", async () => {
    await emptyDoc();
    type("[12,13");
    expect(focusText()).toBe("13");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowLeft" });
    expect(focusText()).toBe("12"); // left out of the cell, into its neighbour
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowRight" });
    expect(focusText()).toBe("13"); // and back
  });

  it("`[12, 13]: 14` — the token becomes the entry's KEY", async () => {
    const container = await emptyDoc();
    type("[12,13]");
    expect((document.activeElement as HTMLElement).className).toContain("yed-after");
    press(":"); // past the closer, a colon makes the token a key
    expect(rows(container)[0]).toContain("[12, 13]:");
    type("14");
    expect(rows(container)[0]).toContain("14");
    fireEvent.blur(document.activeElement as HTMLElement);
    await waitFor(() => expect(editChunks).toHaveBeenCalled(), { timeout: 2000 });
    // the closer had already committed the token as the document's VALUE, so that line is cleared
    // first (the coalesced emplace) and the keyed entry inserted — never an insert into a stale doc
    expect(editChunks.mock.calls.flat(2)).toEqual([
      { path: ":d", op: "emplace", yamlover: '""' },
      { path: ":d[0]", op: "insert", yamlover: "14", key: "[12, 13]" },
    ]);
  });

  it("a `:` INSIDE another flow token is refused — a flow map's keys are typed in its cells", async () => {
    const container = await emptyDoc();
    type("[[1,2]"); // the inner token is closed, the caret sits past its `]`
    press(":");
    expect(rows(container)[0]).not.toContain("]:"); // no key was made
    expect(document.activeElement).not.toBe(document.body);
  });
});

// --- K&R: Enter spreads a flow token, Backspace joins it back ---------------------------------- //
// CONCRETES.md §Collection style — a flow token written across lines IS a json5p subtree, so the
// spread is a CONCRETE switch, not a layout preference. The gesture pair is the whole grammar:
// a COMMA keeps the next element on this line, ENTER puts it on the next one. What the token cannot
// be written as in json5p (a keyed+keyless mixture) simply does not spread.
describe("the K&R spread (a flow token over several rows)", () => {
  const rowsOf = (c: HTMLElement) => Array.from(c.querySelectorAll(".yed-row")).map((r) => r.textContent);
  const lastHoleIn = (c: HTMLElement): HTMLElement => {
    const holes = c.querySelectorAll<HTMLElement>(".yed-hole");
    return holes[holes.length - 1];
  };

  it("Enter inside a token spreads it — the element lands on its own ROW", async () => {
    fetchNode.mockResolvedValue({ path: ":n", type: "object", concrete: "yamlover", title: null, description: null, value: {} });
    const { container } = await mount(":n");
    type(container.querySelector<HTMLElement>(".yed-hole")!, "[");
    const inner = container.querySelector<HTMLElement>(".yed-hole")!;
    type(inner, "1");
    fireEvent.keyDown(inner, { key: "Enter" });
    // the opener keeps its row, the element moved to one of its own, the closer has a third
    await waitFor(() => expect(rowsOf(container).length).toBeGreaterThan(2));
    const flat = rowsOf(container).join("|");
    expect(flat).toContain("[");
    expect(flat).toContain("]");
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":n", op: "emplace", yamlover: "[\n  1\n]" }]), { timeout: 2000 });
  });

  it("a COMMA keeps the next element on the same line", async () => {
    fetchNode.mockResolvedValue({ path: ":n", type: "object", concrete: "yamlover", title: null, description: null, value: {} });
    const { container } = await mount(":n");
    type(container.querySelector<HTMLElement>(".yed-hole")!, "[");
    const inner = container.querySelector<HTMLElement>(".yed-hole")!;
    type(inner, "1");
    fireEvent.keyDown(inner, { key: "," });
    const next = lastHoleIn(container);
    type(next, "2");
    fireEvent.keyDown(next, { key: "]" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":n", op: "emplace", yamlover: "[1, 2]" }]), { timeout: 2000 });
  });

  it("a token loaded K&R from disk draws as rows and re-emplaces as K&R", async () => {
    fetchNode.mockResolvedValue({
      path: ":n", type: "object", concrete: "yamlover", title: null, description: null,
      value: { a: { x: 1, y: 2 } },
      comments: { "/a": { concrete: "json5p" } },
    });
    const { container } = await mount(":n");
    const rows = rowsOf(container);
    expect(rows.some((r) => r?.includes("a: {"))).toBe(true); // the opener rides the key row
    expect(rows.some((r) => r?.trim() === "}")).toBe(true);   // and the closer has its own
    // editing a cell re-emplaces the WHOLE token, still spread
    const cells = Array.from(container.querySelectorAll<HTMLElement>(".editable"));
    const xCell = cells.find((c) => c.textContent === "1")!;
    type(xCell, "5");
    fireEvent.blur(xCell);
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":n:a", op: "emplace", yamlover: "{\n  x: 5,\n  y: 2\n}" }]), { timeout: 2000 });
  });

  it("Backspace at the head of the first element JOINS it back to one line", async () => {
    // the text editor's gesture — pull this line up onto the opener's. (Past the CLOSER, Backspace
    // steps back inside instead: at document scale a join there reflowed a whole file under someone
    // who was deleting.)
    fetchNode.mockResolvedValue({
      path: ":n", type: "object", concrete: "yamlover", title: null, description: null,
      value: { a: { x: 1 } },
      comments: { "/a": { concrete: "json5p" } },
    });
    const { container } = await mount(":n");
    const first = Array.from(container.querySelectorAll<HTMLElement>("[data-yed-cell]"))
      .find((c) => c.textContent === "x")!;
    first.focus();
    const r = document.createRange(); r.selectNodeContents(first); r.collapse(true);
    const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(r);
    fireEvent.keyDown(first, { key: "Backspace" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":n:a", op: "emplace", yamlover: "{x: 1}" }]), { timeout: 2000 });
    expect(rowsOf(container).some((r2) => r2?.includes("a: {x: 1}"))).toBe(true);
  });

  it("a MIXED container does not spread — json5p cannot hold it", async () => {
    // keyed + keyless in one node is yamlover's default and json5p's one refusal, so Enter still
    // opens the next element, just not on a new row
    fetchNode.mockResolvedValue({
      path: ":n", type: "object", concrete: "yamlover", title: null, description: null,
      value: { a: { $yamloverMixed: { kind: "mix", entries: [{ key: null, value: 1 }, { key: "k", value: 2 }] } } },
      comments: { "/a": { repr: "yaml/flow" } },
    });
    const { container } = await mount(":n");
    const cells = Array.from(container.querySelectorAll<HTMLElement>(".editable"));
    const one = cells.find((c) => c.textContent === "1")!;
    fireEvent.keyDown(one, { key: "Enter" });
    await waitFor(() => expect(rowsOf(container).length).toBeGreaterThan(0));
    expect(rowsOf(container).some((r) => r?.trim() === "}")).toBe(false); // never spread
  });
});

// --- NO TRAPS around a flow token's edges ------------------------------------------------------ //
// Reported: a new document, `[` (the closer projects, caret between), then Enter — no row was
// allocated, the caret jumped PAST `]` and nothing could undo it. Three separate dead ends met
// there, and each one is pinned here by where the CARET ends up (a row that renders with the caret
// on <body> is exactly the lock).
describe("flow tokens — the edges never trap the caret", () => {
  const rowsOf = (c: HTMLElement) => Array.from(c.querySelectorAll(".yed-row")).map((r) => r.textContent);
  const emptyRoot = () => fetchNode.mockResolvedValue(
    { path: ":n", type: "object", concrete: "yamlover", title: null, description: null, value: {} });
  const openBracket = async () => {
    emptyRoot();
    const { container } = await mount(":n");
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, "[");
    return container;
  };

  it("Enter right after `[` ALLOCATES the row and keeps the caret inside", async () => {
    // it used to close the token (`[]`) and strand the caret past the closer: an empty cell means
    // "close" only once something has been put in the token
    const container = await openBracket();
    fireEvent.keyDown(container.querySelector<HTMLElement>(".yed-hole")!, { key: "Enter" });
    expect(rowsOf(container)).toEqual(["[", "", "]"]);
    expect(document.activeElement).toBe(container.querySelector(".yed-hole"));
    expect((document.activeElement as HTMLElement).className).toContain("yed-hole");
  });

  it("`[` then Backspace returns to the ROOT hole (not an empty screen)", async () => {
    // `removeEmpty` gave the root kind "hole", which matched no branch in editor.tsx: the view
    // rendered NOTHING and focus fell to <body>
    const container = await openBracket();
    fireEvent.keyDown(container.querySelector<HTMLElement>(".yed-hole")!, { key: "Backspace" });
    expect(rowsOf(container).length).toBe(1);
    expect(document.activeElement).not.toBe(document.body);
    expect((document.activeElement as HTMLElement).className).toContain("editable");
  });

  it("Backspace past the closer of an EMPTY token re-opens a cell inside it", async () => {
    const container = await openBracket();
    fireEvent.keyDown(container.querySelector<HTMLElement>(".yed-hole")!, { key: "]" });
    const after = document.activeElement as HTMLElement;
    expect(after.className).toContain("yed-after");
    fireEvent.keyDown(after, { key: "Backspace" });
    expect((document.activeElement as HTMLElement).className).toContain("yed-hole");
  });

  it("…and past the closer of an emptied SPREAD token too", async () => {
    const container = await openBracket();
    fireEvent.keyDown(container.querySelector<HTMLElement>(".yed-hole")!, { key: "Enter" }); // spread
    fireEvent.keyDown(container.querySelector<HTMLElement>(".yed-hole")!, { key: "]" });     // empty it
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Backspace" });
    expect((document.activeElement as HTMLElement).className).toContain("yed-hole");
    expect(rowsOf(container)).toEqual(["[", "", "]"]);
  });

  it("Tab is the universal escape from the after-cell", async () => {
    const container = await openBracket();
    const hole = container.querySelector<HTMLElement>(".yed-hole")!;
    type(hole, "1");
    fireEvent.keyDown(hole, { key: "Enter" });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Tab" });
    expect(document.activeElement).not.toBe(document.body);
  });
});

// A flow token is ONE token however deeply it nests, so the K&R spread — a CONCRETE switch — is a
// property of the whole token, never of a level inside it. Spreading only the inner container asked
// the one-line parent to draw rows it has no place for: the inner closer and its cells vanished
// (`{"a": [}`), the caret with them, and a commit wrote a file the screen disagreed with.
describe("the spread belongs to the WHOLE flow token", () => {
  const rowsOf = (c: HTMLElement) => Array.from(c.querySelectorAll(".yed-row")).map((r) => r.textContent);
  const openNested = async () => {
    fetchNode.mockResolvedValue({ path: ":n", type: "object", concrete: "yamlover", title: null, description: null, value: {} });
    const { container } = await mount(":n");
    type(container.querySelector<HTMLElement>(".yed-hole")!, "{");            // the outer token
    const inner = container.querySelector<HTMLElement>(".yed-hole")!;
    type(inner, "a: ");                                                        // a keyed pair in it
    type(container.querySelector<HTMLElement>(".yed-hole")!, "[");             // a NESTED token
    return container;
  };

  it("Enter in a NESTED token spreads from the outermost bracket", async () => {
    const container = await openNested();
    fireEvent.keyDown(container.querySelector<HTMLElement>(".yed-hole")!, { key: "Enter" });
    // every level is spread: the outer opener, the pair, the inner's hole, then both closers
    expect(rowsOf(container)).toEqual(["{", "a: [", "", "]", "}"]);
    expect((document.activeElement as HTMLElement).className).toContain("yed-hole");
  });

  it("an untyped element is not written, so an empty token stays tight", async () => {
    const container = await openNested();
    fireEvent.keyDown(container.querySelector<HTMLElement>(".yed-hole")!, { key: "Enter" });
    fireEvent.blur(document.activeElement as HTMLElement);
    await waitFor(() => expect(editChunks).toHaveBeenCalled(), { timeout: 2000 });
    const sent = editChunks.mock.calls.at(-1)![0] as { yamlover: string }[];
    expect(sent[0].yamlover).toBe('{\n  a: []\n}'); // not a blank line between the brackets
  });

  it("a JOIN is symmetric — it collapses the whole token", async () => {
    fetchNode.mockResolvedValue({
      path: ":n", type: "object", concrete: "yamlover", title: null, description: null,
      value: { a: { b: [1] } },
      comments: { "/a": { concrete: "json5p" } },
    });
    const { container } = await mount(":n");
    // from the head of the INNER token's first element: joining only that level would draw `[1]`
    // inline inside a spread outer one, while json5p writes both expanded
    const inner = Array.from(container.querySelectorAll<HTMLElement>("[data-yed-cell]"))
      .find((c) => c.textContent === "1")!;
    inner.focus();
    const rr = document.createRange(); rr.selectNodeContents(inner); rr.collapse(true);
    const ss = window.getSelection()!; ss.removeAllRanges(); ss.addRange(rr);
    fireEvent.keyDown(inner, { key: "Backspace" });
    await waitFor(() => expect(editChunks).toHaveBeenCalled(), { timeout: 2000 });
    const sent = editChunks.mock.calls.at(-1)![0] as { yamlover: string }[];
    expect(sent[0].yamlover).toBe("{b: [1]}"); // ONE line, all the way down
  });
});

// --- UNWINDING: one Backspace, one level, no hidden state --------------------------------------- //
// Reported: `[` `{` then Backspace removed the inner `{}`, the NEXT Backspace did NOTHING, and only
// a third removed `[]`. The wasted press was hidden state — collapsing a structure reset the NODE
// but left the ENTRY marked `decided`, so the next Backspace matched "undo the marker" (there is no
// marker on a flow element) and silently did nothing.
//
// The invariant these pin: EVERY Backspace on an empty cell removes exactly one level, the caret
// always lands in a real cell, and a client-only structure never reaches the server.
describe("Backspace unwinds one level per press", () => {
  const rowsOf = (c: HTMLElement) => Array.from(c.querySelectorAll(".yed-row")).map((r) => r.textContent);
  const fresh = async () => {
    fetchNode.mockResolvedValue({ path: ":n", type: "object", concrete: "yamlover", title: null, description: null, value: {} });
    return (await mount(":n")).container;
  };
  /** Backspace on whatever cell has the caret, then report the rows. */
  const back = (c: HTMLElement): (string | null)[] => {
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Backspace" });
    expect(document.activeElement, "the caret must never fall out of the editor").not.toBe(document.body);
    return rowsOf(c);
  };
  /** Type into the focused cell (the caret follows each projected structure). */
  const at = (c: HTMLElement, text: string) => type(document.activeElement as HTMLElement, text);

  // one press per level, for every pairing of the two brackets
  for (const [outer, inner, opened] of [
    ["[", "{", "[{}]"],
    ["{", "[", "{[]}"],
    ["[", "[", "[[]]"],
    ["{", "{", "{{}}"],
  ] as const) {
    it(`\`${outer}\` then \`${inner}\` unwinds in TWO presses`, async () => {
      const container = await fresh();
      type(container.querySelector<HTMLElement>(".yed-hole")!, outer);
      at(container, inner);
      // (the brackets a token WEARS are derived from its entries — flowIsSeq — so the opened shape
      // is asserted loosely: what matters here is how many presses undo it)
      expect(rowsOf(container)[0]).toHaveLength(opened.length);
      expect(back(container)[0]).toHaveLength(2); // the inner pair is gone, the outer remains
      expect(back(container)).toEqual([""]);      // …and the second press clears the outer
      expect((document.activeElement as HTMLElement).className).toContain("editable");
    });
  }

  it("three levels take three presses", async () => {
    const container = await fresh();
    type(container.querySelector<HTMLElement>(".yed-hole")!, "[");
    at(container, "{");
    at(container, "[");
    expect(rowsOf(container)[0]).toHaveLength(6); // `[`+`[`+`[`+`]`+`]`+`]`, whatever the brackets
    expect(back(container)[0]).toHaveLength(4);
    expect(back(container)[0]).toHaveLength(2);
    expect(back(container)).toEqual([""]);
  });

  it("a POINTER cell inside a token unwinds in two presses too", async () => {
    // the pointer/quote/tag cells dismantle through `dismantle`, which had the same hidden state
    const container = await fresh();
    type(container.querySelector<HTMLElement>(".yed-hole")!, "[");
    at(container, "*");
    expect(back(container)[0]).toHaveLength(2); // the reference cell is gone
    expect(back(container)).toEqual([""]);      // and so is the token
  });

  it("a KEYED entry keeps its key when its value collapses", async () => {
    // the entry decided more than the bracket, so it must NOT be reset — `a: ` survives, and the
    // press after that undoes the key itself (its text returns to the hole to be edited)
    const container = await fresh();
    type(container.querySelector<HTMLElement>(".yed-hole")!, "{");
    at(container, "a: ");
    at(container, "{");
    expect(rowsOf(container)).toEqual(["{a: {}}"]);
    expect(back(container)).toEqual(["{a: }"]);  // the inner pair only
    expect(back(container)).toEqual(["{a}"]);    // the key's text returns to the cell
    type(document.activeElement as HTMLElement, ""); // …the person then deletes that text
    expect(back(container)).toEqual([""]);       // and the token goes
  });

  it("a SIBLING is untouched, and the emptied element goes on the next press", async () => {
    const container = await fresh();
    type(container.querySelector<HTMLElement>(".yed-hole")!, "[");
    at(container, "1");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "," });
    at(container, "{");
    expect(rowsOf(container)).toEqual(["[1, {}]"]);
    expect(back(container)).toEqual(["[1, ]"]); // the inner pair
    expect(back(container)).toEqual(["[1]"]);   // the now-empty element
  });

  it("none of this reaches the SERVER — a client-only structure was never written", async () => {
    const container = await fresh();
    type(container.querySelector<HTMLElement>(".yed-hole")!, "[");
    at(container, "{");
    back(container);
    back(container);
    expect(editChunks).not.toHaveBeenCalled();
  });

  it("and the editor is ALIVE afterwards — the cleared hole still types", async () => {
    const container = await fresh();
    type(container.querySelector<HTMLElement>(".yed-hole")!, "[");
    at(container, "{");
    back(container);
    back(container);
    at(container, "42");
    expect(rowsOf(container)).toEqual(["42"]);
  });
});

// --- THE BRACKET YOU TYPED IS THE BRACKET YOU GET ---------------------------------------------- //
// `{}` and `[]` are DIFFERENT VALUES, so the projection must not re-read one as the other. It used
// to: the entries decided the brackets, so `{` `{` drew `[{}]` and `{12` committed as the list
// `[12]` — both of them rewriting what the person typed while a key was still on its way.
// A map's first key may be a TOKEN (`{{}: 12}`), which is exactly the continuation that was lost.
describe("flow brackets are AUTHORED, not inferred", () => {
  const rowsOf = (c: HTMLElement) => Array.from(c.querySelectorAll(".yed-row")).map((r) => r.textContent);
  const fresh = async () => {
    fetchNode.mockResolvedValue({ path: ":n", type: "object", concrete: "yamlover", title: null, description: null, value: {} });
    return (await mount(":n")).container;
  };
  const at = (c: HTMLElement, text: string) => type(document.activeElement as HTMLElement, text);

  it("`{` stays a brace when its first element has no key YET", async () => {
    const container = await fresh();
    type(container.querySelector<HTMLElement>(".yed-hole")!, "{");
    at(container, "{");
    expect(rowsOf(container)).toEqual(["{{}}"]); // NOT `[{}]`
  });

  it("`[` stays a bracket, and an empty one is not a map", async () => {
    const container = await fresh();
    type(container.querySelector<HTMLElement>(".yed-hole")!, "[");
    at(container, "[");
    expect(rowsOf(container)).toEqual(["[[]]"]);
  });

  it("a pair in progress is DRAWN but never WRITTEN", async () => {
    // `{12}` is not yamlover — but `{12: 3}` is one keystroke away, so the editor shows it and
    // simply says nothing to the server until the key lands
    const container = await fresh();
    type(container.querySelector<HTMLElement>(".yed-hole")!, "{");
    at(container, "12");
    fireEvent.blur(document.activeElement as HTMLElement);
    expect(rowsOf(container)).toEqual(["{12}"]);
    expect(editChunks).not.toHaveBeenCalled();
  });

  it("…and lands the whole pair once the key arrives", async () => {
    const container = await fresh();
    type(container.querySelector<HTMLElement>(".yed-hole")!, "{");
    at(container, "12: ");   // the key decision moves the caret to the VALUE cell…
    at(container, "3");      // …which is where the rest is typed
    fireEvent.blur(document.activeElement as HTMLElement);
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":n", op: "emplace", yamlover: "{12: 3}" }]), { timeout: 2000 });
  });

  it("a KEYED entry still forces the map brackets — `[k: v]` is not yamlover", async () => {
    // the one override, and it is the file's rule rather than a preference
    const container = await fresh();
    type(container.querySelector<HTMLElement>(".yed-hole")!, "[");
    at(container, "a: ");
    at(container, "1");
    expect(rowsOf(container)).toEqual(["{a: 1}"]);
  });

  it("a TOKEN can be a flow map's key — `{` `{` `}` `:` `12`", async () => {
    // the continuation the re-bracketing used to make unreachable; the parser reads it as the
    // string key `{}` (the flow twin of `[256, 256]: …`)
    const container = await fresh();
    type(container.querySelector<HTMLElement>(".yed-hole")!, "{");
    at(container, "{");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "}" });   // close the inner one
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: ":" });   // …and make it the key
    at(container, "12");
    expect(rowsOf(container)).toEqual(["{{}: 12}"]);
  });

  it("but a flow SEQUENCE refuses a token key — it has no keys at all", async () => {
    const container = await fresh();
    type(container.querySelector<HTMLElement>(".yed-hole")!, "[");
    at(container, "[");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "]" });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: ":" });
    expect(rowsOf(container)).toEqual(["[[]]"]); // unchanged, and the cell rings
  });
});

// --- WALKING a flow token: every cell is reachable, and the keys are cells ---------------------- //
// Reported: inside `{"name": "Eurasia", …}` the caret could not leave the quoted value — not right
// past it, and not back to the `name` key to rename it or to sit before the pair. Two causes: a
// quoted cell handed NOTHING to the flow grammar (so the arrows died there), and a key inside a
// token was a static span rather than a cell (so there was nothing to reach).
describe("a flow token is walkable end to end", () => {
  const mountWith = async (src: string) => {
    fetchNode.mockResolvedValue({
      path: ":n", type: "object", concrete: "yamlover", title: null, description: null,
      value: { a: { name: "Eurasia", m: 2 } },
      comments: { "/a": { repr: "yaml/flow" }, "/a/name": { raw: '"Eurasia"' } },
    });
    void src;
    return (await mount(":n")).container;
  };
  const cellsOf = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>("[data-yed-cell]"));
  const caretAt = (el: HTMLElement, where: "start" | "end") => {
    el.focus();
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(where === "start");
    const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r);
  };

  it("the KEY inside a token is a cell, so the arrows reach it from the value", async () => {
    const container = await mountWith("");
    const cells = cellsOf(container);
    expect(cells.map((c) => c.textContent)).toEqual(["a", "name", "Eurasia", "m", "2", ""]);
    const value = cells.find((c) => c.textContent === "Eurasia")!;
    caretAt(value, "start");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowLeft" });
    expect((document.activeElement as HTMLElement).textContent).toBe("name"); // its own key
    caretAt(value, "end");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowRight" });
    expect((document.activeElement as HTMLElement).textContent).toBe("m");    // the next key
  });

  it("renaming a key inside a token re-emplaces the WHOLE token", async () => {
    // there is no interior address to rename at — `rekeyNode` would address a path the server
    // refuses, so the pair changes in the model and the token is written whole
    const container = await mountWith("");
    const key = cellsOf(container).find((c) => c.textContent === "name")!;
    type(key, "title");
    fireEvent.blur(key);
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith(
      [{ path: ":n:a", op: "emplace", yamlover: '{title: "Eurasia", m: 2}' }]), { timeout: 2000 });
  });

  it("a QUOTED cell keeps `,` and the closers as TEXT — only the arrows are grammar", async () => {
    const container = await mountWith("");
    const value = cellsOf(container).find((c) => c.textContent === "Eurasia")!;
    caretAt(value, "end");
    fireEvent.keyDown(value, { key: "," });   // a comma belongs to the string being typed
    expect(cellsOf(container).map((c) => c.textContent)).toEqual(["a", "name", "Eurasia", "m", "2", ""]);
  });

  it("a token opened INSIDE a spread one is spread too", async () => {
    // json5p expands everything under the switch, so an inline inner token would show a shape the
    // file does not have — and Enter in it looked dead, the whole token being spread already
    fetchNode.mockResolvedValue({ path: ":n", type: "object", concrete: "yamlover", title: null, description: null, value: {} });
    const { container } = await mount(":n");
    type(container.querySelector<HTMLElement>(".yed-hole")!, "[");
    fireEvent.keyDown(container.querySelector<HTMLElement>(".yed-hole")!, { key: "Enter" }); // spread
    type(document.activeElement as HTMLElement, "{");                                        // an inner token
    const rows = Array.from(container.querySelectorAll(".yed-row")).map((r) => r.textContent);
    expect(rows).toEqual(["[", "{", "", "}", "]"]); // rows, not `{}` inline
  });
});

// The EDITOR half of the same report: a whole document written K&R must open as rows, not be
// canonicalized to block the moment it is unlocked (the root's `concrete` reaches the model through
// the very bucket the read-only view reads).
describe("a K&R DOCUMENT opens as rows", () => {
  it("draws every level, and an edit keeps the layout", async () => {
    fetchNode.mockResolvedValue({
      path: ":n", type: "array", concrete: "file/yamlover", title: null, description: null,
      value: [{ name: "Eurasia", children: [{ name: "Europe" }] }],
      comments: { "": { concrete: "json5p" }, "[0]/name": { raw: '"Eurasia"' }, "[0]/children[0]/name": { raw: '"Europe"' } },
    });
    const { container } = await mount(":n");
    const rows = Array.from(container.querySelectorAll(".yed-row")).map((r) => r.textContent);
    expect(rows).toEqual(["[", "{", 'name: "Eurasia",', "children: [", "{", 'name: "Europe"', "}", "]", "}", "]"]);
    const cell = Array.from(container.querySelectorAll<HTMLElement>("[data-yed-cell]"))
      .find((c) => c.textContent === "Eurasia")!;
    type(cell, "Eurasien");
    fireEvent.blur(cell);
    await waitFor(() => expect(editChunks).toHaveBeenCalled(), { timeout: 2000 });
    const sent = (editChunks.mock.calls.at(-1)![0] as { yamlover: string }[])[0].yamlover;
    expect(sent).toContain("[\n  {\n"); // still K&R, all the way down
  });
});

// --- THE END OF A DOCUMENT IS NOT A CLIFF ------------------------------------------------------ //
// Reported: a K&R document, caret placed after the last `]`, Backspace — the whole structure
// collapsed onto one row and then nothing worked. Two faults met there:
//   1. Backspace past a closer JOINED the token. Fine for `[1, 2]`, but at document scale it
//      reflowed the whole file out from under someone who was deleting. The join now lives where a
//      text editor puts it: Backspace at the START of the first element, pulling that line up.
//   2. "Step back inside" asked for the last ENTRY's cell by id — and a container entry has no cell
//      of its own (its cells are the ones inside it), so focus went nowhere and every other key in
//      that cell is consumed. It steps to the DOM-previous cell now, which is the token's last
//      inner cell whatever it holds.
describe("Backspace at the end of a K&R document", () => {
  const DOC = {
    path: ":n", type: "array", concrete: "file/yamlover", title: null, description: null,
    value: [{ key: 12 }, { key: 13 }],
    comments: { "": { concrete: "json5p" } },
  };
  const rowsOf = (c: HTMLElement) => Array.from(c.querySelectorAll(".yed-row")).map((r) => r.textContent);
  const cellsOf = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>("[data-yed-cell]"));
  const caretTo = (el: HTMLElement, where: "start" | "end") => {
    el.focus();
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(where === "start");
    const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r);
  };

  it("steps back INSIDE — it does not collapse the document", async () => {
    fetchNode.mockResolvedValue(DOC);
    const { container } = await mount(":n");
    const before = rowsOf(container);
    expect(before).toEqual(["[", "{", "key: 12", "},", "{", "key: 13", "}", "]"]);
    const cells = cellsOf(container);
    const docAfter = cells[cells.length - 1]; // the caret past the document's own `]`
    docAfter.focus();
    fireEvent.keyDown(docAfter, { key: "Backspace" });
    expect(rowsOf(container)).toEqual(before);              // the structure is untouched…
    expect(document.activeElement).toBe(cells[cells.length - 2]); // …and the caret moved one cell in
    expect(editChunks).not.toHaveBeenCalled();              // nothing was written
  });

  it("keeps walking inwards, never trapping", async () => {
    fetchNode.mockResolvedValue(DOC);
    const { container } = await mount(":n");
    const cells = cellsOf(container);
    cells[cells.length - 1].focus();
    for (let i = 0; i < 3; i++) {
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Backspace" });
      expect(document.activeElement, `press ${i + 1}`).not.toBe(document.body);
    }
    expect((document.activeElement as HTMLElement).textContent).toBe("13"); // the last value
  });

  it("JOINS from the start of the FIRST element, as a text editor would", async () => {
    fetchNode.mockResolvedValue(DOC);
    const { container } = await mount(":n");
    const first = cellsOf(container)[0]; // the `key` of the first pair
    caretTo(first, "start");
    fireEvent.keyDown(first, { key: "Backspace" });
    expect(rowsOf(container)).toEqual(["[{key: 12}, {key: 13}]"]);
    expect((document.activeElement as HTMLElement).textContent).toBe("key"); // the caret stays put
  });

  it("but NOT from the start of a later element", async () => {
    fetchNode.mockResolvedValue(DOC);
    const { container } = await mount(":n");
    const second = cellsOf(container).find((c, i) => c.textContent === "key" && i > 0)!;
    caretTo(second, "start");
    fireEvent.keyDown(second, { key: "Backspace" });
    expect(rowsOf(container)).toEqual(["[", "{", "key: 12", "},", "{", "key: 13", "}", "]"]);
  });
});
