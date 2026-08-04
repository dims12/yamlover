import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHandlers } from "./helpers";
import { tmpTree } from "./helpers";
import { call, callBody } from "./http";
import { nodeJson } from "./node-json";

// The WRITE endpoint /api/edit — surgical source-text edits of any `.yo` document, against
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
  "!!<*yamlover: $defs: chapter>\n" +
  'title: "T"\n' +
  "description: Sub\n" +
  "- Hello\n" +
  "- |\n  first line\n  second line\n" +
  "- title: Sub\n  - First\n";
const DEFS = {
  "$defs/chapter":
    "type: variant\nproperties:\n  title:\n    type: string\n  description:\n    type: string\nitems:\n  anyOf:\n    - *:: yamlover: $defs: chapter\n    - *:: yamlover: $defs: chunk\n",
  "$defs/chunk": "type: [string, binary]\nformat: text/marklower\n",
};

const bodyOf = (root: string) => fs.readFileSync(path.join(root, "doc", ".yo", "body.yo"), "utf8");

/** The positional body values of a chapter's `/api/json` projection (a `$yamloverMixed` marker's
 *  keyless entries, or a plain array for an untitled chapter). */
const body = (json: { value: unknown }): unknown[] => {
  const v = json.value as { $yamloverMixed?: { entries: { key: string | null; value: unknown }[] } } | unknown[];
  if (Array.isArray(v)) return v;
  const m = v?.$yamloverMixed;
  return m ? m.entries.filter((e) => e.key == null).map((e) => e.value) : [];
};

