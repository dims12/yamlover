// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

// The whole client api is mocked: AnnotationMenu's hooks (useColorOntos → fetchNode, useOntoIndex →
// query, pruneRememberedTags → fetchNode) fall back gracefully, and the right-click menu's writes
// (annotate / deleteAnnotation / fetchAnnotations) are observed directly.
vi.mock("../../src/client/api", () => ({
  fetchConfig: vi.fn().mockResolvedValue({ source: "", settings: { exports: [], annotations: ":annotations", ontos: ":ontos", sidecars: "per-directory" }, path: ":.yo:settings.yo" }),
  fetchAnnotations: vi.fn().mockResolvedValue([]),
  annotate: vi.fn().mockResolvedValue({ ok: true }),
  deleteAnnotation: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
  fetchNode: vi.fn().mockRejectedValue(new Error("no node")),
  createOnto: vi.fn(),
  // the shared query-cell kit (the popup's search row)
  queryTree: vi.fn().mockResolvedValue([]),
  queryFilter: vi.fn().mockResolvedValue({ root: { path: ":", label: "r", type: "object", format: null, concrete: null, hasChildren: false, children: [] }, matches: [], truncated: false }),
  fetchTree: vi.fn().mockResolvedValue({ path: ":", label: "r", type: "object", format: null, concrete: null, hasChildren: false, children: [] }),
}));

import { AnnotationMenu, indexToRefs } from "../../src/client/renderers/annotate";
import { useExplorerTagMenu } from "../../src/client/renderers/tagmenu";
import { fetchAnnotations, annotate, deleteAnnotation, query, queryTree, queryFilter, fetchNode } from "../../src/client/api";

const mAnns = fetchAnnotations as unknown as ReturnType<typeof vi.fn>;
const mAnnotate = annotate as unknown as ReturnType<typeof vi.fn>;
const mDelete = deleteAnnotation as unknown as ReturnType<typeof vi.fn>;
const mQuery = query as unknown as ReturnType<typeof vi.fn>;
const mQueryTree = queryTree as unknown as ReturnType<typeof vi.fn>;
const mQueryFilter = queryFilter as unknown as ReturnType<typeof vi.fn>;
const mFetchNode = fetchNode as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  mAnns.mockReset().mockResolvedValue([]);
  mAnnotate.mockClear();
  mDelete.mockClear();
  mQuery.mockReset().mockResolvedValue([]);
  mQueryTree.mockReset().mockResolvedValue([]);
  mQueryFilter.mockReset().mockResolvedValue({ root: { path: ":", label: "r", type: "object", format: null, concrete: null, hasChildren: false, children: [] }, matches: [], truncated: false });
  mFetchNode.mockReset().mockRejectedValue(new Error("no node"));
});
afterEach(cleanup);

// ---- the typeahead index: collapse the `yamlover` self-import graft duplicates ---- //
describe("indexToRefs — a tag is just a node (both namespaces listed)", () => {
  it("lists a project's OWN tag and the GLOBAL self-import tag as DISTINCT nodes (IMPORTS.md)", () => {
    // `:ontos:…` (project-own, document-root) and `:yamlover:ontos:…` (global self-import) are
    // different nodes — both belong in the picker. Only an EXACT duplicate path collapses.
    const refs = indexToRefs([
      ":ontos:workflow:dev:ready",
      ":yamlover:ontos:workflow:dev:ready", // a DIFFERENT node (the global one) — kept too
      ":ontos:workflow:dev:ready", // an exact dup of the first — collapsed
    ]);
    expect(refs.map((r) => r.path)).toEqual([":ontos:workflow:dev:ready", ":yamlover:ontos:workflow:dev:ready"]);
    expect(refs.map((r) => r.name)).toEqual(["ready", "ready"]);
  });
  it("keeps each tag at its REAL path and drops the color palette (the swatch row)", () => {
    const refs = indexToRefs([":yamlover:ontos:misc:foo", ":ontos:colors:yellow", ":yamlover:ontos:colors:red"]);
    expect(refs.map((r) => r.name)).toEqual(["foo"]);
    expect(refs[0].path).toBe(":yamlover:ontos:misc:foo"); // real path, not rewritten
  });
});

