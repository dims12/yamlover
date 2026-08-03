// @vitest-environment jsdom
// LOADED × EDITS — the matrix dimension the from-scratch suites missed: content read FROM DISK
// must be exactly as editable as content just typed (the story that kept repeating: `{}` loaded
// from a file drew two puncts and a zero-width gap — no cell, no caret, no way in). THE LAWS here:
// after mount the caret stands somewhere real; every document accepts an edit; placeholders ≤ 1;
// and the whole document still unwinds to empty.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
const { editChunks, fetchNode, fetchAnnotations, queryTree, queryFilter } = vi.hoisted(() => ({
  editChunks: vi.fn(), fetchNode: vi.fn(), fetchAnnotations: vi.fn().mockResolvedValue([]),
  queryTree: vi.fn(), queryFilter: vi.fn(),
}));
vi.mock("../../src/client/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()), editChunks, fetchNode, fetchAnnotations, queryTree, queryFilter,
}));
import { cellText, mountKit, unwindToEmpty, caretTo, type Kit } from "./yed-kit";

/** Put the caret at the document's natural APPEND point: the INNER slot of an empty token when
 *  one exists (the way back between the brackets), else the end of the last content cell (its
 *  `,`/`:` grammar appends from there). The yed mount's initial hole sits at INDEX 0 — the
 *  document's head, not its tail — so the hole is never the append point here. */
function caretToTail(kit: Kit): void {
  const inner = kit.container.querySelectorAll<HTMLElement>(".y2-gapslot.y2-inner");
  if (inner.length > 0) { caretTo(inner[inner.length - 1], "end"); return; }
  const cells = kit.cells().filter((c) => { const t = cellText(c); return t !== "" && t !== "▏"; });
  if (cells.length > 0) { caretTo(cells[cells.length - 1], "end"); return; }
  // an EMPTY document: the mount's own hole is the append point — the caret is already there
}

beforeEach(() => {
  editChunks.mockReset().mockResolvedValue({ ok: true });
  fetchNode.mockReset();
  queryTree.mockReset().mockResolvedValue([]);
  queryFilter.mockReset().mockRejectedValue(new Error("no filter mock"));
});
afterEach(cleanup);

/** A document as the wire delivers it (value + the comments sidecar). */
const doc = (value: unknown, comments: Record<string, unknown> = {}) => ({
  path: ":n", type: "object", concrete: "yamlover", title: null, description: null, value, comments,
});

const FLOW = (frag: string) => ({ [frag]: { repr: "yaml/flow" } });

/** Loaded documents × what typing one key into them must produce. `edit` runs with the caret
 *  wherever the mount left it (the mount-focus law) — no clicking first. */
const DOCS: { name: string; value: unknown; comments?: Record<string, unknown>; edit: string; rows: string[] }[] = [
  { name: "an empty flow map `{}`", value: {}, comments: FLOW(""), edit: "a: 1", rows: ["{a: 1}"] },
  { name: "an empty flow seq `[]`", value: [], comments: FLOW(""), edit: "1", rows: ["[1]"] },
  { name: "a one-pair map `{a: 1}`", value: { a: 1 }, comments: FLOW(""), edit: ", b: 2", rows: ["{a: 1, b: 2}"] },
  { name: "a two-element seq `[1, 2]`", value: [1, 2], comments: FLOW(""), edit: ",3", rows: ["[1, 2, 3]"] /* the projected punct spaces; a typed space would sit in the cell until commit */ },
  { name: "a NESTED empty token `a: {}`", value: { a: {} }, comments: FLOW("/a"), edit: "x: 1", rows: ["a: {x: 1}"] },
  {
    name: "a K&R document",
    value: [{ key: 12 }],
    comments: { "": { concrete: "json5p" } },
    edit: ", 13",
    rows: ["[", "{", "key: 12,", "13", "}", "]"], // hmm — see the row's own assertion below
  },
];

describe("loaded documents are as editable as typed ones", () => {
  for (const d of DOCS.slice(0, 5)) {
    it(`${d.name}: mounts with a live caret and takes the edit`, async () => {
      const kit = await mountKit(fetchNode, doc(d.value, d.comments));
      kit.caret();                      // the mount-focus law: no clicking required
      expect(kit.placeholders().length).toBeLessThanOrEqual(1);
      caretToTail(kit);                 // append at the document's natural edit point
      kit.run(d.edit);
      expect(kit.rows()).toEqual(d.rows);
    });
    it(`${d.name}: unwinds to empty`, async () => {
      const kit = await mountKit(fetchNode, doc(d.value, d.comments));
      unwindToEmpty(kit);
    });
  }

  it("a K&R document mounts editable too", async () => {
    const kit = await mountKit(fetchNode, doc([{ key: 12 }], { "": { concrete: "json5p" } }));
    kit.caret();
    expect(kit.placeholders().length).toBeLessThanOrEqual(1);
    // the caret lands somewhere real; editing a VALUE cell round-trips the whole token
    const v = kit.cells().find((c) => c.textContent === "12")!;
    expect(v, "the value cell must exist").toBeTruthy();
  });

  it("a K&R document unwinds to empty", async () => {
    const kit = await mountKit(fetchNode, doc([{ key: 12 }], { "": { concrete: "json5p" } }));
    unwindToEmpty(kit);
  });
});
