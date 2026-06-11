import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHandlers } from "../src/server/engine-api";
import { tmpTree } from "./helpers";
import { call, callBody, sseCapture } from "./http";

// The WRITE endpoints (/api/annotate, /api/paste), against synthetic temp trees — never the
// repo. Fixtures are minimal and explicit, so they cannot break when examples/ evolves.

const SELECTOR = { type: "text", exact: "Alice" };
// A local tag the fixtures apply — the `!!<…$defs/tag>` attach makes it an `x-yamlover-tag`
// node (format derives from the pointer's last step; the schema file itself isn't needed).
const TAG_FILE = { "tags.yamlover": 'yellow: !!<*yamlover/$defs/tag>\n  color: "#f9e2af"\n' };
const TAG = "/tags.yamlover/yellow";

describe("/api/annotate (create)", () => {
  it("creates the annotation file (one tag application) and reverse-links the material", async () => {
    const root = tmpTree({ name: "Alice", ...TAG_FILE });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/annotate", { target: "/name", tag: TAG, selector: SELECTOR });
    expect(r.status).toBe(201);
    expect(r.json.path).toMatch(/^\/annotations\/[^/]+\.yamlover$/);
    const file = fs.readFileSync(path.join(root, r.json.path.slice(1)), "utf8");
    expect(file).toContain("~- *//tags.yamlover/yellow"); // the keyless tag membership

    // the material lists it (the incoming `target` edge), with the selector AND the tag
    const list = call(h, "/api/annotations", { path: "/name" }).json;
    expect(list).toHaveLength(1);
    expect(list[0].path).toBe(r.json.path);
    expect(list[0].selector.exact).toBe("Alice");
    expect(list[0].tag).toMatchObject({ path: TAG, name: "yellow", color: "#f9e2af" });
  });

  it("the tag survives a full reindex (the `~-` pointer resolves on the walk)", async () => {
    const root = tmpTree({ name: "Alice", ...TAG_FILE });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    await callBody(h, "POST", "/api/annotate", { target: "/name", tag: TAG, selector: SELECTOR });

    expect((await callBody(h, "POST", "/api/reindex", {})).status).toBe(200);
    const list = call(h, "/api/annotations", { path: "/name" }).json;
    expect(list).toHaveLength(1);
    expect(list[0].tag).toMatchObject({ path: TAG, name: "yellow", color: "#f9e2af" });
  });

  it("applies to the WHOLE node when no selector is given", async () => {
    const root = tmpTree({ name: "Alice", ...TAG_FILE });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/annotate", { target: "/name", tag: TAG, description: "the whole thing" });
    expect(r.status).toBe(201);
    const list = call(h, "/api/annotations", { path: "/name" }).json;
    expect(list).toHaveLength(1);
    expect(list[0].selector).toBeUndefined();
    expect(list[0].description).toBe("the whole thing");
  });

  it("honors the settings.yamlover annotation location", async () => {
    const root = tmpTree({
      name: "Alice",
      ...TAG_FILE,
      ".yamlover/settings.yamlover": "annotations:\n  location: /notes/marks\n",
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/annotate", { target: "/name", tag: TAG, selector: SELECTOR });
    expect(r.status).toBe(201);
    expect(r.json.path).toMatch(/^\/notes\/marks\/[^/]+\.yamlover$/);
    expect(fs.existsSync(path.join(root, "notes", "marks", path.basename(r.json.path)))).toBe(true);
    expect(call(h, "/api/annotations", { path: "/name" }).json).toHaveLength(1);
  });

  it("rejects an annotation without a target, without a tag, or with a non-tag tag path", async () => {
    const h = createHandlers(tmpTree({ name: "Alice", ...TAG_FILE }), { gitignore: false });
    await h.ready;
    for (const body of [
      { tag: TAG, selector: SELECTOR }, // no target
      { target: "/name", selector: SELECTOR }, // no tag
      { target: "/name", tag: "/name", selector: SELECTOR }, // tag is not an x-yamlover-tag node
      { target: "/name", tag: "/nowhere", selector: SELECTOR }, // tag does not exist
    ]) {
      const r = await callBody(h, "POST", "/api/annotate", body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error).toBeTruthy();
    }
  });
});

describe("/api/annotate (delete)", () => {
  it("deletes a created annotation (file + index rows, incl. the tag membership)", async () => {
    const root = tmpTree({ name: "Alice", ...TAG_FILE });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const created = await callBody(h, "POST", "/api/annotate", { target: "/name", tag: TAG, selector: SELECTOR });

    const r = await callBody(h, "DELETE", "/api/annotate", undefined, { path: created.json.path });
    expect(r.status).toBe(200);
    expect(fs.existsSync(path.join(root, created.json.path.slice(1)))).toBe(false);
    expect(call(h, "/api/annotations", { path: "/name" }).json).toHaveLength(0);
  });

  it("deletes an annotation living in ANY directory (location is not a constraint)", async () => {
    // an annotation authored (or moved) deep in the tree, present at startup
    const root = tmpTree({
      name: "Alice",
      "deep/dir/a1.yamlover":
        "!!<*yamlover/$defs/annotation>\n" + 'target: *//name\nselector:\n  type: "text"\n  exact: "Alice"\n',
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    expect(call(h, "/api/annotations", { path: "/name" }).json).toHaveLength(1); // found from anywhere

    const r = await callBody(h, "DELETE", "/api/annotate", undefined, { path: "/deep/dir/a1.yamlover" });
    expect(r.status).toBe(200);
    expect(fs.existsSync(path.join(root, "deep", "dir", "a1.yamlover"))).toBe(false);
    expect(call(h, "/api/annotations", { path: "/name" }).json).toHaveLength(0);
  });

  it("refuses to delete anything that is not an annotation node", async () => {
    const root = tmpTree({ name: "Alice", "plain.yamlover": "a: 1\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    for (const p of ["/plain.yamlover", "/name", "/../escape.yamlover"]) {
      const r = await callBody(h, "DELETE", "/api/annotate", undefined, { path: p });
      expect(r.status, p).toBe(400);
    }
    expect(fs.existsSync(path.join(root, "plain.yamlover"))).toBe(true);
    expect(fs.existsSync(path.join(root, "name"))).toBe(true);
  });
});

describe("/api/tag (create)", () => {
  it("creates a named tag at the default location and it is immediately applicable", async () => {
    const root = tmpTree({ name: "Alice" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const NAME = "исаакиевский собор";
    const ENC = "/tags/" + encodeURIComponent(NAME); // client JSON paths percent-encode keys
    const r = await callBody(h, "POST", "/api/tag", { name: NAME });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ path: ENC, name: NAME, color: null, created: true });
    const body = fs.readFileSync(path.join(root, "tags", ".yamlover", "body.yamlover"), "utf8");
    expect(body).toContain(`${NAME}: !!<*yamlover/$defs/tag>`);
    expect(call(h, "/api/json", { path: r.json.path }).json.format).toBe("x-yamlover-tag");

    // the freshly created tag can be applied right away
    const a = await callBody(h, "POST", "/api/annotate", { target: "/name", tag: r.json.path, selector: SELECTOR });
    expect(a.status).toBe(201);
    expect(call(h, "/api/annotations", { path: "/name" }).json[0].tag).toMatchObject({ path: ENC, name: NAME });
  });

  it("is idempotent — the same name twice returns the same tag, written once", async () => {
    const root = tmpTree({ name: "Alice" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    await callBody(h, "POST", "/api/tag", { name: "twice" });
    const r = await callBody(h, "POST", "/api/tag", { name: "twice" });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ path: "/tags/twice", name: "twice", created: false });
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
    expect(body).toContain("new: !!<*yamlover/$defs/tag>");
    expect(call(h, "/api/json", { path: "/tags/old" }).json.format).toBe("x-yamlover-tag");
  });

  it("honors a *-pointer tags location from settings.yamlover", async () => {
    const root = tmpTree({
      name: "Alice",
      ".yamlover/settings.yamlover": "tags:\n  location: *taxonomy/places\n",
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/tag", { name: "спб" });
    expect(r.status).toBe(201);
    expect(r.json.path).toBe("/taxonomy/places/" + encodeURIComponent("спб"));
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
    const target = "/" + encodeURIComponent("Санкт-Петербург") + "/img.txt";
    const a = await callBody(h, "POST", "/api/annotate", { target, tag: t.json.path, selector: SELECTOR });
    expect(a.status).toBe(201);
    const file = fs.readFileSync(path.join(root, "annotations", path.basename(a.json.path)), "utf8");
    expect(file).toContain("target: *//Санкт-Петербург/img.txt");
    expect(file).toContain("~- *//tags/исаакиевский собор");

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
  it("tag create, annotate create and annotate delete each broadcast the touched file", async () => {
    const root = tmpTree({ name: "Alice" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const sse = sseCapture(h);

    const t = await callBody(h, "POST", "/api/tag", { name: "first" });
    await callBody(h, "POST", "/api/tag", { name: "second" });
    const a = await callBody(h, "POST", "/api/annotate", { target: "/name", tag: t.json.path });
    await callBody(h, "DELETE", "/api/annotate", undefined, { path: a.json.path });

    const diffs = sse.frames().filter((f) => f.type === "diff");
    expect(diffs.map((d) => ({ added: d.added, changed: d.changed, removed: d.removed }))).toEqual([
      { added: ["/tags/.yamlover/body.yamlover"], changed: [], removed: [] }, // first tag creates the body
      { added: [], changed: ["/tags/.yamlover/body.yamlover"], removed: [] }, // second appends to it
      { added: [a.json.path], changed: [], removed: [] },
      { added: [], changed: [], removed: [a.json.path] },
    ]);
    sse.close();
  });
});

describe("/api/paste", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64");

  it("onto a directory: the file lands in it (no auto-open)", async () => {
    const root = tmpTree({ "dir/keep.txt": "x" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/paste", { path: "/dir", filename: "note.txt", contentBase64: b64("hello") });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ path: "/dir/note.txt", dir: "/dir", open: false });
    expect(fs.readFileSync(path.join(root, "dir", "note.txt"), "utf8")).toBe("hello");
  });

  it("onto a directory MEMBER: the file lands in the enclosing directory and opens", async () => {
    const root = tmpTree({ "dir/keep.txt": "x" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/paste", { path: "/dir/keep.txt", filename: "note.txt", contentBase64: b64("hi") });
    expect(r.json).toMatchObject({ path: "/dir/note.txt", dir: "/dir", open: true });
  });

  it("de-duplicates filenames (note.txt → note-1.txt)", async () => {
    const root = tmpTree({ "dir/keep.txt": "x" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const body = { path: "/dir", filename: "note.txt", contentBase64: b64("one") };

    await callBody(h, "POST", "/api/paste", body);
    const r = await callBody(h, "POST", "/api/paste", { ...body, contentBase64: b64("two") });
    expect(r.json.path).toBe("/dir/note-1.txt");
    expect(fs.readFileSync(path.join(root, "dir", "note-1.txt"), "utf8")).toBe("two");
  });

  it("onto a chapter: the file lands in its directory AND a pointer chunk is appended", async () => {
    const root = tmpTree({
      "doc/.yamlover/body.yamlover":
        "!!<*yamlover/$defs/chapter>\n" + 'title: "T"\nchunks:\n- "Hello"\nchildren: []\n',
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/paste", { path: "/doc", filename: "pic.png", contentBase64: b64("PNG") });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ path: "/doc/pic.png", chapter: "/doc", pointer: "*/pic.png" });
    expect(fs.existsSync(path.join(root, "doc", "pic.png"))).toBe(true);

    // the pointer chunk is appended to `chunks`, before `children:`
    const body = fs.readFileSync(path.join(root, "doc", ".yamlover", "body.yamlover"), "utf8");
    const lines = body.split("\n");
    expect(lines.indexOf("- */pic.png")).toBe(lines.indexOf('- "Hello"') + 1);
  });

  it("rejects an empty paste", async () => {
    const h = createHandlers(tmpTree({ name: "Alice" }), { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/paste", { path: "/", filename: "x.txt", contentBase64: "" });
    expect(r.status).toBe(400);
  });
});

describe("/api/paste (text)", () => {
  const CHAPTER = "!!<*yamlover/$defs/chapter>\n" + 'title: "T"\nchunks:\n- "Hello"\nchildren:\n- title: "Sub"\n  chunks:\n  - "First"\n';

  it("text onto a directory: a new chapter .yamlover file, titled from the first line", async () => {
    const root = tmpTree({ "dir/keep.txt": "x" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/paste", { path: "/dir", text: "# Hello World\n\nFirst paragraph.\n" });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ path: "/dir/Hello%20World.yamlover", dir: "/dir", open: false });
    const src = fs.readFileSync(path.join(root, "dir", "Hello World.yamlover"), "utf8");
    expect(src).toBe('!!<*yamlover/$defs/chapter>\ntitle: "Hello World"\nchunks:\n- |\n  # Hello World\n\n  First paragraph.\n');

    // the new file indexed as a chapter holding the text as its one chunk
    const node = call(h, "/api/json", { path: "/dir/Hello%20World.yamlover", depth: "3" });
    expect(node.json.format).toBe("x-yamlover-chapter");
    expect(node.json.value.chunks).toEqual(["# Hello World\n\nFirst paragraph.\n"]);
  });

  it("text onto a chapter: appended as an inline chunk (no file)", async () => {
    const root = tmpTree({ "doc/.yamlover/body.yamlover": CHAPTER });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/paste", { path: "/doc", text: "New paragraph\nwith two lines\n" });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ path: "/doc", chapter: "/doc" });
    expect(fs.readdirSync(path.join(root, "doc"))).toEqual([".yamlover"]); // no file landed

    // the chunk sits after the existing one, before `children:` — and round-trips
    const body = fs.readFileSync(path.join(root, "doc", ".yamlover", "body.yamlover"), "utf8");
    expect(body).toContain('- "Hello"\n- |\n  New paragraph\n  with two lines\nchildren:');
    const node = call(h, "/api/json", { path: "/doc", depth: "3" });
    expect(node.json.value.chunks[1]).toBe("New paragraph\nwith two lines\n");
  });

  it("text onto a SUBCHAPTER: appended to that subchapter's chunks", async () => {
    // subchapters get their chapter format by SCHEMA PROPAGATION (walk.ts applySchemas), which
    // loads the hosted yamlover/$defs/chapter — so the fixture hosts a minimal one.
    const root = tmpTree({
      "doc/.yamlover/body.yamlover": CHAPTER,
      "yamlover/$defs/chapter": "type: object\nproperties:\n  children:\n    type: array\n    items: *//yamlover/$defs/chapter\n",
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/paste", { path: "/doc/children[0]", text: "deep note" });
    expect(r.json).toMatchObject({ path: "/doc/children[0]", chapter: "/doc/children[0]" });
    const node = call(h, "/api/json", { path: "/doc/children[0]", depth: "3" });
    expect(node.json.value.chunks).toEqual(["First", "deep note"]);
  });

  it("text whose first line is indented falls back to a quoted scalar (block indent detection)", async () => {
    const root = tmpTree({ "doc/.yamlover/body.yamlover": CHAPTER });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const text = "    indented first line\nplain second";
    await callBody(h, "POST", "/api/paste", { path: "/doc", text });
    const body = fs.readFileSync(path.join(root, "doc", ".yamlover", "body.yamlover"), "utf8");
    expect(body).toContain(`- ${JSON.stringify(text)}`);
    const node = call(h, "/api/json", { path: "/doc", depth: "3" });
    expect(node.json.value.chunks[1]).toBe(text);
  });

  it("non-ASCII first line names the chapter file (Cyrillic + space)", async () => {
    const root = tmpTree({ "dir/keep.txt": "x" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/paste", { path: "/dir", text: "Привет мир\n\nтекст" });
    expect(r.json.path).toBe(`/dir/${encodeURIComponent("Привет мир")}.yamlover`);
    expect(fs.existsSync(path.join(root, "dir", "Привет мир.yamlover"))).toBe(true);
  });

  it("rejects an empty text paste", async () => {
    const h = createHandlers(tmpTree({ name: "Alice" }), { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/paste", { path: "/", text: "   \n " });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/empty/);
  });
});

describe("/api/paste (rich — an HTML selection: image chunks + heading subchapters)", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  const CHAPTER = "!!<*yamlover/$defs/chapter>\n" + 'title: "T"\nchunks:\n- "Hello"\nchildren:\n- title: "Old"\n  chunks:\n  - "First"\n';

  it("onto a chapter: chunks (text+image, order kept) append to chunks:, subchapters to children:", async () => {
    const root = tmpTree({ "doc/.yamlover/body.yamlover": CHAPTER });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/paste", {
      path: "/doc",
      rich: {
        chunks: [{ text: "intro" }, { file: { name: "cat.jpg", contentBase64: b64("JPG") } }, { text: "outro" }],
        children: [{ title: "Cats", chunks: [{ text: "feline facts" }], children: [{ title: "Kittens", chunks: [{ text: "tiny" }], children: [] }] }],
      },
    });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ path: "/doc", chapter: "/doc", files: ["/doc/cat.jpg"] });
    expect(fs.readFileSync(path.join(root, "doc", "cat.jpg"), "utf8")).toBe("JPG");

    // the round-trip: new chunks after the old one, the image as a resolved pointer; the new
    // subchapter (with its nested child) after the old one
    const node = call(h, "/api/json", { path: "/doc", depth: "7" });
    const chunks = node.json.value.chunks;
    expect([chunks[0], chunks[1], chunks[3]]).toEqual(["Hello", "intro", "outro"]);
    expect(chunks[2].$yamloverLink.path).toBe("/doc/cat.jpg");
    const kids = node.json.value.children;
    expect(kids[0].title).toBe("Old");
    expect(kids[1].title).toBe("Cats");
    expect(kids[1].chunks).toEqual(["feline facts"]);
    expect(kids[1].children[0].title).toBe("Kittens");
    expect(kids[1].children[0].chunks).toEqual(["tiny"]);
  });

  it("creates missing chunks:/children: keys on a minimal chapter", async () => {
    const root = tmpTree({ "doc/.yamlover/body.yamlover": "!!<*yamlover/$defs/chapter>\ntitle: \"Bare\"\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/paste", {
      path: "/doc",
      rich: { chunks: [{ text: "body" }], children: [{ title: "Sub", chunks: [{ text: "inner" }], children: [] }] },
    });
    expect(r.status).toBe(201);
    const node = call(h, "/api/json", { path: "/doc", depth: "4" });
    expect(node.json.value.chunks).toEqual(["body"]);
    expect(node.json.value.children[0].title).toBe("Sub");
  });

  it("onto a directory WITHOUT files: a standalone chapter file; a lone leading heading titles it", async () => {
    const root = tmpTree({ "dir/keep.txt": "x" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    // the selection started with an H2 — everything sits under that sole child
    const r = await callBody(h, "POST", "/api/paste", {
      path: "/dir",
      rich: { chunks: [], children: [{ title: "Cats", chunks: [{ text: "feline facts" }], children: [{ title: "Kittens", chunks: [{ text: "tiny" }], children: [] }] }] },
    });
    expect(r.json).toMatchObject({ path: "/dir/Cats.yamlover", dir: "/dir", open: false });
    const node = call(h, "/api/json", { path: "/dir/Cats.yamlover", depth: "4" });
    expect(node.json.format).toBe("x-yamlover-chapter");
    expect(node.json.title).toBe("Cats"); // the heading became the chapter title, not a child
    expect(node.json.value.chunks).toEqual(["feline facts"]);
    expect(node.json.value.children[0].title).toBe("Kittens");
  });

  it("onto a directory WITH files: a directory-backed chapter holding its images", async () => {
    const root = tmpTree({ "dir/keep.txt": "x" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/paste", {
      path: "/dir",
      rich: {
        chunks: [{ text: "A cat article" }, { file: { name: "cat.jpg", contentBase64: b64("JPG") } }],
        children: [{ title: "Gallery", chunks: [{ file: { name: "cat.jpg", contentBase64: b64("JPG2") } }], children: [] }],
      },
    });
    expect(r.json).toMatchObject({ path: "/dir/A%20cat%20article", dir: "/dir", open: false });
    // the chapter is a directory: body overlay + both images inside (deduped names)
    expect(fs.readFileSync(path.join(root, "dir", "A cat article", "cat.jpg"), "utf8")).toBe("JPG");
    expect(fs.readFileSync(path.join(root, "dir", "A cat article", "cat-1.jpg"), "utf8")).toBe("JPG2");
    const body = fs.readFileSync(path.join(root, "dir", "A cat article", ".yamlover", "body.yamlover"), "utf8");
    expect(body).toContain("- */cat.jpg");
    expect(body).toContain("- */cat-1.jpg");

    const node = call(h, "/api/json", { path: encodeURI("/dir/A cat article"), depth: "4" });
    expect(node.json.format).toBe("x-yamlover-chapter");
    expect(node.json.value.chunks[1].$yamloverLink.path).toBe(encodeURI("/dir/A cat article/cat.jpg"));
  });

  it("rejects an empty or malformed rich paste", async () => {
    const h = createHandlers(tmpTree({ name: "Alice" }), { gitignore: false });
    await h.ready;
    const empty = await callBody(h, "POST", "/api/paste", { path: "/", rich: { chunks: [], children: [] } });
    expect(empty.status).toBe(400);
    expect(empty.json.error).toMatch(/empty/);
    const bad = await callBody(h, "POST", "/api/paste", { path: "/", rich: { chunks: [{ nope: 1 }], children: [] } });
    expect(bad.status).toBe(400);
  });
});
