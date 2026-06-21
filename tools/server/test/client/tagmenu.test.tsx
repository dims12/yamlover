// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

// The whole client api is mocked: AnnotationMenu's hooks (useColorTags → fetchNode, useTagIndex →
// query, pruneRememberedTags → fetchNode) fall back gracefully, and the right-click menu's writes
// (annotate / deleteAnnotation / fetchAnnotations) are observed directly.
vi.mock("../../src/client/api", () => ({
  fetchConfig: vi.fn().mockResolvedValue({ source: "", settings: { exports: [], annotations: ":annotations", tags: ":tags", sidecars: "per-directory" }, path: ":.yamlover:settings.yamlover" }),
  saveLastTag: vi.fn().mockResolvedValue({ ok: true }),
  fetchAnnotations: vi.fn().mockResolvedValue([]),
  annotate: vi.fn().mockResolvedValue({ ok: true }),
  deleteAnnotation: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
  fetchNode: vi.fn().mockRejectedValue(new Error("no node")),
  createTag: vi.fn(),
}));

import { AnnotationMenu, indexToRefs } from "../../src/client/renderers/annotate";
import { useExplorerTagMenu } from "../../src/client/renderers/tagmenu";
import { fetchAnnotations, annotate, deleteAnnotation, query, saveLastTag } from "../../src/client/api";

const mAnns = fetchAnnotations as unknown as ReturnType<typeof vi.fn>;
const mAnnotate = annotate as unknown as ReturnType<typeof vi.fn>;
const mDelete = deleteAnnotation as unknown as ReturnType<typeof vi.fn>;
const mQuery = query as unknown as ReturnType<typeof vi.fn>;
const mSaveLastTag = saveLastTag as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  mAnns.mockReset().mockResolvedValue([]);
  mAnnotate.mockClear();
  mDelete.mockClear();
  mQuery.mockReset().mockResolvedValue([]);
});
afterEach(cleanup);

// ---- the typeahead index: collapse the `yamlover` self-import graft duplicates ---- //
describe("indexToRefs — a tag is just a node (both namespaces listed)", () => {
  it("lists a project's OWN tag and the GLOBAL self-import tag as DISTINCT nodes (IMPORTS.md)", () => {
    // `:tags:…` (project-own, document-root) and `:yamlover:tags:…` (global self-import) are
    // different nodes — both belong in the picker. Only an EXACT duplicate path collapses.
    const refs = indexToRefs([
      ":tags:workflow:dev:ready",
      ":yamlover:tags:workflow:dev:ready", // a DIFFERENT node (the global one) — kept too
      ":tags:workflow:dev:ready", // an exact dup of the first — collapsed
    ]);
    expect(refs.map((r) => r.path)).toEqual([":tags:workflow:dev:ready", ":yamlover:tags:workflow:dev:ready"]);
    expect(refs.map((r) => r.name)).toEqual(["ready", "ready"]);
  });
  it("keeps each tag at its REAL path and drops the color palette (the swatch row)", () => {
    const refs = indexToRefs([":yamlover:tags:misc:foo", ":tags:colors:yellow", ":yamlover:tags:colors:red"]);
    expect(refs.map((r) => r.name)).toEqual(["foo"]);
    expect(refs[0].path).toBe(":yamlover:tags:misc:foo"); // real path, not rewritten
  });
});

// ---- no browse tree: empty input is quiet; typing shows the flat list; HOVER reveals the path ---- //
describe("AnnotationMenu — no tree; hover-card reveals the path", () => {
  it("shows no tree on empty input, flat suggestions on typing, and the canonical path on hover", async () => {
    mQuery.mockResolvedValue([":tags:workflow:dev:ready", ":tags:workflow:dev:done", ":tags:first tag"]);
    const { container } = render(<AnnotationMenu x={0} y={0} applied={[]} mode="create" onPick={() => {}} onUnpick={() => {}} onClose={() => {}} />);
    // the browse tree was removed — empty input never renders one
    await waitFor(() => expect(mQuery).toHaveBeenCalled());
    expect(container.querySelector(".annotate-tree")).toBeNull();
    // typing → the flat ranked suggestions (still no tree)
    fireEvent.change(container.querySelector(".annotate-taginput")!, { target: { value: "rea" } });
    await waitFor(() => expect(container.querySelector(".annotate-suggest")).toBeTruthy());
    expect(container.querySelector(".annotate-tree")).toBeNull();
    // hovering a suggestion reveals its path canonically — `tags:` prefix dropped, space after colon
    fireEvent.mouseEnter(container.querySelector(".annotate-suggest .tagtip-anchor")!);
    await waitFor(() => expect(document.querySelector(".tagtip-path")?.textContent).toBe("workflow: dev: ready"));
  });
});

