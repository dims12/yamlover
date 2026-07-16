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
    expect((await callBody(h, "POST", "/api/edit", { path: ":doc", op: "emplace", yamlover: '"x"' })).status).toBe(400);
  });

  it("rejects `concrete` on an existing node — converting one is a move, not an edit", async () => {
    const { h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[2]", op: "emplace", concrete: "file/yamlover", yamlover: '"x"' });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/created/);
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

  it("rejects creating against a scalar — it backs no document and is no directory", async () => {
    const root = tmpTree({ name: "Alice" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: ":name", op: "insert", concrete: "file/yamlover", name: "X", meta: CHAP, yamlover: BODY });
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