async function chapterHandlers(extra: Record<string, string> = {}) {
  const root = tmpTree({ "doc/.yo/body.yo": CHAPTER, ...DEFS, ...extra });
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
    expect((await nodeJson(h, { path: ":doc" })).json.title).toBe("New Title");
  });

  it("adds a description when the chapter has none", async () => {
    const { root, h } = await chapterHandlers({
      "doc/.yo/body.yo": "!!<*yamlover: $defs: chapter>\ntitle: T\n- Hello\n",
    });
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc:description", op: "emplace", yamlover: '"A subtitle"' });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toContain('description: "A subtitle"');
    expect((await nodeJson(h, { path: ":doc" })).json.description).toBe("A subtitle");
  });

  it("removes a keyed entry", async () => {
    const { root, h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc:description", op: "remove" });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).not.toContain("description:");
    expect((await nodeJson(h, { path: ":doc" })).json.description).toBeNull();
  });

  it("edits a subchapter title (descend to the subchapter at [4], then its `title` key)", async () => {
    const { root, h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[4]:title", op: "emplace", yamlover: '"Renamed"' });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toContain('title: "Renamed"');
    expect((await nodeJson(h, { path: ":doc[4]", depth: "3" })).json.title).toBe("Renamed");
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
    expect(body((await nodeJson(h, { path: ":doc", depth: "3" })).json)[0]).toBe("Goodbye **world**");
    expect(body((await nodeJson(h, { path: ":doc", depth: "3" })).json)[1]).toBe("first line\nsecond line\n"); // untouched
  });

  it("replaces a multi-line block-scalar chunk whole", async () => {
    const { h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[3]", op: "replace", yamlover: "|-\n  one\n  two\n  three" });
    expect(r.status).toBe(200);
    const b = body((await nodeJson(h, { path: ":doc", depth: "3" })).json);
    expect(b[0]).toBe("Hello");
    expect(b[1]).toBe("one\ntwo\nthree");
  });

  it("inserts a new entry AT the index the path names", async () => {
    const { h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[3]", op: "insert", yamlover: "|-\n  inserted" });
    expect(r.status).toBe(200);
    const b = body((await nodeJson(h, { path: ":doc", depth: "3" })).json);
    expect(b.slice(0, 3)).toEqual(["Hello", "inserted", "first line\nsecond line\n"]);
  });

  it("prepends (before the first body entry) and appends (the path names the chapter)", async () => {
    const { h } = await chapterHandlers();
    await callBody(h, "POST", "/api/edit", { path: ":doc[2]", op: "insert", yamlover: "|-\n  top" });
    await callBody(h, "POST", "/api/edit", { path: ":doc", op: "insert", yamlover: "|-\n  bottom" });
    const b = body((await nodeJson(h, { path: ":doc", depth: "3" })).json);
    expect(b[0]).toBe("top");
    expect(b[1]).toBe("Hello");
    expect(b[b.length - 1]).toBe("bottom"); // after the last positional item (the subchapter)
  });

  it("an insert index past the end appends — how a caller who doesn't know the count adds one", async () => {
    const { h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[99]", op: "insert", yamlover: "|-\n  last" });
    expect(r.status).toBe(200);
    const b = body((await nodeJson(h, { path: ":doc", depth: "3" })).json);
    expect(b[b.length - 1]).toBe("last");
  });

  it("removes an entry", async () => {
    const { h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[2]", op: "remove" });
    expect(r.status).toBe(200);
    expect(body((await nodeJson(h, { path: ":doc", depth: "3" })).json)[0]).toBe("first line\nsecond line\n");
  });

  it("edits a chunk inside a subchapter — the inline `title` consumes index 0 there too", async () => {
    const { h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[4][1]", op: "emplace", yamlover: "|-\n  Deep edit" });
    expect(r.status).toBe(200);
    expect(body((await nodeJson(h, { path: ":doc[4]", depth: "3" })).json)[0]).toBe("Deep edit");
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
    const b = body((await nodeJson(h, { path: ":doc", depth: "3" })).json);
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
    const b = body((await nodeJson(h, { path: ":doc", depth: "3" })).json);
    expect(b[0]).toBe("H2");
    expect(b).not.toContain("first line\nsecond line\n");
  });

  it("routes a batch touching two different chapter files, one reindex each", async () => {
    const root = tmpTree({
      "a/.yo/body.yo": "!!<*yamlover: $defs: chapter>\ntitle: A\n- one\n",
      "b/.yo/body.yo": "!!<*yamlover: $defs: chapter>\ntitle: B\n- two\n",
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
    expect(body((await nodeJson(h, { path: ":a", depth: "3" })).json)[0]).toBe("one!");
    expect((await nodeJson(h, { path: ":b" })).json.title).toBe("B2");
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
    const chunk = body((await nodeJson(h, { path: ":doc", depth: "3" })).json)[0] as { $yamloverMixed: { value: string } };
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
      "doc/.yo/body.yo": "!!<*yamlover: $defs: chapter>\ntitle: T\n- !!<format: text/x-latex> |\n  e^{i\\pi}\n",
    });
    await callBody(h, "POST", "/api/edit", { path: ":doc[1]", op: "emplace", yamlover: "|-\n  \\sqrt{2}" });
    expect(bodyOf(root)).toContain("!!<format: text/x-latex>");
    expect((await nodeJson(h, { path: ":doc[1]" })).json.format).toBe("text/x-latex");

    await callBody(h, "POST", "/api/edit", { path: ":doc[1]", op: "emplace", meta: "format: text/markdown", yamlover: "|-\n  # H" });
    expect((await nodeJson(h, { path: ":doc[1]" })).json.format).toBe("text/markdown");

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
      "doc/.yo/body.yo": "!!<*yamlover: $defs: chapter>\ntitle: T\n- *: pic.png\n",
    });
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[1]", op: "replace", yamlover: "*: other.png" });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toContain("- *: other.png");
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

  it("rejects an unknown op; root `remove` of an unreferenced document ARCHIVES it", async () => {
    const { root, h } = await chapterHandlers();
    expect((await callBody(h, "POST", "/api/edit", { path: ":doc[2]", op: "frobnicate", yamlover: '"x"' })).status).toBe(400);
    // root `emplace` sets the self-value; root `replace` rewrites the document wholesale;
    // root `remove` DETACHES from the parent — unreferenced, the storage archives to .yo/.trash
    expect((await callBody(h, "POST", "/api/edit", { path: ":doc", op: "remove" })).status).toBe(200);
    expect(fs.existsSync(path.join(root, ".yo", ".trash", "doc", ".yo", "body.yo"))).toBe(true);
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
  "!!<*yamlover: $defs: chapter>\n" +
  "T\n" +
  "description: Sub\n" +
  "- Hello\n" +
  "- |\n  first line\n  second line\n" +
  "- Sub\n  - First\n";
const OMNI_DEFS = {
  "$defs/chapter":
    "type: variant\nvalue:\n  type: string\nproperties:\n  description:\n    type: string\nitems:\n  anyOf:\n    - *:: yamlover: $defs: chapter\n    - *:: yamlover: $defs: chunk\n",
  "$defs/chunk": "type: [string, binary]\nformat: text/marklower\n",
};

async function omniChapterHandlers(extra: Record<string, string> = {}) {
  const root = tmpTree({ "doc/.yo/body.yo": OMNI_CHAPTER, ...OMNI_DEFS, ...extra });
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
    expect((await nodeJson(h, { path: ":doc" })).json.title).toBe("New Title");
  });

  it("a title the bare line would misread KEEPS its quotes (an entry opener, a number)", async () => {
    const { root, h } = await omniChapterHandlers();
    await callBody(h, "POST", "/api/edit", { path: ":doc", op: "emplace", yamlover: '"note: to self"' });
    expect(bodyOf(root)).toContain('"note: to self"'); // bare it would open a keyed entry
    expect((await nodeJson(h, { path: ":doc" })).json.title).toBe("note: to self");
    await callBody(h, "POST", "/api/edit", { path: ":doc", op: "emplace", yamlover: '"30"' });
    expect(bodyOf(root)).toContain('"30"'); // bare it would read as a number
    expect((await nodeJson(h, { path: ":doc" })).json.title).toBe("30");
  });

  it("an EMPTY payload drops the title line (an untitled chapter has no self-value at all)", async () => {
    const { root, h } = await omniChapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc", op: "emplace", yamlover: '""' });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).not.toMatch(/^T$/m);
    expect((await nodeJson(h, { path: ":doc" })).json.title).toBeNull();
  });

  it("an EXPLICITLY EMPTY payload at the root CLEARS the body — the banner and comments stand", async () => {
    // NOT the `""` case above: `""` is a payload CARRYING an empty scalar (it drops the title),
    // while `` is the explicit CLEAR. It used to no-op silently (payloadFacets("") read as an
    // empty self-value with nothing to drop) — the yed mount emits exactly this when a document
    // is unwound to nothing, and the no-op left the editor and the disk DIVERGED (the reported
    // 'TOC did not clear' + every later op mis-addressed the stale document). A flow-rooted body
    // has no entry addresses, so a targeted-removes clear cannot exist — the root emplace is
    // the one honest spelling.
    const { root, h } = await omniChapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc", op: "emplace", yamlover: "" });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toBe("!!<*yamlover: $defs: chapter>\n"); // the meta facet survives the clear
  });

  it("the ops that genuinely need a target still say so at the root", async () => {
    const { h } = await omniChapterHandlers();
    const rk = await callBody(h, "POST", "/api/edit", { path: ":doc", op: "rekey", yamlover: "" });
    expect(rk.status, "`rekey` at the root should be rejected").toBe(400);
    expect(String(rk.json?.error ?? "")).toContain("needs a key or index target");
    // `remove` at a document root means DETACH FROM THE PARENT; with no granting entry the
    // member is ORPHANED and its storage ARCHIVES into .yo/.trash — a 200, data preserved
    const rm = await callBody(h, "POST", "/api/edit", { path: ":doc", op: "remove" });
    expect(rm.status, "`remove` of an unreferenced document archives it").toBe(200);
  });

  it("re-adds a title to an untitled chapter: the self-value lands right after the tag line", async () => {
    const { root, h } = await omniChapterHandlers({
      "doc/.yo/body.yo": "!!<*yamlover: $defs: chapter>\n- Hello\n",
    });
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc", op: "emplace", yamlover: '"Fresh"' });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toBe("!!<*yamlover: $defs: chapter>\nFresh\n- Hello\n");
    expect((await nodeJson(h, { path: ":doc" })).json.title).toBe("Fresh");
  });

  it("a FRESH self-value with `at` lands at its typed position — order kept (REPRESENTATION RULE)", async () => {
    const { root, h } = await omniChapterHandlers({
      "doc/.yo/body.yo": "- solid\n- recommended\nscale: 10\n",
    });
    const r = await callBody(h, "POST", "/api/edit", {
      path: ":doc", op: "emplace", yamlover: "|\n  A block-scalar self-value\n  multi-line text", at: 1,
    });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toBe("- solid\n|\n  A block-scalar self-value\n  multi-line text\n- recommended\nscale: 10\n");
    const v = (await nodeJson(h, { path: ":doc" })).json.value as { $yamloverMixed?: { selfAt?: number } };
    expect(v.$yamloverMixed?.selfAt).toBe(1); // the projection keeps the authored position too
  });

  it("`at` past the entry count appends the self line after the last entry", async () => {
    const { root, h } = await omniChapterHandlers({
      "doc/.yo/body.yo": "- solid\n- recommended\n",
    });
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc", op: "emplace", yamlover: '"late title"', at: 9 });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toBe("- solid\n- recommended\nlate title\n");
  });

  it("an INSERT payload with a mid-position self line keeps the typed order (in its item directory)", async () => {
    const { root, h } = await omniChapterHandlers({
      "doc/.yo/body.yo": "- placeholder\n",
    });
    const r = await callBody(h, "POST", "/api/edit", {
      path: ":doc[1]", op: "insert", yamlover: "- solid\n|\n  block text\n- recommended",
    });
    expect(r.status).toBe(200);
    // an UNTAGGED ordinal container derives to a sequential item directory (derive-concrete.ts
    // dir-seq); the parent body gains the pointer at the insert's position, and the member's own
    // body keeps the typed order verbatim — the self line BETWEEN its entries, as authored
    expect(bodyOf(root)).toBe("- placeholder\n- *: item01\n");
    expect(fs.readFileSync(path.join(root, "doc", "item01", ".yo", "body.yo"), "utf8"))
      .toBe("- solid\n|\n  block text\n- recommended\n");
  });

  it("title edits do not shift body indices: description is [0], the body starts at [1]", async () => {
    const { h } = await omniChapterHandlers();
    await callBody(h, "POST", "/api/edit", { path: ":doc", op: "emplace", yamlover: '"Renamed"' });
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[1]", op: "emplace", yamlover: "|-\n  Goodbye" });
    expect(r.status).toBe(200);
    const b = body((await nodeJson(h, { path: ":doc", depth: "3" })).json);
    expect(b[0]).toBe("Goodbye");
    expect(b[1]).toBe("first line\nsecond line\n");
  });

  it("emplaces a SUBCHAPTER's title: a scalar payload on `[i]` replaces its head, the body stands", async () => {
    const { root, h } = await omniChapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[3]", op: "emplace", yamlover: '"Renamed Sub"' });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toContain("- Renamed Sub\n  - First"); // plain — the safe payload unquotes
    expect((await nodeJson(h, { path: ":doc[3]", depth: "3" })).json.title).toBe("Renamed Sub");
  });

  it("an EMPTY payload on a subchapter un-titles it (its body survives as a compact container)", async () => {
    const { root, h } = await omniChapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[3]", op: "emplace", yamlover: '""' });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toContain("- - First");
    expect((await nodeJson(h, { path: ":doc[3]", depth: "3" })).json.title).toBeNull();
  });

  it("inserts a titled subchapter whole: a `\"Title\"\\n- chunk` payload becomes an item directory", async () => {
    const { root, h } = await omniChapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc", op: "insert", yamlover: '"T2"\n- "c1"' });
    expect(r.status).toBe(200);
    // dir-seq: the subchapter is its own directory member, appended to the body as a pointer.
    // Like ex-66, the dir member sorts as a keyed entry first and the body position holds a
    // `*` ref to it — the KEYED path is its stable address. An UNDERIVED member is untagged
    // (schema does not cross a document boundary): the self-value survives as data, but the
    // chapter TITLE convenience needs the tag — the chapter flows pass meta/concrete explicitly.
    expect(bodyOf(root)).toContain("- *: item01");
    expect(fs.readFileSync(path.join(root, "doc", "item01", ".yo", "body.yo"), "utf8")).toBe('"T2"\n- "c1"\n');
    const j = (await nodeJson(h, { path: ":doc:item01", depth: "3" })).json;
    expect((j.value as { $yamloverMixed?: { value?: unknown } }).$yamloverMixed?.value).toBe("T2");
    expect(j.concrete).toBe("dir/yamlover");
  });

  it("titling a compact UNTITLED subchapter keeps ALL its chunks (the swallowed-first-chunk bug)", async () => {
    // the untitled subchapter is the compact `- - first` form: its first chunk lives inline on the
    // marker line, and a title emplace must file it as body — not replace it as the "scalar"
    const { root, h } = await omniChapterHandlers({
      "doc/.yo/body.yo": "!!<*yamlover: $defs: chapter>\nT\n- Hello\n- - first chunk\n  - second chunk\n",
    });
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[1]", op: "emplace", yamlover: '"Added title"' });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toContain("- Added title\n  - first chunk\n  - second chunk");
    const sub = (await nodeJson(h, { path: ":doc[1]", depth: "3" })).json;
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
    expect(r.json.path).toBe(":doc:5"); // after title(0)/description(1)/Hello(2)/block(3)/Sub(4)
    expect(bodyOf(root)).toContain('title: "Fresh"');
    const node = (await nodeJson(h, { path: ":doc[5]", depth: "3" }));
    expect(node.json.format).toBe("x-yamlover-chapter");
    expect(body(node.json)).toEqual([""]); // one empty, immediately-editable chunk
  });

  it("child linked file: writes a .yo doc beside the parent + a pointer in the body", async () => {
    const { root, h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc", op: "insert", concrete: "file/yamlover", name: "Linked", meta: CHAP, yamlover: BODY });
    expect(r.status).toBe(200);
    expect(fs.existsSync(path.join(root, "doc", "Linked.yo"))).toBe(true); // dir-backed doc → inside doc/
    expect(bodyOf(root)).toContain("- *: Linked.yo");
    expect(r.json.path).toBe(":doc:Linked.yo"); // navigates to the linked doc's own node
    expect((await nodeJson(h, { path: r.json.path })).json.format).toBe("x-yamlover-chapter");
  });

  it("child linked dir: writes an order-numbered <NN-name>/.yo/body.yo + a pointer", async () => {
    const { root, h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc", op: "insert", concrete: "dir/yamlover", name: "SubDir", meta: CHAP, yamlover: BODY });
    expect(r.status).toBe(200);
    expect(fs.existsSync(path.join(root, "doc", "01-SubDir", ".yo", "body.yo"))).toBe(true);
    expect(bodyOf(root)).toContain("- *: 01-SubDir");
    expect(r.json.path).toBe(":doc:01-SubDir");
    expect((await nodeJson(h, { path: r.json.path })).json.format).toBe("x-yamlover-chapter");
  });

  it("a UNICODE name stays readable (pointer-safe): «Заголовок части» → Заголовок_части, not underscores", async () => {
    const { root, h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", {
      path: ":doc", op: "insert", concrete: "dir/yamlover", name: "Заголовок части", meta: CHAP, yamlover: 'Заголовок части\n- ""',
    });
    expect(r.status).toBe(200);
    expect(r.json.path).toBe(":doc:" + encodeURIComponent("01-Заголовок_части"));
    expect(fs.existsSync(path.join(root, "doc", "01-Заголовок_части", ".yo", "body.yo"))).toBe(true);
    expect(bodyOf(root)).toContain("- *: 01-Заголовок_части");
    // the member resolves as a chapter and edits address it by its KEYED path
    expect((await nodeJson(h, { path: r.json.path })).json.format).toBe("x-yamlover-chapter");
    const r2 = await callBody(h, "POST", "/api/edit", { path: `${r.json.path}[0]`, op: "emplace", yamlover: "Первый абзац" });
    expect(r2.status).toBe(200);
    expect(fs.readFileSync(path.join(root, "doc", "01-Заголовок_части", ".yo", "body.yo"), "utf8")).toContain("Первый абзац");
  });

  it("a subchapter inserted BETWEEN two siblings slots a sub-number — no renumbering", async () => {
    const { root, h } = await chapterHandlers();
    await callBody(h, "POST", "/api/edit", { path: ":doc", op: "insert", concrete: "dir/yamlover", name: "A", meta: CHAP, yamlover: BODY });
    await callBody(h, "POST", "/api/edit", { path: ":doc", op: "insert", concrete: "dir/yamlover", name: "B", meta: CHAP, yamlover: BODY });
    expect(bodyOf(root)).toContain("- *: 01-A\n- *: 02-B");
    // the fixture body holds entries [0..4] (title, description, three chunks) — the two
    // appended pointers sit at [5] and [6]; inserting AT [6] slots between them
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[6]", op: "insert", concrete: "dir/yamlover", name: "C", meta: CHAP, yamlover: BODY });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toContain("- *: 01-A\n- *: 01-1-C\n- *: 02-B");
    // the number is cosmetic; existing member directories are never renamed
    for (const dir of ["01-A", "01-1-C", "02-B"]) {
      expect(fs.existsSync(path.join(root, "doc", dir, ".yo", "body.yo"))).toBe(true);
    }
  });

  it("member file: a plain directory has no body to splice, so the content becomes a member", async () => {
    const root = dirTree();
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: ":dir", op: "insert", concrete: "file/yamlover", name: "New Note", meta: CHAP, yamlover: BODY });
    expect(r.status).toBe(200);
    expect(fs.existsSync(path.join(root, "dir", "New Note.yo"))).toBe(true);
    expect((await nodeJson(h, { path: r.json.path })).json.format).toBe("x-yamlover-chapter");
  });

  it("member dir: a directory-backed chapter in a directory", async () => {
    const root = dirTree();
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: ":dir", op: "insert", concrete: "dir/yamlover", name: "New Dir", meta: CHAP, yamlover: BODY });
    expect(r.status).toBe(200);
    expect(fs.existsSync(path.join(root, "dir", "New Dir", ".yo", "body.yo"))).toBe(true);
    expect((await nodeJson(h, { path: r.json.path })).json.format).toBe("x-yamlover-chapter");
  });

  it("untagged NODE member: no `meta`, no body — an EMPTY generic yamlover document", async () => {
    const root = dirTree();
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: ":dir", op: "insert", concrete: "dir/yamlover", name: "New node" });
    expect(r.status).toBe(200);
    expect(fs.readFileSync(path.join(root, "dir", "New node", ".yo", "body.yo"), "utf8")).toBe("\n");
    const node = (await nodeJson(h, { path: r.json.path })).json;
    expect(node.format).toBeNull(); // no schema meta — a plain node, not a chapter
    expect(node.value).toBeNull(); // an empty document, NOT an empty-string scalar
    expect(node.concrete).toBe("dir/yamlover");
    // the first token lands via a root emplace — `12` becomes the integer scalar 12
    const e = await callBody(h, "POST", "/api/edit", { path: r.json.path, op: "emplace", yamlover: "12" });
    expect(e.status).toBe(200);
    expect((await nodeJson(h, { path: r.json.path })).json.value).toBe(12);
  });

  it("rejects creating against a scalar — it backs no document and is no directory", async () => {
    const root = tmpTree({ name: "Alice" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: ":name", op: "insert", concrete: "file/yamlover", name: "X", meta: CHAP, yamlover: BODY });
    expect(r.status).toBe(400);
  });

  it("keyed INSERT: `key` makes a `key: value` entry AT the position — authored order preserved", async () => {
    const root = tmpTree({ "days.yo": "- mon\n12\n", "list.yo": "- a\n- b\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    // past-end append: lands AFTER the bare self line, exactly where it was typed
    const r1 = await callBody(h, "POST", "/api/edit", { path: ":days.yo[1]", op: "insert", key: "12", yamlover: "tue" });
    expect(r1.status).toBe(200);
    // the numeric STRING key is quoted on write - a bare `12:` is a position (YAML-keys round)
    expect(fs.readFileSync(path.join(root, "days.yo"), "utf8")).toBe('- mon\n12\n"12": tue\n');
    // mid-list: splices BEFORE entry [1], keyed — unlike a fresh keyed emplace (top of block)
    const r2 = await callBody(h, "POST", "/api/edit", { path: ":list.yo[1]", op: "insert", key: "k", yamlover: '"v"' });
    expect(r2.status).toBe(200);
    expect(fs.readFileSync(path.join(root, "list.yo"), "utf8")).toBe('- a\nk: "v"\n- b\n');
  });

  it("omni re-emplace: a scalar entry gains children via a whole-omni emplace (the level rule)", async () => {
    const root = tmpTree({ "doc.yo": "- scalar\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    // the editor's `- scalar` ↵ `- element` ↵ — the entry was a plain scalar, so the first child
    // arrives as a re-emplace of the WHOLE omni at the entry's own path
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc.yo[0]", op: "emplace", yamlover: "scalar\n- element" });
    expect(r.status).toBe(200);
    expect(fs.readFileSync(path.join(root, "doc.yo"), "utf8")).toBe("- scalar\n  - element\n");
    const j = (await nodeJson(h, { path: ":doc.yo", depth: ".inf" })).json as { value: { $yamloverMixed: { kind: string; value: unknown; entries: unknown[] } }[] };
    const m = j.value[0].$yamloverMixed;
    expect(m.kind).toBe("omni");
    expect(m.value).toBe("scalar");
    expect(m.entries).toEqual([{ key: null, value: "element" }]);
  });

  it("keyed INSERT with a NESTED payload: the editor's `pets:` ↵ `- name: Rex` flow round-trips", async () => {
    const root = tmpTree({ "pets.yo": "\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: ":pets.yo[0]", op: "insert", key: "pets", yamlover: "- name: Rex" });
    expect(r.status).toBe(200);
    const src = fs.readFileSync(path.join(root, "pets.yo"), "utf8");
    expect(src).toContain("pets:");
    expect(src).toContain("- name: Rex"); // the compact dash form, as the client serializes it
    const j = (await nodeJson(h, { path: ":pets.yo", depth: ".inf" })).json as { value: unknown };
    expect(j.value).toEqual({ pets: [{ name: "Rex" }] });
  });

  it("the editor's whole-document PASTE batch lands on an empty file: per-entry inserts + the self emplace", async () => {
    // exactly the ops pasteRootDocument (client paste.ts) emits for a pasted document with a
    // self line, a nested keyed subtree, and a trailing keyed scalar — a document root takes
    // no whole-payload emplace, so the paste must arrive in this per-entry shape
    const root = tmpTree({ "n.yo": "\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { edits: [
      { path: ":n.yo[0]", op: "insert", key: "pets", yamlover: "- name: Rex\n  species: dog\n- name: Whiskers\n  species: cat" },
      { path: ":n.yo[1]", op: "insert", key: "after", yamlover: "1" },
      { path: ":n.yo", op: "emplace", yamlover: "A Title" },
    ] });
    expect(r.status).toBe(200);
    const j = (await nodeJson(h, { path: ":n.yo", depth: ".inf" })).json as { value: unknown };
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
    const root = tmpTree({ "n.yo": '""\n' });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { edits: [
      { path: ":n.yo", op: "emplace", yamlover: '""' },
      { path: ":n.yo[0]", op: "insert", key: "pets", yamlover: "- name: Rex" },
    ] });
    expect(r.status).toBe(200);
    const src = fs.readFileSync(path.join(root, "n.yo"), "utf8");
    expect(src).not.toContain('""'); // the placeholder line LEFT
    const j = (await nodeJson(h, { path: ":n.yo", depth: ".inf" })).json as { value: unknown };
    expect(j.value).toEqual({ pets: [{ name: "Rex" }] });
  });

  it("bare folder: `concrete:\"dir\"` makes an EMPTY OS directory member — no body, no .yo", async () => {
    const root = dirTree();
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: ":dir", op: "insert", concrete: "dir", name: "New Folder" });
    expect(r.status).toBe(200);
    expect(r.json.path).toBe(":dir:'New%20Folder'"); // segsToStr percent-encodes the space
    const abs = path.join(root, "dir", "New Folder");
    expect(fs.statSync(abs).isDirectory()).toBe(true);
    expect(fs.readdirSync(abs)).toEqual([]); // truly empty — no .yo marker, no body file
    expect((await nodeJson(h, { path: r.json.path })).json.concrete).toBe("dir");
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
    expect(first.json.path).toBe(":dir:'New%20Folder'");
    expect(second.json.path).toBe(":dir:'New%20Folder-1'");
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
  it("edits a chunk of a standalone *.yo chapter (Cyrillic)", async () => {
    const root = tmpTree({ "статья.yo": '!!<*::yamlover:$defs:chapter>\ntitle: "Заголовок"\n- Привет\n' });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const at = ":" + encodeURIComponent("статья.yo") + "[1]"; // title consumes index 0
    const r = await callBody(h, "POST", "/api/edit", { path: at, op: "emplace", yamlover: "|-\n  Пока" });
    expect(r.status).toBe(200);
    const src = fs.readFileSync(path.join(root, "статья.yo"), "utf8");
    expect(src).toContain("Пока"); // re-emitted losslessly (block scalar) — verify the parsed value
    expect((await nodeJson(h, { path: at })).json.value).toBe("Пока");
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
    expect((await nodeJson(h, { path: ":pet.yaml:age" })).json.value).toBe(5);
  });

  it("descends a keyed `key:` → sequence → item and edits an inline field (regression: no phantom entry)", async () => {
    // `reachChapter` sets the descended region's marker to the `pets:` KEY line; that line must NOT be
    // surfaced as an inline entry (only `- ` items are), else a phantom `pets` entry shifts every index
    // and `pets[0]` reads as a scalar. Real breakage from examples/06-tour.yo.
    const src = "pets:\n  - name: Rex\n    species: dog\n  - name: Whiskers\n    species: cat\n";
    const { root, h } = await handlersFor({ "z.yaml": src });
    const r = await callBody(h, "POST", "/api/edit", { path: ":z.yaml:pets[0]:name", op: "emplace", yamlover: "Rex1" });
    expect(r.status).toBe(200);
    const out = read(root, "z.yaml");
    expect(out).toContain("- name: Rex1");
    expect(out).toContain("- name: Whiskers"); // the other item untouched
    expect((await nodeJson(h, { path: ":z.yaml:pets[0]:name" })).json.value).toBe("Rex1");
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
      "doc/.yo/body.yo": "!!<*yamlover: $defs: chapter>\ntitle: Root\n- intro\n- *: zebra\n- *: apple\n",
      "doc/zebra/.yo/body.yo": "!!<*yamlover: $defs: chapter>\ntitle: Zebra\n- z body\n",
      "doc/apple/.yo/body.yo": "!!<*yamlover: $defs: chapter>\ntitle: Apple\n- a body\n",
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
      "doc/.yo/body.yo": "!!<*yamlover: $defs: chapter>\ntitle: Root\n- intro\n- *: zebra\n- *: apple\n",
      "doc/zebra/.yo/body.yo": "!!<*yamlover: $defs: chapter>\ntitle: Zebra\n- z body\n",
      "doc/apple/.yo/body.yo": "!!<*yamlover: $defs: chapter>\ntitle: Apple\n- a body\n",
      "doc/mango/.yo/body.yo": "!!<*yamlover: $defs: chapter>\ntitle: Mango\n- m body\n",
      "doc/kiwi/.yo/body.yo": "!!<*yamlover: $defs: chapter>\ntitle: Kiwi\n- k body\n",
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
    "!!<*yamlover: $defs: chapter>\n" +
    'title: "T"\n' +
    "- !!<*yamlover: $defs: table>\n" +
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
      "type: variant\nproperties:\n  title:\n    type: string\nitems:\n  type: array\n  items:\n    anyOf:\n      - *:: yamlover: $defs: chunk\n      - *:: yamlover: $defs: table\n",
  };
  async function tableHandlers() {
    const root = tmpTree({ "doc/.yo/body.yo": TABLE, ...TDEFS });
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
    const json = (await nodeJson(h, { path: ":doc[1][2]", depth: ".inf" })).json as { value: unknown[] };
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
  const dBody = (root: string) => fs.readFileSync(path.join(root, "d", ".yo", "body.yo"), "utf8");

  it("emplace onto a BODYLESS dir materializes the body with the scalar self-value", async () => {
    const root = emptyDirTree();
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: ":d", op: "emplace", yamlover: "12" });
    expect(r.status).toBe(200);
    expect(dBody(root)).toBe("12\n");
    expect((await nodeJson(h, { path: ":d" })).json.value).toBe(12);
    // a second emplace REPLACES the line in place (the body now exists — the ordinary route)
    const r2 = await callBody(h, "POST", "/api/edit", { path: ":d", op: "emplace", yamlover: '"hello"' });
    expect(r2.status).toBe(200);
    expect((await nodeJson(h, { path: ":d" })).json.value).toBe("hello");
  });

  it("keyed SCALAR insert into a bodyless dir lands in the body overlay", async () => {
    const root = emptyDirTree();
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: ":d[0]", op: "insert", key: "scale", yamlover: "10" });
    expect(r.status).toBe(200);
    expect(dBody(root)).toContain("scale: 10");
    expect(((await nodeJson(h, { path: ":d", depth: ".inf" })).json.value as Record<string, unknown>).scale).toBe(10);
  });

  it("keyed CONTAINER insert becomes a NESTED real directory, recursively", async () => {
    const root = emptyDirTree();
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: ":d[0]", op: "insert", key: "sub", yamlover: "a: 1\ndeep:\n  b: 2" });
    expect(r.status).toBe(200);
    expect(fs.statSync(path.join(root, "d", "sub")).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(root, "d", "sub", ".yo", "body.yo"), "utf8")).toBe("a: 1\n");
    expect(fs.statSync(path.join(root, "d", "sub", "deep")).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(root, "d", "sub", "deep", ".yo", "body.yo"), "utf8")).toBe("b: 2\n");
    const j = (await nodeJson(h, { path: ":d:sub", depth: ".inf" })).json;
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

  it("ordinal CONTAINER insert becomes a sequential item directory + a body pointer (dir-seq)", async () => {
    const root = emptyDirTree();
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: ":d[0]", op: "insert", yamlover: "a: 1\n- 2" });
    expect(r.status).toBe(200);
    expect(dBody(root)).toBe("- *: item01\n");
    expect(fs.readFileSync(path.join(root, "d", "item01", ".yo", "body.yo"), "utf8")).toBe("a: 1\n- 2\n");
    expect((await nodeJson(h, { path: ":d:item01", depth: ".inf" })).json.concrete).toBe("dir/yamlover");
  });

  it("two ordinal containers in one batch: item01 then item02, in order", async () => {
    const root = emptyDirTree();
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { edits: [
      { path: ":d[0]", op: "insert", yamlover: "- 1" },
      { path: ":d[1]", op: "insert", yamlover: "- 2" },
    ] });
    expect(r.status).toBe(200);
    expect(dBody(root)).toBe("- *: item01\n- *: item02\n");
    expect(fs.readFileSync(path.join(root, "d", "item01", ".yo", "body.yo"), "utf8")).toBe("- 1\n");
    expect(fs.readFileSync(path.join(root, "d", "item02", ".yo", "body.yo"), "utf8")).toBe("- 2\n");
  });

  it("an insert BETWEEN two items slots a sub-number (item01-1) — nothing is renumbered", async () => {
    const root = emptyDirTree();
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    await callBody(h, "POST", "/api/edit", { edits: [
      { path: ":d[0]", op: "insert", yamlover: "- 1" },
      { path: ":d[1]", op: "insert", yamlover: "- 2" },
    ] });
    const r = await callBody(h, "POST", "/api/edit", { path: ":d[1]", op: "insert", yamlover: "- between" });
    expect(r.status).toBe(200);
    // order lives in the body pointer-array; the number is cosmetic listing order
    expect(dBody(root)).toBe("- *: item01\n- *: item01-1\n- *: item02\n");
    expect(fs.readFileSync(path.join(root, "d", "item01-1", ".yo", "body.yo"), "utf8")).toBe("- between\n");
    // the no-renumber invariant: the existing directories are untouched
    expect(fs.readFileSync(path.join(root, "d", "item01", ".yo", "body.yo"), "utf8")).toBe("- 1\n");
    expect(fs.readFileSync(path.join(root, "d", "item02", ".yo", "body.yo"), "utf8")).toBe("- 2\n");
  });

  it("inline scalars and item pointers interleave in body order", async () => {
    const root = emptyDirTree();
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { edits: [
      { path: ":d[0]", op: "insert", yamlover: "chunk" },
      { path: ":d[1]", op: "insert", yamlover: "- nested" },
      { path: ":d[2]", op: "insert", yamlover: "tail" },
    ] });
    expect(r.status).toBe(200);
    expect(dBody(root)).toBe("- chunk\n- *: item01\n- tail\n");
  });

  it("a TAGGED ordinal container is CONTENT — it stays inline in the body", async () => {
    const root = emptyDirTree();
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", {
      path: ":d[0]", op: "insert", yamlover: "- a\n- b", meta: "*yamlover: $defs: bullets",
    });
    expect(r.status).toBe(200);
    expect(dBody(root)).toContain("!!<*yamlover: $defs: bullets>");
    expect(dBody(root)).toContain("- a");
    expect(fs.existsSync(path.join(root, "d", "item01"))).toBe(false);
  });

  it("an explicit `concrete: yamlover` pins the INLINE encoding — no derivation", async () => {
    const root = emptyDirTree();
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: ":d[0]", op: "insert", concrete: "yamlover", yamlover: "- 1\n- 2" });
    expect(r.status).toBe(200);
    expect(dBody(root)).toBe("- - 1\n  - 2\n");
    expect(fs.existsSync(path.join(root, "d", "item01"))).toBe(false);
  });

  it("removing the positional element splices only the pointer line — the item directory survives", async () => {
    const root = emptyDirTree();
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    await callBody(h, "POST", "/api/edit", { edits: [
      { path: ":d[0]", op: "insert", yamlover: "chunk" },
      { path: ":d[1]", op: "insert", yamlover: "- kept data" },
    ] });
    const r = await callBody(h, "POST", "/api/edit", { path: ":d[1]", op: "remove" });
    expect(r.status).toBe(200);
    expect(dBody(root)).toBe("- chunk\n");
    // never destroy user data: the directory is ORPHANED and resurfaces as a keyed-only member
    expect(fs.readFileSync(path.join(root, "d", "item01", ".yo", "body.yo"), "utf8")).toBe("- kept data\n");
    const m = ((await nodeJson(h, { path: ":d", depth: ".inf" })).json.value as
      { $yamloverMixed?: { entries: { key: string | null; anchor?: boolean }[] } }).$yamloverMixed;
    const item = m?.entries.find((e) => e.key === "item01");
    expect(item).toBeTruthy();
    expect(item?.anchor).toBeUndefined(); // unreferenced now — keyed-only, no position
  });

  it("a Tab-shaped batch (remove + insert concrete dir/yamlover) remaps same-batch follow-ups", async () => {
    const root = emptyDirTree();
    fs.mkdirSync(path.join(root, "d", ".yo"));
    fs.writeFileSync(path.join(root, "d", ".yo", "body.yo"), "- one\n- two\n");
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { edits: [
      { path: ":d[1]", op: "remove" },
      { path: ":d[1]", op: "insert", concrete: "dir/yamlover", name: "Sub", yamlover: '"Sub"\n- two' },
      { path: ":d[1][1]", op: "insert", yamlover: "three" },
    ] });
    expect(r.status).toBe(200);
    expect(dBody(root)).toBe("- one\n- *: 01-Sub\n");
    expect(fs.readFileSync(path.join(root, "d", "01-Sub", ".yo", "body.yo"), "utf8")).toBe('"Sub"\n- two\n- three\n');
  });

  it("a MARKER-ONLY dir (.yo exists, no body) gains its body on emplace", async () => {
    const root = emptyDirTree();
    fs.mkdirSync(path.join(root, "d", ".yo"));
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: ":d", op: "emplace", yamlover: "12" });
    expect(r.status).toBe(200);
    expect(dBody(root)).toBe("12\n");
  });

  it("the served ROOT of an empty project gains .yo/body.yo on its first keyed insert", async () => {
    const root = tmpTree({}); // an empty project: no body, no files — only what the server adds
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: "[0]", op: "insert", key: "a", yamlover: "12" });
    expect(r.status).toBe(200);
    expect(fs.readFileSync(path.join(root, ".yo", "body.yo"), "utf8")).toBe("a: 12\n");
    expect(((await nodeJson(h, { path: "", depth: ".inf" })).json.value as Record<string, unknown>).a).toBe(12);
    // the body now exists — the NEXT edit takes the established route and appends to it
    const r2 = await callBody(h, "POST", "/api/edit", { path: "[1]", op: "insert", key: "b", yamlover: "34" });
    expect(r2.status).toBe(200);
    expect(fs.readFileSync(path.join(root, ".yo", "body.yo"), "utf8")).toBe("a: 12\nb: 34\n");
    // a keyed CONTAINER at the root derives to a real subdirectory, same as any dir target
    const r3 = await callBody(h, "POST", "/api/edit", { path: "[2]", op: "insert", key: "sub", yamlover: "c: 1" });
    expect(r3.status).toBe(200);
    expect(fs.readFileSync(path.join(root, "sub", ".yo", "body.yo"), "utf8")).toBe("c: 1\n");
  });

  it("emplace onto the BODYLESS served root materializes the body with the self-value", async () => {
    const root = tmpTree({});
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: "", op: "emplace", yamlover: '"hello"' });
    expect(r.status).toBe(200);
    expect(fs.readFileSync(path.join(root, ".yo", "body.yo"), "utf8")).toBe("hello\n");
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
    expect(fs.readFileSync(path.join(root, "d", "sub", ".yo", "body.yo"), "utf8")).toBe("a: 1\n");
    const j = (await nodeJson(h, { path: ":d", depth: ".inf" })).json as { value: { $yamloverMixed?: { value?: unknown; entries?: { key: string | null; value: unknown }[] } } };
    const m = j.value.$yamloverMixed!;
    expect(m.value).toBe(12); // the dir's own scalar line
    expect(Object.fromEntries(m.entries!.map((e) => [e.key, e.value]))).toEqual({ scale: 10, sub: { a: 1 } });
  });
});

