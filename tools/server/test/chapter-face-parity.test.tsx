// @vitest-environment jsdom
// THE CHAPTER FACE-PARITY GATE — the read renderer (ChapterView) and the yed chapter editor,
// mounted from ONE real handler over the deep-book fixture, must present the SAME content.
// Both faces load the ONE WIRE now (fetchNode derives from /api/content; the editor parses
// it), so any disagreement is a WALK-RULE divergence, not a data one.
//
// The six Stage-5 divergences are UNIFIED now (roles.ts — the shared decision table): each
// former `it.todo` row below is an assertion pinning one row of the table.
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { createHandlers, tmpExample, tmpTree } from "./helpers";
import { installFetch } from "./edit-corpus-harness";
import { fetchNode } from "../src/client/api";
import { ChapterView } from "../src/client/renderers/chapter";
import { YedChapterEditor } from "../src/client/renderers/yed-chapter-editor";

afterEach(cleanup);

/** A face's chunk gutters: the crumb arrays, in page order. */
const guttersOf = (root: HTMLElement): string[][] =>
  Array.from(root.querySelectorAll(".chunk-index")).map((g) =>
    Array.from(g.querySelectorAll(".chunk-crumb")).map((c) => c.textContent ?? ""));

interface Faces {
  read: string[][];
  edit: string[][];
  readEl: HTMLElement;
  editEl: HTMLElement;
  done: () => void;
}

async function mountBoth(path: string, files?: Record<string, string>): Promise<Faces> {
  const h = createHandlers(files ? tmpTree(files) : tmpExample("74-deep-book"), { gitignore: false });
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
    readEl: read.container,
    editEl: edit.container,
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

  it("keyed planning fields are BODY in both faces (part-one's `status`)", async () => {
    const { read, edit, readEl, editEl, done } = await mountBoth(":part-one");
    try {
      expect(read).toContainEqual(["status"]); // the key IS the gutter label (roles row 1)
      expect(edit).toContainEqual(["status"]);
      // …and the field's VALUE shows as chunk content in both faces
      expect(readEl.textContent).toContain("draft");
      expect(editEl.textContent).toContain("draft");
    } finally { done(); }
  }, 30_000);

  it("keyed-remainder members show in both faces (part-one's `stray`)", async () => {
    const { readEl, editEl, done } = await mountBoth(":part-one");
    try {
      // stray/ is walked keyed-only (no granting line) — a keyed CONTAINER member, so it
      // folds as a subchapter in both faces, its title visible on the page
      expect(readEl.textContent).toContain("Stray Member");
      expect(editEl.textContent).toContain("Stray Member");
    } finally { done(); }
  }, 30_000);

  it("the title's selfAt row is honored in both faces (01-deep's quote above the title)", async () => {
    const { readEl, editEl, done } = await mountBoth(":part-one:01-deep");
    try {
      for (const el of [readEl, editEl]) {
        const text = el.textContent ?? "";
        const quote = text.indexOf("The quote ABOVE the title");
        const title = text.indexOf("Deep Chapter");
        expect(quote, "the quote chunk renders").toBeGreaterThanOrEqual(0);
        expect(title, "the title renders").toBeGreaterThanOrEqual(0);
        expect(quote, "the quote stays ABOVE the title (selfAt = 1)").toBeLessThan(title);
      }
    } finally { done(); }
  }, 30_000);

  it("a legacy keyed `title:` is the heading in both faces (appendix)", async () => {
    const { read, edit, readEl, editEl, done } = await mountBoth(":appendix");
    try {
      // a heading's text lives in textContent (read) or the active title INPUT's value (edit)
      const headingText = (t: Element): string =>
        (t.textContent ?? "") + Array.from(t.querySelectorAll("input")).map((i) => i.value).join("");
      for (const el of [readEl, editEl]) {
        const heading = Array.from(el.querySelectorAll(".chapter-title"))
          .find((t) => headingText(t).includes("The Appendix"));
        expect(heading, "the legacy keyed title renders as the HEADING").toBeTruthy();
      }
      expect(read, "no chunk gutter cites the title key").not.toContainEqual(["title"]);
      expect(edit, "no chunk gutter cites the title key").not.toContainEqual(["title"]);
    } finally { done(); }
  }, 30_000);

  it("a body-positioned member named `description` stays body in both faces", async () => {
    const { readEl, editEl, done } = await mountBoth(":d", {
      "d/.yo/body.yo": "!!<*yamlover: $defs: chapter>\nHost\n- the real opening\n- *: description\n",
      "d/description/.yo/body.yo": "the member that merely SHARES the field's name\n",
    });
    try {
      for (const el of [readEl, editEl]) {
        // anchorKey is storage provenance, not a field (roles row 5): the member is a chunk,
        // never the page subtitle
        expect(el.querySelector(".chapter-subtitle")?.textContent ?? "").not.toContain("SHARES the field's name");
        expect(el.textContent).toContain("SHARES the field's name");
      }
    } finally { done(); }
  }, 30_000);

  it("overlay keys are hidden in both faces (the annotated chunk's yamlover-annotations)", async () => {
    const { read, edit, readEl, editEl, done } = await mountBoth(":part-two");
    try {
      expect(readEl.textContent).toContain("Annotated prose carries an overlay.");
      expect(editEl.textContent).toContain("Annotated prose carries an overlay.");
      expect(readEl.textContent).not.toContain("yamlover-annotations");
      expect(editEl.textContent).not.toContain("yamlover-annotations");
      expect(read, "the overlay never takes a gutter").not.toContainEqual(["yamlover-annotations"]);
      expect(edit, "the overlay never takes a gutter").not.toContainEqual(["yamlover-annotations"]);
    } finally { done(); }
  }, 30_000);
});

describe("the chapter face-parity gate — membership tag chips", () => {
  it("chunk and subchapter tags chip identically in both faces; the root title stays bare", async () => {
    const { readEl, editEl, done } = await mountBoth(":host", {
      "host/.yo/body.yo": "!!<*yamlover: $defs: chapter>\nHost\n&::ontos:rooty:-\n- the opening chunk\n  &::ontos:urgent:-\n- *: sub\n",
      "host/sub/.yo/body.yo": "Sub Chapter\n&::ontos:review:-\n- inner text\n",
      "ontos/.yo/body.yo": "!!<*yamlover:$defs:onto>\nrooty: !!<*yamlover:$defs:onto> Rooty\nurgent: !!<*yamlover:$defs:onto> Urgent\nreview: !!<*yamlover:$defs:onto> Review\n",
    });
    try {
      await waitFor(() => {
        for (const [face, el] of [["read", readEl], ["edit", editEl]] as const) {
          // the chunk's chip row, resolved to the tag's title
          const chunkChips = Array.from(el.querySelectorAll(".chunk-tags .tagtag")).map((c) => c.textContent);
          expect(chunkChips, `${face}: chunk chips`).toEqual(["Urgent"]);
          // the subchapter's heading chip
          const titleChips = Array.from(el.querySelectorAll(".title-tags .tagtag")).map((c) => c.textContent);
          expect(titleChips, `${face}: title chips`).toEqual(["Review"]);
          // the page ROOT's own tag never rides the body (the header bar owns it)
          expect(el.textContent, `${face}: root tag leaked`).not.toContain("Rooty");
        }
      });
    } finally { done(); }
  }, 30_000);
});
