// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

vi.mock("../../src/client/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/client/api")>();
  return { ...mod, fetchNode: vi.fn(), annotate: vi.fn(), deleteAnnotation: vi.fn(), saveBoardLanes: vi.fn() };
});
import { annotate, deleteAnnotation, fetchNode, type NodeJson } from "../../src/client/api";
import { BoardView, cardMemberPaths } from "../../src/client/renderers/board";

const mFetchNode = fetchNode as unknown as ReturnType<typeof vi.fn>;
const mAnnotate = annotate as unknown as ReturnType<typeof vi.fn>;
const mDelete = deleteAnnotation as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mFetchNode.mockReset();
  mAnnotate.mockReset().mockResolvedValue({ ok: true });
  mDelete.mockReset().mockResolvedValue({ ok: true });
});
afterEach(cleanup);

const link = (info: Record<string, unknown>) => ({ $yamloverLink: info });

const node = (value: Record<string, unknown>): NodeJson => ({
  path: ":board",
  type: "object",
  format: "x-yamlover-board",
  concrete: "dir/yamlover",
  title: null,
  description: null,
  value,
});

describe("cardMemberPaths (board cards from the shared projection)", () => {
  it("includes ordinary card members and excludes the board's config keys + nested tag/workflow/board links", () => {
    const n = node({
      // config / taxonomy / graft keys — never cards
      workflow: link({ kind: "object", type: "object", format: "x-yamlover-workflow", path: ":board:workflow" }),
      lanes: link({ kind: "array", type: "array", path: ":board:lanes", count: 2 }),
      yamlover: link({ kind: "object", type: "object", path: ":board:yamlover" }),
      tags: link({ kind: "object", type: "object", path: ":board:tags" }),
      // a nested tag link is container-tagish → excluded even though its key is not a config key
      "a-tag": link({ kind: "object", type: "object", format: "x-yamlover-tag", path: ":board:a-tag" }),
      // genuine content cards
      "task-1.yo": link({ kind: "object", type: "object", format: "x-yamlover-task", path: ":board:task-1.yo", count: 4 }),
      "note.md": link({ kind: "scalar", type: "string", path: ":board:note.md", format: "text/markdown" }),
    });
    expect(cardMemberPaths(n)).toEqual([":board:task-1.yo", ":board:note.md"]);
  });

  it("drops inert (non-link) members", () => {
    const n = node({ stray: "not a link", "task.yo": link({ kind: "object", type: "object", path: ":board:task.yo" }) });
    expect(cardMemberPaths(n)).toEqual([":board:task.yo"]);
  });
});

describe("BoardView card drag (unified confirm popup)", () => {
  // an explicit two-lane board (todo | doing) with one card, tagged todo
  const boardNode = node({
    lanes: link({ kind: "array", type: "array", path: ":board:lanes", count: 2 }),
    "t1.yo": link({ kind: "object", type: "object", format: "x-yamlover-task", path: ":board:t1.yo", count: 2 }),
  });
  const tagLink = (p: string) => link({ kind: "object", type: "object", format: "x-yamlover-tag", path: p });

  function mockBoardFetches() {
    mFetchNode.mockImplementation((p: string) => {
      switch (p) {
        case ":board": // the depth-3 lanes fetch
          return Promise.resolve({ ...boardNode, value: { ...(boardNode.value as object), lanes: [[tagLink(":tags:todo")], [tagLink(":tags:doing")]] } });
        case ":tags:todo":
          return Promise.resolve({ path: p, type: "object", concrete: null, title: "todo", description: null, value: {} });
        case ":tags:doing":
          return Promise.resolve({ path: p, type: "object", concrete: null, title: "doing", description: null, value: {} });
        case ":board:t1.yo": // the card, currently tagged todo
          return Promise.resolve({
            path: p, type: "object", concrete: "file/yamlover", title: "Task One", description: null,
            value: { "yamlover-annotations": [tagLink(":tags:todo")] },
          });
        default:
          return Promise.reject(new Error("unexpected fetch: " + p));
      }
    });
  }

  async function renderBoardAndDragCard() {
    render(<BoardView node={boardNode} onNavigate={() => {}} />);
    const card = (await screen.findByText("Task One")).closest(".board-card") as HTMLElement;
    const groups = document.querySelectorAll(".board-group");
    expect(groups.length).toBe(2);
    fireEvent.dragStart(card);
    fireEvent.dragOver(groups[1]); // the doing lane
    fireEvent.drop(groups[1]);
    return screen.findByRole("dialog");
  }

  it("dropping a card on another lane confirms, then retags via moveState", async () => {
    mockBoardFetches();
    const dialog = await renderBoardAndDragCard();
    expect(dialog.textContent).toContain('Move "Task One" to "doing"');
    expect(mDelete).not.toHaveBeenCalled(); // nothing moved yet

    fireEvent.click(screen.getByRole("button", { name: "Move task" }));
    await vi.waitFor(() => expect(mAnnotate).toHaveBeenCalled());
    expect(mDelete).toHaveBeenCalledWith(":board:t1.yo", ":tags:todo");
    expect(mAnnotate).toHaveBeenCalledWith({ target: ":board:t1.yo", tag: ":tags:doing" });
  });

  it("cancelling the confirm retags nothing", async () => {
    mockBoardFetches();
    await renderBoardAndDragCard();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mDelete).not.toHaveBeenCalled();
    expect(mAnnotate).not.toHaveBeenCalled();
  });

  it("dropping back on the same lane is refused silently — no popup at all", async () => {
    mockBoardFetches();
    render(<BoardView node={boardNode} onNavigate={() => {}} />);
    const card = (await screen.findByText("Task One")).closest(".board-card") as HTMLElement;
    fireEvent.dragStart(card);
    fireEvent.drop(document.querySelectorAll(".board-group")[0]); // todo → todo
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mDelete).not.toHaveBeenCalled();
  });
});
