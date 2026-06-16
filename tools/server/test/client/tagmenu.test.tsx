// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

// The whole client api is mocked: AnnotationMenu's hooks (useColorTags → fetchNode, useTagIndex →
// query, pruneRememberedTags → fetchNode) fall back gracefully, and the right-click menu's writes
// (annotate / deleteAnnotation / fetchAnnotations) are observed directly.
vi.mock("../../src/client/api", () => ({
  fetchAnnotations: vi.fn().mockResolvedValue([]),
  annotate: vi.fn().mockResolvedValue({ ok: true }),
  deleteAnnotation: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
  fetchNode: vi.fn().mockRejectedValue(new Error("no node")),
  createTag: vi.fn(),
}));

import { AnnotationMenu, buildTagTree, indexToRefs } from "../../src/client/renderers/annotate";
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
describe("indexToRefs — graft-aware dedup", () => {
  it("collapses a tag duplicated by the yamlover self-import graft, keeping the real node", () => {
    const refs = indexToRefs([
      ":tags:workflow:dev:ready",
      ":yamlover:tags:workflow:dev:ready", // graft dup of the same tag
      ":yamlover:yamlover:tags:workflow:dev:ready", // doubly-grafted dup
    ]);
    expect(refs.map((r) => r.name)).toEqual(["ready"]); // listed ONCE (was 3× before the fix)
    expect(refs[0].path).toBe(":tags:workflow:dev:ready"); // the real (non-grafted) node is kept
  });
  it("keeps a tag that only exists under the graft, and drops the color palette", () => {
    const refs = indexToRefs([":yamlover:tags:misc:foo", ":tags:colors:yellow", ":yamlover:tags:colors:red"]);
    expect(refs.map((r) => r.name)).toEqual(["foo"]);
    expect(refs[0].path).toBe(":yamlover:tags:misc:foo");
  });
});

// ---- the browse tree: tags nested by their path spine ---- //
describe("buildTagTree — tags nested by spine", () => {
  it("nests tags under their path segments, marking containers vs. selectable tags, in order", () => {
    const tree = buildTagTree([
      { path: ":tags:workflow:dev:ready", name: "ready", color: null },
      { path: ":tags:workflow:dev:done", name: "done", color: null },
      { path: ":tags:first tag", name: "first tag", color: null },
    ]);
    // a single `tags` root container (not itself a tag → no TagRef)
    expect(tree.map((n) => n.seg)).toEqual(["tags"]);
    expect(tree[0].tag).toBeNull();
    const tagsKids = tree[0].children;
    expect(tagsKids.map((n) => n.seg)).toEqual(["workflow", "first tag"]); // insertion order preserved
    // `workflow` is a synthesized container (no tag); `first tag` is a leaf tag
    expect(tagsKids[0].tag).toBeNull();
    expect(tagsKids[1].tag?.name).toBe("first tag");
    // `tags › workflow › dev › {ready, done}`
    const dev = tagsKids[0].children[0];
    expect(dev.seg).toBe("dev");
    expect(dev.children.map((n) => n.tag?.name)).toEqual(["ready", "done"]);
  });

  it("marks an INTERMEDIATE node that is itself a tag as selectable", () => {
    const tree = buildTagTree([
      { path: ":tags:workflow", name: "workflow", color: null }, // the container IS a tag too
      { path: ":tags:workflow:dev:ready", name: "ready", color: null },
    ]);
    expect(tree[0].children[0].seg).toBe("workflow");
    expect(tree[0].children[0].tag?.name).toBe("workflow"); // selectable, not a bare header
  });
});

// ---- BROWSE mode: empty input shows the tree; typing shows the flat list ---- //
describe("AnnotationMenu — browse tree on empty input", () => {
  it("renders the tag tree when the input is empty, and the flat list once typing", async () => {
    mQuery.mockResolvedValue([":tags:workflow:dev:ready", ":tags:workflow:dev:done", ":tags:first tag"]);
    const { container } = render(<AnnotationMenu x={0} y={0} applied={[]} mode="create" onPick={() => {}} onUnpick={() => {}} onClose={() => {}} />);
    // empty input → a tree with container headers + tag chips, mirroring the spine
    await waitFor(() => expect(container.querySelector(".annotate-tree")).toBeTruthy());
    const tree = container.querySelector(".annotate-tree")!;
    expect([...tree.querySelectorAll(".annotate-tree-group")].map((g) => g.textContent)).toContain("workflow");
    expect([...tree.querySelectorAll(".tagtag .tt-label")].map((b) => b.textContent)).toEqual(expect.arrayContaining(["ready", "done", "first tag"]));
    // a tag chip carries its full path on hover
    expect(tree.querySelector(".tagtag")!.getAttribute("title")).toMatch(/^:tags:/);
    // typing switches to the flat ranked suggestions (no tree)
    fireEvent.change(container.querySelector(".annotate-taginput")!, { target: { value: "rea" } });
    await waitFor(() => expect(container.querySelector(".annotate-suggest")).toBeTruthy());
    expect(container.querySelector(".annotate-tree")).toBeNull();
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

    // the applied chip shows the NAME, with its full PATH on hover (title)
    await waitFor(() => expect(screen.getByTitle(":tags:keep")).toBeTruthy());
    expect(screen.getByTitle(":tags:keep").textContent).toBe("keep");
    expect(mAnns).toHaveBeenCalledWith(":doc.md");

    // clicking the applied chip → deleteAnnotation(target, tagPath)
    fireEvent.click(screen.getByTitle(":tags:keep"));
    expect(mDelete).toHaveBeenCalledWith(":doc.md", ":tags:keep");

    // a color swatch → annotate({ target, tag })
    fireEvent.click(document.querySelector(".annotate-swatch")!);
    expect(mAnnotate).toHaveBeenCalledTimes(1);
    expect(mAnnotate.mock.calls[0][0].target).toBe(":doc.md");
  });

  it("pre-applies the last-used tag immediately when the node opens with NO tags", async () => {
    mAnns.mockResolvedValue([]); // an untagged node
    localStorage.setItem("yo-annotate-tag", JSON.stringify({ path: ":tags:fav", name: "fav", color: null }));
    render(<Harness />);
    fireEvent.click(screen.getByText("open"));
    // opening writes the remembered tag at once (it then shows checked; click to remove)
    await waitFor(() => expect(mAnnotate).toHaveBeenCalledWith(expect.objectContaining({ target: ":doc.md", tag: ":tags:fav" })));
  });
});
