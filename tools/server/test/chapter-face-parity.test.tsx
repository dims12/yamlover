// @vitest-environment jsdom
// THE CHAPTER FACE-PARITY GATE — the read renderer (ChapterView) and the yed chapter editor,
// mounted from ONE real handler over the deep-book fixture, must present the SAME content.
// Both faces load the ONE WIRE now (fetchNode derives from /api/content; the editor parses
// it), so any disagreement is a WALK-RULE divergence, not a data one.
//
// The known divergences are the Stage-5 unification targets (roles.ts) — recorded here as
// `it.todo` rows and flipped to assertions when the shared rule lands:
//   1. keyed non-title/description entries: read DROPS them, edit shows them as chunks
//   2. title placement: read honors selfAt, edit always draws the title first
//   3. the title test: read wants an omni STRING, edit takes any self-value
//   4. legacy keyed `title:`: read flows it as the heading, edit as a body chunk
//   5. the description gate: edit excludes anchorKey'd members named `description`
//   6. overlay keys (`yamlover-annotations`): read hides them, edit walks into them
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { createHandlers, tmpExample } from "./helpers";
import { installFetch } from "./edit-corpus-harness";
import { fetchNode } from "../src/client/api";
import { ChapterView } from "../src/client/renderers/chapter";
import { YedChapterEditor } from "../src/client/renderers/yed-chapter-editor";

afterEach(cleanup);

/** A face's chunk gutters: the crumb arrays, in page order. */
const guttersOf = (root: HTMLElement): string[][] =>
  Array.from(root.querySelectorAll(".chunk-index")).map((g) =>
    Array.from(g.querySelectorAll(".chunk-crumb")).map((c) => c.textContent ?? ""));

async function mountBoth(path: string): Promise<{ read: string[][]; edit: string[][]; done: () => void }> {
  const h = createHandlers(tmpExample("74-deep-book"), { gitignore: false });
  await h.ready;
  const restore = installFetch(h);
  window.history.replaceState({}, "", "/?depth=.inf");
  const node = await fetchNode(path, null);
  const read = render(<ChapterView node={node} onNavigate={() => {}} />);
  await waitFor(() => expect(read.container.querySelector(".chapter")).toBeTruthy());
  const edit = render(<YedChapterEditor path={path} onNavigate={() => {}} />);
  await waitFor(() => expect(edit.container.querySelector(".chapter-wysiwyg")).toBeTruthy());
  return {
    read: guttersOf(read.container),
    edit: guttersOf(edit.container),
    done: () => { read.unmount(); edit.unmount(); restore(); },
  };
}

describe("the chapter face-parity gate — examples/74-deep-book", () => {
  it("a page with no keyed fields lists the SAME chunk gutters in both faces (item01)", async () => {
    const { read, edit, done } = await mountBoth(":part-one:item01");
    try {
      expect(edit).toEqual(read);
      expect(read.length).toBeGreaterThan(2); // the lists/table/back-edge chunks are all there
    } finally { done(); }
  }, 30_000);

  // the Stage-5 rows — each currently FAILS on part-one (status field, stray member) or
  // appendix (legacy keyed title, selfAt) and flips to an assertion with roles.ts:
  it.todo("keyed planning fields are BODY in both faces (part-one's `status`)");
  it.todo("keyed-remainder members show in both faces (part-one's `stray`)");
  it.todo("the title's selfAt row is honored in both faces (01-deep's quote above the title)");
  it.todo("a legacy keyed `title:` is the heading in both faces (appendix)");
  it.todo("a member named `description` stays body in both faces");
  it.todo("overlay keys are hidden in both faces (the annotated chunk's yamlover-annotations)");
});
