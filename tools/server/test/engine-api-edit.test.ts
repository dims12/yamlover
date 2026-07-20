import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHandlers } from "./helpers";
import { tmpTree } from "./helpers";
import { call, callBody } from "./http";

// The WRITE endpoint /api/edit — surgical source-text edits of any `.yamlover` document, against
// synthetic temp trees (never the repo's own examples/). It splices lines rather than reserializing,
// so comments, quoting, and block scalars survive.
//
// `path` is a plain yamlover path: each segment is a key or an ABSOLUTE entry index, the same index
// /api/json and the resolver use. A node has four FACETS — scalar value, keyed entries, ordinal
// entries, and its `!!<…>` meta tag — and `emplace` replaces only the ones its payload carries,
// while `replace` drops them all. `yamlover` is valid inline yamlover SOURCE: the caller escapes.

// A chapter that hosts $defs so subchapters gain the chapter format by schema propagation
// (walk.ts applySchemas: an `items: {anyOf:[chapter, chunk]}` union routes a container element to
// the chapter branch, a scalar element to the chunk branch).
const CHAPTER =
  "!!<*yamlover/$defs/chapter>\n" +
  'title: "T"\n' +
  "description: Sub\n" +
  "- Hello\n" +
  "- |\n  first line\n  second line\n" +
  "- title: Sub\n  - First\n";
const DEFS = {
  "$defs/chapter":
    "type: variant\nproperties:\n  title:\n    type: string\n  description:\n    type: string\nitems:\n  anyOf:\n    - *//yamlover/$defs/chapter\n    - *//yamlover/$defs/chunk\n",
  "$defs/chunk": "type: [string, binary]\nformat: text/marklower\n",
};

const bodyOf = (root: string) => fs.readFileSync(path.join(root, "doc", ".yamlover", "body.yamlover"), "utf8");

/** The positional body values of a chapter's `/api/json` projection (a `$yamloverMixed` marker's
 *  keyless entries, or a plain array for an untitled chapter). */
const body = (json: { value: unknown }): unknown[] => {
  const v = json.value as { $yamloverMixed?: { entries: { key: string | null; value: unknown }[] } } | unknown[];
  if (Array.isArray(v)) return v;
  const m = v?.$yamloverMixed;
  return m ? m.entries.filter((e) => e.key == null).map((e) => e.value) : [];
};

async function chapterHandlers(extra: Record<string, string> = {}) {
  const root = tmpTree({ "doc/.yamlover/body.yamlover": CHAPTER, ...DEFS, ...extra });
  const h = createHandlers(root, { gitignore: false });
  await h.ready;
  return { root, h };
}

