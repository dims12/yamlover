import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHandlers } from "../src/server/engine-api";
import { tmpTree } from "./helpers";
import { call, callBody, sseCapture } from "./http";

// The WRITE endpoints /api/tag and /api/paste, against synthetic temp trees — never the repo.
// (The embedded /api/annotate + /api/fragment endpoints are covered in embed-api.test.ts.)

// A chapter is an OMNI node (CHAPTER.md): title/description keyed, the body positional. Its
// `/api/json` value is a `$yamloverMixed` marker (or a plain array when untitled). These read the
// positional body values, a subchapter's title, and the hosted $defs the paste tests need.
const bodyVals = (v: unknown): unknown[] => {
  if (Array.isArray(v)) return v;
  const m = (v as { $yamloverMixed?: { entries: { key: string | null; value: unknown }[] } })?.$yamloverMixed;
  return m ? m.entries.filter((e) => e.key == null).map((e) => e.value) : [];
};
const subTitle = (marker: unknown): unknown =>
  (marker as { $yamloverMixed?: { entries: { key: string | null; value: unknown }[] } })?.$yamloverMixed?.entries.find((e) => e.key === "title")?.value;
const CHAPTER_DEFS = {
  "$defs/chapter":
    "type: variant\nproperties:\n  title:\n    type: string\nitems:\n  anyOf:\n    - *//yamlover/$defs/chapter\n    - *//yamlover/$defs/chunk\n",
  "$defs/chunk": "type: [string, binary]\nformat: text/marklower\n",
};

