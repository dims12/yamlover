// @vitest-environment jsdom
// THE RECENTS BAG (src/complete.ts RecentsProvider + src/cells.tsx PortionCells) — the
// host-injected "recently used targets" section BELOW the completion hints: it shows whole
// at the bare sigil, never arms, survives the first Escape (which closes only the hint
// rows), and a pick INSERTS the whole raw into the cells — the grammar's Enter stays the
// single commit point. Plus the commit-observation seam (apply.ts refCommitOf → page.tsx
// onRefCommit) the host records recents through.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { useState } from "react";
import { EditorView } from "../src/page";
import { docHints, type RecentEntry, type RecentsProvider, type RecentsQuery } from "../src/complete";
import { parseSource, sourceOf, type EditorState } from "../src/state";
import type { RefCommit } from "../src/apply";

afterEach(cleanup);

const DOC = "pets:\n  - Rex\n  - Whiskers\nowner:\n  name: Alice\n";
const doc = () => parseSource(DOC);

let lastState: EditorState = null as never;

function Harness({ recents, onRefCommit, paneOpen, onPane, onForget }: {
  recents?: RecentsProvider;
  onRefCommit?: (c: RefCommit) => void;
  paneOpen?: boolean;
  onPane?: (open: boolean) => void;
  onForget?: (e: RecentEntry, anchor: boolean) => void;
}) {
  const [state, setState] = useState<EditorState>(() => ({
    doc: doc(),
    cursor: { at: "hole", path: [], index: 2, text: "", key: null },
    refused: false,
    log: [],
  }));
  lastState = state;
  return (
    <EditorView
      state={state} setState={setState} debug={false} hints={docHints} recents={recents}
      onRefCommit={onRefCommit} recentsPaneOpen={paneOpen} onRecentsPane={onPane} onRecentForget={onForget}
    />
  );
}

const focused = (): HTMLInputElement => document.activeElement as HTMLInputElement;

function domType(script: string): void {
  for (const ch of script) {
    const input = focused();
    const key = ch === "\n" ? "Enter" : ch;
    const before = input.value ?? "";
    const s = input.selectionStart ?? before.length;
    const e = input.selectionEnd ?? before.length;
    const defaulted = fireEvent.keyDown(input, { key });
    if (key.length === 1 && defaulted) fireEvent.change(input, { target: { value: before.slice(0, s) + key + before.slice(e) } });
  }
}

const popup = (): HTMLElement | null => document.querySelector("[data-testid=y2-hints]");
const bag = (): HTMLElement | null => document.querySelector("[data-testid=y2-bag]");
const hintTexts = (): string[] =>
  Array.from(document.querySelectorAll(".y2-hint:not(.y2-bagrow) .y2-hint-insert")).map((el) => el.textContent ?? "");
const bagTexts = (): string[] =>
  Array.from(document.querySelectorAll(".y2-bagrow .y2-hint-insert")).map((el) => el.textContent ?? "");

/** A stable stub provider: one remembered reference target, one remembered bookmark target
 *  (the membership `-` riding the raw, as the server provider spells it). Queries are kept
 *  for the anchor-flag assertions. */
const queries: RecentsQuery[] = [];
const stubRecents: RecentsProvider = (q) => {
  queries.push(q);
  return q.anchor
    ? [{ raw: "pets: -", label: "pets", detail: ": pets", key: ":pets" }]
    : [{ raw: "owner: name", label: "name", detail: ": owner: name", key: ":owner:name" }];
};

