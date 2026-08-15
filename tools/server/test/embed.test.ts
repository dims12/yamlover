import { describe, it, expect } from "vitest";
import { appendBookmark, upsertFragment, removeBookmark, bookmarksRemain, keyToken } from "../src/server/embed";

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
