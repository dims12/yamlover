// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

vi.mock("../../src/client/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/client/api")>();
  return { ...mod, fetchBoard: vi.fn(), boardReconcile: vi.fn(), boardMove: vi.fn(), saveBoardStructure: vi.fn() };
});
// The picker host contract: board.tsx must exempt the portaled `.crumb-dd` dropdown (and the TOC
// pane) from its outside-click close — the c7876ba regression — and file picks into the recents.
vi.mock("../../src/client/renderers/annotate", () => ({
  AnnotationMenu: (props: { onPick: (t: { path: string; name: string }) => void }) => (
    <div data-testid="picker">
      <button onClick={() => props.onPick({ path: ":ontos:new", name: "new" })}>pick-new</button>
    </div>
  ),
  rememberTag: vi.fn(),
  withinTocPane: (t: EventTarget | null) => !!(t as Element)?.closest?.(".pane.left"),
  withinQueryDropdown: (t: EventTarget | null) => !!(t as Element)?.closest?.(".crumb-dd"),
}));
import { boardMove, boardReconcile, fetchBoard, saveBoardStructure, type BoardCard, type BoardResolved, type NodeJson } from "../../src/client/api";
import { rememberTag } from "../../src/client/renderers/annotate";
import { BoardView } from "../../src/client/renderers/board";

const mReconcile = boardReconcile as unknown as ReturnType<typeof vi.fn>;
const mFetch = fetchBoard as unknown as ReturnType<typeof vi.fn>;
const mMove = boardMove as unknown as ReturnType<typeof vi.fn>;
const mSave = saveBoardStructure as unknown as ReturnType<typeof vi.fn>;
const mRemember = rememberTag as unknown as ReturnType<typeof vi.fn>;

const READY = { path: ":ontos:ready", name: "ready", color: null };
const DONE = { path: ":ontos:done", name: "done", color: null };
const card = (path: string, title: string, tags: string[]): BoardCard => ({ path, title, priority: null, assignee: null, due: null, tags });
const resolved: BoardResolved = {
  seeded: false,
  lanes: [
    [{ tags: [READY], items: [card(":board:t1.yo", "Task One", [":ontos:ready"])] }],
    [{ tags: [DONE], items: [] }],
  ],
  backlog: [card(":board:t2.yo", "Orphan Two", [])],
};

const boardNode: NodeJson = {
  path: ":board", type: "object", format: "x-yamlover-board", concrete: "dir/.yo", title: null, description: null, value: {},
};

beforeEach(() => {
  mReconcile.mockReset().mockResolvedValue(resolved);
  mFetch.mockReset().mockResolvedValue(resolved);
  mMove.mockReset().mockResolvedValue(resolved);
  mSave.mockReset().mockResolvedValue(resolved);
  mRemember.mockReset();
});
afterEach(cleanup);

async function renderBoard() {
  render(<BoardView node={boardNode} onNavigate={() => {}} />);
  await screen.findByText("Task One");
}

