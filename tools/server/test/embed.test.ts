import { describe, it, expect } from "vitest";
import { appendBookmark, upsertFragment, removeBookmark, removeMapEntry, bookmarksRemain, keyToken } from "../src/server/embed";

// Surgical embedding of fragments + membership bookmarks into a yamlover host body
// (docs/annotations). Pure string transforms — no fs / Store; the round-trip target is
// "parses back to the same data".

const TAG = "&::ontos:colors:yellow:-";

describe("appendBookmark", () => {
  it("files a fresh whole-document body — the bookmark rides after the value", () => {
    const src = "title: A Paper\n";
    const out = appendBookmark(src, [], [TAG]);
    expect(out).toBe("title: A Paper\n&::ontos:colors:yellow:-\n");
  });

  it("appends after an existing bookmark line", () => {
    const src = "title: A Paper\n&::ontos:colors:green:-\n";
    const out = appendBookmark(src, [], [TAG]);
    expect(out).toBe("title: A Paper\n&::ontos:colors:green:-\n&::ontos:colors:yellow:-\n");
  });

  it("creates a keyed file block in a fresh overlay, then its bookmark", () => {
    const out = appendBookmark("", ["S0002-9904.pdf"], [TAG]);
    expect(out).toBe(`"S0002-9904.pdf":\n  &::ontos:colors:yellow:-\n`);
  });

  it("bookmarks land at the END of an existing keyed block", () => {
    const src = `"a.pdf":\n  size: 12\n`;
    const out = appendBookmark(src, ["a.pdf"], [TAG]);
    expect(out).toBe(`"a.pdf":\n  size: 12\n  &::ontos:colors:yellow:-\n`);
  });

  it("targets a fragment's own memberships, parameter fields riding behind", () => {
    const src = `"a.pdf":\n  yo:\n    fragments:\n      slug1:\n        type: pdf\n        page: 1\n`;
    const out = appendBookmark(src, ["a.pdf", "yo", "fragments", "slug1"], [TAG, `description: "hi"`]);
    expect(out).toBe(
      `"a.pdf":\n  yo:\n    fragments:\n      slug1:\n        type: pdf\n        page: 1\n        &::ontos:colors:yellow:-\n        description: "hi"\n`,
    );
  });
});

describe("upsertFragment", () => {
  const frag = (i: number) => [
    `${" ".repeat(i)}slug1:`,
    `${" ".repeat(i + 2)}type: pdf`,
    `${" ".repeat(i + 2)}page: 1`,
  ];

  it("creates yo: fragments: + the slug on a fresh file block", () => {
    const out = upsertFragment("", ["a.pdf"], "slug1", frag);
    expect(out).toBe(
      `"a.pdf":\n  yo:\n    fragments:\n      slug1:\n        type: pdf\n        page: 1\n`,
    );
  });

  it("adds a second slug into an existing fragments map", () => {
    const src = `"a.pdf":\n  yo:\n    fragments:\n      slug0:\n        type: pdf\n`;
    const out = upsertFragment(src, ["a.pdf"], "slug1", frag);
    expect(out).toBe(
      `"a.pdf":\n  yo:\n    fragments:\n      slug0:\n        type: pdf\n      slug1:\n        type: pdf\n        page: 1\n`,
    );
  });

  it("replaces an existing slug block", () => {
    const src = `"a.pdf":\n  yo:\n    fragments:\n      slug1:\n        type: pdf\n        page: 9\n`;
    const out = upsertFragment(src, ["a.pdf"], "slug1", frag);
    expect(out).toBe(
      `"a.pdf":\n  yo:\n    fragments:\n      slug1:\n        type: pdf\n        page: 1\n`,
    );
  });

  // THE FLAT ROW (docs/language/flattening): the serializer spells the single-child chain as
  // `yo: fragments:` on ONE line. The walk must read it as both keys — descending it as `yo:`
  // alone grew a SECOND nested `fragments:` mapping (the reported doubled
  // `…: yo: fragments: fragments: <slug>` member pointer).
  it("adds a slug under a FLAT `yo: fragments:` row — never a nested duplicate mapping", () => {
    const src = `"a.jpg":\n  yo: fragments:\n    slug0: !!<*::yamlover:$defs:fragment>\n      type: "rect"\n      x: 1\n`;
    const out = upsertFragment(src, ["a.jpg"], "slug1", (i) => [
      `${" ".repeat(i)}slug1:`,
      `${" ".repeat(i + 2)}type: "rect"`,
    ]);
    expect(out).toBe(
      `"a.jpg":\n  yo: fragments:\n    slug0: !!<*::yamlover:$defs:fragment>\n      type: "rect"\n      x: 1\n    slug1:\n      type: "rect"\n`,
    );
    expect(out).not.toContain("fragments:\n    fragments:");
  });

  it("replaces an existing slug under a FLAT `yo: fragments:` row", () => {
    const src = `"a.jpg":\n  yo: fragments:\n    slug0:\n      x: 9\n`;
    const out = upsertFragment(src, ["a.jpg"], "slug0", (i) => [`${" ".repeat(i)}slug0:`, `${" ".repeat(i + 2)}x: 1`]);
    expect(out).toBe(`"a.jpg":\n  yo: fragments:\n    slug0:\n      x: 1\n`);
  });
});