describe("/api/tag (create)", () => {
  it("creates a named tag at the default location and it is immediately applicable", async () => {
    const root = tmpTree({ name: "Alice" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const NAME = "исаакиевский собор";
    const ENC = ":tags:" + encodeURIComponent(NAME); // client JSON paths percent-encode keys
    const r = await callBody(h, "POST", "/api/tag", { name: NAME });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ path: ENC, name: NAME, color: null, created: true });
    const body = fs.readFileSync(path.join(root, "tags", ".yamlover", "body.yamlover"), "utf8");
    expect(body).toContain(`${NAME}: !!<*::yamlover:$defs:tag>`);
    expect(call(h, "/api/json", { path: r.json.path }).json.format).toBe("x-yamlover-tag");

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
    expect(r.json).toMatchObject({ path: ":tags:twice", name: "twice", created: false });
    const body = fs.readFileSync(path.join(root, "tags", ".yamlover", "body.yamlover"), "utf8");
    expect(body.match(/^twice:/gm)).toHaveLength(1);
  });

  it("appends to an existing taxonomy body without clobbering it", async () => {
    const root = tmpTree({ "tags/.yamlover/body.yamlover": "old: !!<*yamlover/$defs/tag>\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/tag", { name: "new" });
    expect(r.status).toBe(201);
    const body = fs.readFileSync(path.join(root, "tags", ".yamlover", "body.yamlover"), "utf8");
    expect(body).toContain("old: !!<*yamlover/$defs/tag>");
    expect(body).toContain("new: !!<*::yamlover:$defs:tag>");
    expect(call(h, "/api/json", { path: ":tags:old" }).json.format).toBe("x-yamlover-tag");
  });

  it("honors a *-pointer tags location from settings.yamlover", async () => {
    const root = tmpTree({
      name: "Alice",
      ".yamlover/settings.yamlover": "tags: *:: taxonomy: places\n",
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/tag", { name: "спб" });
    expect(r.status).toBe(201);
    expect(r.json.path).toBe(":taxonomy:places:" + encodeURIComponent("спб"));
    expect(fs.existsSync(path.join(root, "taxonomy", "places", ".yamlover", "body.yamlover"))).toBe(true);
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
    expect(fs.existsSync(path.join(root, "tags"))).toBe(false); // nothing was written
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
    const overlay = fs.readFileSync(path.join(root, "Санкт-Петербург", ".yamlover", "body.yamlover"), "utf8");
    expect(overlay).toContain('"img.txt":');
    expect(overlay).toContain("*::tags:'исаакиевский собор'");

    expect((await callBody(h, "POST", "/api/reindex", {})).status).toBe(200);
    const list = call(h, "/api/annotations", { path: target }).json;
    expect(list).toHaveLength(1);
    expect(list[0].tag).toMatchObject({ path: t.json.path, name: "исаакиевский собор" });
    const tagged = call(h, "/api/tagged", { path: t.json.path }).json;
    expect(tagged).toHaveLength(1);
    expect(tagged[0].$yamloverLink.path).toBe(target);
  });

  it("refuses when a non-tag node already occupies the path", async () => {
    const root = tmpTree({ "tags/busy": "plain file" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/tag", { name: "busy" });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/not a tag/);
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
    expect(diffs[0]).toMatchObject({ added: [":tags:.yamlover:body.yamlover"], changed: [], removed: [] });
    expect(diffs[1]).toMatchObject({ added: [], changed: [":tags:.yamlover:body.yamlover"], removed: [] });
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
      "doc/.yamlover/body.yamlover": "!!<*yamlover/$defs/chapter>\n" + 'title: "T"\n- "Hello"\n',
      ...CHAPTER_DEFS,
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/paste", { path: ":doc", filename: "pic.png", contentBase64: b64("PNG") });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ path: ":doc:pic.png", chapter: ":doc", pointer: "*/pic.png" });
    expect(fs.existsSync(path.join(root, "doc", "pic.png"))).toBe(true);

    // the pointer chunk is appended to the positional body, after the last item
    const body = fs.readFileSync(path.join(root, "doc", ".yamlover", "body.yamlover"), "utf8");
    const lines = body.split("\n");
    expect(lines.indexOf("- */pic.png")).toBe(lines.indexOf('- "Hello"') + 1);
  });

  // `inline`: the WYSIWYG editor uploading an image pasted INTO a prose chunk. The file must land,
  // and the body must not gain a chunk — the editor is placing its own embed token in the sentence,
  // and an appended chunk would put the picture on the page twice.
  it("onto a chapter with inline: the file lands, the body is untouched, and it does not auto-open", async () => {
    const source = "!!<*yamlover/$defs/chapter>\n" + 'title: "T"\n- "Hello"\n';
    const root = tmpTree({ "doc/.yamlover/body.yamlover": source, ...CHAPTER_DEFS });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/paste", { path: ":doc", filename: "pic.png", contentBase64: b64("PNG"), inline: true });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ path: ":doc:pic.png", dir: ":doc", open: false });
    expect(r.json).not.toHaveProperty("pointer");
    expect(fs.readFileSync(path.join(root, "doc", "pic.png"), "utf8")).toBe("PNG");
    expect(fs.readFileSync(path.join(root, "doc", ".yamlover", "body.yamlover"), "utf8")).toBe(source);
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
  const CHAPTER = "!!<*yamlover/$defs/chapter>\n" + 'title: "T"\n- "Hello"\n- title: "Sub"\n  - "First"\n';

  it("text onto a directory: a new chapter .yamlover file, titled from the first line", async () => {
    const root = tmpTree({ "dir/keep.txt": "x", ...CHAPTER_DEFS });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/paste", { path: ":dir", text: "# Hello World\n\nFirst paragraph.\n" });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ path: ":dir:Hello%20World.yamlover", dir: ":dir", open: false });
    const src = fs.readFileSync(path.join(root, "dir", "Hello World.yamlover"), "utf8");
    expect(src).toBe('!!<*::yamlover:$defs:chapter>\ntitle: "Hello World"\n- |\n  # Hello World\n\n  First paragraph.\n');

    // the new file indexed as a chapter holding the text as its one body chunk
    const node = call(h, "/api/json", { path: ":dir:Hello%20World.yamlover", depth: "3" });
    expect(node.json.format).toBe("x-yamlover-chapter");
    expect(bodyVals(node.json.value)).toEqual(["# Hello World\n\nFirst paragraph.\n"]);
  });

  it("text onto a chapter: appended as an inline chunk at the end of the body (no file)", async () => {
    const root = tmpTree({ "doc/.yamlover/body.yamlover": CHAPTER, ...CHAPTER_DEFS });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/paste", { path: ":doc", text: "New paragraph\nwith two lines\n" });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ path: ":doc", chapter: ":doc" });
    expect(fs.readdirSync(path.join(root, "doc"))).toEqual([".yamlover"]); // no file landed

    // the chunk is appended after the last body item (the subchapter) — one interleaved stream
    const body = fs.readFileSync(path.join(root, "doc", ".yamlover", "body.yamlover"), "utf8");
    expect(body).toContain('- |\n  New paragraph\n  with two lines');
    const vals = bodyVals(call(h, "/api/json", { path: ":doc", depth: "3" }).json.value);
    expect(vals[vals.length - 1]).toBe("New paragraph\nwith two lines\n");
  });

  it("text onto a SUBCHAPTER: appended to that subchapter's body", async () => {
    // subchapters get their chapter format by SCHEMA PROPAGATION (walk.ts applySchemas) via the
    // hosted $defs/chapter's `items: {anyOf:[chapter, chunk]}` union — so the fixture hosts one.
    const root = tmpTree({ "doc/.yamlover/body.yamlover": CHAPTER, ...CHAPTER_DEFS });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    // the subchapter "Sub" is body element [2] (title is store index 0, "Hello" is [1])
    const r = await callBody(h, "POST", "/api/paste", { path: ":doc[2]", text: "deep note" });
    expect(r.json).toMatchObject({ path: ":doc[2]", chapter: ":doc[2]" });
    const node = call(h, "/api/json", { path: ":doc[2]", depth: "3" });
    expect(bodyVals(node.json.value)).toEqual(["First", "deep note"]);
  });

  it("text whose first line is indented falls back to a quoted scalar (block indent detection)", async () => {
    const root = tmpTree({ "doc/.yamlover/body.yamlover": CHAPTER, ...CHAPTER_DEFS });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const text = "    indented first line\nplain second";
    await callBody(h, "POST", "/api/paste", { path: ":doc", text });
    const body = fs.readFileSync(path.join(root, "doc", ".yamlover", "body.yamlover"), "utf8");
    expect(body).toContain(`- ${JSON.stringify(text)}`);
    const vals = bodyVals(call(h, "/api/json", { path: ":doc", depth: "3" }).json.value);
    expect(vals[vals.length - 1]).toBe(text);
  });

  it("non-ASCII first line names the chapter file (Cyrillic + space)", async () => {
    const root = tmpTree({ "dir/keep.txt": "x" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/paste", { path: ":dir", text: "Привет мир\n\nтекст" });
    expect(r.json.path).toBe(`:dir:${encodeURIComponent("Привет мир")}.yamlover`);
    expect(fs.existsSync(path.join(root, "dir", "Привет мир.yamlover"))).toBe(true);
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
  const CHAPTER = "!!<*yamlover/$defs/chapter>\n" + 'title: "T"\n- "Hello"\n- title: "Old"\n  - "First"\n';

  it("onto a chapter: chunks (text+image) then subchapters append to the positional body, in order", async () => {
    const root = tmpTree({ "doc/.yamlover/body.yamlover": CHAPTER, ...CHAPTER_DEFS });
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
    const vals = bodyVals(call(h, "/api/json", { path: ":doc", depth: "7" }).json.value);
    expect(vals.filter((x) => typeof x === "string")).toEqual(["Hello", "intro", "outro"]);
    expect((vals.find((x) => (x as { $yamloverLink?: { path: string } })?.$yamloverLink) as { $yamloverLink: { path: string } }).$yamloverLink.path).toBe(":doc:cat.jpg");
    const subs = vals.filter((x) => subTitle(x) != null);
    expect(subs.map(subTitle)).toEqual(["Old", "Cats"]);
    const cats = subs[1];
    expect(bodyVals(cats).filter((x) => typeof x === "string")).toEqual(["feline facts"]);
    const kittens = bodyVals(cats).find((x) => subTitle(x) === "Kittens");
    expect(bodyVals(kittens)).toEqual(["tiny"]);
  });

  it("appends a body to a minimal (body-less) chapter", async () => {
    const root = tmpTree({ "doc/.yamlover/body.yamlover": '!!<*yamlover/$defs/chapter>\ntitle: "Bare"\n', ...CHAPTER_DEFS });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/paste", {
      path: ":doc",
      rich: { chunks: [{ text: "body" }], children: [{ title: "Sub", chunks: [{ text: "inner" }], children: [] }] },
    });
    expect(r.status).toBe(201);
    const vals = bodyVals(call(h, "/api/json", { path: ":doc", depth: "4" }).json.value);
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
    expect(r.json).toMatchObject({ path: ":dir:Cats.yamlover", dir: ":dir", open: false });
    const node = call(h, "/api/json", { path: ":dir:Cats.yamlover", depth: "4" });
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
    expect(r.json).toMatchObject({ path: ":dir:A%20cat%20article", dir: ":dir", open: false });
    // the chapter is a directory: body overlay + both images inside (deduped names)
    expect(fs.readFileSync(path.join(root, "dir", "A cat article", "cat.jpg"), "utf8")).toBe("JPG");
    expect(fs.readFileSync(path.join(root, "dir", "A cat article", "cat-1.jpg"), "utf8")).toBe("JPG2");
    const body = fs.readFileSync(path.join(root, "dir", "A cat article", ".yamlover", "body.yamlover"), "utf8");
    expect(body).toContain("- */cat.jpg");
    expect(body).toContain("- */cat-1.jpg");

    const node = call(h, "/api/json", { path: encodeURI(":dir:A cat article"), depth: "4" });
    expect(node.json.format).toBe("x-yamlover-chapter");
    const img = bodyVals(node.json.value).find((x) => (x as { $yamloverLink?: unknown })?.$yamloverLink) as { $yamloverLink: { path: string } };
    expect(img.$yamloverLink.path).toBe(encodeURI(":dir:A cat article:cat.jpg"));
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
      "mytask.yamlover": ["!!<*yamlover:$defs:task>", "title: Wire the widget", "yamlover-annotations:", "- *::tags:state:backlog", ""].join("\n"),
      "tags/.yamlover/body.yamlover": ["!!<*yamlover:$defs:tag>", "state: Lifecycle states", "  backlog: Captured", "  in-progress: Working", ""].join("\n"),
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const column = (tag: string): string[] =>
      call(h, "/api/tagged", { path: tag }).json.map((m: any) => m?.$yamloverLink?.path).filter(Boolean);

    // the task starts in the backlog lane
    expect(call(h, "/api/json", { path: ":mytask.yamlover" }).json.format).toBe("x-yamlover-task");
    expect(column(":tags:state:backlog")).toContain(":mytask.yamlover");
    expect(column(":tags:state:in-progress")).not.toContain(":mytask.yamlover");

    // DRAG → in-progress: drop the old state annotation, add the new
    const del = await callBody(h, "DELETE", "/api/annotate", undefined, { target: ":mytask.yamlover", tag: ":tags:state:backlog" });
    expect(del.status).toBe(200);
    const add = await callBody(h, "POST", "/api/annotate", { target: ":mytask.yamlover", tag: ":tags:state:in-progress" });
    expect(add.status).toBe(201);

    // the lanes have flipped, and the file now points at the new state
    expect(column(":tags:state:in-progress")).toContain(":mytask.yamlover");
    expect(column(":tags:state:backlog")).not.toContain(":mytask.yamlover");
    const body = fs.readFileSync(path.join(root, "mytask.yamlover"), "utf8");
    expect(body).toContain("*::tags:state:in-progress");
    expect(body).not.toContain("state:backlog");
  });
});

// The BOARD lane config (TICKETS.md §3): POST /api/board rewrites the directory overlay's
// `lanes:` block (lanes × tag pointers), persisting the explorer board view's configuration.
describe("/api/board (lane config)", () => {
  it("persists lanes as project-scope tag pointers and re-reads them", async () => {
    const root = tmpTree({
      ".yamlover/body.yamlover": "!!<*yamlover:$defs:board>\nworkflow: *::tags:workflow:dev\n",
      "tags/.yamlover/body.yamlover": "!!<*yamlover:$defs:tag>\nworkflow: Lifecycles\n  dev: Software task lifecycle\n    ready: Ready\n    done: Done\n    cancelled: Dropped\n",
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/board", {
      path: ":",
      lanes: [[":tags:workflow:dev:ready"], [":tags:workflow:dev:done", ":tags:workflow:dev:cancelled"]],
    });
    expect(r.status).toBe(201);
    const body = fs.readFileSync(path.join(root, ".yamlover", "body.yamlover"), "utf8");
    expect(body).toContain("lanes:");
    expect(body).toContain("- [*::tags:workflow:dev:ready]");
    expect(body).toContain("- [*::tags:workflow:dev:done, *::tags:workflow:dev:cancelled]");
    expect(body).toContain("workflow: *::tags:workflow:dev"); // the existing config is preserved
    // the lane tag pointers resolve (the board reads them at depth 3)
    const deep = call(h, "/api/json", { path: ":", depth: "3" }).json;
    const lanes = deep.value.lanes;
    expect(Array.isArray(lanes)).toBe(true);
    expect(lanes).toHaveLength(2);

    // a later save with no lanes writes an empty flow-sequence (valid YAML, not a null key)
    const empty = await callBody(h, "POST", "/api/board", { path: ":", lanes: [] });
    expect(empty.status).toBe(201);
    expect(fs.readFileSync(path.join(root, ".yamlover", "body.yamlover"), "utf8")).toContain("lanes: []");
  });
});