describe("/api/edit — compact `- - x` nesting (a one-line nested item is a container)", () => {
  const emptyDirTree = () => {
    const root = tmpTree({ "readme.txt": "x" });
    fs.mkdirSync(path.join(root, "d"));
    return root;
  };
  const dBody = (root: string) => fs.readFileSync(path.join(root, "d", ".yo", "body.yo"), "utf8");

  it("the editor's typing flow: `- 12` then a nested `- - 12` / `- 13`, one request per pause", async () => {
    const root = emptyDirTree();
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    await callBody(h, "POST", "/api/edit", { path: ":d[0]", op: "insert", yamlover: "12" });
    // the nested container derives to a sequential ITEM DIRECTORY (derive-concrete.ts dir-seq)
    // referenced by a pointer-array element at its position
    await callBody(h, "POST", "/api/edit", { path: ":d[1]", op: "insert", yamlover: "- 12" });
    // descending INTO `[1]` — the position aliases the keyed item01 member (canonSegs)
    const r = await callBody(h, "POST", "/api/edit", { path: ":d[1][1]", op: "insert", yamlover: "13" });
    expect(r.status).toBe(200);
    expect(dBody(root)).toBe("- 12\n- *: item01\n");
    expect(fs.readFileSync(path.join(root, "d", "item01", ".yo", "body.yo"), "utf8")).toBe("- 12\n- 13\n");
    expect((await nodeJson(h, { path: ":d[1]", depth: ".inf" })).json.value).toEqual([12, 13]);
  });

  it("the same flow typed FAST — one batch, the member born mid-batch (the in-batch remap)", async () => {
    const root = emptyDirTree();
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { edits: [
      { path: ":d[0]", op: "insert", yamlover: "12" },
      { path: ":d[1]", op: "insert", yamlover: "- 12" },
      { path: ":d[1][1]", op: "insert", yamlover: "13" },
    ] });
    expect(r.status).toBe(200);
    expect(dBody(root)).toBe("- 12\n- *: item01\n");
    expect(fs.readFileSync(path.join(root, "d", "item01", ".yo", "body.yo"), "utf8")).toBe("- 12\n- 13\n");
  });

  it("the same fast batch at the served ROOT of an empty project", async () => {
    const root = tmpTree({});
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { edits: [
      { path: "[0]", op: "insert", yamlover: "12" },
      { path: "[1]", op: "insert", yamlover: "- 12" },
      { path: "[1][1]", op: "insert", yamlover: "13" },
    ] });
    expect(r.status).toBe(200);
    expect(fs.readFileSync(path.join(root, ".yo", "body.yo"), "utf8")).toBe("- 12\n- *: item01\n");
    expect(fs.readFileSync(path.join(root, "item01", ".yo", "body.yo"), "utf8")).toBe("- 12\n- 13\n");
  });

  it("emplace and remove on the INLINE nested item keep the outer `- ` marker", async () => {
    const root = emptyDirTree();
    fs.mkdirSync(path.join(root, "d", ".yo"));
    fs.writeFileSync(path.join(root, "d", ".yo", "body.yo"), "- 12\n- - 12\n  - 13\n");
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: ":d[1][0]", op: "emplace", yamlover: "14" });
    expect(r.status).toBe(200);
    expect(dBody(root)).toBe("- 12\n- - 14\n  - 13\n");
    const r2 = await callBody(h, "POST", "/api/edit", { path: ":d[1][0]", op: "remove" });
    expect(r2.status).toBe(200);
    expect(dBody(root)).toBe("- 12\n-\n  - 13\n");
    expect((await nodeJson(h, { path: ":d[1]", depth: ".inf" })).json.value).toEqual([13]);
  });
});