describe("the recents bag under the portion cells", () => {
  it("shows below the hints at the bare `*`; a pick FILLS the cells (never commits); Enter then commits", async () => {
    render(<Harness recents={stubRecents} />);
    await act(async () => { domType("*"); });
    expect(popup()).toBeTruthy();
    expect(hintTexts()).toEqual(["pets", "owner"]);
    expect(bag()).toBeTruthy();
    expect(bagTexts()).toEqual(["name"]);
    // the bag pick inserts the WHOLE raw — cells filled, caret in the last portion's input,
    // the document untouched (only the provisional row stands)
    await act(async () => { fireEvent.mouseDown(document.querySelector(".y2-bagrow")!); });
    expect(lastState.cursor).toMatchObject({ ref: { ladder: 0, portions: ["owner", "name"], active: 1 } });
    expect(sourceOf(lastState.doc)).toBe(DOC + "-\n"); // inserted, NOT committed
    expect(focused().tagName).toBe("INPUT"); // the caret stands in the cells
    await act(async () => { fireEvent.keyDown(focused(), { key: "Enter" }); });
    expect(sourceOf(lastState.doc)).toBe(DOC + "- *owner: name\n");
  });

  it("the ESCAPE ladder: hints close first (bag stands, pickable), then the bag, then the page's law", async () => {
    const reached: string[] = [];
    const onDoc = (e: KeyboardEvent) => { if (e.key === "Escape") reached.push("esc"); };
    document.addEventListener("keydown", onDoc);
    try {
      render(<Harness recents={stubRecents} />);
      await act(async () => { domType("*ow"); });
      expect(hintTexts()).toEqual(["owner"]);
      expect(bagTexts()).toEqual(["name"]);
      // Escape #1 — the hint rows go, the bag STANDS; swallowed entirely
      const esc1 = fireEvent.keyDown(focused(), { key: "Escape" });
      await act(async () => {});
      expect(esc1).toBe(false);
      expect(reached).toEqual([]); // stopPropagation — never the page's lock-on-Escape
      expect(hintTexts()).toEqual([]);
      expect(bagTexts()).toEqual(["name"]);
      expect(focused().tagName).toBe("INPUT"); // the edit survives
      // ...and the standing bag is still pickable
      expect(document.querySelector(".y2-bagrow")).toBeTruthy();
      // Escape #2 — the bag goes too; still swallowed
      const esc2 = fireEvent.keyDown(focused(), { key: "Escape" });
      await act(async () => {});
      expect(esc2).toBe(false);
      expect(reached).toEqual([]);
      expect(popup()).toBeNull();
      expect(focused().tagName).toBe("INPUT");
      // Escape #3 — nothing left to close: falls through past the completion layer
      fireEvent.keyDown(focused(), { key: "Escape" });
      await act(async () => {});
      expect(reached).toEqual(["esc"]);
    } finally {
      document.removeEventListener("keydown", onDoc);
    }
  });

  it("ArrowDown walks past the last hint INTO the bag; a bag row never arms (no inline tail)", async () => {
    render(<Harness recents={stubRecents} />);
    await act(async () => { domType("*ow"); });
    // armed hint: the tail rides in the cell
    expect(focused().value).toBe("owner");
    await act(async () => { fireEvent.keyDown(focused(), { key: "ArrowDown" }); });
    // sel crossed into the bag: the row highlights, the tail is GONE (a bag row never arms)
    expect(document.querySelector(".y2-bagrow.y2-hint-sel")).toBeTruthy();
    expect(focused().value).toBe("ow");
    // Enter on the bag row INSERTS (never forwarded to the grammar's commit)
    await act(async () => { fireEvent.keyDown(focused(), { key: "Enter" }); });
    expect(lastState.cursor).toMatchObject({ ref: { portions: ["owner", "name"], active: 1 } });
    expect(sourceOf(lastState.doc)).toBe(DOC + "-\n"); // still uncommitted
    await act(async () => { fireEvent.keyDown(focused(), { key: "Enter" }); });
    expect(sourceOf(lastState.doc)).toBe(DOC + "- *owner: name\n");
  });

  it("the `&` face asks with anchor:true and gets the bookmarks bag; the pick + Enter land the bookmark", async () => {
    queries.length = 0;
    render(<Harness recents={stubRecents} />);
    await act(async () => { domType("&"); });
    expect(queries[queries.length - 1]?.anchor).toBe(true);
    expect(bagTexts()).toEqual(["pets"]);
    await act(async () => { fireEvent.mouseDown(document.querySelector(".y2-bagrow")!); });
    expect(lastState.cursor).toMatchObject({ at: "hole", anchor: true, ref: { portions: ["pets", "-"] } });
    await act(async () => { fireEvent.keyDown(focused(), { key: "Enter" }); });
    expect(lastState.refused).toBe(false);
    expect(sourceOf(lastState.doc)).toContain("&pets"); // the membership bookmark landed
    // the caret is the RESTORED hole — the bookmark is a decoration, not an entry
    expect(lastState.cursor).toMatchObject({ at: "hole", path: [], text: "" });
    expect(focused().tagName).toBe("INPUT");
  });

  it("the ✕ CLOSES the pane to its header (the rows go, the hints and the caret stay)", async () => {
    const onPane = vi.fn();
    const { rerender } = render(<Harness recents={stubRecents} paneOpen={true} onPane={onPane} />);
    await act(async () => { domType("*ow"); });
    expect(bagTexts()).toEqual(["name"]);
    await act(async () => { fireEvent.mouseDown(document.querySelector(".y2-bag-close")!); });
    expect(onPane).toHaveBeenCalledWith(false); // the host stores the preference
    // a host-driven pane: it collapses when the prop comes back false
    rerender(<Harness recents={stubRecents} paneOpen={false} onPane={onPane} />);
    await act(async () => { domType("n"); });
    expect(bagTexts()).toEqual([]); // collapsed…
    expect(document.querySelector(".y2-bag-title")?.textContent).toContain("recent"); // …to its header
    expect(hintTexts().length).toBeGreaterThan(0); // the candidates are untouched
    expect(focused().tagName).toBe("INPUT"); // and the caret never moved
  });

  it("a collapsed pane leaves the vertical walk to the hints alone", async () => {
    render(<Harness recents={stubRecents} paneOpen={false} />);
    await act(async () => { domType("*ow"); });
    expect(bagTexts()).toEqual([]);
    await act(async () => { fireEvent.keyDown(focused(), { key: "ArrowDown" }); });
    // with one hint and no bag rows the walk stays on the hint (it would wrap into the bag)
    expect(document.querySelector(".y2-hint-sel .y2-hint-insert")?.textContent).toBe("owner");
  });

  it("a bag row is FORGOTTEN by right-click, and says which face it came from", async () => {
    const onForget = vi.fn();
    render(<Harness recents={stubRecents} onForget={onForget} />);
    await act(async () => { domType("&pe"); });
    await act(async () => { fireEvent.contextMenu(document.querySelector(".y2-bagrow")!); });
    expect(onForget).toHaveBeenCalledTimes(1);
    expect(onForget.mock.calls[0][0]).toMatchObject({ key: ":pets" });
    expect(onForget.mock.calls[0][1]).toBe(true); // the `&` face → the bookmarks list
    expect(focused().tagName).toBe("INPUT"); // forgetting never disturbs the edit
  });

  it("with NO recents provider there is no bag and the old single-Escape behavior stands", async () => {
    render(<Harness />);
    await act(async () => { domType("*ow"); });
    expect(bag()).toBeNull();
    const esc = fireEvent.keyDown(focused(), { key: "Escape" });
    await act(async () => {});
    expect(esc).toBe(false);
    expect(popup()).toBeNull(); // one Escape closed everything there was
  });
});

