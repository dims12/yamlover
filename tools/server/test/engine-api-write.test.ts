import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHandlers } from "./helpers";
import { tmpTree } from "./helpers";
import { call, callBody, sseCapture } from "./http";
import { nodeJson } from "./node-json";

// The WRITE endpoints /api/tag and /api/paste, against synthetic temp trees — never the repo.
// (The embedded /api/annotate + /api/fragment endpoints are covered in embed-api.test.ts.)

// A chapter is an OMNI node (docs/documents/chapter): title/description keyed, the body positional. Its
// `/api/json` value is a `$yamloverMixed` marker (or a plain array when untitled). These read the
// positional body values, a subchapter's title, and the hosted $defs the paste tests need.
const bodyVals = (v: unknown): unknown[] => {
  if (Array.isArray(v)) return v;
  const m = (v as { $yamloverMixed?: { entries: { key: string | null; anchor?: boolean; value: unknown }[] } })?.$yamloverMixed;
  // a BODY-ANCHORED member is part of the positional flow: the body ordered it by pointer, which
  // CONSUMED the pointer — it projects at that position, keyed by its storage name (walk.ts applyBody)
  return m ? m.entries.filter((e) => e.key == null || e.anchor).map((e) => e.value) : [];
};
/** The mixed marker's entries (key + anchor flag), for asserting WHERE a member landed. */
const bodyEntries = (v: unknown): { key: string | null; anchor?: boolean }[] =>
  (v as { $yamloverMixed?: { entries: { key: string | null; anchor?: boolean }[] } })?.$yamloverMixed?.entries ?? [];
const subTitle = (marker: unknown): unknown => {
  // a fully-omni subchapter's title is the marker's `value` (its scalar self-value, docs/documents/chapter);
  // a legacy keyed `title:` entry still reads
  const m = (marker as { $yamloverMixed?: { value?: unknown; entries: { key: string | null; value: unknown }[] } })?.$yamloverMixed;
  return m?.value ?? m?.entries.find((e) => e.key === "title")?.value;
};
const CHAPTER_DEFS = {
  "$defs/chapter":
    "type: variant\nproperties:\n  title:\n    type: string\nitems:\n  anyOf:\n    - *:: yamlover: $defs: chapter\n    - *:: yamlover: $defs: chunk\n",
  "$defs/chunk": "type: [string, binary]\nformat: text/marklower\n",
};

