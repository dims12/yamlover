// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

// The whole client api is mocked: AnnotationMenu's hooks (useColorTags → fetchNode, useTagIndex →
// query, pruneRememberedTags → fetchNode) fall back gracefully, and the right-click menu's writes
// (annotate / deleteAnnotation / fetchAnnotations) are observed directly.
vi.mock("../../src/client/api", () => ({
  fetchConfig: vi.fn().mockResolvedValue({ source: "", settings: { exports: [], annotations: ":annotations", tags: ":tags", sidecars: "per-directory" }, path: ":.yamlover:settings.yamlover" }),
  fetchAnnotations: vi.fn().mockResolvedValue([]),
  annotate: vi.fn().mockResolvedValue({ ok: true }),
  deleteAnnotation: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
  fetchNode: vi.fn().mockRejectedValue(new Error("no node")),
  createTag: vi.fn(),
}));

import { AnnotationMenu, indexToRefs } from "../../src/client/renderers/annotate";
import { useExplorerTagMenu } from "../../src/client/renderers/tagmenu";
import { fetchAnnotations, annotate, deleteAnnotation, query } from "../../src/client/api";

const mAnns = fetchAnnotations as unknown as ReturnType<typeof vi.fn>;
const mAnnotate = annotate as unknown as ReturnType<typeof vi.fn>;
const mDelete = deleteAnnotation as unknown as ReturnType<typeof vi.fn>;
const mQuery = query as unknown as ReturnType<typeof vi.fn>;

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
  it("shows no tree; typing filters the chip row to ranked matches; HOVER reveals the canonical path", async () => {
    mQuery.mockResolvedValue([":tags:workflow:dev:ready", ":tags:workflow:dev:done", ":tags:first tag"]);
    const { container } = render(<AnnotationMenu x={0} y={0} applied={[]} mode="create" onPick={() => {}} onUnpick={() => {}} onClose={() => {}} />);
    // the browse tree was removed — never rendered
    await waitFor(() => expect(mQuery).toHaveBeenCalled());
    expect(container.querySelector(".annotate-tree")).toBeNull();
    // typing → the chip row filters to the ranked match (still no tree)
    fireEvent.change(container.querySelector(".annotate-taginput")!, { target: { value: "rea" } });
    await waitFor(() => expect([...container.querySelectorAll(".annotate-recents .tagtag")].map((b) => b.textContent)).toEqual(["ready"]));
    expect(container.querySelector(".annotate-tree")).toBeNull();
    // hovering a chip reveals its path canonically — `tags:` prefix dropped, space after colon
    fireEvent.mouseEnter(container.querySelector(".annotate-recents .tagtip-anchor")!);
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
describe("AnnotationMenu — typeahead dedupes the filtered chips by name", () => {
  it("shows one 'ready' chip when two distinct tags are both named 'ready'", async () => {
    // two REAL tags (different paths, NOT graft duplicates of each other) that read the same
    mQuery.mockResolvedValue([":tags:ready", ":tags:workflow:dev:ready"]);
    const { container } = render(<AnnotationMenu x={0} y={0} applied={[]} mode="create" onPick={() => {}} onUnpick={() => {}} onClose={() => {}} />);
    fireEvent.change(container.querySelector(".annotate-taginput")!, { target: { value: "rea" } });
    await waitFor(() => {
      const chips = [...container.querySelectorAll(".annotate-recents .tagtag")].map((b) => b.textContent);
      expect(chips).toEqual(["ready"]); // one chip, not two identical "ready"
    });
  });
});

// ---- default chips: the four sources shown without typing (graft · config location · node · recents) ---- //
describe("AnnotationMenu — default chips from the four sources", () => {
  it("shows grafted + configured-location tags as chips without typing; out-of-scope tags only via the typeahead", async () => {
    // settings.tags is ":tags" (the mocked config). The graft lives at :yamlover:tags; a sub-document's
    // own taxonomy (:67-pdf-tags:tags) is OUT of scope — reachable by typing, not a default chip.
    mQuery.mockResolvedValue([":yamlover:tags:fifth tag", ":tags:mine", ":67-pdf-tags:tags:genre:humor"]);
    const { container } = render(<AnnotationMenu x={0} y={0} applied={[]} mode="create" onPick={() => {}} onUnpick={() => {}} onClose={() => {}} />);
    await waitFor(() => {
      const chips = [...container.querySelectorAll(".annotate-recents .tagtag")].map((b) => b.textContent);
      expect(chips).toContain("fifth tag"); // (1) grafted yamlover
      expect(chips).toContain("mine"); // (2) configured tags location
      expect(chips).not.toContain("humor"); // out of scope → not a default chip
    });
    // typing reaches the out-of-scope tag
    fireEvent.change(container.querySelector(".annotate-taginput")!, { target: { value: "hum" } });
    await waitFor(() => expect([...container.querySelectorAll(".annotate-recents .tagtag")].map((b) => b.textContent)).toEqual(["humor"]));
  });

  it("shows tags borne by OTHER components of the node (nodeTags) as default chips", async () => {
    mQuery.mockResolvedValue([]);
    const sib = { path: ":tags:sibling", name: "sibling", color: null };
    const { container } = render(<AnnotationMenu x={0} y={0} applied={[]} nodeTags={[sib]} mode="create" onPick={() => {}} onUnpick={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(mQuery).toHaveBeenCalled());
    expect([...container.querySelectorAll(".annotate-recents .tagtag")].map((b) => b.textContent)).toContain("sibling"); // (3)
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

  it("does NOT auto-apply any tag when a whole node opens with no tags (a right-click never tags silently)", async () => {
    mAnns.mockResolvedValue([]); // an untagged node
    render(<Harness />);
    fireEvent.click(screen.getByText("open"));
    await waitFor(() => expect(mAnns).toHaveBeenCalledWith(":doc.md")); // it loaded the node's tags…
    expect(mAnnotate).not.toHaveBeenCalled(); // …but writes nothing just for opening (that is region tagging's job)
  });

  it("ignores FRAGMENT annotations — an image with a tagged REGION is not itself tagged", async () => {
    // the node's only annotation is on a fragment (a tagged region), marked by `fragmentSlug`
    mAnns.mockResolvedValue([{ tag: { path: ":tags:верхушка", name: "верхушка", color: null }, fragmentSlug: "abc" }]);
    render(<Harness />);
    fireEvent.click(screen.getByText("open"));
    await waitFor(() => expect(mAnns).toHaveBeenCalledWith(":doc.md"));
    expect(screen.queryByText("верхушка")).toBeNull(); // the fragment's tag is not a whole-node tag
    expect(mAnnotate).not.toHaveBeenCalled(); // and nothing is auto-applied
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