describe("refCommitOf → onRefCommit — the host's recording seam", () => {
  it("fires on a pointer commit and on a bookmark commit, with the anchor flag and the raw", async () => {
    const commits: RefCommit[] = [];
    render(<Harness recents={stubRecents} onRefCommit={(c) => commits.push(c)} />);
    await act(async () => { domType("*pe"); });
    await act(async () => { fireEvent.keyDown(focused(), { key: "Enter" }); }); // accept `pets` + commit
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ anchor: false, raw: "pets", holder: [] });
    expect(commits[0].doc).not.toBe(lastState.doc); // the PRE-commit document rides along
    // the bookmark face
    await act(async () => { domType("&"); });
    await act(async () => { fireEvent.mouseDown(document.querySelector(".y2-bagrow")!); });
    expect(commits).toHaveLength(1); // a bag INSERT is not a commit
    await act(async () => { fireEvent.keyDown(focused(), { key: "Enter" }); });
    expect(commits).toHaveLength(2);
    expect(commits[1]).toMatchObject({ anchor: true, raw: "pets: -" });
  });

  it("never fires on a refusal or an abandoned entry", async () => {
    const commits: RefCommit[] = [];
    render(<Harness recents={stubRecents} onRefCommit={(c) => commits.push(c)} />);
    await act(async () => { domType("*"); });
    await act(async () => { domType("no such node!!"); });
    // unparsable — the ring, the text stands, no commit observed
    await act(async () => { fireEvent.keyDown(focused(), { key: "Enter" }); });
    expect(lastState.refused).toBe(true);
    expect(commits).toHaveLength(0);
  });
});