// STAGE 0 (chapter WYSIWYG plan): the server contract the client's "make this folder a chapter"
// flow rests on — a bodyless directory (the served root included) takes its `!!<…>` schema tag
// through the SAME root emplace that materializes its body, and re-projects as a chapter.
describe("/api/edit — stamping a schema tag on a bodyless directory", () => {
  const CHAPTER_META = "*::yamlover:$defs:chapter";

  it("meta alone on the empty served root writes a tagged body and projects as a chapter", async () => {
    const root = tmpTree({});
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: "", op: "emplace", meta: CHAPTER_META });
    expect(r.status).toBe(200);
    expect(fs.readFileSync(path.join(root, ".yo", "body.yo"), "utf8")).toBe(`!!<${CHAPTER_META}>\n`);
    expect((await nodeJson(h, { path: "" })).json.format).toBe("x-yamlover-chapter");
  });

  it("meta + a scalar payload sets the tag AND the title in one op (the first-edit stamp)", async () => {
    const root = tmpTree({});
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: "", op: "emplace", meta: CHAPTER_META, yamlover: '"My book"' });
    expect(r.status).toBe(200);
    expect(fs.readFileSync(path.join(root, ".yo", "body.yo"), "utf8")).toBe(`!!<${CHAPTER_META}>\nMy book\n`);
    const j = (await nodeJson(h, { path: "" })).json;
    expect(j.format).toBe("x-yamlover-chapter");
    expect(j.title).toBe("My book");
  });

  it("the whole first-edit batch: stamp+title, then a first body chunk", async () => {
    const root = tmpTree({});
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { edits: [
      { path: "", op: "emplace", meta: CHAPTER_META, yamlover: '"My book"' },
      { path: "", op: "insert", yamlover: '"first paragraph"' },
    ] });
    expect(r.status).toBe(200);
    expect(fs.readFileSync(path.join(root, ".yo", "body.yo"), "utf8"))
      .toBe(`!!<${CHAPTER_META}>\nMy book\n- "first paragraph"\n`); // a body insert splices verbatim; only the title emplace unquotes
    expect((await nodeJson(h, { path: "" })).json.format).toBe("x-yamlover-chapter");
  });

  it("the same on a bodyless SUBdirectory — the directory itself becomes the chapter", async () => {
    const root = tmpTree({ "readme.txt": "x" });
    fs.mkdirSync(path.join(root, "d"));
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: ":d", op: "emplace", meta: CHAPTER_META, yamlover: '"Sub"' });
    expect(r.status).toBe(200);
    expect((await nodeJson(h, { path: ":d" })).json.format).toBe("x-yamlover-chapter");
    expect((await nodeJson(h, { path: ":d" })).json.concrete).toBe("dir/yamlover");
  });

  it("a second edit carries no meta and leaves the tag standing", async () => {
    const root = tmpTree({});
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    await callBody(h, "POST", "/api/edit", { path: "", op: "emplace", meta: CHAPTER_META, yamlover: '"T"' });
    const r = await callBody(h, "POST", "/api/edit", { path: "", op: "emplace", yamlover: '"T2"' });
    expect(r.status).toBe(200);
    expect(fs.readFileSync(path.join(root, ".yo", "body.yo"), "utf8")).toBe(`!!<${CHAPTER_META}>\nT2\n`);
    expect((await nodeJson(h, { path: "" })).json.format).toBe("x-yamlover-chapter");
  });
});