describe("BoardView (lanes of compartments + backlog)", () => {
  it("opens through the silent reconcile and renders compartments, tags, and the backlog", async () => {
    await renderBoard();
    expect(mReconcile).toHaveBeenCalledWith(":board");
    expect(document.querySelectorAll(".board-comp").length).toBe(2);
    expect(screen.getByText("ready")).toBeTruthy();
    expect(screen.getByText("done")).toBeTruthy();
    const backlog = document.querySelector(".board-backlog")!;
    expect(backlog.textContent).toContain("backlog");
    expect(backlog.textContent).toContain("Orphan Two");
  });

  it("dropping a card on another compartment confirms with the tag deltas, then moves", async () => {
    await renderBoard();
    const cardEl = screen.getByText("Task One").closest(".board-card") as HTMLElement;
    const comps = document.querySelectorAll(".board-comp");
    fireEvent.dragStart(cardEl);
    fireEvent.dragOver(comps[1]);
    fireEvent.drop(comps[1]);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain('Move "Task One" to "done" (+done, −ready)');
    expect(mMove).not.toHaveBeenCalled(); // nothing moved yet

    fireEvent.click(screen.getByRole("button", { name: "Move task" }));
    await vi.waitFor(() => expect(mMove).toHaveBeenCalledWith(":board", ":board:t1.yo", { lane: 0, comp: 0 }, { lane: 1, comp: 0 }));
  });

  it("cancelling the confirm moves nothing", async () => {
    await renderBoard();
    const cardEl = screen.getByText("Task One").closest(".board-card") as HTMLElement;
    fireEvent.dragStart(cardEl);
    fireEvent.drop(document.querySelectorAll(".board-comp")[1]);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mMove).not.toHaveBeenCalled();
  });

  it("dropping back on the same compartment is refused silently — no popup at all", async () => {
    await renderBoard();
    const cardEl = screen.getByText("Task One").closest(".board-card") as HTMLElement;
    fireEvent.dragStart(cardEl);
    fireEvent.drop(document.querySelectorAll(".board-comp")[0]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mMove).not.toHaveBeenCalled();
  });

  it("drags to and from the backlog (null coordinates, delta-only descriptions)", async () => {
    await renderBoard();
    // compartment → backlog: only the shared tag is removed
    const cardEl = screen.getByText("Task One").closest(".board-card") as HTMLElement;
    fireEvent.dragStart(cardEl);
    fireEvent.drop(document.querySelector(".board-backlog")!);
    let dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain('Move "Task One" to the backlog (−ready)');
    fireEvent.click(screen.getByRole("button", { name: "Move task" }));
    await vi.waitFor(() => expect(mMove).toHaveBeenCalledWith(":board", ":board:t1.yo", { lane: 0, comp: 0 }, null));

    // backlog → compartment: the destination's tags land
    mMove.mockClear();
    const orphan = screen.getByText("Orphan Two").closest(".board-card") as HTMLElement;
    fireEvent.dragStart(orphan);
    fireEvent.drop(document.querySelectorAll(".board-comp")[0]);
    dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain('Move "Orphan Two" to "ready" (+ready)');
    fireEvent.click(screen.getByRole("button", { name: "Move task" }));
    await vi.waitFor(() => expect(mMove).toHaveBeenCalledWith(":board", ":board:t2.yo", null, { lane: 0, comp: 0 }));
  });

  it("the per-column ＋ lane ghost (below the box) appends a manual compartment to the lane", async () => {
    await renderBoard();
    const adder = document.querySelectorAll(".board-add-comp")[0];
    expect(adder.textContent).toBe("＋ lane"); // a compartment is a stacked sub-lane — same name
    fireEvent.click(adder);
    await vi.waitFor(() =>
      expect(mSave).toHaveBeenCalledWith(":board", [
        [{ tags: [":ontos:ready"], items: [{ path: ":board:t1.yo" }] }, { tags: [], items: [] }],
        [{ tags: [":ontos:done"], items: [] }],
      ]),
    );
  });

  it("the trailing ＋ lane ghost appends a single-compartment lane", async () => {
    await renderBoard();
    fireEvent.click(document.querySelector(".board-add-lane")!);
    await vi.waitFor(() => expect(mSave).toHaveBeenCalled());
    expect(mSave.mock.calls[0][1]).toHaveLength(3);
    expect(mSave.mock.calls[0][1][2]).toEqual([{ tags: [], items: [] }]);
  });

  it("dragging the pane's ground pans the lane row; a card drag never does", async () => {
    await renderBoard();
    const lanes = document.querySelector(".board-lanes") as HTMLElement;
    lanes.scrollLeft = 0;
    fireEvent.mouseDown(lanes, { button: 0, clientX: 300 });
    expect(lanes.className).toContain("board-panning");
    fireEvent.mouseMove(window, { clientX: 180 });
    expect(lanes.scrollLeft).toBe(120); // dragged left → the pane scrolls right
    fireEvent.mouseUp(window);
    expect(lanes.className).not.toContain("board-panning");

    // grabbing a CARD starts the card's own drag, never a pan
    const card = screen.getByText("Task One").closest(".board-card") as HTMLElement;
    fireEvent.mouseDown(card, { button: 0, clientX: 300 });
    expect(lanes.className).not.toContain("board-panning");
  });

  it("the picker survives a mousedown in the portaled dropdown (the c7876ba regression) and files picks", async () => {
    await renderBoard();
    fireEvent.click(document.querySelectorAll(".board-lane-add")[0]); // the compartment's ＋
    expect(screen.getByTestId("picker")).toBeTruthy();

    // a candidate row in the PORTALED dropdown (document.body, outside the picker) — never a close
    const dd = document.createElement("div");
    dd.className = "crumb-dd";
    document.body.appendChild(dd);
    fireEvent.mouseDown(dd);
    expect(screen.queryByTestId("picker")).toBeTruthy();
    dd.remove();

    // picking lands the tag as a structure write and files it among the recents
    fireEvent.click(screen.getByText("pick-new"));
    expect(mRemember).toHaveBeenCalledWith({ path: ":ontos:new", name: "new" });
    await vi.waitFor(() =>
      expect(mSave).toHaveBeenCalledWith(":board", [
        [{ tags: [":ontos:ready", ":ontos:new"], items: [{ path: ":board:t1.yo" }] }],
        [{ tags: [":ontos:done"], items: [] }],
      ]),
    );
    expect(screen.queryByTestId("picker")).toBeNull();

    // a genuinely-outside mousedown still closes
    fireEvent.click(document.querySelectorAll(".board-lane-add")[0]);
    expect(screen.getByTestId("picker")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId("picker")).toBeNull();
  });

  it("removing a compartment tag persists the shrunken tag list (reconcile is the server's)", async () => {
    await renderBoard();
    fireEvent.click(screen.getByText("ready").closest("button")!);
    await vi.waitFor(() =>
      expect(mSave).toHaveBeenCalledWith(":board", [
        [{ tags: [], items: [{ path: ":board:t1.yo" }] }],
        [{ tags: [":ontos:done"], items: [] }],
      ]),
    );
  });
});