// ---- no browse tree: the scoped taxonomy shows as chips; HOVER reveals the path ---- //
describe("AnnotationMenu — no tree; hover-card reveals the path", () => {
  it("shows no tree; the scoped taxonomy shows as chips; HOVER reveals the canonical path", async () => {
    mQuery.mockResolvedValue([":ontos:workflow:dev:ready", ":ontos:workflow:dev:done", ":ontos:first tag"]);
    const { container } = render(<AnnotationMenu x={0} y={0} applied={[]} mode="create" onPick={() => {}} onUnpick={() => {}} onClose={() => {}} />);
    // the browse tree was removed — never rendered; searching is the query-cell row's job now
    await waitFor(() => expect([...container.querySelectorAll(".annotate-recents .tagtag")].map((b) => b.textContent)).toEqual(["ready", "done", "first tag"]));
    expect(container.querySelector(".annotate-tree")).toBeNull();
    expect(container.querySelector(".annotate-cells")).toBeTruthy(); // the shared query cells
    // hovering a chip reveals its path canonically — `ontos:` prefix dropped, space after colon
    fireEvent.mouseEnter(container.querySelector(".annotate-recents .tagtip-anchor")!);
    await waitFor(() => expect(document.querySelector(".tagtip-path")?.textContent).toBe("workflow: dev: ready"));
  });
});