// The ORDINAL half of the scalar→container promotion (concrete-rules.ts deriveMemberEncoding). A
// keyed node grown a child lifts into a directory named by its key; an ORDINAL element lifts the
// same way, into a sequentially-named member whose position is granted by the `- *: itemNN` pointer
// left in its place. Before this, an ordinal element could only grow INLINE — so a list nested by
// typing ended up entirely inside one body file, whatever depth it reached.
describe("/api/edit — an ordinal element grows into a directory member", () => {
  const body = (root: string, ...segs: string[]): string =>
    fs.readFileSync(path.join(root, ...segs, ".yo", "body.yo"), "utf8");
  const listing = (root: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string, rel: string): void => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (d.name.startsWith("index.db")) continue;
        const key = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) { out.push(key + "/"); walk(path.join(dir, d.name), key); } else out.push(key);
      }
    };
    walk(root, "");
    return out.sort();
  };

  it("nesting under an existing scalar element, one request per pause", async () => {
    const root = tmpTree({});
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    for (const p of [":[0]", ":[0][0]", ":[0][0][0]", ":[0][0][1]"]) {
      const val = { ":[0]": "World", ":[0][0]": "Eurasia", ":[0][0][0]": "Europe", ":[0][0][1]": "Asia" }[p]!;
      const r = await callBody(h, "POST", "/api/edit", { path: p, op: "insert", yamlover: val });
      expect(r.status, `${p} -> ${JSON.stringify(r.json)}`).toBe(200);
    }
    // each level is its OWN directory — the collection never accumulates in one file
    expect(listing(root)).toEqual([
      ".yo/",
      ".yo/body.yo",
      "item01/",
      "item01/.yo/",
      "item01/.yo/body.yo",
      "item01/item01/",
      "item01/item01/.yo/",
      "item01/item01/.yo/body.yo",
    ]);
    expect(body(root)).toBe("- *: item01\n");
    expect(body(root, "item01")).toBe("World\n- *: item01\n"); // the old scalar is the member's SELF-value
    expect(body(root, "item01", "item01")).toBe("Eurasia\n- Europe\n- Asia\n");
    // and the value still reads back as the list the user typed
    expect((await nodeJson(h, { path: ":", depth: ".inf" })).json.value).toMatchObject({
      $yamloverMixed: { entries: [{ key: "item01" }] },
    });
  });

  it("the same flow typed FAST — one batch, each level born mid-batch", async () => {
    const root = tmpTree({});
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { edits: [
      { path: ":[0]", op: "insert", yamlover: "World" },
      { path: ":[0][0]", op: "insert", yamlover: "Eurasia" },
      { path: ":[0][0][0]", op: "insert", yamlover: "Europe" },
    ] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(body(root)).toBe("- *: item01\n");
    expect(body(root, "item01")).toBe("World\n- *: item01\n");
    expect(body(root, "item01", "item01")).toBe("Eurasia\n- Europe\n");
  });

  it("an emplace that hands the element container content promotes it too (commitSpine)", async () => {
    const root = tmpTree({});
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    expect((await callBody(h, "POST", "/api/edit", { path: ":[0]", op: "insert", yamlover: "World" })).status).toBe(200);
    const r = await callBody(h, "POST", "/api/edit", { path: ":[0]", op: "emplace", yamlover: "World\n- Eurasia" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(body(root)).toBe("- *: item01\n");
    expect(body(root, "item01")).toBe("World\n- Eurasia\n");
  });

  it("a TAGGED ordinal container is CONTENT — it stays inline, exactly as at birth", async () => {
    const root = tmpTree({});
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    expect((await callBody(h, "POST", "/api/edit", { path: ":[0]", op: "insert", yamlover: "Row" })).status).toBe(200);
    const r = await callBody(h, "POST", "/api/edit", { path: ":[0]", op: "emplace", yamlover: "Row\n- a\n- b", meta: "format: text/marklower" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(listing(root)).toEqual([".yo/", ".yo/body.yo"]); // no member directory
    expect(body(root)).toContain("- !!<format: text/marklower> Row");
  });

  it("a FILE document keeps the grown element INLINE — there is no directory family to inherit", async () => {
    // the same transition, the other storage family: defaultChildConcrete keeps a file document's
    // children inline, so the element grows in place instead of lifting out
    const root = tmpTree({ "note.yo": "- World\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: ":note.yo[0]", op: "emplace", yamlover: "World\n- Eurasia" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(fs.readFileSync(path.join(root, "note.yo"), "utf8")).toBe("- World\n  - Eurasia\n");
    expect(listing(root).filter((p) => p.endsWith("/"))).toEqual([".yo/"]);
  });

  it("the hidden .yo overlay never takes a POSITIONAL address", async () => {
    // In a fresh project the overlay is the root's only indexed child, so `:[0]` used to alias it —
    // and the edit then wrote `.yo/.yo/`, the format violation this guards.
    const root = tmpTree({});
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { edits: [
      { path: ":[0]", op: "insert", yamlover: "World" },
      { path: ":[0][0]", op: "insert", yamlover: "Eurasia" },
    ] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(fs.existsSync(path.join(root, ".yo", ".yo"))).toBe(false);
    expect((call(h, "/api/doctor").json as { diagnostics: unknown[] }).diagnostics).toEqual([]);
  });
});

// The TOC's two display rules for a body-ordered list (walk.ts applyBody + buildTree):
// a BODY-ANCHORED member is ordinal, so it is named by POSITION like any array element rather than
// by the directory that happens to store it; and a node's scalar self-value rides its row, the way
// the `large-icons` grid shows `key: value`.
describe("/api/tree — anchored members read as indices, scalars ride the row", () => {
  type T = { label: string; value?: string; path: string; type: string; children: T[] };
  const tree = (h: ReturnType<typeof createHandlers>, path = ":", depth = "4"): T => call(h, "/api/tree", { path, depth }).json as T;
  const flat = (n: T, ind = ""): string[] => [`${ind}${n.label}${n.value != null ? " = " + n.value : ""}`, ...n.children.flatMap((c) => flat(c, ind + "  "))];

  async function listTree() {
    const root = tmpTree({
      ".yo/body.yo": "- *: item01\n- plain\n",
      "item01/.yo/body.yo": "World\n- *: item01\n",
      "item01/item01/.yo/body.yo": "Eurasia\n- Europe\n- Asia\n",
      "loose.yo": "Unlisted\n", // a child the body never named — keeps its storage name
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    return h;
  }

  it("names a consumed member by position, and trails an unlisted child by its own name", async () => {
    const h = await listTree();
    expect(flat(tree(h)).slice(1)).toEqual([
      "  0 = World",
      "    0 = Eurasia",
      "      0 = Europe",
      "      1 = Asia",
      "  1 = plain",
      "  loose.yo = Unlisted", // never granted a position: still keyed, still named
    ]);
  });

  it("keeps the PATH keyed — the label is display, the address is storage", async () => {
    const h = await listTree();
    const member = tree(h).children[0];
    expect(member.label).toBe("0");
    expect(member.path).toBe(":item01");
    expect(member.children[0].path).toBe(":item01:item01");
  });

  it("truncates a long scalar to one capped line", async () => {
    const long = "x".repeat(200);
    const root = tmpTree({ ".yo/body.yo": "- *: item01\n", "item01/.yo/body.yo": `${long}\nkeyed: v\n` });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const v = tree(h).children[0].value!;
    expect(v).toHaveLength(80);
    expect(v.endsWith("…")).toBe(true);
    // multi-line takes only the FIRST line
    const root2 = tmpTree({ "note.yo": "|\n  first line\n  second line\n" });
    const h2 = createHandlers(root2, { gitignore: false });
    await h2.ready;
    expect(tree(h2).children.find((c) => c.label === "note.yo")?.value).toBe("first line");
  });

  it("shows no value for a BINARY member, which still reads as an index", async () => {
    const root = tmpTree({ "doc/.yo/body.yo": "- note\n- *: pic.png\n", "doc/pic.png": "PNG" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const pic = tree(h, ":doc").children.find((c) => c.path === ":doc:pic.png")!;
    expect(pic.label).toBe("1"); // anchored: ordinal, not "pic.png"
    expect(pic.value).toBeUndefined(); // blob bytes have no readable value
  });

  it("never repeats the label — a titled chapter's self-value IS its label", async () => {
    const root = tmpTree({ "doc/.yo/body.yo": '!!<*yamlover: $defs: chapter>\n"The Title"\n- prose\n', ...DEFS });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const doc = tree(h, ":doc");
    expect(doc.label).toBe("The Title");
    expect(doc.value).toBeUndefined();
  });

  it("a TITLED anchored member still goes by its title — the index is only the fallback", async () => {
    const root = tmpTree({
      "doc/.yo/body.yo": '!!<*yamlover: $defs: chapter>\n"Book"\n- *: 01-Part\n',
      "doc/01-Part/.yo/body.yo": '!!<*yamlover: $defs: chapter>\n"Part One"\n- text\n',
      ...DEFS,
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    expect(tree(h, ":doc").children.map((c) => c.label)).toEqual(["Part One"]);
  });
});

// A whole FLOW token is a VALUE, not entry lines. `opensEntry` matches `{a: 1}` (its leading `{`
// passes the first-character class and `a: ` reads as a key), so a flow-MAP payload used to be torn
// apart into a block mapping — a 400 at a document root, block children at a keyed target. A flow
// SEQ slipped through only because it carries no colon. One grammatical rule (`isFlowToken`) now
// covers both, at both targets, to any nesting depth.
describe("/api/edit — a flow token payload stays one token", () => {
  const bodyOf = (root: string) => fs.readFileSync(path.join(root, "d", ".yo", "body.yo"), "utf8");
  const cases: [string, string][] = [
    ["a flow seq", "[12, 13, 14]"],
    ["a flow map", "{a: 1}"],
    ["a map holding a seq", "{a: [1, 2]}"],
    ["a seq holding maps", "[{a: 1}, 2]"],
    ["quoted cells", "['a, b', \"x: y\"]"],
  ];

  for (const [name, token] of cases) {
    it(`${name} emplaces verbatim at a KEYED path`, async () => {
      const root = tmpTree({ "d/.yo/body.yo": "k: old\n" });
      const h = createHandlers(root, { gitignore: false });
      await h.ready;
      const r = await callBody(h, "POST", "/api/edit", { path: ":d:k", op: "emplace", yamlover: token });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      expect(bodyOf(root)).toBe(`k: ${token}\n`);
    });

    it(`${name} emplaces verbatim at the document ROOT — it IS the document`, async () => {
      const root = tmpTree({ "d/.yo/body.yo": "" });
      const h = createHandlers(root, { gitignore: false });
      await h.ready;
      const r = await callBody(h, "POST", "/api/edit", { path: ":d", op: "emplace", yamlover: token });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      expect(bodyOf(root)).toBe(`${token}\n`);
    });
  }

  it("replacing a document root's body with a flow token keeps the `!!<…>` banner", async () => {
    const root = tmpTree({ "d/.yo/body.yo": "!!<*yamlover: $defs: chapter>\nTitle\n- chunk\n", ...DEFS });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: ":d", op: "emplace", yamlover: "[1, 2]" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(bodyOf(root)).toBe("!!<*yamlover: $defs: chapter>\n[1, 2]\n"); // the body goes, the banner stands
  });

  it("an ordinary keyed payload is still entry lines — the rule is about FLOW, not braces", async () => {
    // a FILE-backed document, so the keyed scalar→container promotion (a dir-backed concern) is
    // not in play and the assertion is purely about how the payload is grammatically classified
    const root = tmpTree({ "note.yo": "k: old\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: ":note.yo:k", op: "emplace", yamlover: "a: 1\nb: 2" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // grouped as ENTRY LINES and written under the key (the old scalar stays as the omni
    // self-value) — never carried across as one opaque token the way a flow payload is
    expect(fs.readFileSync(path.join(root, "note.yo"), "utf8")).toBe("k: old\n  a: 1\n  b: 2\n");
  });

  it("an UNTERMINATED flow token is not one — it stays a plain scalar", async () => {
    const root = tmpTree({ "d/.yo/body.yo": "k: old\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: ":d:k", op: "emplace", yamlover: "'[1, 2'" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(bodyOf(root)).toBe("k: '[1, 2'\n");
  });
});

// --- K&R values: a flow token that SPANS LINES ------------------------------------------------- //
// CONCRETES.md §Collection style — a multi-line flow token is an inline concrete switch to json5p.
// For the SPLICER the point is simpler: it is ONE value written across several lines, so every
// line-level reader must step over its interior. Before `flowSpanEnd` the splicer read `a: {` plus
// two indented lines as an entry WITH CHILDREN and rewrote them as block mapping lines, dropping
// the flow commas — a silent corruption, and the file no longer parsed.
describe("/api/edit — a K&R (multi-line flow) value is one token", () => {
  const KR = "a: {\n  x: 1,\n  y: 2\n}\nb: 9\n";
  async function krHandlers(src = KR) {
    const root = tmpTree({ "note.yo": src });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    return { root, h, disk: () => fs.readFileSync(path.join(root, "note.yo"), "utf8") };
  }
  const valueOf = async (h: Parameters<typeof call>[0]) =>
    ((await nodeJson(h, { path: ":note.yo", depth: ".inf" })).json as { value: unknown }).value;

  it("projects the value and leaves its siblings alone", async () => {
    const { h, disk } = await krHandlers();
    expect(await valueOf(h)).toEqual({ a: { x: 1, y: 2 }, b: 9 });
    const r = await callBody(h, "POST", "/api/edit", { path: ":note.yo:b", op: "emplace", yamlover: "10" });
    expect(r.status).toBe(200);
    expect(disk()).toBe("a: {\n  x: 1,\n  y: 2\n}\nb: 10\n"); // the token is untouched, byte for byte
  });

  it("emplaces a MULTI-LINE payload as the whole value", async () => {
    const { h, disk } = await krHandlers();
    const r = await callBody(h, "POST", "/api/edit",
      { path: ":note.yo:a", op: "emplace", yamlover: "{\n  x: 1,\n  y: 9\n}" });
    expect(r.status).toBe(200);
    expect(disk()).toBe("a: {\n  x: 1,\n  y: 9\n}\nb: 9\n"); // no orphaned interior lines
    expect(await valueOf(h)).toEqual({ a: { x: 1, y: 9 }, b: 9 });
  });

  it("switches between K&R, one-line flow and block without leaving orphans", async () => {
    for (const [start, payload, want] of [
      ["a: {\n  x: 1\n}\n", "{x: 2}", "a: {x: 2}\n"],           // K&R → one line
      ["a: {x: 1}\n", "{\n  x: 2\n}", "a: {\n  x: 2\n}\n"],      // one line → K&R
      ["a:\n  x: 1\n", "{\n  y: 9\n}", "a: {\n  y: 9\n}\n"],     // block → K&R (children replaced)
      ["a: {\n  x: 1\n}\n", "y: 9", "a:\n  y: 9\n"],             // K&R → block
    ] as const) {
      const { h, disk } = await krHandlers(start);
      const r = await callBody(h, "POST", "/api/edit", { path: ":note.yo:a", op: "emplace", yamlover: payload });
      expect(r.status, `${start} + ${payload}`).toBe(200);
      expect(disk(), `${start} + ${payload}`).toBe(want);
    }
  });

  it("removes the whole token, interior included", async () => {
    const { h, disk } = await krHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":note.yo:a", op: "remove" });
    expect(r.status).toBe(200);
    expect(disk()).toBe("b: 9\n");
  });

  it("nests, on a dash item and under several keys", async () => {
    const { h: h1, disk: d1 } = await krHandlers("- [\n  1,\n  2\n]\n- 7\n");
    expect(await valueOf(h1)).toEqual([[1, 2], 7]);
    expect((await callBody(h1, "POST", "/api/edit",
      { path: ":note.yo[0]", op: "emplace", yamlover: "[\n  1,\n  3\n]" })).status).toBe(200);
    expect(d1()).toBe("- [\n  1,\n  3\n]\n- 7\n");

    const { h: h2, disk: d2 } = await krHandlers("a:\n  b: {\n    x: 1\n  }\n");
    expect(await valueOf(h2)).toEqual({ a: { b: { x: 1 } } });
    expect((await callBody(h2, "POST", "/api/edit",
      { path: ":note.yo:a:b", op: "emplace", yamlover: "{\n  x: 2\n}" })).status).toBe(200);
    expect(d2()).toBe("a:\n  b: {\n    x: 2\n  }\n"); // the closer keeps its key's column
  });

  it("REFUSES a path INTO the token, naming the whole-token edit instead", async () => {
    // a flow value has no interior line to splice (v1) — the diagnostic has to say what to do
    const { h, disk } = await krHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":note.yo:a:x", op: "emplace", yamlover: "5" });
    expect(r.status).toBe(400);
    expect((r.json as { error: string }).error).toMatch(/written in flow form — edit it as a whole token/);
    expect(disk()).toBe(KR); // and nothing was written
  });

  it("carries the ROOT's own concrete — a whole document written K&R", async () => {
    // the self bucket was emitted only when one of FIVE named fields was set, and `concrete` was
    // not among them: a K&R document rendered as BLOCK, because the switch never reached the
    // client. Any field is worth sending — the per-child buckets always used that test.
    const { h } = await krHandlers('[\n  {\n    "name": "Eurasia"\n  }\n]\n');
    const j = (await nodeJson(h, { path: ":note.yo", depth: ".inf" })).json as
      { comments?: Record<string, { concrete?: string }> };
    expect(j.comments?.[""]).toEqual({ concrete: "json5p" });
  });

  it("carries PER-CONTAINER layout: each container's own bit, nothing inherited", async () => {
    // Layout is per container (2026-07-27): a multi-line container carries its own `concrete`,
    // an inner ONE-LINE token keeps `repr: yaml/flow` — and round-trips as one line.
    const { h } = await krHandlers("a: {\n  q: [\n    1\n  ],\n  t: {p: 1}\n}\nb: {x: 1}\n");
    const j = (await nodeJson(h, { path: ":note.yo", depth: ".inf" })).json as
      { comments?: Record<string, { concrete?: string; repr?: string }> };
    expect(j.comments?.["/a"]).toEqual({ concrete: "json5p" });
    expect(j.comments?.["/a/q"]).toEqual({ concrete: "json5p" }); // its own span, its own bit
    expect(j.comments?.["/a/t"]).toEqual({ repr: "yaml/flow" });  // an inner one-liner stays one
    expect(j.comments?.["/b"]).toEqual({ repr: "yaml/flow" });
  });
});

describe("/api/edit — own-line & anchors are decorations, never entries (the index-skew fix)", () => {
  it("an INDEXED emplace past a colon-form anchor line hits the right sibling", async () => {
    const { root, h } = await chapterHandlers({
      "doc/.yo/body.yo": "!!<*yamlover: $defs: chapter>\ntitle: T\n- one\n&: tags: whole\n- two\n- three\n",
    });
    // entries: title=0, "one"=1, "two"=2, "three"=3 — the anchor line consumes NO index
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc:2", op: "emplace", yamlover: "TWO" });
    expect(r.status).toBe(200);
    const out = bodyOf(root);
    expect(out).toContain("- TWO");
    expect(out).toContain("- three");     // the NEXT sibling untouched (was clobbered by the skew)
    expect(out).toContain("&: tags: whole"); // the anchor line stands
    expect(out).not.toContain("- two");
  });

  it("an INDEXED remove past the anchor line removes the named sibling, and the anchor stays", async () => {
    const { root, h } = await chapterHandlers({
      "doc/.yo/body.yo": "!!<*yamlover: $defs: chapter>\ntitle: T\n- one\n&: tags: whole\n- two\n- three\n",
    });
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc:3", op: "remove" });
    expect(r.status).toBe(200);
    const out = bodyOf(root);
    expect(out).toContain("- two");
    expect(out).not.toContain("- three");
    expect(out).toContain("&: tags: whole");
  });

  it("a scalar self-value emplace never mistakes an anchor or a lone !!yo line for the title", async () => {
    const { root, h } = await chapterHandlers({
      "doc/.yo/body.yo": "!!yo\nOld title\n&: tags: whole\n- x\n",
    });
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc", op: "emplace", yamlover: '"New"' });
    expect(r.status).toBe(200);
    const out = bodyOf(root);
    expect(out).toContain("New");
    expect(out).not.toContain("Old title");
    expect(out).toContain("!!yo");          // the island mark stands
    expect(out).toContain("&: tags: whole"); // the anchor stands
  });
});

describe("/api/edit — `replace` at a document root (the kind-conversion landing)", () => {
  it("replaces a MEMBER document wholesale: the payload becomes the body, facets drop", async () => {
    const { root, h } = await chapterHandlers({
      "doc/.yo/body.yo": "!!<*yamlover: $defs: chapter>\ntitle: T\n- *: m\n",
      "doc/m/.yo/body.yo": "- Can ne\n",
    });
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc:m", op: "replace", yamlover: "Can ne" });
    expect(r.status).toBe(200);
    expect(fs.readFileSync(path.join(root, "doc", "m", ".yo", "body.yo"), "utf8")).toBe("Can ne\n");
  });

  it("root replace: `meta` restamps the banner; OMITTED meta preserves it (the identity law)", async () => {
    const { root, h } = await chapterHandlers({
      "doc/.yo/body.yo": "!!<*yamlover: $defs: chapter>\ntitle: T\n- *: m\n- *: n\n",
      "doc/m/.yo/body.yo": "!!<*yamlover: $defs: recipe>\n- x\n",
      "doc/n/.yo/body.yo": "!!<*yamlover: $defs: chapter>\n- a chunk\n",
    });
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc:m", op: "replace", yamlover: "just text", meta: "*yamlover: $defs: chapter" });
    expect(r.status).toBe(200);
    expect(fs.readFileSync(path.join(root, "doc", "m", ".yo", "body.yo"), "utf8")).toBe("!!<*yamlover: $defs: chapter>\njust text\n");
    // the T kind-conversion sends NO meta — the member must stay a CHAPTER, never untyped
    const r2 = await callBody(h, "POST", "/api/edit", { path: ":doc:n", op: "replace", yamlover: "a title" });
    expect(r2.status).toBe(200);
    expect(fs.readFileSync(path.join(root, "doc", "n", ".yo", "body.yo"), "utf8")).toBe("!!<*yamlover: $defs: chapter>\na title\n");
    // …and an explicit meta: null DOES drop it
    const r3 = await callBody(h, "POST", "/api/edit", { path: ":doc:n", op: "replace", yamlover: "plain", meta: null });
    expect(r3.status).toBe(200);
    expect(fs.readFileSync(path.join(root, "doc", "n", ".yo", "body.yo"), "utf8")).toBe("plain\n");
  });
});

describe("/api/edit — `remove` at a MEMBER document root detaches it AND archives its storage (trash on delete)", () => {
  it("the pointer entry goes; the member's storage moves into the parent's .yo/.trash — recoverable, never destroyed", async () => {
    const { root, h } = await chapterHandlers({
      "doc/.yo/body.yo": "!!<*yamlover: $defs: chapter>\ntitle: T\n- keep\n- *: m\n- after\n",
      "doc/m/.yo/body.yo": "member text\n",
    });
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc:m", op: "remove" });
    expect(r.status).toBe(200);
    const body = bodyOf(root);
    expect(body).not.toContain("- *: m");
    expect(body).toContain("- keep");
    expect(body).toContain("- after");
    // TRASH ON DELETE: the member directory left its place…
    expect(fs.existsSync(path.join(root, "doc", "m"))).toBe(false);
    // …and survives, whole, inside the parent's trash (a dot-name the walk never visits)
    expect(fs.readFileSync(path.join(root, "doc", ".yo", ".trash", "m", ".yo", "body.yo"), "utf8")).toBe("member text\n");
  });

  it("a name already in the trash collision-suffixes (nothing is ever overwritten)", async () => {
    const { root, h } = await chapterHandlers({
      "doc/.yo/body.yo": "!!<*yamlover: $defs: chapter>\ntitle: T\n- *: m\n",
      "doc/m/.yo/body.yo": "second life\n",
      "doc/.yo/.trash/m/.yo/body.yo": "first life\n", // a prior deletion already archived here
    });
    expect((await callBody(h, "POST", "/api/edit", { path: ":doc:m", op: "remove" })).status).toBe(200);
    const trash = path.join(root, "doc", ".yo", ".trash");
    expect(fs.readFileSync(path.join(trash, "m", ".yo", "body.yo"), "utf8")).toBe("first life\n");
    expect(fs.readFileSync(path.join(trash, "m-2", ".yo", "body.yo"), "utf8")).toBe("second life\n");
  });

  it("a MID-BATCH failure archives NOTHING — the storage moves only after the batch commits", async () => {
    const { root, h } = await chapterHandlers({
      "doc/.yo/body.yo": "!!<*yamlover: $defs: chapter>\ntitle: T\n- keep\n- *: m\n",
      "doc/m/.yo/body.yo": "member text\n",
    });
    const r = await callBody(h, "POST", "/api/edit", [
      { path: ":doc:m", op: "remove" },
      { path: ":doc:no_such_key", op: "emplace", yamlover: "boom" }, // fails the batch
    ]);
    expect(r.status).toBe(400);
    expect(bodyOf(root)).toContain("- *: m"); // the splice rolled back…
    expect(fs.existsSync(path.join(root, "doc", "m", ".yo", "body.yo"))).toBe(true); // …and the storage never moved
    expect(fs.existsSync(path.join(root, "doc", ".yo", ".trash"))).toBe(false);
  });
});

describe("/api/edit — a batch is ATOMIC across files", () => {
  it("a mid-batch failure leaves EVERY file untouched — never a half-applied batch", async () => {
    // the reported runaway: the first file's insert was written, the second file's op threw,
    // and the client's retry appended a duplicate on every attempt
    const { root, h } = await chapterHandlers({
      "doc/.yo/body.yo": "!!<*yamlover: $defs: chapter>\ntitle: T\n- *: m\n",
      "doc/m/.yo/body.yo": "- first\n",
    });
    const before = fs.readFileSync(path.join(root, "doc", "m", ".yo", "body.yo"), "utf8");
    const r = await callBody(h, "POST", "/api/edit", { edits: [
      { path: ":doc:m:1", op: "insert", yamlover: "sneaky" },       // valid — splices file 1
      { path: ":doc:no_such_key", op: "remove" },                    // throws at splice time in file 2
    ] });
    expect(r.status).toBe(400);
    expect(fs.readFileSync(path.join(root, "doc", "m", ".yo", "body.yo"), "utf8"), "file 1 must be untouched").toBe(before);
    expect(bodyOf(root)).toContain("- *: m");
  });
});

describe("/api/edit — removing an ORPHANED member archives its storage (never a wall, never destroyed)", () => {
  it("an unreferenced dir member moves into the parent's .yo/.trash and leaves the projection", async () => {
    const { root, h } = await chapterHandlers({
      "doc/.yo/body.yo": "!!<*yamlover: $defs: chapter>\ntitle: T\n- keep\n",
      "doc/m/.yo/body.yo": "orphan text\n", // present on disk, never referenced by the body
    });
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc:m", op: "remove" });
    expect(r.status).toBe(200);
    expect(fs.existsSync(path.join(root, "doc", "m")), "the member left its place").toBe(false);
    expect(fs.readFileSync(path.join(root, "doc", ".yo", ".trash", "m", ".yo", "body.yo"), "utf8"), "…into the trash, intact").toBe("orphan text\n");
    // the projection no longer surfaces it
    const j = (await nodeJson(h, { path: ":doc", depth: "1" })).json as { value: Record<string, unknown> };
    expect(JSON.stringify(j.value)).not.toContain("orphan text");
  });
});

describe("/api/edit - a PLAIN folded chunk whose prose looks like keys (the chunk-mangle regression)", () => {
  // A `- >` block with content AT the child column is the PLAIN form: every deeper-or-equal
  // line is scalar content. A content line like "omni one: the node's ..." must NOT read as a
  // keyed field (itemHasFields) - misreading it made the emplace replace only the first content
  // line and orphan the rest, leaving an unparseable file on disk (a `**...` orphan line then
  // read as a pointer: "a key containing a space must be quoted").
  const PROSE_BODY =
    "Title line\n" +
    "description: d\n" +
    "- >\n" +
    "  A chapter is **just an omni (`variant`) node** - a **fully**\n" +
    "  omni one: the node's own scalar **self-value is the title** (there is no `title:` key),\n" +
    "  **`description`** is an optional keyed field, and everything else is positional.\n" +
    "  element**. There is one interleaved body stream - no `chunks`\n" +
    "  array and no `children` array.\n" +
    "- second chunk\n";

  it("emplace replaces the WHOLE block and the file still parses", async () => {
    const { root, h } = await chapterHandlers({ "doc/.yo/body.yo": PROSE_BODY });
    const payload =
      ">-\n" +
      "  A chapter is **just an omni (`variantX`) node** - a **fully**\n" +
      "  omni one: the node's own scalar **self-value is the title** (there is no `title:` key),\n" +
      "  edited tail.";
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc:1", op: "emplace", yamlover: payload });
    expect(r.status).toBe(200);
    const out = bodyOf(root);
    expect(out).toContain("variantX");
    expect(out, "no orphaned lines of the old block").not.toContain("array and no");
    const j = (await nodeJson(h, { path: ":doc", depth: ".inf" })).json as { value: unknown };
    const items = body(j as { value: unknown });
    expect(items.length).toBe(2);
    expect(String(items[0])).toContain("edited tail");
    expect(String(items[1])).toBe("second chunk");
  });

  it("a splice that would corrupt the document 400s with the file untouched", async () => {
    // the post-splice parse gate: whatever surgical bug produces an unparseable body must
    // refuse to write (this drives the gate with a payload that splices fine but cannot
    // reparse in place - an over-deep block header the entry grammar rejects)
    const { root, h } = await chapterHandlers({ "doc/.yo/body.yo": PROSE_BODY });
    const before = bodyOf(root);
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc:1", op: "emplace", yamlover: "x: [unclosed" });
    expect(r.status).toBe(400);
    expect(bodyOf(root), "the document must be untouched").toBe(before);
  });
});