describe("the flat `yo: fragments:` row across the OTHER verbs", () => {
  const FLAT = `"a.jpg":\n  yo: fragments:\n    slug0:\n      type: "rect"\n      ${TAG.slice(0)}\n`;

  it("appendBookmark reaches a fragment under the flat row", () => {
    const src = `"a.jpg":\n  yo: fragments:\n    slug0:\n      type: "rect"\n`;
    const out = appendBookmark(src, ["a.jpg", "yo", "fragments", "slug0"], [TAG]);
    expect(out).toBe(`"a.jpg":\n  yo: fragments:\n    slug0:\n      type: "rect"\n      ${TAG}\n`);
  });

  it("removeBookmark + bookmarksRemain read through the flat row", () => {
    expect(bookmarksRemain(FLAT, ["a.jpg", "yo", "fragments", "slug0"])).toBe(true);
    const out = removeBookmark(FLAT, ["a.jpg", "yo", "fragments", "slug0"], () => true);
    expect(out).toBe(`"a.jpg":\n  yo: fragments:\n    slug0:\n      type: "rect"\n`);
    expect(bookmarksRemain(out, ["a.jpg", "yo", "fragments", "slug0"])).toBe(false);
  });

  it("removeMapEntry drops the slug, and the emptied FLAT row goes as the one line it is", () => {
    const out = removeMapEntry(FLAT, ["a.jpg"], ["yo", "fragments"], "slug0");
    expect(out).toBe(`"a.jpg":\n`);
  });

  it("removeMapEntry keeps the flat row while a sibling slug remains", () => {
    const src = `"a.jpg":\n  yo: fragments:\n    slug0:\n      x: 1\n    slug1:\n      x: 2\n`;
    const out = removeMapEntry(src, ["a.jpg"], ["yo", "fragments"], "slug0");
    expect(out).toBe(`"a.jpg":\n  yo: fragments:\n    slug1:\n      x: 2\n`);
  });
});

describe("removeBookmark", () => {
  it("removes the matching membership line, keeping the others", () => {
    const src = "title: T\n&::ontos:colors:green:-\n&::ontos:colors:yellow:-\n";
    const out = removeBookmark(src, [], (t) => t.includes(":ontos:colors:green"));
    expect(out).toBe("title: T\n&::ontos:colors:yellow:-\n");
    expect(bookmarksRemain(out, [])).toBe(true);
  });

  it("is a no-op when nothing matches", () => {
    const src = "title: T\n&::ontos:colors:green:-\n";
    expect(removeBookmark(src, [], (t) => t.includes("nope"))).toBe(src);
  });

  it("bookmarksRemain goes false once the last membership is gone", () => {
    const src = "title: T\n&::ontos:colors:green:-\n";
    const out = removeBookmark(src, [], () => true);
    expect(out).toBe("title: T\n");
    expect(bookmarksRemain(out, [])).toBe(false);
  });
});

describe("keyToken", () => {
  it("quotes filenames with dots/dashes-as-needed and spaces", () => {
    expect(keyToken("plain_name")).toBe("plain_name");
    expect(keyToken("S0002-9904.pdf")).toBe('"S0002-9904.pdf"');
    expect(keyToken("has space")).toBe('"has space"');
  });
});