// ---- applied tags are OUTLINED (toggle), shown once, never as a duplicate chip ---- //
describe("AnnotationMenu — applied tags outline, no duplicates", () => {
  const NAMED = { path: ":tags:done", name: "done", color: "#a6e3a1" };

  it("outlines an applied NAMED tag (once) and toggles it OFF via onUnpick", () => {
    const onPick = vi.fn();
    const onUnpick = vi.fn();
    const { container } = render(<AnnotationMenu x={0} y={0} applied={[NAMED]} mode="create" onPick={onPick} onUnpick={onUnpick} onClose={() => {}} />);
    // the applied named tag is shown ONCE, as an OUTLINED badge (no separate "current" chip)
    const badges = [...container.querySelectorAll(".annotate-recents .tagtag")].map((b) => b.textContent);
    expect(badges).toEqual(["done"]);
    expect(container.querySelector(".annotate-recents .tagtag.on")?.textContent).toBe("done");
    expect(container.querySelector(".annotate-current")).toBeNull(); // the ad-hoc row is gone
    // clicking the applied badge toggles it OFF (remove), not add
    fireEvent.click(screen.getByText("done"));
    expect(onUnpick).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("outlines an applied COLOR tag on its SWATCH — never as a duplicate badge", () => {
    const yellow = { path: "::yamlover:tags:colors:yellow", name: "yellow", color: "#f9e2af" };
    const { container } = render(<AnnotationMenu x={0} y={0} applied={[yellow]} mode="create" onPick={() => {}} onUnpick={() => {}} onClose={() => {}} />);
    // a color tag stays in the swatch row (outlined), and does NOT appear as a named badge
    expect([...container.querySelectorAll(".annotate-recents .tagtag")].map((b) => b.textContent)).toEqual([]);
    expect(container.querySelector(".annotate-swatch.on")).toBeTruthy();
  });
});

// ---- the typeahead shows each NAME once, even for two genuinely-different homonym tags ---- //
describe("AnnotationMenu — typeahead dedupes suggestions by name", () => {
  it("shows one 'ready' chip when two distinct tags are both named 'ready'", async () => {
    // two REAL tags (different paths, NOT graft duplicates of each other) that read the same
    mQuery.mockResolvedValue([":tags:ready", ":tags:workflow:dev:ready"]);
    const { container } = render(<AnnotationMenu x={0} y={0} applied={[]} mode="create" onPick={() => {}} onUnpick={() => {}} onClose={() => {}} />);
    fireEvent.change(container.querySelector(".annotate-taginput")!, { target: { value: "rea" } });
    await waitFor(() => {
      const sugg = [...container.querySelectorAll(".annotate-suggest .tagtag")].map((b) => b.textContent);
      expect(sugg).toEqual(["ready"]); // one chip, not two identical "ready"
    });
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
    mAnns.mockResolvedValue([{ tag: { path: ":tags:keep", name: "keep", color: null } }]);
    render(<Harness />);
    fireEvent.click(screen.getByText("open"));

    // the applied chip shows the NAME (its full path lives on the hover-card now, not a title)
    await waitFor(() => expect(screen.getByText("keep")).toBeTruthy());
    expect(screen.getByText("keep").textContent).toBe("keep");
    expect(mAnns).toHaveBeenCalledWith(":doc.md");

    // clicking the applied chip → deleteAnnotation(target, tagPath)
    fireEvent.click(screen.getByText("keep"));
    expect(mDelete).toHaveBeenCalledWith(":doc.md", ":tags:keep");

    // a color swatch → annotate({ target, tag })
    fireEvent.click(document.querySelector(".annotate-swatch")!);
    expect(mAnnotate).toHaveBeenCalledTimes(1);
    expect(mAnnotate.mock.calls[0][0].target).toBe(":doc.md");
  });

  it("pre-applies the default tag immediately when the node opens with NO tags", async () => {
    mAnns.mockResolvedValue([]); // an untagged node
    render(<Harness />);
    fireEvent.click(screen.getByText("open"));
    // opening writes the seed tag at once (it then shows checked; click to remove). The seed is the
    // project default (settings.yamlover annotation-tag, IMPORTS.md); the mocked config has none, so
    // it is the palette default — assert SOME tag is auto-applied to this target.
    await waitFor(() => expect(mAnnotate).toHaveBeenCalledWith(expect.objectContaining({ target: ":doc.md" })));
  });

  it("picking a tag PERSISTS it as the project default (saveLastTag), not browser localStorage", async () => {
    mAnns.mockResolvedValue([]);
    render(<Harness />);
    fireEvent.click(screen.getByText("open"));
    fireEvent.click(document.querySelector(".annotate-swatch")!); // pick a palette color
    await waitFor(() => expect(mSaveLastTag).toHaveBeenCalled());
    expect(typeof mSaveLastTag.mock.calls[0][0]).toBe("string"); // a tag path
  });
});