describe("/api/edit — scalars", () => {
  it("emplaces a chapter title (replacing the existing line)", async () => {
    const { root, h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc:title", op: "emplace", yamlover: '"New Title"' });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toContain('title: "New Title"');
    expect(call(h, "/api/json", { path: ":doc" }).json.title).toBe("New Title");
  });

  it("adds a description when the chapter has none", async () => {
    const { root, h } = await chapterHandlers({
      "doc/.yamlover/body.yamlover": "!!<*yamlover/$defs/chapter>\ntitle: T\n- Hello\n",
    });
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc:description", op: "emplace", yamlover: '"A subtitle"' });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toContain('description: "A subtitle"');
    expect(call(h, "/api/json", { path: ":doc" }).json.description).toBe("A subtitle");
  });

  it("removes a keyed entry", async () => {
    const { root, h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc:description", op: "remove" });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).not.toContain("description:");
    expect(call(h, "/api/json", { path: ":doc" }).json.description).toBeNull();
  });

  it("edits a subchapter title (descend to the subchapter at [4], then its `title` key)", async () => {
    const { root, h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[4]:title", op: "emplace", yamlover: '"Renamed"' });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toContain('title: "Renamed"');
    expect(call(h, "/api/json", { path: ":doc[4]", depth: "3" }).json.title).toBe("Renamed");
  });
});

// ONE index space: `[i]` is the ABSOLUTE entry index — the keyed title(0)/description(1) consume
// indices, so the prose "Hello" is `:doc[2]`, the block `:doc[3]`, the subchapter `:doc[4]`. It is
// the same index /api/json and the resolver use, so an edit path is a plain yamlover path.
describe("/api/edit — entries", () => {
  it("emplaces an inline chunk with new prose", async () => {
    const { h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[2]", op: "emplace", yamlover: "|-\n  Goodbye **world**" });
    expect(r.status).toBe(200);
    expect(body(call(h, "/api/json", { path: ":doc", depth: "3" }).json)[0]).toBe("Goodbye **world**");
    expect(body(call(h, "/api/json", { path: ":doc", depth: "3" }).json)[1]).toBe("first line\nsecond line\n"); // untouched
  });

  it("replaces a multi-line block-scalar chunk whole", async () => {
    const { h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[3]", op: "replace", yamlover: "|-\n  one\n  two\n  three" });
    expect(r.status).toBe(200);
    const b = body(call(h, "/api/json", { path: ":doc", depth: "3" }).json);
    expect(b[0]).toBe("Hello");
    expect(b[1]).toBe("one\ntwo\nthree");
  });

  it("inserts a new entry AT the index the path names", async () => {
    const { h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[3]", op: "insert", yamlover: "|-\n  inserted" });
    expect(r.status).toBe(200);
    const b = body(call(h, "/api/json", { path: ":doc", depth: "3" }).json);
    expect(b.slice(0, 3)).toEqual(["Hello", "inserted", "first line\nsecond line\n"]);
  });

  it("prepends (before the first body entry) and appends (the path names the chapter)", async () => {
    const { h } = await chapterHandlers();
    await callBody(h, "POST", "/api/edit", { path: ":doc[2]", op: "insert", yamlover: "|-\n  top" });
    await callBody(h, "POST", "/api/edit", { path: ":doc", op: "insert", yamlover: "|-\n  bottom" });
    const b = body(call(h, "/api/json", { path: ":doc", depth: "3" }).json);
    expect(b[0]).toBe("top");
    expect(b[1]).toBe("Hello");
    expect(b[b.length - 1]).toBe("bottom"); // after the last positional item (the subchapter)
  });

  it("an insert index past the end appends — how a caller who doesn't know the count adds one", async () => {
    const { h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[99]", op: "insert", yamlover: "|-\n  last" });
    expect(r.status).toBe(200);
    const b = body(call(h, "/api/json", { path: ":doc", depth: "3" }).json);
    expect(b[b.length - 1]).toBe("last");
  });

  it("removes an entry", async () => {
    const { h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[2]", op: "remove" });
    expect(r.status).toBe(200);
    expect(body(call(h, "/api/json", { path: ":doc", depth: "3" }).json)[0]).toBe("first line\nsecond line\n");
  });

  it("edits a chunk inside a subchapter — the inline `title` consumes index 0 there too", async () => {
    const { h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[4][1]", op: "emplace", yamlover: "|-\n  Deep edit" });
    expect(r.status).toBe(200);
    expect(body(call(h, "/api/json", { path: ":doc[4]", depth: "3" }).json)[0]).toBe("Deep edit");
  });
});

describe("/api/edit — batch", () => {
  it("applies a batch of ops in order in one call (a split: emplace head + insert tail)", async () => {
    const { h } = await chapterHandlers();
    // splitting chunk "Hello" (abs 2) at a caret → head "Hel", tail "lo" inserted after it
    const r = await callBody(h, "POST", "/api/edit", {
      edits: [
        { path: ":doc[2]", op: "emplace", yamlover: "|-\n  Hel" },
        { path: ":doc[3]", op: "insert", yamlover: "|-\n  lo" },
      ],
    });
    expect(r.status).toBe(200);
    const b = body(call(h, "/api/json", { path: ":doc", depth: "3" }).json);
    expect(b.slice(0, 3)).toEqual(["Hel", "lo", "first line\nsecond line\n"]);
  });

  it("batches a title emplace + a chunk emplace + a remove together", async () => {
    const { root, h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", {
      edits: [
        { path: ":doc:title", op: "emplace", yamlover: '"Batched"' },
        { path: ":doc[2]", op: "emplace", yamlover: "|-\n  H2" },
        { path: ":doc[3]", op: "remove" },
      ],
    });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toContain('title: "Batched"');
    const b = body(call(h, "/api/json", { path: ":doc", depth: "3" }).json);
    expect(b[0]).toBe("H2");
    expect(b).not.toContain("first line\nsecond line\n");
  });

  it("routes a batch touching two different chapter files, one reindex each", async () => {
    const root = tmpTree({
      "a/.yamlover/body.yamlover": "!!<*yamlover/$defs/chapter>\ntitle: A\n- one\n",
      "b/.yamlover/body.yamlover": "!!<*yamlover/$defs/chapter>\ntitle: B\n- two\n",
      ...DEFS,
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", {
      edits: [
        { path: ":a[1]", op: "emplace", yamlover: "|-\n  one!" },
        { path: ":b:title", op: "emplace", yamlover: '"B2"' },
      ],
    });
    expect(r.status).toBe(200);
    expect(body(call(h, "/api/json", { path: ":a", depth: "3" }).json)[0]).toBe("one!");
    expect(call(h, "/api/json", { path: ":b" }).json.title).toBe("B2");
  });
});

// A node has four FACETS: scalar value, keyed entries, ordinal entries, and its `!!<…>` meta tag.
// `emplace` replaces only the facets its payload carries; `replace` drops them all.
describe("/api/edit — facets", () => {
  it("emplacing prose over an ANNOTATED chunk keeps its annotations (an omni overlay on the prose)", async () => {
    const { root, h } = await chapterHandlers();
    const tag = await callBody(h, "POST", "/api/tag", { name: "important" });
    await callBody(h, "POST", "/api/annotate", { target: ":doc[2]", tag: tag.json.path });
    expect(bodyOf(root)).toContain("yamlover-annotations:");

    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[2]", op: "emplace", yamlover: "|-\n  edited prose" });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toContain("yamlover-annotations:"); // the keyed facet stood
    // the chunk is now an omni node — its prose under the annotation overlay
    const chunk = body(call(h, "/api/json", { path: ":doc", depth: "3" }).json)[0] as { $yamloverMixed: { value: string } };
    expect(chunk.$yamloverMixed.value).toBe("edited prose");
  });

  it("replacing that same chunk drops its annotations — replace is the clean-slate verb", async () => {
    const { root, h } = await chapterHandlers();
    const tag = await callBody(h, "POST", "/api/tag", { name: "important" });
    await callBody(h, "POST", "/api/annotate", { target: ":doc[2]", tag: tag.json.path });
    await callBody(h, "POST", "/api/edit", { path: ":doc[2]", op: "replace", yamlover: '"clean"' });
    expect(bodyOf(root)).not.toContain("yamlover-annotations:");
  });

  it("emplace keeps an inline `!!<…>` tag; replace drops it; `meta` sets it; `meta: null` removes it", async () => {
    const { root, h } = await chapterHandlers({
      "doc/.yamlover/body.yamlover": "!!<*yamlover/$defs/chapter>\ntitle: T\n- !!<format: text/x-latex> |\n  e^{i\\pi}\n",
    });
    await callBody(h, "POST", "/api/edit", { path: ":doc[1]", op: "emplace", yamlover: "|-\n  \\sqrt{2}" });
    expect(bodyOf(root)).toContain("!!<format: text/x-latex>");
    expect(call(h, "/api/json", { path: ":doc[1]" }).json.format).toBe("text/x-latex");

    await callBody(h, "POST", "/api/edit", { path: ":doc[1]", op: "emplace", meta: "format: text/markdown", yamlover: "|-\n  # H" });
    expect(call(h, "/api/json", { path: ":doc[1]" }).json.format).toBe("text/markdown");

    await callBody(h, "POST", "/api/edit", { path: ":doc[1]", op: "emplace", meta: null });
    expect(bodyOf(root)).not.toContain("!!<format:");

    await callBody(h, "POST", "/api/edit", { path: ":doc[1]", op: "emplace", meta: "format: text/markdown", yamlover: "|-\n  # H" });
    await callBody(h, "POST", "/api/edit", { path: ":doc[1]", op: "replace", yamlover: "|-\n  plain" });
    expect(bodyOf(root)).not.toContain("!!<format:");
  });

  it("edits a `*…` pointer chunk — with yamlover source there is nothing to forbid", async () => {
    const { root, h } = await chapterHandlers({
      "doc/pic.png": "PNG",
      "doc/other.png": "PNG2",
      "doc/.yamlover/body.yamlover": "!!<*yamlover/$defs/chapter>\ntitle: T\n- */pic.png\n",
    });
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[1]", op: "replace", yamlover: "*/other.png" });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toContain("- */other.png");
  });
});

describe("/api/edit — rejections", () => {
  it("refuses to descend into a scalar (it used to splice underneath it and corrupt the file)", async () => {
    const { root, h } = await chapterHandlers();
    const before = bodyOf(root);
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[2][0]", op: "emplace", yamlover: '"x"' });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/scalar/);
    expect(bodyOf(root)).toBe(before);
  });

  it("rejects a malformed `yamlover` payload and leaves the document untouched", async () => {
    const { root, h } = await chapterHandlers();
    const before = bodyOf(root);
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[2]", op: "emplace", yamlover: "bad: [unclosed" });
    expect(r.status).toBe(400);
    expect(bodyOf(root)).toBe(before);
  });

  it("rejects an unknown op, and an op with no target", async () => {
    const { h } = await chapterHandlers();
    expect((await callBody(h, "POST", "/api/edit", { path: ":doc[2]", op: "frobnicate", yamlover: '"x"' })).status).toBe(400);
    // root `emplace` with a SCALAR payload is legal (it sets the self-value — the title);
    // `replace` at the root would drop the whole document and stays refused
    expect((await callBody(h, "POST", "/api/edit", { path: ":doc", op: "replace", yamlover: '"x"' })).status).toBe(400);
  });

  it("rejects `concrete` on an existing node — converting one is a move, not an edit", async () => {
    const { h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[2]", op: "emplace", concrete: "file/yamlover", yamlover: '"x"' });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/created/);
  });
});

// The FULLY-OMNI chapter (CHAPTER.md): the title is the node's own scalar SELF-VALUE — no `title:`
// key — so it consumes NO absolute index. `description` (keyed) is [0], the body follows.
const OMNI_CHAPTER =
  "!!<*yamlover/$defs/chapter>\n" +
  "T\n" +
  "description: Sub\n" +
  "- Hello\n" +
  "- |\n  first line\n  second line\n" +
  "- Sub\n  - First\n";
const OMNI_DEFS = {
  "$defs/chapter":
    "type: variant\nvalue:\n  type: string\nproperties:\n  description:\n    type: string\nitems:\n  anyOf:\n    - *//yamlover/$defs/chapter\n    - *//yamlover/$defs/chunk\n",
  "$defs/chunk": "type: [string, binary]\nformat: text/marklower\n",
};

async function omniChapterHandlers(extra: Record<string, string> = {}) {
  const root = tmpTree({ "doc/.yamlover/body.yamlover": OMNI_CHAPTER, ...OMNI_DEFS, ...extra });
  const h = createHandlers(root, { gitignore: false });
  await h.ready;
  return { root, h };
}

describe("/api/edit — the omni self-value title (CHAPTER.md: title = the node's scalar facet)", () => {
  it("emplaces the ROOT title: a scalar payload on the document node replaces the self-value line", async () => {
    const { root, h } = await omniChapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc", op: "emplace", yamlover: '"New Title"' });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toMatch(/^New Title$/m); // authored PLAIN — the safe quoted payload unquotes
    expect(bodyOf(root)).not.toMatch(/^T$/m);
    expect(call(h, "/api/json", { path: ":doc" }).json.title).toBe("New Title");
  });

  it("a title the bare line would misread KEEPS its quotes (an entry opener, a number)", async () => {
    const { root, h } = await omniChapterHandlers();
    await callBody(h, "POST", "/api/edit", { path: ":doc", op: "emplace", yamlover: '"note: to self"' });
    expect(bodyOf(root)).toContain('"note: to self"'); // bare it would open a keyed entry
    expect(call(h, "/api/json", { path: ":doc" }).json.title).toBe("note: to self");
    await callBody(h, "POST", "/api/edit", { path: ":doc", op: "emplace", yamlover: '"30"' });
    expect(bodyOf(root)).toContain('"30"'); // bare it would read as a number
    expect(call(h, "/api/json", { path: ":doc" }).json.title).toBe("30");
  });

  it("an EMPTY payload drops the title line (an untitled chapter has no self-value at all)", async () => {
    const { root, h } = await omniChapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc", op: "emplace", yamlover: '""' });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).not.toMatch(/^T$/m);
    expect(call(h, "/api/json", { path: ":doc" }).json.title).toBeNull();
  });

  it("re-adds a title to an untitled chapter: the self-value lands right after the tag line", async () => {
    const { root, h } = await omniChapterHandlers({
      "doc/.yamlover/body.yamlover": "!!<*yamlover/$defs/chapter>\n- Hello\n",
    });
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc", op: "emplace", yamlover: '"Fresh"' });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toBe("!!<*yamlover/$defs/chapter>\nFresh\n- Hello\n");
    expect(call(h, "/api/json", { path: ":doc" }).json.title).toBe("Fresh");
  });

  it("a FRESH self-value with `at` lands at its typed position — order kept (REPRESENTATION RULE)", async () => {
    const { root, h } = await omniChapterHandlers({
      "doc/.yamlover/body.yamlover": "- solid\n- recommended\nscale: 10\n",
    });
    const r = await callBody(h, "POST", "/api/edit", {
      path: ":doc", op: "emplace", yamlover: "|\n  A block-scalar self-value\n  multi-line text", at: 1,
    });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toBe("- solid\n|\n  A block-scalar self-value\n  multi-line text\n- recommended\nscale: 10\n");
    const v = call(h, "/api/json", { path: ":doc" }).json.value as { $yamloverMixed?: { selfAt?: number } };
    expect(v.$yamloverMixed?.selfAt).toBe(1); // the projection keeps the authored position too
  });

  it("`at` past the entry count appends the self line after the last entry", async () => {
    const { root, h } = await omniChapterHandlers({
      "doc/.yamlover/body.yamlover": "- solid\n- recommended\n",
    });
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc", op: "emplace", yamlover: '"late title"', at: 9 });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toBe("- solid\n- recommended\nlate title\n");
  });

  it("an INSERT payload with a mid-position self line keeps the typed order", async () => {
    const { root, h } = await omniChapterHandlers({
      "doc/.yamlover/body.yamlover": "- placeholder\n",
    });
    const r = await callBody(h, "POST", "/api/edit", {
      path: ":doc[1]", op: "insert", yamlover: "- solid\n|\n  block text\n- recommended",
    });
    expect(r.status).toBe(200);
    // the nested omni serializes with its self line BETWEEN its entries, as authored
    expect(bodyOf(root)).toBe("- placeholder\n- - solid\n  |\n    block text\n  - recommended\n");
  });

  it("title edits do not shift body indices: description is [0], the body starts at [1]", async () => {
    const { h } = await omniChapterHandlers();
    await callBody(h, "POST", "/api/edit", { path: ":doc", op: "emplace", yamlover: '"Renamed"' });
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[1]", op: "emplace", yamlover: "|-\n  Goodbye" });
    expect(r.status).toBe(200);
    const b = body(call(h, "/api/json", { path: ":doc", depth: "3" }).json);
    expect(b[0]).toBe("Goodbye");
    expect(b[1]).toBe("first line\nsecond line\n");
  });

  it("emplaces a SUBCHAPTER's title: a scalar payload on `[i]` replaces its head, the body stands", async () => {
    const { root, h } = await omniChapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[3]", op: "emplace", yamlover: '"Renamed Sub"' });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toContain("- Renamed Sub\n  - First"); // plain — the safe payload unquotes
    expect(call(h, "/api/json", { path: ":doc[3]", depth: "3" }).json.title).toBe("Renamed Sub");
  });

  it("an EMPTY payload on a subchapter un-titles it (its body survives as a compact container)", async () => {
    const { root, h } = await omniChapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[3]", op: "emplace", yamlover: '""' });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toContain("- - First");
    expect(call(h, "/api/json", { path: ":doc[3]", depth: "3" }).json.title).toBeNull();
  });

  it("inserts a titled subchapter whole: a `\"Title\"\\n- chunk` payload is self-value + body", async () => {
    const { root, h } = await omniChapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc", op: "insert", yamlover: '"T2"\n- "c1"' });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toContain('- T2\n  - "c1"');
    expect(call(h, "/api/json", { path: ":doc[4]", depth: "3" }).json.title).toBe("T2");
  });

  it("titling a compact UNTITLED subchapter keeps ALL its chunks (the swallowed-first-chunk bug)", async () => {
    // the untitled subchapter is the compact `- - first` form: its first chunk lives inline on the
    // marker line, and a title emplace must file it as body — not replace it as the "scalar"
    const { root, h } = await omniChapterHandlers({
      "doc/.yamlover/body.yamlover": "!!<*yamlover/$defs/chapter>\nT\n- Hello\n- - first chunk\n  - second chunk\n",
    });
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[1]", op: "emplace", yamlover: '"Added title"' });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toContain("- Added title\n  - first chunk\n  - second chunk");
    const sub = call(h, "/api/json", { path: ":doc[1]", depth: "3" }).json;
    expect(sub.title).toBe("Added title");
  });
});

// Creating an object is an `insert` carrying the schema as its `meta` tag and a body template. The
// server no longer knows what a chapter is: `concrete` says how the content is stored, and the
// parent decides whether it becomes a body CHILD or a directory MEMBER.
describe("/api/edit — creating objects (concrete)", () => {
  const CHAP = "*::yamlover:$defs:chapter";
  const BODY = 'title: "Fresh"\n- ""';
  const dirTree = () => tmpTree({ "dir/keep.txt": "x", ...DEFS });

  it("child inline: appends a subchapter (one empty chunk) to a chapter's body", async () => {
    const { root, h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc", op: "insert", concrete: "yamlover", meta: CHAP, yamlover: BODY });
    expect(r.status).toBe(200);
    expect(r.json.path).toBe(":doc[5]"); // after title(0)/description(1)/Hello(2)/block(3)/Sub(4)
    expect(bodyOf(root)).toContain('title: "Fresh"');
    const node = call(h, "/api/json", { path: ":doc[5]", depth: "3" });
    expect(node.json.format).toBe("x-yamlover-chapter");
    expect(body(node.json)).toEqual([""]); // one empty, immediately-editable chunk
  });

  it("child linked file: writes a .yamlover doc beside the parent + a pointer in the body", async () => {
    const { root, h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc", op: "insert", concrete: "file/yamlover", name: "Linked", meta: CHAP, yamlover: BODY });
    expect(r.status).toBe(200);
    expect(fs.existsSync(path.join(root, "doc", "Linked.yamlover"))).toBe(true); // dir-backed doc → inside doc/
    expect(bodyOf(root)).toContain("- */Linked.yamlover");
    expect(r.json.path).toBe(":doc:Linked.yamlover"); // navigates to the linked doc's own node
    expect(call(h, "/api/json", { path: r.json.path }).json.format).toBe("x-yamlover-chapter");
  });

  it("child linked dir: writes <name>/.yamlover/body.yamlover + a pointer", async () => {
    const { root, h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc", op: "insert", concrete: "dir/yamlover", name: "SubDir", meta: CHAP, yamlover: BODY });
    expect(r.status).toBe(200);
    expect(fs.existsSync(path.join(root, "doc", "SubDir", ".yamlover", "body.yamlover"))).toBe(true);
    expect(bodyOf(root)).toContain("- */SubDir");
    expect(r.json.path).toBe(":doc:SubDir");
    expect(call(h, "/api/json", { path: r.json.path }).json.format).toBe("x-yamlover-chapter");
  });

  it("member file: a plain directory has no body to splice, so the content becomes a member", async () => {
    const root = dirTree();
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: ":dir", op: "insert", concrete: "file/yamlover", name: "New Note", meta: CHAP, yamlover: BODY });
    expect(r.status).toBe(200);
    expect(fs.existsSync(path.join(root, "dir", "New Note.yamlover"))).toBe(true);
    expect(call(h, "/api/json", { path: r.json.path }).json.format).toBe("x-yamlover-chapter");
  });

  it("member dir: a directory-backed chapter in a directory", async () => {
    const root = dirTree();
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: ":dir", op: "insert", concrete: "dir/yamlover", name: "New Dir", meta: CHAP, yamlover: BODY });
    expect(r.status).toBe(200);
    expect(fs.existsSync(path.join(root, "dir", "New Dir", ".yamlover", "body.yamlover"))).toBe(true);
    expect(call(h, "/api/json", { path: r.json.path }).json.format).toBe("x-yamlover-chapter");
  });

  it("untagged NODE member: no `meta`, no body — an EMPTY generic yamlover document", async () => {
    const root = dirTree();
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: ":dir", op: "insert", concrete: "dir/yamlover", name: "New node" });
    expect(r.status).toBe(200);
    expect(fs.readFileSync(path.join(root, "dir", "New node", ".yamlover", "body.yamlover"), "utf8")).toBe("\n");
    const node = call(h, "/api/json", { path: r.json.path }).json;
    expect(node.format).toBeNull(); // no schema meta — a plain node, not a chapter
    expect(node.value).toBeNull(); // an empty document, NOT an empty-string scalar
    expect(node.concrete).toBe("dir/yamlover");
    // the first token lands via a root emplace — `12` becomes the integer scalar 12
    const e = await callBody(h, "POST", "/api/edit", { path: r.json.path, op: "emplace", yamlover: "12" });
    expect(e.status).toBe(200);
    expect(call(h, "/api/json", { path: r.json.path }).json.value).toBe(12);
  });

  it("rejects creating against a scalar — it backs no document and is no directory", async () => {
    const root = tmpTree({ name: "Alice" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: ":name", op: "insert", concrete: "file/yamlover", name: "X", meta: CHAP, yamlover: BODY });
    expect(r.status).toBe(400);
  });

  it("keyed INSERT: `key` makes a `key: value` entry AT the position — authored order preserved", async () => {
    const root = tmpTree({ "days.yamlover": "- mon\n12\n", "list.yamlover": "- a\n- b\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    // past-end append: lands AFTER the bare self line, exactly where it was typed
    const r1 = await callBody(h, "POST", "/api/edit", { path: ":days.yamlover[1]", op: "insert", key: "12", yamlover: "tue" });
    expect(r1.status).toBe(200);
    expect(fs.readFileSync(path.join(root, "days.yamlover"), "utf8")).toBe("- mon\n12\n12: tue\n");
    // mid-list: splices BEFORE entry [1], keyed — unlike a fresh keyed emplace (top of block)
    const r2 = await callBody(h, "POST", "/api/edit", { path: ":list.yamlover[1]", op: "insert", key: "k", yamlover: '"v"' });
    expect(r2.status).toBe(200);
    expect(fs.readFileSync(path.join(root, "list.yamlover"), "utf8")).toBe('- a\nk: "v"\n- b\n');
  });

  it("omni re-emplace: a scalar entry gains children via a whole-omni emplace (the level rule)", async () => {
    const root = tmpTree({ "doc.yamlover": "- scalar\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    // the editor's `- scalar` ↵ `- element` ↵ — the entry was a plain scalar, so the first child
    // arrives as a re-emplace of the WHOLE omni at the entry's own path
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc.yamlover[0]", op: "emplace", yamlover: "scalar\n- element" });
    expect(r.status).toBe(200);
    expect(fs.readFileSync(path.join(root, "doc.yamlover"), "utf8")).toBe("- scalar\n  - element\n");
    const j = call(h, "/api/json", { path: ":doc.yamlover", depth: ".inf" }).json as { value: { $yamloverMixed: { kind: string; value: unknown; entries: unknown[] } }[] };
    const m = j.value[0].$yamloverMixed;
    expect(m.kind).toBe("omni");
    expect(m.value).toBe("scalar");
    expect(m.entries).toEqual([{ key: null, value: "element" }]);
  });

  it("keyed INSERT with a NESTED payload: the editor's `pets:` ↵ `- name: Rex` flow round-trips", async () => {
    const root = tmpTree({ "pets.yamlover": "\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: ":pets.yamlover[0]", op: "insert", key: "pets", yamlover: "- name: Rex" });
    expect(r.status).toBe(200);
    const src = fs.readFileSync(path.join(root, "pets.yamlover"), "utf8");
    expect(src).toContain("pets:");
    expect(src).toContain("- name: Rex"); // the compact dash form, as the client serializes it
    const j = call(h, "/api/json", { path: ":pets.yamlover", depth: ".inf" }).json as { value: unknown };
    expect(j.value).toEqual({ pets: [{ name: "Rex" }] });
  });

  it("the editor's whole-document PASTE batch lands on an empty file: per-entry inserts + the self emplace", async () => {
    // exactly the ops pasteRootDocument (client paste.ts) emits for a pasted document with a
    // self line, a nested keyed subtree, and a trailing keyed scalar — a document root takes
    // no whole-payload emplace, so the paste must arrive in this per-entry shape
    const root = tmpTree({ "n.yamlover": "\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { edits: [
      { path: ":n.yamlover[0]", op: "insert", key: "pets", yamlover: "- name: Rex\n  species: dog\n- name: Whiskers\n  species: cat" },
      { path: ":n.yamlover[1]", op: "insert", key: "after", yamlover: "1" },
      { path: ":n.yamlover", op: "emplace", yamlover: "A Title" },
    ] });
    expect(r.status).toBe(200);
    const j = call(h, "/api/json", { path: ":n.yamlover", depth: ".inf" }).json as { value: unknown };
    expect(j.value).toEqual({
      $yamloverMixed: {
        kind: "omni", value: "A Title", // selfAt 0 is elided by the projection
        entries: [
          { key: "pets", value: [{ name: "Rex", species: "dog" }, { name: "Whiskers", species: "cat" }] },
          { key: "after", value: 1 },
        ],
      },
    });
  });

  it("the paste batch onto a LEGACY `\"\"` fresh file: the clearing emplace drops the line first", async () => {
    const root = tmpTree({ "n.yamlover": '""\n' });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { edits: [
      { path: ":n.yamlover", op: "emplace", yamlover: '""' },
      { path: ":n.yamlover[0]", op: "insert", key: "pets", yamlover: "- name: Rex" },
    ] });
    expect(r.status).toBe(200);
    const src = fs.readFileSync(path.join(root, "n.yamlover"), "utf8");
    expect(src).not.toContain('""'); // the placeholder line LEFT
    const j = call(h, "/api/json", { path: ":n.yamlover", depth: ".inf" }).json as { value: unknown };
    expect(j.value).toEqual({ pets: [{ name: "Rex" }] });
  });

  it("bare folder: `concrete:\"dir\"` makes an EMPTY OS directory member — no body, no .yamlover", async () => {
    const root = dirTree();
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: ":dir", op: "insert", concrete: "dir", name: "New Folder" });
    expect(r.status).toBe(200);
    expect(r.json.path).toBe(":dir:New%20Folder"); // segsToStr percent-encodes the space
    const abs = path.join(root, "dir", "New Folder");
    expect(fs.statSync(abs).isDirectory()).toBe(true);
    expect(fs.readdirSync(abs)).toEqual([]); // truly empty — no .yamlover marker, no body file
    expect(call(h, "/api/json", { path: r.json.path }).json.concrete).toBe("dir");
  });

  it("bare folder inside a dir-backed chapter: a keyed member, the parent's body UNTOUCHED", async () => {
    const { root, h } = await chapterHandlers();
    const before = bodyOf(root);
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc", op: "insert", concrete: "dir", name: "Assets" });
    expect(r.status).toBe(200);
    expect(fs.statSync(path.join(root, "doc", "Assets")).isDirectory()).toBe(true);
    expect(bodyOf(root)).toBe(before); // no pointer spliced — the walk finds the member by name
    expect(r.json.path).toBe(":doc:Assets");
  });

  it("bare folder collisions: `uniqueName` suffixes; extra meta/yamlover fields are ignored", async () => {
    const root = dirTree();
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const first = await callBody(h, "POST", "/api/edit", { path: ":dir", op: "insert", concrete: "dir", name: "New Folder", meta: CHAP, yamlover: BODY });
    const second = await callBody(h, "POST", "/api/edit", { path: ":dir", op: "insert", concrete: "dir", name: "New Folder" });
    expect(first.json.path).toBe(":dir:New%20Folder");
    expect(second.json.path).toBe(":dir:New%20Folder-1");
    expect(fs.readdirSync(path.join(root, "dir", "New Folder"))).toEqual([]); // meta/yamlover wrote nothing
    expect(fs.statSync(path.join(root, "dir", "New Folder-1")).isDirectory()).toBe(true);
  });

  it("rejects a bare folder against a scalar — a file backs it, not a directory", async () => {
    const root = tmpTree({ name: "Alice" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: ":name", op: "insert", concrete: "dir", name: "X" });
    expect(r.status).toBe(400);
  });
});

describe("/api/edit — standalone chapter file", () => {
  it("edits a chunk of a standalone *.yamlover chapter (Cyrillic)", async () => {
    const root = tmpTree({ "статья.yamlover": '!!<*::yamlover:$defs:chapter>\ntitle: "Заголовок"\n- Привет\n' });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const at = ":" + encodeURIComponent("статья.yamlover") + "[1]"; // title consumes index 0
    const r = await callBody(h, "POST", "/api/edit", { path: at, op: "emplace", yamlover: "|-\n  Пока" });
    expect(r.status).toBe(200);
    const src = fs.readFileSync(path.join(root, "статья.yamlover"), "utf8");
    expect(src).toContain("Пока"); // re-emitted losslessly (block scalar) — verify the parsed value
    expect(call(h, "/api/json", { path: at }).json.value).toBe("Пока");
  });
});

// The GENERAL value editor: plain `.yaml`/`.yml` (block splice, same engine as chapters) and
// `.json`/`.json5`/`.json5p` (span surgery — flow syntax has no block structure). Scalar `emplace`
// only; formatting and comments survive.
describe("/api/edit — general data files (yaml/json)", () => {
  const handlersFor = async (files: Record<string, string>) => {
    const root = tmpTree(files);
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    return { root, h };
  };
  const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

  it("emplaces scalar values in a .yaml file, preserving comments and structure", async () => {
    const src = "# cfg\nname: Rex\nage: 4\nactive: true\ntags:\n  - a\n  - b\n";
    const { root, h } = await handlersFor({ "pet.yaml": src });
    const r = await callBody(h, "POST", "/api/edit", {
      edits: [
        { path: ":pet.yaml:name", op: "emplace", yamlover: "Fido" },
        { path: ":pet.yaml:age", op: "emplace", yamlover: "5" },
        { path: ":pet.yaml:active", op: "emplace", yamlover: "false" },
        { path: ":pet.yaml:tags[1]", op: "emplace", yamlover: "z" },
      ],
    });
    expect(r.status).toBe(200);
    const out = read(root, "pet.yaml");
    expect(out).toContain("# cfg"); // comment survives
    expect(out).toContain("name: Fido");
    expect(out).toContain("age: 5");
    expect(out).toContain("active: false");
    expect(out).toContain("- z");
    expect(call(h, "/api/json", { path: ":pet.yaml:age" }).json.value).toBe(5);
  });

  it("descends a keyed `key:` → sequence → item and edits an inline field (regression: no phantom entry)", async () => {
    // `reachChapter` sets the descended region's marker to the `pets:` KEY line; that line must NOT be
    // surfaced as an inline entry (only `- ` items are), else a phantom `pets` entry shifts every index
    // and `pets[0]` reads as a scalar. Real breakage from examples/06-tour.yamlover.
    const src = "pets:\n  - name: Rex\n    species: dog\n  - name: Whiskers\n    species: cat\n";
    const { root, h } = await handlersFor({ "z.yaml": src });
    const r = await callBody(h, "POST", "/api/edit", { path: ":z.yaml:pets[0]:name", op: "emplace", yamlover: "Rex1" });
    expect(r.status).toBe(200);
    const out = read(root, "z.yaml");
    expect(out).toContain("- name: Rex1");
    expect(out).toContain("- name: Whiskers"); // the other item untouched
    expect(call(h, "/api/json", { path: ":z.yaml:pets[0]:name" }).json.value).toBe("Rex1");
  });

  it("edits scalar values in a .json file by SPAN surgery — comments and flow formatting survive", async () => {
    const src = '{\n  // rec\n  "name": "Alice",\n  "age": 30,\n  "tags": ["a", "b"],\n  "profile": { "city": "NYC" }\n}\n';
    const { root, h } = await handlersFor({ "user.json": src });
    const r = await callBody(h, "POST", "/api/edit", {
      edits: [
        { path: ":user.json:name", op: "emplace", yamlover: '"Bob"' },
        { path: ":user.json:age", op: "emplace", yamlover: "31" },
        { path: ":user.json:tags[1]", op: "emplace", yamlover: '"z"' }, // nested array element
        { path: ":user.json:profile:city", op: "emplace", yamlover: '"San Jose"' }, // nested object field
      ],
    });
    expect(r.status).toBe(200);
    const out = read(root, "user.json");
    expect(out).toContain("// rec"); // comment survives
    expect(out).toContain('"name": "Bob"');
    expect(out).toContain('"age": 31');
    expect(out).toContain('"tags": ["a", "z"]'); // compact flow formatting kept
    expect(out).toContain('"profile": { "city": "San Jose" }');
  });

  it("locates a JSON string value containing a colon and escaped quotes", async () => {
    const { root, h } = await handlersFor({ "u.json": '{ "msg": "old" }\n' });
    const r = await callBody(h, "POST", "/api/edit", { path: ":u.json:msg", op: "emplace", yamlover: '"He said: \\"hi\\""' });
    expect(r.status).toBe(200);
    expect(read(root, "u.json")).toBe('{ "msg": "He said: \\"hi\\"" }\n');
  });

  it("400s a non-scalar / malformed payload on a JSON file and leaves it untouched", async () => {
    const src = '{\n  "age": 30\n}\n';
    const { root, h } = await handlersFor({ "u.json": src });
    // the payload is yamlover source (the universal edit surface) — a non-scalar or a parse error is refused
    expect((await callBody(h, "POST", "/api/edit", { path: ":u.json:age", op: "emplace", yamlover: "{x: 1}" })).status).toBe(400);
    expect((await callBody(h, "POST", "/api/edit", { path: ":u.json:age", op: "emplace", yamlover: "[1, 2" })).status).toBe(400);
    expect(read(root, "u.json")).toBe(src);
  });

  it("writes a JSON value from YAMLOVER source — `~` becomes JSON null, a bare word becomes a JSON string", async () => {
    const { root, h } = await handlersFor({ "u.json": '{ "a": 1, "b": 2 }\n' });
    expect((await callBody(h, "POST", "/api/edit", { path: ":u.json:a", op: "emplace", yamlover: "~" })).status).toBe(200);
    expect((await callBody(h, "POST", "/api/edit", { path: ":u.json:b", op: "emplace", yamlover: "hello" })).status).toBe(200);
    expect(read(root, "u.json")).toBe('{ "a": null, "b": "hello" }\n'); // yamlover null/bare-string → JSON
  });

  it("rejects a non-scalar target and a non-emplace op on a JSON file", async () => {
    const { root, h } = await handlersFor({ "u.json": '{ "obj": { "a": 1 } }\n' });
    expect((await callBody(h, "POST", "/api/edit", { path: ":u.json:obj", op: "emplace", yamlover: "2" })).status).toBe(400); // obj is a container
    expect((await callBody(h, "POST", "/api/edit", { path: ":u.json:obj:a", op: "remove" })).status).toBe(400); // remove not supported for JSON
    expect(read(root, "u.json")).toBe('{ "obj": { "a": 1 } }\n');
  });
});

describe("/api/tree — directory-chapter subchapter order", () => {
  it("orders subchapters by BODY position, not the alphabetical directory scan", async () => {
    // a directory chapter whose subchapters are their OWN subdirectories, referenced by `*` body
    // pointers in a deliberately NON-alphabetical order: zebra, then apple.
    const root = tmpTree({
      "doc/.yamlover/body.yamlover": "!!<*yamlover/$defs/chapter>\ntitle: Root\n- intro\n- *: zebra\n- *: apple\n",
      "doc/zebra/.yamlover/body.yamlover": "!!<*yamlover/$defs/chapter>\ntitle: Zebra\n- z body\n",
      "doc/apple/.yamlover/body.yamlover": "!!<*yamlover/$defs/chapter>\ntitle: Apple\n- a body\n",
      ...DEFS,
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const tree = call(h, "/api/tree", { path: ":doc", depth: "1" }).json as { children: { label: string; format: string | null }[] };
    const subchapters = tree.children.filter((c) => c.format === "x-yamlover-chapter").map((c) => c.label);
    expect(subchapters).toEqual(["Zebra", "Apple"]); // body order — NOT ["Apple", "Zebra"]
  });

  it("trails on-disk subchapters the body never references AFTER the ordered ones, in dir-scan order", async () => {
    // zebra and apple are placed by `*` body pointers; kiwi and mango exist on disk only.
    const root = tmpTree({
      "doc/.yamlover/body.yamlover": "!!<*yamlover/$defs/chapter>\ntitle: Root\n- intro\n- *: zebra\n- *: apple\n",
      "doc/zebra/.yamlover/body.yamlover": "!!<*yamlover/$defs/chapter>\ntitle: Zebra\n- z body\n",
      "doc/apple/.yamlover/body.yamlover": "!!<*yamlover/$defs/chapter>\ntitle: Apple\n- a body\n",
      "doc/mango/.yamlover/body.yamlover": "!!<*yamlover/$defs/chapter>\ntitle: Mango\n- m body\n",
      "doc/kiwi/.yamlover/body.yamlover": "!!<*yamlover/$defs/chapter>\ntitle: Kiwi\n- k body\n",
      ...DEFS,
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const tree = call(h, "/api/tree", { path: ":doc", depth: "1" }).json as { children: { label: string; format: string | null }[] };
    const subchapters = tree.children.filter((c) => c.format === "x-yamlover-chapter").map((c) => c.label);
    expect(subchapters).toEqual(["Zebra", "Apple", "Kiwi", "Mango"]); // listed first in body order, unlisted trailing
  });
});

describe("/api/edit — flow-row cells (a table's `- [a, b, c]`, MARKLOWER.md)", () => {
  const TABLE =
    "!!<*yamlover/$defs/chapter>\n" +
    'title: "T"\n' +
    "- !!<*yamlover/$defs/table>\n" +
    "  title: Who\n" +
    "  header: [Name, Class, *[.-1]]   # Class spans\n" +
    "  - [Whiskers, mammal, '**manager**']\n" +
    "  - [Rex, *..[.-1][.], security]\n" +
    "  -\n" +
    "    - Bubbles\n" +
    "    - fish\n";
  const TDEFS = {
    ...DEFS,
    "$defs/table":
      "type: variant\nproperties:\n  title:\n    type: string\nitems:\n  type: array\n  items:\n    anyOf:\n      - *//yamlover/$defs/chunk\n      - *//yamlover/$defs/table\n",
  };
  async function tableHandlers() {
    const root = tmpTree({ "doc/.yamlover/body.yamlover": TABLE, ...TDEFS });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    return { root, h };
  }

  it("emplaces a plain cell in a flow body row", async () => {
    const { root, h } = await tableHandlers();
    // the table is body entry [1] (title consumes [0]); its row [2] is Whiskers; cell [0]
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[1][2][0]", op: "emplace", yamlover: "|-\n  Tom" });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toContain("- [Tom, mammal, '**manager**']");
  });

  it("quotes a cell containing spaces (single quotes, '' doubling) and keeps the comment", async () => {
    const { root, h } = await tableHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[1]:header[1]", op: "emplace", yamlover: "|-\n  Bob's class" });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toContain("header: [Name, 'Bob''s class', *[.-1]]   # Class spans");
  });

  it("leaves the neighbouring pointer cells verbatim", async () => {
    const { root, h } = await tableHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[1][3][2]", op: "emplace", yamlover: '"guard dog"' });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toContain("- [Rex, *..[.-1][.], 'guard dog']");
  });

  it("rejects multi-line text into a flow cell (block rows accept it)", async () => {
    const { root, h } = await tableHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[1][2][0]", op: "emplace", yamlover: "|-\n  a\n  b" });
    expect(r.status).toBe(400);
    expect(bodyOf(root)).toContain("- [Whiskers, mammal, '**manager**']"); // untouched
    // the same text lands fine in a BLOCK row's cell, through the ordinary engine
    const ok = await callBody(h, "POST", "/api/edit", { path: ":doc[1][4][0]", op: "emplace", yamlover: "|-\n  a\n  b" });
    expect(ok.status).toBe(200);
    expect(bodyOf(root)).toContain("- |-\n      a\n      b");
  });

  it("the edited cell round-trips through /api/json", async () => {
    const { h } = await tableHandlers();
    await callBody(h, "POST", "/api/edit", { path: ":doc[1][2][2]", op: "emplace", yamlover: "|-\n  the boss" });
    const json = call(h, "/api/json", { path: ":doc[1][2]", depth: ".inf" }).json as { value: unknown[] };
    expect(json.value[2]).toBe("the boss");
  });
});

describe("/api/edit — directory targets (concrete derivation, derive-concrete.ts)", () => {
  /** A served tree holding one genuinely EMPTY directory `d`. */
  const emptyDirTree = () => {
    const root = tmpTree({ "readme.txt": "x" });
    fs.mkdirSync(path.join(root, "d"));
    return root;
  };
  const dBody = (root: string) => fs.readFileSync(path.join(root, "d", ".yamlover", "body.yamlover"), "utf8");

  it("emplace onto a BODYLESS dir materializes the body with the scalar self-value", async () => {
    const root = emptyDirTree();
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: ":d", op: "emplace", yamlover: "12" });
    expect(r.status).toBe(200);
    expect(dBody(root)).toBe("12\n");
    expect(call(h, "/api/json", { path: ":d" }).json.value).toBe(12);
    // a second emplace REPLACES the line in place (the body now exists — the ordinary route)
    const r2 = await callBody(h, "POST", "/api/edit", { path: ":d", op: "emplace", yamlover: '"hello"' });
    expect(r2.status).toBe(200);
    expect(call(h, "/api/json", { path: ":d" }).json.value).toBe("hello");
  });

  it("keyed SCALAR insert into a bodyless dir lands in the body overlay", async () => {
    const root = emptyDirTree();
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: ":d[0]", op: "insert", key: "scale", yamlover: "10" });
    expect(r.status).toBe(200);
    expect(dBody(root)).toContain("scale: 10");
    expect((call(h, "/api/json", { path: ":d", depth: ".inf" }).json.value as Record<string, unknown>).scale).toBe(10);
  });

  it("keyed CONTAINER insert becomes a NESTED real directory, recursively", async () => {
    const root = emptyDirTree();
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: ":d[0]", op: "insert", key: "sub", yamlover: "a: 1\ndeep:\n  b: 2" });
    expect(r.status).toBe(200);
    expect(fs.statSync(path.join(root, "d", "sub")).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(root, "d", "sub", ".yamlover", "body.yamlover"), "utf8")).toBe("a: 1\n");
    expect(fs.statSync(path.join(root, "d", "sub", "deep")).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(root, "d", "sub", "deep", ".yamlover", "body.yamlover"), "utf8")).toBe("b: 2\n");
    const j = call(h, "/api/json", { path: ":d:sub", depth: ".inf" }).json;
    expect(j.value).toEqual({ a: 1, deep: { b: 2 } });
    expect(j.concrete).toBe("dir/yamlover");
  });

  it("a keyed container member whose key collides with an existing child is rejected", async () => {
    const root = emptyDirTree();
    fs.mkdirSync(path.join(root, "d", "sub"));
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: ":d[0]", op: "insert", key: "sub", yamlover: "a: 1" });
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toContain("already exists");
  });

  it("ordinal insert into a bodyless dir appends a positional body entry", async () => {
    const root = emptyDirTree();
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: ":d[0]", op: "insert", yamlover: "chunk" });
    expect(r.status).toBe(200);
    expect(dBody(root)).toContain("- chunk");
  });

  it("a MARKER-ONLY dir (.yamlover exists, no body) gains its body on emplace", async () => {
    const root = emptyDirTree();
    fs.mkdirSync(path.join(root, "d", ".yamlover"));
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: ":d", op: "emplace", yamlover: "12" });
    expect(r.status).toBe(200);
    expect(dBody(root)).toBe("12\n");
  });

  it("DOD: one empty directory takes a self value, a scalar field, and a subdirectory", async () => {
    const root = emptyDirTree();
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { edits: [
      { path: ":d", op: "emplace", yamlover: "12" },
      { path: ":d[0]", op: "insert", key: "scale", yamlover: "10" },
      { path: ":d[1]", op: "insert", key: "sub", yamlover: "a: 1" },
    ] });
    expect(r.status).toBe(200);
    expect(dBody(root)).toBe("12\nscale: 10\n");
    expect(fs.readFileSync(path.join(root, "d", "sub", ".yamlover", "body.yamlover"), "utf8")).toBe("a: 1\n");
    const j = call(h, "/api/json", { path: ":d", depth: ".inf" }).json as { value: { $yamloverMixed?: { value?: unknown; entries?: { key: string | null; value: unknown }[] } } };
    const m = j.value.$yamloverMixed!;
    expect(m.value).toBe(12); // the dir's own scalar line
    expect(Object.fromEntries(m.entries!.map((e) => [e.key, e.value]))).toEqual({ scale: 10, sub: { a: 1 } });
  });
});