describe("/api/tag (create)", () => {
  it("creates a named tag at the default location and it is immediately applicable", async () => {
    const root = tmpTree({ name: "Alice" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const NAME = "исаакиевский собор";
    const ENC = ":ontos:'" + encodeURIComponent(NAME) + "'"; // percent-encoded canonical token (a spacey key rides quoted)
    const r = await callBody(h, "POST", "/api/tag", { name: NAME });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ path: ENC, name: NAME, color: null, created: true });
    const body = fs.readFileSync(path.join(root, "ontos", ".yo", "body.yo"), "utf8");
    expect(body).toContain(`${NAME}: !!<*::yamlover:$defs:onto>`);
    expect((await nodeJson(h, { path: r.json.path })).json.format).toBe("x-yamlover-onto");

    // the freshly created tag can be applied right away
    const a = await callBody(h, "POST", "/api/annotate", { target: ":name", tag: r.json.path });
    expect(a.status).toBe(201);
    expect(call(h, "/api/annotations", { path: ":name" }).json[0].tag).toMatchObject({ path: ENC, name: NAME });
  });

  it("is idempotent — the same name twice returns the same tag, written once", async () => {
    const root = tmpTree({ name: "Alice" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    await callBody(h, "POST", "/api/tag", { name: "twice" });
    const r = await callBody(h, "POST", "/api/tag", { name: "twice" });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ path: ":ontos:twice", name: "twice", created: false });
    const body = fs.readFileSync(path.join(root, "ontos", ".yo", "body.yo"), "utf8");
    expect(body.match(/^twice:/gm)).toHaveLength(1);
  });

  it("appends to an existing taxonomy body without clobbering it", async () => {
    const root = tmpTree({ "ontos/.yo/body.yo": "old: !!<*yamlover: $defs: onto>\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/tag", { name: "new" });
    expect(r.status).toBe(201);
    const body = fs.readFileSync(path.join(root, "ontos", ".yo", "body.yo"), "utf8");
    expect(body).toContain("old: !!<*yamlover: $defs: onto>");
    expect(body).toContain("new: !!<*::yamlover:$defs:onto>");
    expect((await nodeJson(h, { path: ":ontos:old" })).json.format).toBe("x-yamlover-onto");
  });

  it("honors a *-pointer tags location from settings.yo", async () => {
    const root = tmpTree({
      name: "Alice",
      ".yo/settings.yo": "ontos: *:: taxonomy: places\n",
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/tag", { name: "спб" });
    expect(r.status).toBe(201);
    expect(r.json.path).toBe(":taxonomy:places:" + encodeURIComponent("спб"));
    expect(fs.existsSync(path.join(root, "taxonomy", "places", ".yo", "body.yo"))).toBe(true);
  });

  it("rejects empty and unwritable names", async () => {
    const root = tmpTree({ name: "Alice" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    for (const name of ["", "   ", "a/b", "a: b", "line\nbreak", "# comment"]) {
      const r = await callBody(h, "POST", "/api/tag", { name });
      expect(r.status, JSON.stringify(name)).toBe(400);
      expect(r.json.error).toBeTruthy();
    }
    expect(fs.existsSync(path.join(root, "ontos"))).toBe(false); // nothing was written
  });

  it("writes raw (un-encoded) pointer keys, so everything survives a full reindex", async () => {
    // Cyrillic + spaces everywhere: the client sends PERCENT-ENCODED JSON paths, but the
    // pointers must be written with the real key text — encoded keys go dangling on re-walk.
    const root = tmpTree({ "Санкт-Петербург/img.txt": "x" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const t = await callBody(h, "POST", "/api/tag", { name: "исаакиевский собор" });
    const target = ":" + encodeURIComponent("Санкт-Петербург") + ":img.txt";
    const a = await callBody(h, "POST", "/api/annotate", { target, tag: t.json.path });
    expect(a.status).toBe(201);
    // a blob file → its annotation rides the enclosing directory's overlay, keyed by filename,
    // with the tag written as a RAW (un-encoded) project-scoped pointer (spacey key quoted).
    const overlay = fs.readFileSync(path.join(root, "Санкт-Петербург", ".yo", "body.yo"), "utf8");
    expect(overlay).toContain('"img.txt":');
    expect(overlay).toContain("&::ontos:'исаакиевский собор':-");

    expect((await callBody(h, "POST", "/api/reindex", {})).status).toBe(200);
    const list = call(h, "/api/annotations", { path: target }).json;
    expect(list).toHaveLength(1);
    expect(list[0].tag).toMatchObject({ path: t.json.path, name: "исаакиевский собор" });
    const tagged = call(h, "/api/tagged", { path: t.json.path }).json;
    expect(tagged).toHaveLength(1);
    expect(tagged[0].$yamloverLink.path).toBe(target);
  });

  it("refuses when a non-tag node already occupies the path", async () => {
    const root = tmpTree({ "ontos/busy": "plain file" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/tag", { name: "busy" });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/not a tag/);
  });
});

// ANY node can be used as a tag — an annotation is just a `*` reference inside the target's
// yamlover-annotations. The annotating entity is identified by its scalar OMNI title (the
// value-plus-fields self-value), else by its key inside the parent.
describe("any node as a tag", () => {
  it("annotating with an arbitrary node succeeds; the name is its omni title else its key", async () => {
    const root = tmpTree({
      "topics.yo": 'math: "Mathematics"\n  level: hard\nplain:\n  x: 1\n',
      "note.yo": 'body: "hello"\n',
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    // an OMNI node: scalar self-value "Mathematics" over a keyed child — the title wins
    const a = await callBody(h, "POST", "/api/annotate", { target: ":note.yo", tag: ":topics.yo:math" });
    expect(a.status).toBe(201);
    // a plain mapping with no title — its key inside the parent identifies it
    const b = await callBody(h, "POST", "/api/annotate", { target: ":note.yo", tag: ":topics.yo:plain" });
    expect(b.status).toBe(201);
    const list = call(h, "/api/annotations", { path: ":note.yo" }).json;
    expect(list).toHaveLength(2);
    expect(list[0].tag).toMatchObject({ path: ":topics.yo:math", name: "Mathematics", color: null });
    expect(list[1].tag).toMatchObject({ path: ":topics.yo:plain", name: "plain" });

    // /api/tagged answers for the arbitrary node: the annotator is filed under it
    const tagged = call(h, "/api/tagged", { path: ":topics.yo:math" }).json;
    expect(tagged).toHaveLength(1);
    expect(tagged[0].$yamloverLink.path).toBe(":note.yo");
  });

  it("an ordinary pointer INTO a node is not a tagging — only annotation-array edges count", async () => {
    const root = tmpTree({
      "a.yo": "x: 1\n",
      "b.yo": "ref: *:: a.yo: x\n",
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const tagged = call(h, "/api/tagged", { path: ":a.yo:x" }).json;
    expect(tagged).toEqual([]); // b's plain ref does not file b under x
  });

  it("annotating with a MISSING node is still refused", async () => {
    const root = tmpTree({ name: "Alice" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/annotate", { target: ":name", tag: ":nowhere" });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/existing node/);
  });

  it("the ROOT is refused as a tag — and refused BEFORE any write (no corrupt body file)", async () => {
    // The root has no project-scope pointer spelling: `::` alone is not a pointer, so writing
    // `- *::` would make the body overlay unparseable — the original bug corrupted the file and
    // only the follow-up reindex threw. The refusal must come before disk is touched.
    const root = tmpTree({ name: "Alice" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/annotate", { target: ":name", tag: ":" });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/root/);
    expect(fs.existsSync(path.join(root, ".yo", "body.yo"))).toBe(false);
  });
});

// docs/annotations/applications: a membership is a BOOKMARK — never an entry — so filing a node
// changes NOTHING about its shape: a scalar stays a childless scalar, and every reader is unmoved.
describe("filing a node never changes how it reads", () => {
  it("a filed string stays a plain childless scalar — a bookmark is not an entry", async () => {
    const root = tmpTree({ "chap.yo": 'title: "T"\nother: "x"\n' });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const tag = await callBody(h, "POST", "/api/tag", { name: "important" });
    await callBody(h, "POST", "/api/annotate", { target: ":chap.yo:title", tag: tag.json.path });

    const q = (m: string): string[] => call(h, "/api/query", { q: `...:!!<type: ${m}>`, path: ":" }).json.results;
    expect(q("string")).toContain(":chap.yo:title"); // still a plain string…
    expect(q("variant")).not.toContain(":chap.yo:title"); // …and NOT an omni: the bookmark added no child
    expect(q("omni")).not.toContain(":chap.yo:title");
  });

  it("a chapter keeps its title after the title itself is annotated", async () => {
    const root = tmpTree({
      "chap.yo": "!!<*yamlover: $defs: chapter>\n" + 'title: "T"\n- "Hello"\n',
      "$defs/chapter": "type: variant\nproperties:\n  title:\n    type: string\nitems:\n  anyOf:\n    - *:: yamlover: $defs: chapter\n    - *:: yamlover: $defs: chunk\n",
      "$defs/chunk": "type: [string, binary]\nformat: text/marklower\n",
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    expect((await nodeJson(h, { path: ":chap.yo", depth: "1" })).json.title).toBe("T");

    const tag = await callBody(h, "POST", "/api/tag", { name: "important" });
    await callBody(h, "POST", "/api/annotate", { target: ":chap.yo:title", tag: tag.json.path });

    // the title node is now omni (a mapping carrying the annotation) — but it still IS "T"
    expect((await nodeJson(h, { path: ":chap.yo", depth: "1" })).json.title).toBe("T");
  });
});

describe("unified change flow — every write announces its diff over SSE", () => {
  it("tag create, annotate create and annotate delete each broadcast a diff", async () => {
    const root = tmpTree({ name: "Alice" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const sse = sseCapture(h);

    const t = await callBody(h, "POST", "/api/tag", { name: "first" });
    await callBody(h, "POST", "/api/tag", { name: "second" });
    await callBody(h, "POST", "/api/annotate", { target: ":name", tag: t.json.path });
    await callBody(h, "DELETE", "/api/annotate", undefined, { target: ":name", tag: t.json.path });

    const diffs = sse.frames().filter((f) => f.type === "diff");
    // tag create is incremental (announce); annotate/delete reconcile the edited overlay (reindex).
    expect(diffs.length).toBe(4);
    expect(diffs[0]).toMatchObject({ added: [":ontos:.yo:body.yo"], changed: [], removed: [] });
    expect(diffs[1]).toMatchObject({ added: [], changed: [":ontos:.yo:body.yo"], removed: [] });
    const nonEmpty = (d: { added: string[]; changed: string[]; removed: string[] }) => d.added.length + d.changed.length + d.removed.length > 0;
    expect(nonEmpty(diffs[2])).toBe(true); // annotate edited the root overlay
    expect(nonEmpty(diffs[3])).toBe(true); // delete edited it again
    sse.close();
  });
});

describe("/api/paste", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64");

  it("onto a directory: the file lands in it (no auto-open)", async () => {
    const root = tmpTree({ "dir/keep.txt": "x" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/paste", { path: ":dir", filename: "note.txt", contentBase64: b64("hello") });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ path: ":dir:note.txt", dir: ":dir", open: false });
    expect(fs.readFileSync(path.join(root, "dir", "note.txt"), "utf8")).toBe("hello");
  });

  it("onto a directory MEMBER: the file lands in the enclosing directory and opens", async () => {
    const root = tmpTree({ "dir/keep.txt": "x" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/paste", { path: ":dir:keep.txt", filename: "note.txt", contentBase64: b64("hi") });
    expect(r.json).toMatchObject({ path: ":dir:note.txt", dir: ":dir", open: true });
  });

  it("de-duplicates filenames (note.txt → note-1.txt)", async () => {
    const root = tmpTree({ "dir/keep.txt": "x" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const body = { path: ":dir", filename: "note.txt", contentBase64: b64("one") };

    await callBody(h, "POST", "/api/paste", body);
    const r = await callBody(h, "POST", "/api/paste", { ...body, contentBase64: b64("two") });
    expect(r.json.path).toBe(":dir:note-1.txt");
    expect(fs.readFileSync(path.join(root, "dir", "note-1.txt"), "utf8")).toBe("two");
  });

  it("onto a chapter: the file lands in its directory AND a pointer chunk is appended", async () => {
    const root = tmpTree({
      "doc/.yo/body.yo": "!!<*yamlover: $defs: chapter>\n" + 'title: "T"\n- "Hello"\n',
      ...CHAPTER_DEFS,
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/paste", { path: ":doc", filename: "pic.png", contentBase64: b64("PNG") });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ path: ":doc:pic.png", chapter: ":doc", pointer: "*: pic.png" });
    expect(fs.existsSync(path.join(root, "doc", "pic.png"))).toBe(true);

    // the pointer chunk is appended to the positional body, after the last item
    const body = fs.readFileSync(path.join(root, "doc", ".yo", "body.yo"), "utf8");
    const lines = body.split("\n");
    expect(lines.indexOf("- *: pic.png")).toBe(lines.indexOf('- "Hello"') + 1);
  });

  // `inline`: the WYSIWYG editor uploading an image pasted INTO a prose chunk. The file must land,
  // and the body must not gain a chunk — the editor is placing its own embed token in the sentence,
  // and an appended chunk would put the picture on the page twice.
  it("onto a chapter with inline: the file lands, the body is untouched, and it does not auto-open", async () => {
    const source = "!!<*yamlover: $defs: chapter>\n" + 'title: "T"\n- "Hello"\n';
    const root = tmpTree({ "doc/.yo/body.yo": source, ...CHAPTER_DEFS });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/paste", { path: ":doc", filename: "pic.png", contentBase64: b64("PNG"), inline: true });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ path: ":doc:pic.png", dir: ":doc", open: false });
    expect(r.json).not.toHaveProperty("pointer");
    expect(fs.readFileSync(path.join(root, "doc", "pic.png"), "utf8")).toBe("PNG");
    expect(fs.readFileSync(path.join(root, "doc", ".yo", "body.yo"), "utf8")).toBe(source);
  });

  // A drop that lands on an inlined subchapter section targets THAT subchapter's path (NodeView
  // resolves `data-chapter-path`): the media must go into the SUBCHAPTER's own directory and its
  // body gains the pointer — the parent body stays untouched (the ex-66 shape).
  it("onto a DIR-BACKED subchapter: the file lands in ITS directory, ITS body gains the pointer", async () => {
    const root = tmpTree({
      "doc/.yo/body.yo": "!!<*yamlover: $defs: chapter>\n" + '"Book"\n- intro\n- *: 01-Dogs\n',
      "doc/01-Dogs/.yo/body.yo": "!!<*yamlover: $defs: chapter>\n" + '"Dogs"\n- woof\n',
      ...CHAPTER_DEFS,
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/paste", { path: ":doc:01-Dogs", filename: "bone.png", contentBase64: b64("PNG") });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ path: ":doc:01-Dogs:bone.png", chapter: ":doc:01-Dogs", pointer: "*: bone.png" });
    expect(fs.existsSync(path.join(root, "doc", "01-Dogs", "bone.png"))).toBe(true);
    const sub = fs.readFileSync(path.join(root, "doc", "01-Dogs", ".yo", "body.yo"), "utf8");
    expect(sub).toContain("- woof\n- *: bone.png");
    // the PARENT body is untouched
    expect(fs.readFileSync(path.join(root, "doc", ".yo", "body.yo"), "utf8")).not.toContain("bone.png");
  });

  it("onto an INLINE subchapter path: the pointer lands INSIDE its region, the file in the doc's dir", async () => {
    const root = tmpTree({
      "doc/.yo/body.yo":
        "!!<*yamlover: $defs: chapter>\n" + '"Book"\n- intro\n- Dogs\n  - woof\n- outro\n',
      ...CHAPTER_DEFS,
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    // the inline subchapter `Dogs` is body entry [1] (after `- intro`)
    const r = await callBody(h, "POST", "/api/paste", { path: ":doc[1]", filename: "bone.png", contentBase64: b64("PNG") });
    expect(r.status).toBe(201);
    expect(fs.existsSync(path.join(root, "doc", "bone.png"))).toBe(true); // the doc's own dir
    const body = fs.readFileSync(path.join(root, "doc", ".yo", "body.yo"), "utf8");
    const lines = body.split("\n");
    // the pointer sits INSIDE the subchapter (indented under `- Dogs`), before `- outro`
    expect(lines.indexOf("  - *: bone.png")).toBe(lines.indexOf("  - woof") + 1);
    expect(lines.indexOf("- outro")).toBeGreaterThan(lines.indexOf("  - *: bone.png"));
  });

  it("rejects an empty paste", async () => {
    const h = createHandlers(tmpTree({ name: "Alice" }), { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/paste", { path: ":", filename: "x.txt", contentBase64: "" });
    expect(r.status).toBe(400);
  });
});

describe("/api/paste (text)", () => {
  // an omni chapter: title (keyed), then a positional body (a chunk + a subchapter)
  const CHAPTER = "!!<*yamlover: $defs: chapter>\n" + 'title: "T"\n- "Hello"\n- title: "Sub"\n  - "First"\n';

  it("text onto a directory: a new chapter .yo file, titled from the first line", async () => {
    const root = tmpTree({ "dir/keep.txt": "x", ...CHAPTER_DEFS });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/paste", { path: ":dir", text: "# Hello World\n\nFirst paragraph.\n" });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ path: ":dir:'Hello%20World.yo'", dir: ":dir", open: false });
    const src = fs.readFileSync(path.join(root, "dir", "Hello World.yo"), "utf8");
    // the title is the root's scalar SELF-VALUE line — no `title:` key (docs/documents/chapter)
    expect(src).toBe('!!<*::yamlover:$defs:chapter>\n"Hello World"\n- |\n  # Hello World\n\n  First paragraph.\n');

    // the new file indexed as a chapter holding the text as its one body chunk
    const node = (await nodeJson(h, { path: ":dir:'Hello%20World.yo'", depth: "3" }));
    expect(node.json.format).toBe("x-yamlover-chapter");
    expect(bodyVals(node.json.value)).toEqual(["# Hello World\n\nFirst paragraph.\n"]);
  });

  it("text onto a chapter: appended as an inline chunk at the end of the body (no file)", async () => {
    const root = tmpTree({ "doc/.yo/body.yo": CHAPTER, ...CHAPTER_DEFS });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/paste", { path: ":doc", text: "New paragraph\nwith two lines\n" });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ path: ":doc", chapter: ":doc" });
    expect(fs.readdirSync(path.join(root, "doc"))).toEqual([".yo"]); // no file landed

    // the chunk is appended after the last body item (the subchapter) — one interleaved stream
    const body = fs.readFileSync(path.join(root, "doc", ".yo", "body.yo"), "utf8");
    expect(body).toContain('- |\n  New paragraph\n  with two lines');
    const vals = bodyVals((await nodeJson(h, { path: ":doc", depth: "3" })).json.value);
    expect(vals[vals.length - 1]).toBe("New paragraph\nwith two lines\n");
  });

  it("text onto a SUBCHAPTER: appended to that subchapter's body", async () => {
    // subchapters get their chapter format by SCHEMA PROPAGATION (walk.ts applySchemas) via the
    // hosted $defs/chapter's `items: {anyOf:[chapter, chunk]}` union — so the fixture hosts one.
    const root = tmpTree({ "doc/.yo/body.yo": CHAPTER, ...CHAPTER_DEFS });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    // the subchapter "Sub" is body element [2] (title is store index 0, "Hello" is [1])
    const r = await callBody(h, "POST", "/api/paste", { path: ":doc[2]", text: "deep note" });
    expect(r.json).toMatchObject({ path: ":doc:2", chapter: ":doc:2" });
    const node = (await nodeJson(h, { path: ":doc[2]", depth: "3" }));
    expect(bodyVals(node.json.value)).toEqual(["First", "deep note"]);
  });

  it("text whose first line is indented falls back to a quoted scalar (block indent detection)", async () => {
    const root = tmpTree({ "doc/.yo/body.yo": CHAPTER, ...CHAPTER_DEFS });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const text = "    indented first line\nplain second";
    await callBody(h, "POST", "/api/paste", { path: ":doc", text });
    const body = fs.readFileSync(path.join(root, "doc", ".yo", "body.yo"), "utf8");
    expect(body).toContain(`- ${JSON.stringify(text)}`);
    const vals = bodyVals((await nodeJson(h, { path: ":doc", depth: "3" })).json.value);
    expect(vals[vals.length - 1]).toBe(text);
  });

  it("non-ASCII first line names the chapter file (Cyrillic + space)", async () => {
    const root = tmpTree({ "dir/keep.txt": "x" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/paste", { path: ":dir", text: "Привет мир\n\nтекст" });
    expect(r.json.path).toBe(`:dir:'${encodeURIComponent("Привет мир")}.yo'`); // a spacey key rides quoted
    expect(fs.existsSync(path.join(root, "dir", "Привет мир.yo"))).toBe(true);
  });

  it("rejects an empty text paste", async () => {
    const h = createHandlers(tmpTree({ name: "Alice" }), { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/paste", { path: ":", text: "   \n " });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/empty/);
  });
});

describe("/api/paste (rich — an HTML selection: image chunks + heading subchapters)", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  // the wire `rich` payload still carries chunks/children; the SOURCE it writes is a positional body
  const CHAPTER = "!!<*yamlover: $defs: chapter>\n" + 'title: "T"\n- "Hello"\n- title: "Old"\n  - "First"\n';

  it("onto a chapter: chunks (text+image) then subchapters append to the positional body, in order", async () => {
    const root = tmpTree({ "doc/.yo/body.yo": CHAPTER, ...CHAPTER_DEFS });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/paste", {
      path: ":doc",
      rich: {
        chunks: [{ text: "intro" }, { file: { name: "cat.jpg", contentBase64: b64("JPG") } }, { text: "outro" }],
        children: [{ title: "Cats", chunks: [{ text: "feline facts" }], children: [{ title: "Kittens", chunks: [{ text: "tiny" }], children: [] }] }],
      },
    });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ path: ":doc", chapter: ":doc", files: [":doc:cat.jpg"] });
    expect(fs.readFileSync(path.join(root, "doc", "cat.jpg"), "utf8")).toBe("JPG");

    // the round-trip: the new prose chunks (order kept), the image as a resolved pointer, and the
    // new subchapter (with its nested child) — all in ONE positional body after the old content
    const vals = bodyVals((await nodeJson(h, { path: ":doc", depth: "7" })).json.value);
    expect(vals.filter((x) => typeof x === "string")).toEqual(["Hello", "intro", "outro"]);
    expect((vals.find((x) => (x as { $yamloverLink?: { path: string } })?.$yamloverLink) as { $yamloverLink: { path: string } }).$yamloverLink.path).toBe(":doc:cat.jpg");
    // the image member is ANCHORED at its body position — its `- *: cat.jpg` pointer was consumed,
    // so it appears ONCE, never also as a bare keyed child beside its own pointer
    expect(
      bodyEntries((await nodeJson(h, { path: ":doc", depth: "7" })).json.value)
        .filter((e) => e.key === "cat.jpg")
        .map((e) => [e.key, e.anchor ?? false]),
    ).toEqual([["cat.jpg", true]]);
    const subs = vals.filter((x) => subTitle(x) != null);
    expect(subs.map(subTitle)).toEqual(["Old", "Cats"]);
    const cats = subs[1];
    expect(bodyVals(cats).filter((x) => typeof x === "string")).toEqual(["feline facts"]);
    const kittens = bodyVals(cats).find((x) => subTitle(x) === "Kittens");
    expect(bodyVals(kittens)).toEqual(["tiny"]);
  });

  it("appends a body to a minimal (body-less) chapter", async () => {
    const root = tmpTree({ "doc/.yo/body.yo": '!!<*yamlover: $defs: chapter>\ntitle: "Bare"\n', ...CHAPTER_DEFS });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/paste", {
      path: ":doc",
      rich: { chunks: [{ text: "body" }], children: [{ title: "Sub", chunks: [{ text: "inner" }], children: [] }] },
    });
    expect(r.status).toBe(201);
    const vals = bodyVals((await nodeJson(h, { path: ":doc", depth: "4" })).json.value);
    expect(vals.filter((x) => typeof x === "string")).toEqual(["body"]);
    expect(bodyVals(vals.find((x) => subTitle(x) === "Sub"))).toEqual(["inner"]);
  });

  it("onto a directory WITHOUT files: a standalone chapter file; a lone leading heading titles it", async () => {
    const root = tmpTree({ "dir/keep.txt": "x", ...CHAPTER_DEFS });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    // the selection started with an H2 — everything sits under that sole child
    const r = await callBody(h, "POST", "/api/paste", {
      path: ":dir",
      rich: { chunks: [], children: [{ title: "Cats", chunks: [{ text: "feline facts" }], children: [{ title: "Kittens", chunks: [{ text: "tiny" }], children: [] }] }] },
    });
    expect(r.json).toMatchObject({ path: ":dir:Cats.yo", dir: ":dir", open: false });
    const node = (await nodeJson(h, { path: ":dir:Cats.yo", depth: "4" }));
    expect(node.json.format).toBe("x-yamlover-chapter");
    expect(node.json.title).toBe("Cats"); // the heading became the chapter title, not a child
    const vals = bodyVals(node.json.value);
    expect(vals.filter((x) => typeof x === "string")).toEqual(["feline facts"]);
    expect(vals.find((x) => subTitle(x) === "Kittens")).toBeDefined();
  });

  it("onto a directory WITH files: a directory-backed chapter holding its images", async () => {
    const root = tmpTree({ "dir/keep.txt": "x", ...CHAPTER_DEFS });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/paste", {
      path: ":dir",
      rich: {
        chunks: [{ text: "A cat article" }, { file: { name: "cat.jpg", contentBase64: b64("JPG") } }],
        children: [{ title: "Gallery", chunks: [{ file: { name: "cat.jpg", contentBase64: b64("JPG2") } }], children: [] }],
      },
    });
    expect(r.json).toMatchObject({ path: ":dir:'A%20cat%20article'", dir: ":dir", open: false });
    // the chapter is a directory: body overlay + both images inside (deduped names)
    expect(fs.readFileSync(path.join(root, "dir", "A cat article", "cat.jpg"), "utf8")).toBe("JPG");
    expect(fs.readFileSync(path.join(root, "dir", "A cat article", "cat-1.jpg"), "utf8")).toBe("JPG2");
    const body = fs.readFileSync(path.join(root, "dir", "A cat article", ".yo", "body.yo"), "utf8");
    expect(body).toContain("- *: cat.jpg");
    expect(body).toContain("- *: cat-1.jpg");

    const node = (await nodeJson(h, { path: encodeURI(":dir:A cat article"), depth: "4" }));
    expect(node.json.format).toBe("x-yamlover-chapter");
    const img = bodyVals(node.json.value).find((x) => (x as { $yamloverLink?: unknown })?.$yamloverLink) as { $yamloverLink: { path: string } };
    expect(img.$yamloverLink.path).toBe(encodeURI(":dir:'A cat article':cat.jpg")); // spacey key quoted
    // `cat.jpg` is ordered by the body's own top-level flow, so its pointer is CONSUMED and the
    // member rides that position as an anchor. `cat-1.jpg` is referenced from INSIDE the inline
    // "Gallery" subchapter — a cross-reference, not a body position — so it stays an ordinary keyed
    // member of the directory. Either way each appears exactly once at this level.
    expect(
      bodyEntries(node.json.value)
        .filter((e) => e.key?.startsWith("cat"))
        .map((e) => [e.key, e.anchor ?? false]),
    ).toEqual([
      ["cat.jpg", true],
      ["cat-1.jpg", false],
    ]);
  });

  it("rejects an empty or malformed rich paste", async () => {
    const h = createHandlers(tmpTree({ name: "Alice" }), { gitignore: false });
    await h.ready;
    const empty = await callBody(h, "POST", "/api/paste", { path: ":", rich: { chunks: [], children: [] } });
    expect(empty.status).toBe(400);
    expect(empty.json.error).toMatch(/empty/);
    const bad = await callBody(h, "POST", "/api/paste", { path: ":", rich: { chunks: [{ nope: 1 }], children: [] } });
    expect(bad.status).toBe(400);
  });
});

// The AGILE BOARD's state change (TICKETS.md §3): a card drag is just the two existing
// /api/annotate calls — DELETE the old state annotation, POST the new — and the reverse
// /api/tagged "lanes" must flip. States are kept as plain sub-tags here so the test does not
// depend on the $defs/workflow schema (absent from a synthetic tree's builtin graft).
describe("agile board — drag = re-tag a task's state", () => {
  it("moves a task between state lanes and rewrites its on-disk annotation", async () => {
    const root = tmpTree({
      "mytask.yo": ["!!<*yamlover:$defs:task>", "title: Wire the widget", "&::ontos:state:backlog:-", ""].join("\n"),
      "ontos/.yo/body.yo": ["!!<*yamlover:$defs:onto>", "state: Lifecycle states", "  backlog: Captured", "  in-progress: Working", ""].join("\n"),
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const column = (tag: string): string[] =>
      call(h, "/api/tagged", { path: tag }).json.map((m: any) => m?.$yamloverLink?.path).filter(Boolean);

    // the task starts in the backlog lane
    expect((await nodeJson(h, { path: ":mytask.yo" })).json.format).toBe("x-yamlover-task");
    expect(column(":ontos:state:backlog")).toContain(":mytask.yo");
    expect(column(":ontos:state:in-progress")).not.toContain(":mytask.yo");

    // DRAG → in-progress: drop the old state annotation, add the new
    const del = await callBody(h, "DELETE", "/api/annotate", undefined, { target: ":mytask.yo", tag: ":ontos:state:backlog" });
    expect(del.status).toBe(200);
    const add = await callBody(h, "POST", "/api/annotate", { target: ":mytask.yo", tag: ":ontos:state:in-progress" });
    expect(add.status).toBe(201);

    // the lanes have flipped, and the file now points at the new state
    expect(column(":ontos:state:in-progress")).toContain(":mytask.yo");
    expect(column(":ontos:state:backlog")).not.toContain(":mytask.yo");
    const body = fs.readFileSync(path.join(root, "mytask.yo"), "utf8");
    expect(body).toContain("&::ontos:state:in-progress:-");
    expect(body).not.toContain("state:backlog");
  });
});

// The TAG BOARD (TICKETS.md §3): the `yo: lanes:` structure — lanes of tagged COMPARTMENTS
// holding member refs — served resolved by GET /api/board, written by POST /api/board's three
// ops (structure | move | reconcile). board-model.ts is the pure policy under both.
describe("/api/board (lanes of compartments)", () => {
  const READY = ":ontos:workflow:dev:ready";
  const DONE = ":ontos:workflow:dev:done";
  const BACKLOG_TAG = ":ontos:workflow:dev:backlog";
  const boardTree = () =>
    tmpTree({
      ".yo/body.yo": "!!<*yamlover:$defs:board>\nworkflow: *::ontos:workflow:dev\n",
      "ontos/.yo/body.yo": [
        "!!<*yamlover:$defs:onto>",
        "workflow: Lifecycles",
        "  dev: Software task lifecycle",
        "    initial: *::ontos:workflow:dev:backlog",
        "    backlog: !!<*yamlover:$defs:onto> Captured",
        "    ready: !!<*yamlover:$defs:onto> Ready",
        "    done: !!<*yamlover:$defs:onto> Done",
        "",
      ].join("\n"),
      "task-a.yo": "!!<*yamlover:$defs:task>\ntitle: Wire the widget\n&::ontos:workflow:dev:ready:-\n",
      "task-b.yo": "!!<*yamlover:$defs:task>\ntitle: Untagged orphan\n",
    });
  const cardPaths = (cards: { path: string }[]): string[] => cards.map((c) => c.path);

  it("GET seeds from the workflow (initial state included), reconciles in memory, never writes", async () => {
    const root = boardTree();
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const before = fs.readFileSync(path.join(root, ".yo", "body.yo"), "utf8");

    const g = call(h, "/api/board", { path: ":" });
    expect(g.status).toBe(200);
    expect(g.json.seeded).toBe(true);
    // one single-compartment lane per state, in taxonomy order — backlog (the initial) included
    expect(g.json.lanes.map((l: any[]) => l.map((c: any) => c.tags.map((t: any) => t.path)))).toEqual([
      [[BACKLOG_TAG]], [[READY]], [[DONE]],
    ]);
    // the display reconcile filed task-a into the ready compartment; task-b is a structural orphan
    expect(cardPaths(g.json.lanes[1][0].items)).toEqual([":task-a.yo"]);
    expect(cardPaths(g.json.backlog)).toEqual([":task-b.yo"]);
    expect(g.json.lanes[1][0].items[0]).toMatchObject({ title: "Wire the widget", tags: [expect.objectContaining({ path: READY })] });
    // merely reading never materializes
    expect(fs.readFileSync(path.join(root, ".yo", "body.yo"), "utf8")).toBe(before);
  });

  it("op:reconcile on a still-seeded board answers resolved but writes nothing", async () => {
    const root = boardTree();
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const before = fs.readFileSync(path.join(root, ".yo", "body.yo"), "utf8");

    const r = await callBody(h, "POST", "/api/board", { path: ":", op: "reconcile" });
    expect(r.status).toBe(201);
    expect(r.json.seeded).toBe(true);
    expect(cardPaths(r.json.backlog)).toEqual([":task-b.yo"]);
    expect(fs.readFileSync(path.join(root, ".yo", "body.yo"), "utf8")).toBe(before);
  });

  it("op:structure materializes the pinned `yo: lanes:` spelling and round-trips through the index", async () => {
    const root = boardTree();
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/board", {
      path: ":",
      op: "structure",
      structure: [
        [{ tags: [READY], items: [] }],
        [{ tags: [DONE], items: [] }, { tags: [BACKLOG_TAG], items: [] }],
      ],
    });
    expect(r.status).toBe(201);
    expect(r.json.seeded).toBe(false);
    // the write reconciled: task-a joined the ready compartment
    expect(cardPaths(r.json.lanes[0][0].items)).toEqual([":task-a.yo"]);
    expect(cardPaths(r.json.backlog)).toEqual([":task-b.yo"]);

    // THE PINNED BLOCK SPELLING (block form only — flow refuses anchors): lane items at the
    // key's own indent, first compartment folded onto the lane mark, bookmarks own-line
    const body = fs.readFileSync(path.join(root, ".yo", "body.yo"), "utf8");
    expect(body).toContain(
      [
        "yo:",
        "  lanes:",
        "  - -",
        "      &::ontos:workflow:dev:ready:-",
        "      - *::task-a.yo",
        "  - -",
        "      &::ontos:workflow:dev:done:-",
        "    -",
        "      &::ontos:workflow:dev:backlog:-",
      ].join("\n"),
    );
    expect(body).toContain("workflow: *::ontos:workflow:dev"); // existing config preserved

    // round-trip: the reindexed structure reads back identically
    const g = call(h, "/api/board", { path: ":" });
    expect(g.json.seeded).toBe(false);
    expect(g.json.lanes.map((l: any[]) => l.map((c: any) => c.tags.map((t: any) => t.path)))).toEqual([
      [[READY]], [[DONE], [BACKLOG_TAG]],
    ]);
    expect(cardPaths(g.json.lanes[0][0].items)).toEqual([":task-a.yo"]);
    // the compartment IS a member of its tag (its bookmark indexed as a back edge)
    const anns = call(h, "/api/annotations", { path: ":yo:lanes:0:0" }).json;
    expect(anns.some((a: any) => a.tag?.path === READY)).toBe(true);
  });

  it("op:move retags the chapter by the compartments' deltas and restructures", async () => {
    const root = boardTree();
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    await callBody(h, "POST", "/api/board", {
      path: ":",
      op: "structure",
      structure: [[{ tags: [READY], items: [] }], [{ tags: [DONE], items: [] }]],
    });

    // ready → done: the source tag drops, the destination tag lands
    const mv = await callBody(h, "POST", "/api/board", {
      path: ":", op: "move", task: ":task-a.yo", from: { lane: 0, comp: 0 }, to: { lane: 1, comp: 0 },
    });
    expect(mv.status).toBe(201);
    expect(cardPaths(mv.json.lanes[0][0].items)).toEqual([]);
    expect(cardPaths(mv.json.lanes[1][0].items)).toEqual([":task-a.yo"]);
    const taskA = fs.readFileSync(path.join(root, "task-a.yo"), "utf8");
    expect(taskA).toContain("&::ontos:workflow:dev:done:-");
    expect(taskA).not.toContain("&::ontos:workflow:dev:ready:-");

    // backlog → ready: the orphan gains the compartment's tags
    const up = await callBody(h, "POST", "/api/board", {
      path: ":", op: "move", task: ":task-b.yo", from: null, to: { lane: 0, comp: 0 },
    });
    expect(cardPaths(up.json.lanes[0][0].items)).toEqual([":task-b.yo"]);
    expect(cardPaths(up.json.backlog)).toEqual([]);
    expect(fs.readFileSync(path.join(root, "task-b.yo"), "utf8")).toContain("&::ontos:workflow:dev:ready:-");

    // ready → backlog: only the shared tags are removed; the card returns to the backlog section
    const down = await callBody(h, "POST", "/api/board", {
      path: ":", op: "move", task: ":task-b.yo", from: { lane: 0, comp: 0 }, to: null,
    });
    expect(cardPaths(down.json.backlog)).toEqual([":task-b.yo"]);
    expect(fs.readFileSync(path.join(root, "task-b.yo"), "utf8")).not.toContain("&::ontos:workflow:dev:ready:-");
  });

  it("a move's tag change relocates the task's OTHER instances through the follow-up reconcile", async () => {
    const root = tmpTree({
      ".yo/body.yo": "!!<*yamlover:$defs:board>\n",
      "ontos/.yo/body.yo": "!!<*yamlover:$defs:onto>\na: !!<*yamlover:$defs:onto> A\nb: !!<*yamlover:$defs:onto> B\n",
      "task.yo": "!!<*yamlover:$defs:task>\ntitle: Twice filed\n&::ontos:a:-\n",
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    // two compartments both wanting :ontos:a → the task lists twice
    const st = await callBody(h, "POST", "/api/board", {
      path: ":", op: "structure",
      structure: [[{ tags: [":ontos:a"], items: [] }], [{ tags: [":ontos:a"], items: [] }, { tags: [":ontos:b"], items: [] }]],
    });
    expect(cardPaths(st.json.lanes[0][0].items)).toEqual([":task.yo"]);
    expect(cardPaths(st.json.lanes[1][0].items)).toEqual([":task.yo"]);
    // move the FIRST instance a → b: the tag flip pulls the second instance out too
    const mv = await callBody(h, "POST", "/api/board", {
      path: ":", op: "move", task: ":task.yo", from: { lane: 0, comp: 0 }, to: { lane: 1, comp: 1 },
    });
    expect(cardPaths(mv.json.lanes[0][0].items)).toEqual([]);
    expect(cardPaths(mv.json.lanes[1][0].items)).toEqual([]);
    expect(cardPaths(mv.json.lanes[1][1].items)).toEqual([":task.yo"]);
  });

  it("a TAGLESS compartment holds no member tickets: a move in bounces back to the backlog", async () => {
    const root = tmpTree({
      ".yo/body.yo": "!!<*yamlover:$defs:board>\n",
      "ontos/.yo/body.yo": "!!<*yamlover:$defs:onto>\na: !!<*yamlover:$defs:onto> A\n",
      "task.yo": "!!<*yamlover:$defs:task>\ntitle: Pinboard item\n",
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    await callBody(h, "POST", "/api/board", {
      path: ":", op: "structure", structure: [[{ tags: [], items: [] }]],
    });
    // the client refuses this drop up front (drop-policy); a direct API move still cannot
    // violate the principle — the follow-up reconcile releases the ticket to the backlog
    const mv = await callBody(h, "POST", "/api/board", {
      path: ":", op: "move", task: ":task.yo", from: null, to: { lane: 0, comp: 0 },
    });
    expect(cardPaths(mv.json.lanes[0][0].items)).toEqual([]);
    expect(cardPaths(mv.json.backlog)).toEqual([":task.yo"]);
    expect(fs.readFileSync(path.join(root, "task.yo"), "utf8")).not.toContain("&"); // never retagged
  });

  it("EVERY file-backed member is a card — scalar-walked files, empty leafs, and blobs included (55-meta parity)", async () => {
    // the reported shape: large-icons showed 4 members, the board's "other" only 2 — the
    // scalar-walked text file and the empty leaf file were wrongly filtered as inline fields
    const root = tmpTree({
      ".yo/body.yo": "!!<*yamlover:$defs:board>\n",
      "age": "",
      "as-text.txt": "name: Whiskers\nspecies: cat\n",
      "as-tree.yaml": "name: Whiskers\nspecies: cat\n",
      "sample.png": "\x89PNG\r\n\x1a\n binary-ish",
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const g = call(h, "/api/board", { path: ":" });
    expect(cardPaths(g.json.backlog).sort()).toEqual([":age", ":as-text.txt", ":as-tree.yaml", ":sample.png"]);
  });

  it("turn-on cleanup: a HAND-AUTHORED tagless compartment holding a ticket is cleaned by op:reconcile", async () => {
    // the reported shape: the user untagged every compartment on disk, one still lists a task —
    // opening the board view (the client fires op:"reconcile") must release it to "other"
    const root = tmpTree({
      ".yo/body.yo": [
        "!!<*yamlover:$defs:board>",
        "yo:",
        "  lanes:",
        "  - -",
        "      - *::task.yo",
        "  - -",
        "",
      ].join("\n"),
      "task.yo": "!!<*yamlover:$defs:task>\ntitle: Stranded in a tagless lane\n",
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/board", { path: ":", op: "reconcile" });
    expect(r.status).toBe(201);
    expect(r.json.seeded).toBe(false);
    expect(r.json.lanes.flat().every((c: any) => c.items.length === 0)).toBe(true);
    expect(cardPaths(r.json.backlog)).toEqual([":task.yo"]);
    // …and the fix is ON DISK, not just in the answer
    expect(fs.readFileSync(path.join(root, ".yo", "body.yo"), "utf8")).not.toContain("*::task.yo");
    expect(fs.readFileSync(path.join(root, "task.yo"), "utf8")).not.toContain("&"); // never retagged
  });

  it("emptying a compartment's tag list releases its tickets to their tags' homes", async () => {
    const root = tmpTree({
      ".yo/body.yo": "!!<*yamlover:$defs:board>\n",
      "ontos/.yo/body.yo": "!!<*yamlover:$defs:onto>\na: !!<*yamlover:$defs:onto> A\n",
      "task.yo": "!!<*yamlover:$defs:task>\ntitle: Tagged item\n&::ontos:a:-\n",
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const st = await callBody(h, "POST", "/api/board", {
      path: ":", op: "structure", structure: [[{ tags: [":ontos:a"], items: [] }]],
    });
    expect(cardPaths(st.json.lanes[0][0].items)).toEqual([":task.yo"]);
    // the tag-list edit: same compartment, tags emptied — its ticket falls to the backlog
    // (no other compartment wants it), its own bookmark untouched
    const cleared = await callBody(h, "POST", "/api/board", {
      path: ":", op: "structure", structure: [[{ tags: [], items: [{ path: ":task.yo" }] }]],
    });
    expect(cardPaths(cleared.json.lanes[0][0].items)).toEqual([]);
    expect(cardPaths(cleared.json.backlog)).toEqual([":task.yo"]);
    expect(fs.readFileSync(path.join(root, "task.yo"), "utf8")).toContain("&::ontos:a:-");
  });
});

// ---------------------------------------------------------------------------
// The FORMAT GUARD (validate.ts) at the write chokepoints. These assert two things at once: the
// write is refused, AND the tree is byte-identical afterwards — a guard that rejects but has
// already mkdir'd half the damage is not a guard.
// ---------------------------------------------------------------------------

/** Every file and directory under `root`, with contents — the snapshot a refused write must not move. */
function treeSnapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string): void => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, d.name);
      const key = rel ? `${rel}/${d.name}` : d.name;
      if (d.name === "index.db" || d.name.startsWith("index.db-")) continue; // the derived index churns
      if (d.isDirectory()) {
        out[`${key}/`] = "";
        walk(abs, key);
      } else out[key] = fs.readFileSync(abs, "utf8");
    }
  };
  walk(root, "");
  return out;
}

describe("the format guard refuses corrupting edits", () => {
  it("refuses an edit that would write INSIDE the hidden overlay, leaving the tree untouched", async () => {
    const root = tmpTree({ "World/.yo/body.yo": "Europe: 1\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const before = treeSnapshot(root);
    // `:World:.yo` resolves to a real directory, so this reaches the directory-target route
    // and would compute <root>/World/.yo/.yo/body.yo.
    const r = await callBody(h, "POST", "/api/edit", { path: ":World:.yo", op: "insert", key: "Asia", yamlover: "x: 1" });
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toContain(".yo");
    expect(treeSnapshot(root)).toEqual(before);
  });

  it("refuses a member name the filesystem cannot carry, leaving the tree untouched", async () => {
    const root = tmpTree({ "World/.yo/body.yo": "Europe: 1\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const before = treeSnapshot(root);
    const r = await callBody(h, "POST", "/api/edit", { path: ":World", op: "insert", key: ".hidden", yamlover: "x: 1" });
    expect(r.status).toBe(400);
    expect(treeSnapshot(root)).toEqual(before);
  });

  it("still writes the legitimate twin — a keyed container becomes a real directory", async () => {
    const root = tmpTree({ "World/.yo/body.yo": "Europe: 1\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", { path: ":World", op: "insert", key: "Eurasia", yamlover: "Asia: 1" });
    expect(r.status).toBe(200);
    expect(fs.statSync(path.join(root, "World", "Eurasia")).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(root, "World", "Eurasia", ".yo", "body.yo"), "utf8")).toContain("Asia: 1");
    // and the promotion did NOT bury an overlay inside an overlay
    expect(fs.existsSync(path.join(root, "World", ".yo", ".yo"))).toBe(false);
  });
});