// ---- applied tags are OUTLINED (toggle), shown once, never as a duplicate chip ---- //
describe("AnnotationMenu — applied tags outline, no duplicates", () => {
  const NAMED = { path: ":ontos:done", name: "done", color: "#a6e3a1" };

  it("outlines an applied NAMED tag (once) and toggles it OFF via onUnpick", () => {
    const onPick = vi.fn();
    const onUnpick = vi.fn();
    const { container } = render(<AnnotationMenu x={0} y={0} applied={[NAMED]} mode="create" onPick={onPick} onUnpick={onUnpick} onClose={() => {}} />);
    // the applied named tag is shown ONCE, as an OUTLINED badge in the APPLIED row (state,
    // never inside the collapsible suggestion pane — a hidden bag must not hide the untag)
    const badges = [...container.querySelectorAll(".annotate-applied .tagtag")].map((b) => b.textContent);
    expect(badges).toEqual(["done"]);
    expect(container.querySelector(".annotate-applied .tagtag.on")?.textContent).toBe("done");
    expect([...container.querySelectorAll(".annotate-recents .tagtag")].map((b) => b.textContent)).not.toContain("done");
    expect(container.querySelector(".annotate-current")).toBeNull(); // the ad-hoc row is gone
    // clicking the applied badge toggles it OFF (remove), not add
    fireEvent.click(screen.getByText("done"));
    expect(onUnpick).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("outlines an applied COLOR tag on its SWATCH — never as a duplicate badge", () => {
    const yellow = { path: "::yamlover:ontos:colors:yellow", name: "yellow", color: "#f9e2af" };
    const { container } = render(<AnnotationMenu x={0} y={0} applied={[yellow]} mode="create" onPick={() => {}} onUnpick={() => {}} onClose={() => {}} />);
    // a color tag stays in the swatch row (outlined), and does NOT appear as a named badge
    expect([...container.querySelectorAll(".annotate-recents .tagtag, .annotate-applied .tagtag")].map((b) => b.textContent)).toEqual([]);
    expect(container.querySelector(".annotate-swatch.on")).toBeTruthy();
  });
});

// ---- the chip row shows each NAME once, even for two genuinely-different homonym tags ---- //
describe("AnnotationMenu — the chip row dedupes by name", () => {
  it("shows one 'ready' chip when two distinct tags are both named 'ready'", async () => {
    // two REAL tags (different paths, NOT graft duplicates of each other) that read the same
    mQuery.mockResolvedValue([":ontos:ready", ":ontos:workflow:dev:ready"]);
    const { container } = render(<AnnotationMenu x={0} y={0} applied={[]} mode="create" onPick={() => {}} onUnpick={() => {}} onClose={() => {}} />);
    await waitFor(() => {
      const chips = [...container.querySelectorAll(".annotate-recents .tagtag")].map((b) => b.textContent);
      expect(chips).toEqual(["ready"]); // one chip, not two identical "ready"
    });
  });
});

// ---- default chips: the four sources shown without typing (graft · config location · node · recents) ---- //
describe("AnnotationMenu — default chips from the four sources", () => {
  it("shows grafted + configured-location tags as chips; out-of-scope nodes only via the query cells", async () => {
    // settings.ontos is ":tags" (the mocked config). The graft lives at :yamlover:tags; a sub-document's
    // own taxonomy (:67-pdf-tags:tags) is OUT of scope — reachable through the search row, not a chip.
    mQuery.mockResolvedValue([":yamlover:ontos:fifth tag", ":ontos:mine", ":67-pdf-tags:ontos:genre:humor"]);
    mQueryFilter.mockResolvedValue({
      root: { path: ":", label: "r", type: "object", format: null, concrete: null, hasChildren: false, children: [] },
      matches: [":67-pdf-tags:ontos:genre:humor"],
      truncated: false,
    });
    mFetchNode.mockResolvedValue({ path: ":67-pdf-tags:ontos:genre:humor", type: "object", concrete: null, title: null, description: null, value: {} });
    const onPick = vi.fn();
    const { container } = render(<AnnotationMenu x={0} y={0} applied={[]} mode="create" onPick={onPick} onUnpick={() => {}} onClose={() => {}} />);
    await waitFor(() => {
      const chips = [...container.querySelectorAll(".annotate-recents .tagtag")].map((b) => b.textContent);
      expect(chips).toContain("fifth tag"); // (1) grafted yamlover
      expect(chips).toContain("mine"); // (2) configured tags location
      expect(chips).not.toContain("humor"); // out of scope → not a default chip
    });
    // the SEARCH row reaches it: type into the query cells (seeded `: ...: ▮`), Enter applies
    // the first match — resolved through fetchNode, named by title-or-key, no format gate
    const cell = [...container.querySelectorAll<HTMLElement>(".annotate-cells .crumb-cell")].pop()!;
    fireEvent.focus(cell);
    cell.textContent = "humor";
    fireEvent.input(cell);
    fireEvent.keyDown(cell, { key: "Enter" });
    await waitFor(() => expect(onPick).toHaveBeenCalledWith({ path: ":67-pdf-tags:ontos:genre:humor", name: "humor", color: null }));
    expect(mQueryFilter).toHaveBeenCalledWith(":: ...: humor"); // project-wide: the seeded descent + the typed name
  });

  it("opens PROJECT-scoped with the caret in the trailing cell; Backspace steps the ladder down", async () => {
    const { container } = render(<AnnotationMenu x={0} y={0} applied={[]} mode="create" onPick={() => {}} onUnpick={() => {}} onClose={() => {}} />);
    // ready to type at once — and the autofocus did not double the seeded cells
    await waitFor(() => expect(document.activeElement?.classList.contains("crumb-cell")).toBe(true));
    expect(container.querySelectorAll(".annotate-cells .crumb-cell")).toHaveLength(2);
    // the opener spells the PROJECT rung — tags (the grafted palette included) live there
    expect(container.querySelector(".annotate-cells .crumb-sep")?.textContent).toBe("::");
    await waitFor(() => expect(mQueryTree).toHaveBeenCalledWith(":: ...: ?", ":"));
    // Backspace at the emptied first cell's start narrows to the DOCUMENT scope
    const first = container.querySelectorAll<HTMLElement>(".annotate-cells .crumb-cell")[0];
    fireEvent.focus(first);
    first.textContent = "";
    fireEvent.input(first);
    first.textContent = ""; // jsdom has no real focus, so the uncontrolled-cell resync restored the seed
    const sel = window.getSelection()!;
    const r = document.createRange();
    r.setStart(first, 0);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    fireEvent.keyDown(first, { key: "Backspace" });
    expect(container.querySelector(".annotate-cells .crumb-sep")?.textContent).toBe(":");
    await waitFor(() => expect(mQueryTree).toHaveBeenCalledWith(": ?", ":"));
  });

  it("Enter on a bare name with NO match CREATES the tag (create-on-miss)", async () => {
    const { createOnto } = await import("../../src/client/api");
    const created = { path: ":ontos:fresh", name: "fresh", color: null };
    (createOnto as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(created);
    const onPick = vi.fn();
    const { container } = render(<AnnotationMenu x={0} y={0} applied={[]} mode="create" onPick={onPick} onUnpick={() => {}} onClose={() => {}} />);
    const cell = [...container.querySelectorAll<HTMLElement>(".annotate-cells .crumb-cell")].pop()!;
    fireEvent.focus(cell);
    cell.textContent = "fresh";
    fireEvent.input(cell);
    fireEvent.keyDown(cell, { key: "Enter" });
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(created));
    expect(createOnto).toHaveBeenCalledWith("fresh");
  });

  it("shows tags borne by OTHER components of the node (nodeTags) as default chips", async () => {
    mQuery.mockResolvedValue([]);
    const sib = { path: ":ontos:sibling", name: "sibling", color: null };
    const { container } = render(<AnnotationMenu x={0} y={0} applied={[]} nodeTags={[sib]} mode="create" onPick={() => {}} onUnpick={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(mQuery).toHaveBeenCalled());
    // a sibling component's tag is CURRENT state of the node — the applied row, beside the
    // target's own (it is one click from being applied here too)
    expect([...container.querySelectorAll(".annotate-applied .tagtag")].map((b) => b.textContent)).toContain("sibling"); // (3)
  });
});

// ---- the create section: a SPLIT button (action + fused concrete select) and plain one-concrete buttons ---- //
describe("AnnotationMenu — create entries (split button + bare folder)", () => {
  const noop = () => {};

  it("a multi-concrete entry is one SPLIT pill: button + select side by side; the pick rides onCreate", () => {
    const onCreate = vi.fn();
    const creates = [{
      schema: "::yamlover:$defs:chapter", label: "chapter", defaultConcrete: "yamlover",
      concretes: [{ id: "yamlover", label: "inline" }, { id: "file/yamlover", label: "file" }, { id: "dir/.yo", label: "directory" }],
      onCreate,
    }];
    const { container } = render(<AnnotationMenu x={0} y={0} applied={[]} mode="create" onPick={noop} onUnpick={noop} onClose={noop} creates={creates} />);
    const row = container.querySelector(".annotate-create.split")!;
    expect(row).toBeTruthy();
    // button and select are SIBLINGS in the same row — the fused segmented control
    const button = row.querySelector("button.annotate-action")!;
    const select = row.querySelector("select.annotate-concrete") as HTMLSelectElement;
    expect(button.textContent).toBe("＋ New chapter");
    expect(select).toBeTruthy();
    // changing the segment's select then clicking the action creates with the PICKED concrete
    fireEvent.change(select, { target: { value: "file/yamlover" } });
    fireEvent.click(button);
    expect(onCreate).toHaveBeenCalledWith("file/yamlover");
  });

  it("the generic-node entry: a split pill defaulted to `directory`; clicking creates with it", () => {
    const onCreate = vi.fn();
    const creates = [{
      schema: "node", label: "node", defaultConcrete: "dir/.yo",
      concretes: [{ id: "file/yamlover", label: "file" }, { id: "dir/.yo", label: "directory" }],
      onCreate,
    }];
    const { container } = render(<AnnotationMenu x={0} y={0} applied={[]} mode="create" onPick={noop} onUnpick={noop} onClose={noop} creates={creates} />);
    const row = container.querySelector(".annotate-create.split")!;
    expect(row.querySelector("button.annotate-action")!.textContent).toBe("＋ New node");
    const select = row.querySelector("select.annotate-concrete") as HTMLSelectElement;
    expect(select.value).toBe("dir/.yo"); // defaulted to directory
    fireEvent.click(row.querySelector("button.annotate-action")!);
    expect(onCreate).toHaveBeenCalledWith("dir/.yo");
  });

  it("remembers the last-picked concrete per schema across menus (localStorage)", () => {
    const entry = () => ({
      schema: "::yamlover:$defs:chapter", label: "chapter", defaultConcrete: "yamlover",
      concretes: [{ id: "yamlover", label: "inline" }, { id: "file/yamlover", label: "file" }, { id: "dir/.yo", label: "directory" }],
      onCreate: vi.fn(),
    });
    const first = render(<AnnotationMenu x={0} y={0} applied={[]} mode="create" onPick={noop} onUnpick={noop} onClose={noop} creates={[entry()]} />);
    fireEvent.change(first.container.querySelector("select")!, { target: { value: "file/yamlover" } });
    first.unmount();
    // a FRESH menu (a new right-click) opens with the remembered pick, not the default
    const second = render(<AnnotationMenu x={0} y={0} applied={[]} mode="create" onPick={noop} onUnpick={noop} onClose={noop} creates={[entry()]} />);
    expect((second.container.querySelector("select") as HTMLSelectElement).value).toBe("file/yamlover");
  });

  it("a single-concrete entry is a plain button — no select, no split styling", () => {
    const onCreate = vi.fn();
    const creates = [{
      schema: "x", label: "thing", defaultConcrete: "file/yamlover",
      concretes: [{ id: "file/yamlover", label: "file" }],
      onCreate,
    }];
    const { container } = render(<AnnotationMenu x={0} y={0} applied={[]} mode="create" onPick={noop} onUnpick={noop} onClose={noop} creates={creates} />);
    const row = container.querySelector(".annotate-create")!;
    expect(row.classList.contains("split")).toBe(false);
    expect(row.querySelector("select")).toBeNull();
    fireEvent.click(row.querySelector("button.annotate-action")!);
    expect(onCreate).toHaveBeenCalledWith("file/yamlover");
  });
});

// ---- the popup drives the TOC filter session: typing filters the TOC, a TOC click applies ---- //
describe("AnnotationMenu — the TOC filter session", () => {
  it("mirrors the query's filter into the session; a session pick APPLIES the node as the tag", async () => {
    const { TocFilterCtx, useTocFilterSession } = await import("../../src/client/toc-filter-session");
    const PRUNED = { path: ":", label: "r", type: "object", format: null, concrete: null, hasChildren: true, children: [] };
    mQueryFilter.mockResolvedValue({ root: PRUNED, matches: [":topics:math"], truncated: false });
    mFetchNode.mockResolvedValue({ path: ":topics:math", type: "object", concrete: null, title: "Mathematics", description: null, value: {} });
    const onPick = vi.fn();
    let session!: import("../../src/client/toc-filter-session").TocFilterSession;
    function Host() {
      session = useTocFilterSession();
      return (
        <TocFilterCtx.Provider value={session}>
          <AnnotationMenu x={0} y={0} applied={[]} mode="create" onPick={onPick} onUnpick={() => {}} onClose={() => {}} />
        </TocFilterCtx.Provider>
      );
    }
    const { container } = render(<Host />);
    await waitFor(() => expect(session.active).toBe(true)); // the open popup owns the session
    // typing pushes the pruned filter tree into the session (App would swap the TOC to it)
    const cell = [...container.querySelectorAll<HTMLElement>(".annotate-cells .crumb-cell")].pop()!;
    fireEvent.focus(cell);
    cell.textContent = "math";
    fireEvent.input(cell);
    await waitFor(() => expect(session.filter?.root).toEqual(PRUNED));
    // a TOC row click routes to the popup and APPLIES the node — no format gate, title-named
    session.pick(":topics:math");
    await waitFor(() => expect(onPick).toHaveBeenCalledWith({ path: ":topics:math", name: "Mathematics", color: null }));
  });

  // Hosts for the pick-rules tests below: the same session harness, parameterized.
  async function sessionHost(props: { targetPath?: string; applied?: { path: string; name: string; color: string | null }[]; onPick: ReturnType<typeof vi.fn>; onUnpick?: ReturnType<typeof vi.fn>; onClose?: ReturnType<typeof vi.fn> }) {
    const { TocFilterCtx, useTocFilterSession } = await import("../../src/client/toc-filter-session");
    let session!: import("../../src/client/toc-filter-session").TocFilterSession;
    function Host() {
      session = useTocFilterSession();
      return (
        <TocFilterCtx.Provider value={session}>
          <AnnotationMenu
            x={0} y={0} applied={props.applied ?? []} mode="create"
            onPick={props.onPick} onUnpick={props.onUnpick ?? (() => {})} onClose={props.onClose ?? (() => {})}
            targetPath={props.targetPath}
          />
        </TocFilterCtx.Provider>
      );
    }
    render(<Host />);
    await waitFor(() => expect(session.active).toBe(true));
    return () => session;
  }

  it("a session pick of the popup's own TARGET closes it — click-again = dismiss, never a self-tag", async () => {
    // the user's bug: right-click the ROOT (the popup opens for `:`), then left-click the root row
    const onPick = vi.fn();
    const onClose = vi.fn();
    const session = await sessionHost({ targetPath: ":", onPick, onClose });
    session().pick(":");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
    expect(mAnnotate).not.toHaveBeenCalled(); // nothing round-trips — no `::` pointer is ever spelled
  });

  it("a session pick of the ROOT (when it is NOT the target) is silently IGNORED", async () => {
    // the root has no project-scope pointer spelling (`::` needs a first portion), so it can never
    // be a tag — and a modal alert for a stray click would out-annoy the mistake: just ignore
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    const onPick = vi.fn();
    const onClose = vi.fn();
    const session = await sessionHost({ targetPath: ":doc.md", onPick, onClose });
    session().pick(":");
    expect(alert).not.toHaveBeenCalled(); // no modal — the pick is just a no-op
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled(); // the popup stays open
    alert.mockRestore();
  });

  it("a session pick of an ALREADY-APPLIED tag toggles it OFF — a TOC row obeys the chips' rule", async () => {
    const math = { path: ":topics:math", name: "Mathematics", color: null };
    mFetchNode.mockResolvedValue({ path: ":topics:math", type: "object", concrete: null, title: "Mathematics", description: null, value: {} });
    const onPick = vi.fn();
    const onUnpick = vi.fn();
    const session = await sessionHost({ targetPath: ":doc.md", applied: [math], onPick, onUnpick });
    session().pick(":topics:math");
    await waitFor(() => expect(onUnpick).toHaveBeenCalledWith(math));
    expect(onPick).not.toHaveBeenCalled();
  });
});

// ---- Enter semantics: a miss rings in place (no modal); a match ASSIGNS (never toggles off) ---- //
describe("AnnotationMenu — Enter commit semantics", () => {
  it("a MISSED non-creatable query keeps the cells RINGED and editable — no modal, no commit", async () => {
    // "x?y" carries an operator → not create-on-miss eligible; the filter finds nothing (the
    // user's `ontos: colors: yell` case). Enter must NOT pop a modal "no such node" — the typed
    // query stays visible with the error ring, ready for correction.
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    const onPick = vi.fn();
    const { container } = render(<AnnotationMenu x={0} y={0} applied={[]} mode="create" onPick={onPick} onUnpick={() => {}} onClose={() => {}} />);
    const cell = [...container.querySelectorAll<HTMLElement>(".annotate-cells .crumb-cell")].pop()!;
    fireEvent.focus(cell);
    cell.textContent = "x?y";
    fireEvent.input(cell);
    fireEvent.keyDown(cell, { key: "Enter" });
    await waitFor(() => expect(container.querySelector(".crumb-cell.edit-error")).toBeTruthy()); // the ring
    expect(cell.textContent).toBe("x?y"); // still visible, still editable
    expect(alert).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  it("Enter on an ALREADY-APPLIED tag is a satisfied no-op — assign, never a toggle-off", async () => {
    const done = { path: ":ontos:done", name: "done", color: null };
    mQueryFilter.mockResolvedValue({
      root: { path: ":", label: "r", type: "object", format: null, concrete: null, hasChildren: false, children: [] },
      matches: [":ontos:done"],
      truncated: false,
    });
    mFetchNode.mockResolvedValue({ path: ":ontos:done", type: "object", concrete: null, title: null, description: null, value: {} });
    const onPick = vi.fn();
    const onUnpick = vi.fn();
    const { container } = render(<AnnotationMenu x={0} y={0} applied={[done]} mode="create" onPick={onPick} onUnpick={onUnpick} onClose={() => {}} />);
    const cell = [...container.querySelectorAll<HTMLElement>(".annotate-cells .crumb-cell")].pop()!;
    fireEvent.focus(cell);
    cell.textContent = "done";
    fireEvent.input(cell);
    fireEvent.keyDown(cell, { key: "Enter" });
    await waitFor(() => expect(mFetchNode).toHaveBeenCalled()); // the match resolved…
    await new Promise((r) => setTimeout(r, 0)); // …and the assign settled
    expect(onUnpick).not.toHaveBeenCalled(); // typing the tag again must not UN-tag it
    expect(onPick).not.toHaveBeenCalled(); // already assigned — nothing to re-apply
  });
});

// ---- recents: the root can never be a suggested tag ---- //
describe("recent tags — the root is never filed nor surfaced", () => {
  it("filters a stale ':' recent from storage and refuses to file the root anew", async () => {
    const { rememberTag } = await import("../../src/client/renderers/annotate");
    const { readRecents, _resetRecentsCacheForTests } = await import("../../src/client/recents");
    _resetRecentsCacheForTests();
    // the mocked config has no `uri` and no fetchInfo — the project key falls back to "local"
    const KEY = "yo-recents:bookmarks:local";
    // a stale localStorage list may hold the root: a failed root-tag attempt used to file it
    // BEFORE the write round-trip — it then showed as a bare ':' chip in every popup
    localStorage.setItem(KEY, JSON.stringify([
      { path: ":", name: ":", color: null },
      { path: ":ontos:ok", name: "ok", color: null },
    ]));
    expect((await readRecents("bookmarks")).map((t) => t.path)).toEqual([":ontos:ok"]); // the stale root is invisible
    rememberTag({ path: ":", name: ":", color: null }); // and can never be filed again
    await new Promise((r) => setTimeout(r, 0)); // recordRecent is fire-and-forget
    expect((await readRecents("bookmarks")).some((t) => t.path === ":")).toBe(false);
  });

  it("files a picked tag under the PROJECT key, newest first, deduped on the canonical path", async () => {
    const { recordRecent, readRecents, _resetRecentsCacheForTests, MAX_RECENTS } = await import("../../src/client/recents");
    _resetRecentsCacheForTests();
    const KEY = "yo-recents:bookmarks:local";
    recordRecent("bookmarks", { path: ":ontos:a", name: "a", color: null });
    await new Promise((r) => setTimeout(r, 0));
    recordRecent("bookmarks", { path: ":ontos:b", name: "b", color: null });
    await new Promise((r) => setTimeout(r, 0));
    recordRecent("bookmarks", { path: "::ontos:a", name: "a", color: null }); // same node, scope-spelled
    await new Promise((r) => setTimeout(r, 0));
    expect((await readRecents("bookmarks")).map((t) => t.path)).toEqual(["::ontos:a", ":ontos:b"]);
    expect(JSON.parse(localStorage.getItem(KEY)!).length).toBeLessThanOrEqual(MAX_RECENTS);
    // the color palette never files — the swatch row already shows those
    recordRecent("bookmarks", { path: "::yamlover:ontos:colors:sky", name: "sky", color: "#89dceb" });
    await new Promise((r) => setTimeout(r, 0));
    expect((await readRecents("bookmarks")).some((t) => t.name === "sky")).toBe(false);
    // the references bag is its OWN list — a bookmark record never leaks into it
    expect(await readRecents("references")).toEqual([]);
  });
});

// ---- the right-click driver: load → add → remove ---- //
describe("useExplorerTagMenu — right-click whole-node tagging", () => {
  function Harness() {
    const { openAt, tagMenu } = useExplorerTagMenu();
    return (
      <div>
        <button onClick={() => openAt(":doc.md", 5, 5)}>open</button>
        {tagMenu}
      </div>
    );
  }
  it("loads the target's tags, removes via a chip, and adds via a swatch", async () => {
    mAnns.mockResolvedValue([{ tag: { path: ":ontos:keep", name: "keep", color: null } }]);
    render(<Harness />);
    fireEvent.click(screen.getByText("open"));

    // the applied chip shows the NAME (its full path lives on the hover-card now, not a title)
    await waitFor(() => expect(screen.getByText("keep")).toBeTruthy());
    expect(screen.getByText("keep").textContent).toBe("keep");
    expect(mAnns).toHaveBeenCalledWith(":doc.md");

    // clicking the applied chip → deleteAnnotation(target, tagPath)
    fireEvent.click(screen.getByText("keep"));
    expect(mDelete).toHaveBeenCalledWith(":doc.md", ":ontos:keep");

    // a color swatch → annotate({ target, tag })
    fireEvent.click(document.querySelector(".annotate-swatch")!);
    expect(mAnnotate).toHaveBeenCalledTimes(1);
    expect(mAnnotate.mock.calls[0][0].target).toBe(":doc.md");
  });

  it("does NOT auto-apply any tag when a whole node opens with no tags (a right-click never tags silently)", async () => {
    mAnns.mockResolvedValue([]); // an untagged node
    render(<Harness />);
    fireEvent.click(screen.getByText("open"));
    await waitFor(() => expect(mAnns).toHaveBeenCalledWith(":doc.md")); // it loaded the node's tags…
    expect(mAnnotate).not.toHaveBeenCalled(); // …but writes nothing just for opening (that is region tagging's job)
  });

  it("ignores FRAGMENT annotations — an image with a tagged REGION is not itself tagged", async () => {
    // the node's only annotation is on a fragment (a tagged region), marked by `fragmentSlug`
    mAnns.mockResolvedValue([{ tag: { path: ":ontos:верхушка", name: "верхушка", color: null }, fragmentSlug: "abc" }]);
    render(<Harness />);
    fireEvent.click(screen.getByText("open"));
    await waitFor(() => expect(mAnns).toHaveBeenCalledWith(":doc.md"));
    expect(screen.queryByText("верхушка")).toBeNull(); // the fragment's tag is not a whole-node tag
    expect(mAnnotate).not.toHaveBeenCalled(); // and nothing is auto-applied
  });

  it("a mousedown in the PORTALED candidate dropdown never closes the popup (a body click does)", async () => {
    mAnns.mockResolvedValue([]);
    render(<Harness />);
    fireEvent.click(screen.getByText("open"));
    await waitFor(() => expect(document.querySelector(".annotate-menu")).toBeTruthy());
    // the query cells' dropdown is portaled to document.body — OUTSIDE the menu's own DOM. A
    // mousedown there must not read as an outside click (it used to cancel the whole popup
    // before the candidate PICK could land; only Tab worked).
    const dd = document.createElement("div");
    dd.className = "crumb-dd";
    const row = document.createElement("div");
    dd.appendChild(row);
    document.body.appendChild(dd);
    fireEvent.mouseDown(row);
    expect(document.querySelector(".annotate-menu")).toBeTruthy(); // still open — the pick can land
    dd.remove();
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(document.querySelector(".annotate-menu")).toBeNull()); // a true outside click closes
  });

  it("picking a palette tag APPLIES it to the node (no project-scoped 'last tag' persistence)", async () => {
    mAnns.mockResolvedValue([]);
    render(<Harness />);
    fireEvent.click(screen.getByText("open"));
    fireEvent.click(document.querySelector(".annotate-swatch")!); // pick a palette color
    await waitFor(() => expect(mAnnotate).toHaveBeenCalled());
    expect(typeof mAnnotate.mock.calls[0][0].tag).toBe("string"); // annotate({ target, tag })
  });
});
