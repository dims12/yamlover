// @vitest-environment jsdom
// KEY EDITING (issue: the caret could not enter keys). A committed key renders as an editable cell;
// clicking/typing into it and committing routes through act.rekey → POST /api/rekey. A duplicate
// key rings the error and never calls the server. The caret stays in the key cell after commit.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react";

const { editChunks, fetchNode, fetchAnnotations, queryTree, queryFilter, rekeyNode } = vi.hoisted(() => ({
  editChunks: vi.fn(), fetchNode: vi.fn(), fetchAnnotations: vi.fn().mockResolvedValue([]),
  queryTree: vi.fn(), queryFilter: vi.fn(), rekeyNode: vi.fn(),
}));
vi.mock("../../src/client/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), editChunks, fetchNode, fetchAnnotations, queryTree, queryFilter, rekeyNode }));

import { YamloverEditor } from "../../src/client/renderers/yamlover-editor/editor";

const NODE = {
  path: ":doc", type: "object", concrete: "dir/yamlover", title: null, description: null,
  value: { europe: "Europe", asia: "Asia" },
  comments: {},
};

beforeEach(() => {
  editChunks.mockReset().mockResolvedValue({ ok: true });
  fetchNode.mockReset().mockResolvedValue(NODE);
  queryTree.mockReset().mockResolvedValue([]);
  queryFilter.mockReset().mockRejectedValue(new Error("no filter"));
  rekeyNode.mockReset().mockResolvedValue({ path: ":doc:capital" });
});
afterEach(cleanup);

async function mount() {
  const utils = render(<YamloverEditor path={":doc"} onNavigate={() => {}} />);
  await waitFor(() => expect(utils.container.querySelector(".yed-row")).toBeTruthy());
  return utils;
}

const keyCell = (c: HTMLElement, text: string) =>
  [...c.querySelectorAll<HTMLElement>(".k.editable")].find((e) => e.textContent === text)!;

describe("key editing", () => {
  it("renders committed keys as editable cells the caret can enter", async () => {
    const { container } = await mount();
    const k = keyCell(container, "europe");
    expect(k).toBeTruthy();
    expect(k.getAttribute("contenteditable")).toBe("true");
    k.focus();
    expect(document.activeElement).toBe(k); // the cursor DOES enter the key now
  });

  it("renaming a key commits via /api/rekey and keeps the caret in the key cell", async () => {
    const { container } = await mount();
    const k = keyCell(container, "europe");
    k.focus();
    k.textContent = "capital";
    fireEvent.input(k);
    fireEvent.keyDown(k, { key: "Enter" });
    // optimistic: the key text updates and focus stays in the (same) key cell
    await waitFor(() => expect(keyCell(container, "capital")).toBeTruthy());
    expect(document.activeElement).toBe(keyCell(container, "capital"));
    // the server was asked to rename europe → capital (old path, new key)
    await waitFor(() => expect(rekeyNode).toHaveBeenCalledWith(":doc:europe", "capital"));
    expect(keyCell(container, "europe")).toBeUndefined(); // the old key is gone
  });

  it("rejects a duplicate key with the error ring and never calls the server", async () => {
    const { container } = await mount();
    const k = keyCell(container, "europe");
    k.focus();
    k.textContent = "asia"; // already a sibling key
    fireEvent.input(k);
    fireEvent.keyDown(k, { key: "Enter" });
    await waitFor(() => expect(k.classList.contains("edit-error")).toBe(true));
    expect(rekeyNode).not.toHaveBeenCalled(); // the server was never asked
    expect(k.textContent).toBe("asia"); // error_flash keeps the typed text; the MODEL key stays "europe"
  });
});
