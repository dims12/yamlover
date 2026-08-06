// @vitest-environment jsdom
// The YED reference cells - references in the SERVER mount ride the PURE editor's PORTION
// cells (yed cells.tsx / grammar/portions.ts); the server adds COMPLETION over them
// (yed-cells.tsx treeHints): typing `*` in a hole opens the portion face, each cell asks the
// wire for the context's real children (`?` at the holder, the scope ladder spelled into the
// context query), and the grammar's Enter commits the joined reference - parses-or-refuses,
// hints never validate. The op goes out through the same diff flush as any edit.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, waitFor, fireEvent, act } from "@testing-library/react";

const { editChunks, fetchNode, fetchContent, rekeyNode, queryTree, queryFilter } = vi.hoisted(() => ({
  editChunks: vi.fn(),
  fetchNode: vi.fn(),
  fetchContent: vi.fn(),
  rekeyNode: vi.fn(),
  queryTree: vi.fn(),
  queryFilter: vi.fn(),
}));
vi.mock("../../src/client/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), editChunks, fetchNode, rekeyNode, queryTree, queryFilter }));
vi.mock("../../src/client/content", async (orig) => ({ ...(await orig<Record<string, unknown>>()), fetchContent }));

import { YedEditor } from "../../src/client/renderers/yed-editor";
import { TocFilterCtx, useTocFilterSession, type TocFilterSession } from "../../src/client/toc-filter-session";
import { contentViaNode } from "./wire-fixture";

const PETS = {
  path: ":doc", type: "object", concrete: "file/yamlover", title: null, description: null,
  value: { pets: [{ name: "Rex" }, { name: "Whiskers" }] },
};
const TREE = (path: string, label: string) => ({ path, label, type: "object", format: null, concrete: null, hasChildren: false, children: [] });
const FILTER = (matches: string[]) => ({ root: TREE(":", "r"), matches, truncated: false });

beforeEach(() => {
  editChunks.mockReset().mockResolvedValue({ ok: true });
  fetchNode.mockReset().mockResolvedValue(PETS);
  fetchContent.mockReset().mockImplementation(contentViaNode(fetchNode)); // the mount's wire follows fetchNode
  queryTree.mockReset().mockResolvedValue([]);
  queryFilter.mockReset().mockRejectedValue(new Error("no filter mock"));
});
afterEach(cleanup);

async function mount(path = ":doc") {
  const utils = render(<YedEditor path={path} onNavigate={() => {}} />);
  await waitFor(() => expect(utils.container.querySelector("[data-testid=y2-doc]")).toBeTruthy());
  return utils;
}

/** The fresh mount's entry hole input (the initial cursor) - type `*` here to start a reference. */
const holeInput = (container: HTMLElement): HTMLInputElement =>
  container.querySelector<HTMLInputElement>(".y2-hole .y2-input")!;

/** The ACTIVE portion cell's input (the reference being entered). */
const portionInput = (container: HTMLElement): HTMLInputElement =>
  container.querySelector<HTMLInputElement>(".y2-portions .y2-input")!;

/** Type text into the active portion input through the REAL plumbing: keydown first (the
 *  grammar may claim the key - `:` splits, `[` folds); a printable it left alone lands via
 *  onChange, caret at the end. */
function type(container: HTMLElement, text: string): void {
  for (const ch of text) {
    const input = portionInput(container);
    const before = input.value;
    input.setSelectionRange(before.length, before.length);
    const defaulted = fireEvent.keyDown(input, { key: ch });
    if (defaulted) fireEvent.change(input, { target: { value: before + ch } });
  }
}

/** Start a reference: `*` typed into the fresh hole opens the PORTION face - and the active
 *  cell CLAIMS the caret (the hole input just unmounted; focus falling to <body> was the
 *  reported defect). */
async function star(container: HTMLElement): Promise<HTMLInputElement> {
  fireEvent.change(holeInput(container), { target: { value: "*" } });
  await waitFor(() => expect(portionInput(container)).toBeTruthy());
  await waitFor(() => expect(document.activeElement?.classList.contains("y2-input"),
    `the portion cell did not take the caret - activeElement is ${document.activeElement?.tagName}.${document.activeElement?.className}`).toBe(true));
  return portionInput(container);
}

describe("yed pointer cells - the PORTION face with tree-backed completion", () => {
  it("a bare `*`: hints are the HOLDER's children (`?` at the holder); the dropdown shows them", async () => {
    queryTree.mockResolvedValue([TREE(":doc:pets", "pets")]);
    const { container } = await mount(":doc");
    await star(container);
    await waitFor(() => expect(queryTree).toHaveBeenCalledWith("?", ":doc")); // bare scope, at = the holder
    await waitFor(() => expect(document.querySelector(".y2-hints .y2-hint-insert")?.textContent).toBe("pets"));
  });

  it("`:` in the empty first cell CLIMBS the scope ladder (the chip shows it); Backspace steps down", async () => {
    const { container } = await mount(":doc");
    const cell = await star(container);
    fireEvent.keyDown(cell, { key: ":" });
    expect(container.querySelector(".y2-scope")?.textContent).toBe(":");
    fireEvent.keyDown(portionInput(container), { key: ":" });
    expect(container.querySelector(".y2-scope")?.textContent).toBe("::");
    await waitFor(() => expect(queryTree).toHaveBeenCalledWith(":: ?", ":doc"));
    fireEvent.keyDown(portionInput(container), { key: "Backspace" });
    expect(container.querySelector(".y2-scope")?.textContent).toBe(":");
  });

  it("Enter COMMITS the joined portions: a keyless insert, then the sibling hole", async () => {
    const { container } = await mount(":doc");
    await star(container);
    type(container, "pets:1"); // `:` splits the portion - the key-value gesture, repeated
    fireEvent.keyDown(portionInput(container), { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([
      { path: ":doc:0", op: "insert", yamlover: "*pets:1" }, // the fresh hole sits at index 0; the wire spells compact
    ]), { timeout: 2000 });
    // THE SIBLING RULE: the commit opened the next hole
    await waitFor(() => expect(container.querySelector(".y2-hole .y2-input")).toBeTruthy());
  });

  it("free text with NO tree answer still commits verbatim (dangling allowed - hints are never validators)", async () => {
    queryTree.mockRejectedValue(new Error("wire down"));
    const { container } = await mount(":doc");
    const cell = await star(container);
    fireEvent.keyDown(cell, { key: ":" }); // -> document scope `*:`
    type(container, "nowhere:7");
    fireEvent.keyDown(portionInput(container), { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([
      { path: ":doc:0", op: "insert", yamlover: "*:nowhere:7" },
    ]), { timeout: 2000 });
  });

  it("UNPARSABLE text keeps the typed text on screen with the ring (no silent revert, no op)", async () => {
    const { container } = await mount(":doc");
    await star(container);
    type(container, "a[x"); // a malformed index - not a pointer the wire can carry
    fireEvent.keyDown(portionInput(container), { key: "Enter" });
    await waitFor(() => expect(container.querySelector(".y2-refused")).toBeTruthy(), { timeout: 2000 });
    expect(portionInput(container).value).toContain("a[x"); // the text stands
    await new Promise((r) => setTimeout(r, 700)); // across the flush debounce
    expect(editChunks).not.toHaveBeenCalled();
  });

  it("a dropdown pick REPLACES the active cell's text; the grammar's Enter commits", async () => {
    queryTree.mockResolvedValue([TREE(":doc:pets", "pets")]);
    const { container } = await mount(":doc");
    await star(container);
    await waitFor(() => expect(document.querySelector(".y2-hints .y2-hint")).toBeTruthy());
    await act(async () => { fireEvent.mouseDown(document.querySelector(".y2-hints .y2-hint")!); });
    expect(portionInput(container).value).toBe("pets"); // picked, NOT committed
    await new Promise((r) => setTimeout(r, 700));
    expect(editChunks).not.toHaveBeenCalled(); // nothing landed yet
    fireEvent.keyDown(portionInput(container), { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([
      { path: ":doc:0", op: "insert", yamlover: "*pets" },
    ]), { timeout: 2000 });
  });

  it("a TOC pick lands the picked path IN THE CELLS (bare scope); Enter commits; the session claims/releases", async () => {
    queryFilter.mockResolvedValue(FILTER([":doc:pets:0:name"]));
    let session!: TocFilterSession;
    function Host() {
      session = useTocFilterSession();
      return (
        <TocFilterCtx.Provider value={session}>
          <YedEditor path=":doc" onNavigate={() => {}} />
        </TocFilterCtx.Provider>
      );
    }
    const { container } = render(<Host />);
    await waitFor(() => expect(container.querySelector("[data-testid=y2-doc]")).toBeTruthy());
    await star(container);
    await waitFor(() => expect(session.active).toBe(true)); // editing a reference claims the TOC filter
    act(() => session.pick(":doc:pets:0:name")); // a TOC row click routes here
    // spelled relative to the holder; a position is its own cell - the committed cells idle,
    // the LAST one is the active input (the pick inserted, the caret stands ready)
    const idleCells = () => Array.from(container.querySelectorAll<HTMLElement>(".y2-portions .y2-portion")).map((c) => c.textContent);
    await waitFor(() => expect(idleCells()).toEqual(["pets", "0"]));
    expect(portionInput(container).value).toBe("name");
    await new Promise((r) => setTimeout(r, 700)); // across the flush debounce
    expect(editChunks).not.toHaveBeenCalled(); // the pick INSERTED, not committed
    fireEvent.keyDown(portionInput(container), { key: "Enter" }); // the grammar's Enter commits
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([
      { path: ":doc:0", op: "insert", yamlover: "*pets:0:name" },
    ]), { timeout: 2000 });
    await waitFor(() => expect(session.active).toBe(false)); // the commit released the TOC filter
  });

  it("typing FEEDS the TOC filter session - the pruned tree arrives on the handle (at the holder)", async () => {
    queryFilter.mockResolvedValue({ root: TREE(":doc:pets", "pets"), matches: [":doc:pets"], truncated: false });
    let session!: TocFilterSession;
    function Host() {
      session = useTocFilterSession();
      return (
        <TocFilterCtx.Provider value={session}>
          <YedEditor path=":doc" onNavigate={() => {}} />
        </TocFilterCtx.Provider>
      );
    }
    const { container } = render(<Host />);
    await waitFor(() => expect(container.querySelector("[data-testid=y2-doc]")).toBeTruthy());
    await star(container);
    await waitFor(() => expect(session.active).toBe(true));
    expect(session.filter).toBeNull(); // nothing typed yet - the normal TOC stands
    type(container, "pe");
    await waitFor(() => expect(queryFilter).toHaveBeenCalledWith("pe", ":doc")); // evaluated AT the holder
    await waitFor(() => expect(session.filter?.root.label).toBe("pets"));
  });

  it("RETARGET of a committed SPACED-canonical pointer: an unchanged Enter emits NO op", async () => {
    fetchNode.mockResolvedValue({
      path: ":d", type: "array", concrete: "file/yamlover", title: null, description: null,
      value: [{ $yamloverRef: { text: "*: pets: 1", path: null } }],
      comments: { "[0]": { pointer: ": pets[1]" } },
    });
    const { container } = await mount(":d");
    // the idle face is the pure atom - walk onto it and Enter opens the PORTION face (the
    // focus re-renders the tree, so the keydown goes to the FRESH element)
    fireEvent.focus(container.querySelector<HTMLElement>(".y2-p")!);
    await waitFor(() => expect(container.querySelector(".y2-active .y2-p, .y2-cell.y2-active")).toBeTruthy());
    fireEvent.keyDown(container.querySelector<HTMLElement>(".y2-p")!, { key: "Enter" });
    await waitFor(() => expect(portionInput(container)).toBeTruthy());
    fireEvent.keyDown(portionInput(container), { key: "Enter" }); // unchanged - the same target respelled
    // the commit walked on (the sibling hole opened) without re-emitting the pointer
    await waitFor(() => expect(container.querySelector(".y2-hole .y2-input")).toBeTruthy(), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 700)); // across the flush debounce
    expect(editChunks).not.toHaveBeenCalled();
  });

  it("a $yamloverLink member draws the DESCEND hyperlink over a walkable atom", async () => {
    const navigate = vi.fn();
    fetchNode.mockResolvedValue({
      path: ":d", type: "object", concrete: "dir/.yo", title: null, description: null,
      value: { pic: { $yamloverLink: { path: ":d:pic", title: "the picture", format: "image/png" } } },
    });
    const utils = render(<YedEditor path=":d" onNavigate={navigate} />);
    await waitFor(() => expect(utils.container.querySelector("[data-testid=y2-doc]")).toBeTruthy());
    const link = utils.container.querySelector<HTMLAnchorElement>("a.descend")!;
    expect(link.textContent).toBe("the picture");
    fireEvent.click(link);
    expect(navigate).toHaveBeenCalledWith(":d:pic");
    // the atom stays walkable - its focus home is the .y2-p span, and no ops were emitted
    const span = link.closest(".y2-p") as HTMLElement;
    fireEvent.focus(span);
    await new Promise((r) => setTimeout(r, 700));
    expect(editChunks).not.toHaveBeenCalled();
  });
});
