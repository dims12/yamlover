// @vitest-environment jsdom
// The YED reference cells (yed-cells.tsx) — the legacy PICK suite ported onto the yed mount:
// typing `*` in a hole mounts the SHARED query-cell kit (candidates at the HOLDER, the scope
// ladder, TOC insertion), Enter reduces to a pointer and the op goes out COMPACT; refusals
// ring and keep the text. The root-of-mounted-node emplace of the legacy suite is NOT ported
// (yed's document model deliberately drops it — a bare pointer is a keyless member instead).
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, waitFor, fireEvent, act } from "@testing-library/react";
import { TocFilterCtx, useTocFilterSession } from "../../src/client/toc-filter-session";

const { editChunks, fetchNode, rekeyNode, queryTree, queryFilter } = vi.hoisted(() => ({
  editChunks: vi.fn(),
  fetchNode: vi.fn(),
  rekeyNode: vi.fn(),
  queryTree: vi.fn(),
  queryFilter: vi.fn(),
}));
vi.mock("../../src/client/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), editChunks, fetchNode, rekeyNode, queryTree, queryFilter }));

import { YedEditor } from "../../src/client/renderers/yed-editor";

const PETS = {
  path: ":doc", type: "object", concrete: "file/yamlover", title: null, description: null,
  value: { pets: [{ name: "Rex" }, { name: "Whiskers" }] },
};
const TREE = (path: string, label: string) => ({ path, label, type: "object", format: null, concrete: null, hasChildren: false, children: [] });
const FILTER = (matches: string[]) => ({ root: TREE(":", "r"), matches, truncated: false });

beforeEach(() => {
  editChunks.mockReset().mockResolvedValue({ ok: true });
  fetchNode.mockReset().mockResolvedValue(PETS);
  queryTree.mockReset().mockResolvedValue([]);
  queryFilter.mockReset().mockRejectedValue(new Error("no filter mock")); // pick Enter falls back to verbatim
});
afterEach(cleanup);

async function mount(path = ":doc") {
  const utils = render(<YedEditor path={path} onNavigate={() => {}} />);
  await waitFor(() => expect(utils.container.querySelector("[data-testid=y2-doc]")).toBeTruthy());
  return utils;
}

/** The fresh mount's entry hole input (the initial cursor) — type `*` here to start a reference. */
const holeInput = (container: HTMLElement): HTMLInputElement =>
  container.querySelector<HTMLInputElement>(".y2-hole .y2-input")!;

/** Type into a contentEditable KIT cell (the classifier reads the full text). */
function type(el: Element, text: string) {
  (el as HTMLElement).textContent = text;
  fireEvent.input(el);
}

const pointerCell = (container: HTMLElement): HTMLElement =>
  container.querySelector<HTMLElement>(".y2-ptrwrap .crumb-cell")!;

/** Put the collapsed caret at `offset` inside a cell (jsdom Range). */
function setCaret(el: HTMLElement, offset: number) {
  const sel = window.getSelection()!;
  const r = document.createRange();
  const t = el.firstChild ?? el;
  r.setStart(t, offset);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

/** Start a reference: `*` typed into the fresh hole mounts the kit. */
async function star(container: HTMLElement): Promise<HTMLElement> {
  fireEvent.change(holeInput(container), { target: { value: "*" } });
  await waitFor(() => expect(pointerCell(container)).toBeTruthy());
  return pointerCell(container);
}

describe("yed pointer cells — the SHARED query kit (pick mode)", () => {
  it("a bare `*`: candidates are the HOLDER's children (`?` at the holder); the dropdown shows TOC rows", async () => {
    queryTree.mockResolvedValue([TREE(":doc:pets", "pets")]);
    const { container } = await mount(":doc");
    await star(container);
    await waitFor(() => expect(queryTree).toHaveBeenCalledWith("?", ":doc")); // bare scope, at = the holder
    await waitFor(() => expect(document.querySelector(".crumb-dd .tree-label")?.textContent).toBe("pets"));
  });

  it("`:` in the empty first cell CLIMBS the scope ladder (the chip shows it); Backspace steps down", async () => {
    const { container } = await mount(":doc");
    const cell = await star(container);
    fireEvent.keyDown(cell, { key: ":" });
    expect(container.querySelector(".y2-scope")?.textContent).toBe(":");
    fireEvent.keyDown(cell, { key: ":" });
    expect(container.querySelector(".y2-scope")?.textContent).toBe("::");
    await waitFor(() => expect(queryTree).toHaveBeenCalledWith(":: ?", ":doc"));
    setCaret(cell, 0);
    fireEvent.keyDown(cell, { key: "Backspace" });
    expect(container.querySelector(".y2-scope")?.textContent).toBe(":");
  });

  it("Enter REDUCES the typed query to the first match: a keyless COMPACT insert, then the sibling hole", async () => {
    queryFilter.mockResolvedValue(FILTER([":doc:pets:1"]));
    const { container } = await mount(":doc");
    const cell = await star(container);
    type(cell, "pets[1]"); // bare scope — relative to the holder :doc
    fireEvent.keyDown(cell, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([
      { path: ":doc:0", op: "insert", yamlover: "*pets:1" }, // the fresh hole sits at index 0
    ]), { timeout: 2000 });
    // THE SIBLING RULE: the commit opened the next hole
    await waitFor(() => expect(container.querySelector(".y2-hole .y2-input")).toBeTruthy());
  });

  it("free text with NO match still commits verbatim (dangling allowed — hints are never validators)", async () => {
    queryFilter.mockResolvedValue(FILTER([]));
    const { container } = await mount(":doc");
    const cell = await star(container);
    fireEvent.keyDown(cell, { key: ":" }); // → document scope `*:`
    type(cell, "nowhere[7]");
    fireEvent.keyDown(cell, { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([
      { path: ":doc:0", op: "insert", yamlover: "*:nowhere:7" },
    ]), { timeout: 2000 });
  });

  it("UNPARSABLE free text keeps the typed text on screen with the ring (no silent revert, no op)", async () => {
    queryFilter.mockRejectedValue(new Error("400"));
    const { container } = await mount(":doc");
    const cell = await star(container);
    type(cell, "a[x]"); // malformed index — not a pointer the wire can carry
    fireEvent.keyDown(cell, { key: "Enter" });
    await waitFor(() => expect(container.querySelector(".y2-refused")).toBeTruthy(), { timeout: 2000 });
    expect(container.querySelector(".y2-ptrwrap")!.textContent).toContain("a[x]"); // the text stands
    expect(editChunks).not.toHaveBeenCalled();
  });

  it("a TOC pick lands the picked path IN THE CELLS (bare scope); Enter commits; the session claims/releases", async () => {
    queryFilter.mockResolvedValue(FILTER([":doc:pets:0:name"]));
    let session!: import("../../src/client/toc-filter-session").TocFilterSession;
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
    const cells = () => Array.from(container.querySelectorAll<HTMLElement>(".y2-ptrwrap .crumb-cell")).map((c) => c.textContent);
    await waitFor(() => expect(cells()).toEqual(["pets", "0", "name"])); // spelled relative; a position is its own cell
    // the pick INSERTED, not committed — Enter commits the reduced pointer
    fireEvent.keyDown(pointerCell(container), { key: "Enter" });
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([
      { path: ":doc:0", op: "insert", yamlover: "*pets:0:name" },
    ]), { timeout: 2000 });
    await waitFor(() => expect(session.active).toBe(false)); // the commit released the TOC filter
  });

  it("RETARGET of a committed SPACED-canonical pointer: an unchanged Enter emits NO op", async () => {
    fetchNode.mockResolvedValue({
      path: ":d", type: "array", concrete: "file/yamlover", title: null, description: null,
      value: [{ $yamloverRef: { text: "*: pets: 1", path: null } }],
      comments: { "[0]": { pointer: ": pets[1]" } },
    });
    queryFilter.mockRejectedValue(new Error("no filter")); // the dangling reduce hands the query back
    const { container } = await mount(":d");
    // the idle face is the pure atom — walk onto it and Enter opens the kit (the focus
    // re-renders the tree, so the keydown goes to the FRESH element)
    fireEvent.focus(container.querySelector<HTMLElement>(".y2-p")!);
    await waitFor(() => expect(container.querySelector(".y2-active .y2-p, .y2-cell.y2-active")).toBeTruthy());
    fireEvent.keyDown(container.querySelector<HTMLElement>(".y2-p")!, { key: "Enter" });
    await waitFor(() => expect(pointerCell(container)).toBeTruthy());
    fireEvent.keyDown(pointerCell(container), { key: "Enter" }); // unchanged — the same target respelled
    // the commit walked on (the sibling hole opened) without re-emitting the pointer
    await waitFor(() => expect(container.querySelector(".y2-hole .y2-input")).toBeTruthy(), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 700)); // across the flush debounce
    expect(editChunks).not.toHaveBeenCalled();
  });

  it("a $yamloverLink member draws the DESCEND hyperlink over a walkable atom", async () => {
    const navigate = vi.fn();
    fetchNode.mockResolvedValue({
      path: ":d", type: "object", concrete: "dir/yamlover", title: null, description: null,
      value: { pic: { $yamloverLink: { path: ":d:pic", title: "the picture", format: "image/png" } } },
    });
    const utils = render(<YedEditor path=":d" onNavigate={navigate} />);
    await waitFor(() => expect(utils.container.querySelector("[data-testid=y2-doc]")).toBeTruthy());
    const link = utils.container.querySelector<HTMLAnchorElement>("a.descend")!;
    expect(link.textContent).toBe("the picture");
    fireEvent.click(link);
    expect(navigate).toHaveBeenCalledWith(":d:pic");
    // the atom stays walkable — its focus home is the .y2-p span, and no ops were emitted
    const span = link.closest(".y2-p") as HTMLElement;
    fireEvent.focus(span);
    await new Promise((r) => setTimeout(r, 700));
    expect(editChunks).not.toHaveBeenCalled();
  });
});
