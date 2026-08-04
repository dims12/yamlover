// @vitest-environment jsdom
// THE FLUSH DISCIPLINE of the yed mount (yed-editor.tsx) — ported from the legacy sync suite:
// edits COALESCE into one debounced batch (the diff runs committed-vs-newest, so two commits
// inside the window emit one op); pending work flushes on UNMOUNT (lock / navigation); a FAILED
// flush alerts, keeps the committed snapshot, and the next flush re-diffs the SAME change —
// never a queued-op double-apply.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";

const { editChunks, fetchNode, fetchContent, queryTree, queryFilter } = vi.hoisted(() => ({
  editChunks: vi.fn(), fetchNode: vi.fn(), fetchContent: vi.fn(), queryTree: vi.fn(), queryFilter: vi.fn(),
}));
vi.mock("../../src/client/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), editChunks, fetchNode, queryTree, queryFilter }));
vi.mock("../../src/client/content", async (orig) => ({ ...(await orig<Record<string, unknown>>()), fetchContent }));

import { YedEditor } from "../../src/client/renderers/yed-editor";
import { contentViaNode } from "./wire-fixture";

const ARR = {
  path: ":d", type: "array", concrete: "file/yamlover", title: null, description: null,
  value: ["alpha", "beta"],
};

beforeEach(() => {
  editChunks.mockReset().mockResolvedValue({ ok: true });
  fetchNode.mockReset().mockResolvedValue(ARR);
  fetchContent.mockReset().mockImplementation(contentViaNode(fetchNode)); // the mount's wire follows fetchNode
  queryTree.mockReset().mockResolvedValue([]);
  queryFilter.mockReset().mockRejectedValue(new Error("no filter mock"));
});
afterEach(cleanup);

async function mount() {
  const utils = render(<YedEditor path=":d" onNavigate={() => {}} />);
  await waitFor(() => expect(utils.container.querySelector("[data-testid=y2-doc]")).toBeTruthy());
  return utils;
}

/** Focus the token face spelled `text` and commit `next` in its place (change + ArrowRight —
 *  yed's move-free commit). Re-queries per step: renders replace elements. */
function retype(container: HTMLElement, text: string, next: string): void {
  const face = Array.from(container.querySelectorAll<HTMLElement>(".y2-v")).find((c) => c.textContent === text)!;
  expect(face, `no token face spelled ${JSON.stringify(text)}`).toBeTruthy();
  fireEvent.focus(face);
  const input = document.activeElement as HTMLInputElement;
  expect(input instanceof HTMLInputElement).toBe(true);
  fireEvent.change(input, { target: { value: next } });
  input.setSelectionRange(next.length, next.length);
  fireEvent.keyDown(input, { key: "ArrowRight" });
}

describe("the yed flush discipline", () => {
  it("edits COALESCE (keep-last) into one emplace — one batch, one flush", async () => {
    const { container } = await mount();
    retype(container, "alpha", "alp");
    retype(container, "alp", "alphax"); // both inside the 500 ms window
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":d:0", op: "emplace", yamlover: "alphax" }]), { timeout: 2000 });
    expect(editChunks).toHaveBeenCalledTimes(1);
  });

  it("pending ops flush on UNMOUNT (lock / navigation)", async () => {
    const { container, unmount } = await mount();
    retype(container, "alpha", "changed");
    unmount(); // before the debounce elapses
    await waitFor(() => expect(editChunks).toHaveBeenCalledWith([{ path: ":d:0", op: "emplace", yamlover: "changed" }]));
  });

  it("a FAILED flush alerts, keeps the change, and the next flush re-diffs the same batch", async () => {
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    editChunks.mockRejectedValueOnce(new Error("boom"));
    const { container, unmount } = await mount();
    retype(container, "alpha", "kept");
    await waitFor(() => expect(editChunks).toHaveBeenCalledTimes(1), { timeout: 2000 }); // the debounced flush fails
    await waitFor(() => expect(alert).toHaveBeenCalled());
    unmount(); // the unmount flush re-diffs committed-vs-newest — the SAME change goes out
    await waitFor(() => expect(editChunks).toHaveBeenCalledTimes(2));
    expect(editChunks).toHaveBeenLastCalledWith([{ path: ":d:0", op: "emplace", yamlover: "kept" }]);
    alert.mockRestore();
  });
});
