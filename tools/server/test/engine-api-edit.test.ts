import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHandlers } from "../src/server/engine-api";
import { tmpTree } from "./helpers";
import { call, callBody } from "./http";

// The WRITE endpoint /api/edit — the unlocked WYSIWYG editor's surgical edits of a chapter's
// `.yamlover` source (set title/description, replace/insert/remove a prose chunk), against
// synthetic temp trees (never the repo's own examples/).

// A chapter that hosts $defs so subchapters gain the chapter format by schema propagation
// (walk.ts applySchemas) — needed for subchapter-title edits addressed at `:doc:children[0]`.
const CHAPTER =
  "!!<*yamlover/$defs/chapter>\n" +
  'title: "T"\n' +
  "description: Sub\n" +
  "chunks:\n- Hello\n- |\n  first line\n  second line\n" +
  "children:\n- title: Sub\n  chunks:\n  - First\n";
const DEFS = { "$defs/chapter": "type: object\nproperties:\n  children:\n    type: array\n    items: *//yamlover/$defs/chapter\n" };

const bodyOf = (root: string) => fs.readFileSync(path.join(root, "doc", ".yamlover", "body.yamlover"), "utf8");

async function chapterHandlers(extra: Record<string, string> = {}) {
  const root = tmpTree({ "doc/.yamlover/body.yamlover": CHAPTER, ...DEFS, ...extra });
  const h = createHandlers(root, { gitignore: false });
  await h.ready;
  return { root, h };
}

describe("/api/edit — scalars", () => {
  it("sets a chapter title (replacing the existing line)", async () => {
    const { root, h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc:title", op: "set", text: "New Title" });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toContain('title: "New Title"');
    expect(call(h, "/api/json", { path: ":doc" }).json.title).toBe("New Title");
  });

  it("adds a description when the chapter has none", async () => {
    const { root, h } = await chapterHandlers({
      "doc/.yamlover/body.yamlover": "!!<*yamlover/$defs/chapter>\ntitle: T\nchunks:\n- Hello\n",
    });
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc:description", op: "set", text: "A subtitle" });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toContain('description: "A subtitle"');
  });

  it("edits a subchapter title (children[0])", async () => {
    const { root, h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc:children[0]:title", op: "set", text: "Renamed" });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toContain('title: "Renamed"');
    expect(call(h, "/api/json", { path: ":doc:children[0]", depth: "3" }).json.title).toBe("Renamed");
  });
});

describe("/api/edit — chunks", () => {
  it("replaces an inline chunk with new prose", async () => {
    const { root, h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc:chunks[0]", op: "replace", text: "Goodbye **world**" });
    expect(r.status).toBe(200);
    expect(call(h, "/api/json", { path: ":doc", depth: "3" }).json.value.chunks[0]).toBe("Goodbye **world**");
    // the block chunk (chunks[1]) is untouched
    expect(call(h, "/api/json", { path: ":doc", depth: "3" }).json.value.chunks[1]).toBe("first line\nsecond line\n");
  });

  it("replaces a multi-line block-scalar chunk whole", async () => {
    const { root, h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc:chunks[1]", op: "replace", text: "one\ntwo\nthree" });
    expect(r.status).toBe(200);
    const chunks = call(h, "/api/json", { path: ":doc", depth: "3" }).json.value.chunks;
    expect(chunks[0]).toBe("Hello");
    expect(chunks[1]).toBe("one\ntwo\nthree");
  });

  it("inserts a new chunk at the given position (index)", async () => {
    const { h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc:chunks", op: "insert", index: 1, text: "inserted" });
    expect(r.status).toBe(200);
    const chunks = call(h, "/api/json", { path: ":doc", depth: "3" }).json.value.chunks;
    expect(chunks).toEqual(["Hello", "inserted", "first line\nsecond line\n"]);
  });

  it("prepends a chunk (index 0) and appends (index past the end)", async () => {
    const { h } = await chapterHandlers();
    await callBody(h, "POST", "/api/edit", { path: ":doc:chunks", op: "insert", index: 0, text: "top" });
    await callBody(h, "POST", "/api/edit", { path: ":doc:chunks", op: "insert", index: 99, text: "bottom" });
    const chunks = call(h, "/api/json", { path: ":doc", depth: "3" }).json.value.chunks;
    expect(chunks).toEqual(["top", "Hello", "first line\nsecond line\n", "bottom"]);
  });

  it("removes a chunk", async () => {
    const { root, h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc:chunks[0]", op: "remove" });
    expect(r.status).toBe(200);
    const chunks = call(h, "/api/json", { path: ":doc", depth: "3" }).json.value.chunks;
    expect(chunks).toEqual(["first line\nsecond line\n"]);
  });

  it("edits a chunk inside a subchapter", async () => {
    const { root, h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc:children[0]:chunks[0]", op: "replace", text: "Deep edit" });
    expect(r.status).toBe(200);
    expect(call(h, "/api/json", { path: ":doc:children[0]", depth: "3" }).json.value.chunks[0]).toBe("Deep edit");
  });
});

describe("/api/edit — batch", () => {
  it("applies a batch of ops in order in one call (a split: replace head + insert tail)", async () => {
    const { h } = await chapterHandlers();
    // simulate splitting chunk 0 "Hello" at a caret → head "Hel", tail "lo"
    const r = await callBody(h, "POST", "/api/edit", {
      edits: [
        { path: ":doc:chunks[0]", op: "replace", text: "Hel" },
        { path: ":doc:chunks", op: "insert", index: 1, text: "lo" },
      ],
    });
    expect(r.status).toBe(200);
    const chunks = call(h, "/api/json", { path: ":doc", depth: "3" }).json.value.chunks;
    // the head is truncated AND the tail is a new chunk — the v1 bug (head un-truncated) is gone
    expect(chunks).toEqual(["Hel", "lo", "first line\nsecond line\n"]);
  });

  it("batches a title set + a chunk replace + a remove together", async () => {
    const { root, h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", {
      edits: [
        { path: ":doc:title", op: "set", text: "Batched" },
        { path: ":doc:chunks[0]", op: "replace", text: "H2" },
        { path: ":doc:chunks[1]", op: "remove" },
      ],
    });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toContain('title: "Batched"');
    expect(call(h, "/api/json", { path: ":doc", depth: "3" }).json.value.chunks).toEqual(["H2"]);
  });

  it("routes a batch touching two different chapter files, one reindex each", async () => {
    const root = tmpTree({
      "a/.yamlover/body.yamlover": "!!<*yamlover/$defs/chapter>\ntitle: A\nchunks:\n- one\n",
      "b/.yamlover/body.yamlover": "!!<*yamlover/$defs/chapter>\ntitle: B\nchunks:\n- two\n",
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit", {
      edits: [
        { path: ":a:chunks[0]", op: "replace", text: "one!" },
        { path: ":b:title", op: "set", text: "B2" },
      ],
    });
    expect(r.status).toBe(200);
    expect(call(h, "/api/json", { path: ":a", depth: "3" }).json.value.chunks).toEqual(["one!"]);
    expect(call(h, "/api/json", { path: ":b" }).json.title).toBe("B2");
  });
});

describe("/api/edit — guards & formats", () => {
  it("preserves an inline schema tag on a markdown chunk", async () => {
    const { root, h } = await chapterHandlers({
      "doc/.yamlover/body.yamlover": "!!<*yamlover/$defs/chapter>\ntitle: T\nchunks:\n- !!<format: text/markdown> |\n  # Head\n",
    });
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc:chunks[0]", op: "replace", text: "# New Head\n\nbody" });
    expect(r.status).toBe(200);
    const body = bodyOf(root);
    expect(body).toContain("!!<format: text/markdown>");
    expect(call(h, "/api/json", { path: ":doc:chunks[0]" }).json.format).toBe("text/markdown");
  });

  it("edits a LaTeX chunk (keeps its inline schema tag)", async () => {
    const { root, h } = await chapterHandlers({
      "doc/.yamlover/body.yamlover": "!!<*yamlover/$defs/chapter>\ntitle: T\nchunks:\n- !!<format: text/x-latex> |\n  e^{i\\pi}\n",
    });
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc:chunks[0]", op: "replace", text: "\\sqrt{2}" });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toContain("!!<format: text/x-latex>");
    expect(call(h, "/api/json", { path: ":doc:chunks[0]" }).json.format).toBe("text/x-latex");
    expect(call(h, "/api/json", { path: ":doc", depth: "3" }).json.value.chunks[0]).toBe("\\sqrt{2}");
  });

  it("still rejects editing a non-text (image/pointer) chunk", async () => {
    const { h } = await chapterHandlers({
      "doc/pic.png": "PNG",
      "doc/.yamlover/body.yamlover": "!!<*yamlover/$defs/chapter>\ntitle: T\nchunks:\n- !!<format: image/png> \"x\"\n",
    });
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc:chunks[0]", op: "replace", text: "hi" });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/non-text/);
  });

  it("rejects editing a file/pointer chunk as text", async () => {
    const { h } = await chapterHandlers({
      "doc/pic.png": "PNG",
      "doc/.yamlover/body.yamlover": "!!<*yamlover/$defs/chapter>\ntitle: T\nchunks:\n- */pic.png\n",
    });
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc:chunks[0]", op: "replace", text: "hi" });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/pointer/);
  });

  it("rejects an unsupported edit target", async () => {
    const { h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc", op: "set", text: "x" });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/unsupported edit target/);
  });
});

describe("/api/create — objects of a schema", () => {
  const CHAP = "::yamlover:$defs:chapter";
  const dirTree = () => tmpTree({ "dir/keep.txt": "x", ...DEFS });

  it("child inline: appends a subchapter (one empty chunk) to a chapter's children", async () => {
    const { root, h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/create", { schema: CHAP, parent: ":doc", concrete: "yamlover", title: "Fresh" });
    expect(r.status).toBe(201);
    expect(r.json.path).toBe(":doc:children[1]"); // doc already has one child ("Sub")
    expect(bodyOf(root)).toContain('title: "Fresh"');
    const node = call(h, "/api/json", { path: ":doc:children[1]", depth: "3" });
    expect(node.json.format).toBe("x-yamlover-chapter");
    expect(node.json.value.chunks).toEqual([""]); // one empty, immediately-editable chunk
  });

  it("child linked file: writes a .yamlover doc beside the parent + a pointer in children", async () => {
    const { root, h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/create", { schema: CHAP, parent: ":doc", concrete: "file/yamlover", title: "Linked" });
    expect(r.status).toBe(201);
    expect(fs.existsSync(path.join(root, "doc", "Linked.yamlover"))).toBe(true); // dir-backed doc → inside doc/
    expect(bodyOf(root)).toContain("- */Linked.yamlover");
    expect(r.json.path).toBe(":doc:Linked.yamlover"); // navigates to the linked doc's own node
    expect(call(h, "/api/json", { path: r.json.path }).json.format).toBe("x-yamlover-chapter");
  });

  it("child linked dir: writes <name>/.yamlover/body.yamlover + a pointer", async () => {
    const { root, h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/create", { schema: CHAP, parent: ":doc", concrete: "dir/yamlover", title: "SubDir" });
    expect(r.status).toBe(201);
    expect(fs.existsSync(path.join(root, "doc", "SubDir", ".yamlover", "body.yamlover"))).toBe(true);
    expect(bodyOf(root)).toContain("- */SubDir");
    expect(r.json.path).toBe(":doc:SubDir");
    expect(call(h, "/api/json", { path: r.json.path }).json.format).toBe("x-yamlover-chapter");
  });

  it("member file: a standalone .yamlover chapter file in a directory", async () => {
    const root = dirTree();
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/create", { schema: CHAP, parent: ":dir", concrete: "file/yamlover", title: "New Note" });
    expect(r.status).toBe(201);
    expect(fs.existsSync(path.join(root, "dir", "New Note.yamlover"))).toBe(true);
    expect(call(h, "/api/json", { path: r.json.path }).json.format).toBe("x-yamlover-chapter");
  });

  it("member dir: a directory-backed chapter in a directory (the default concrete)", async () => {
    const root = dirTree();
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/create", { schema: CHAP, parent: ":dir", concrete: "dir/yamlover", title: "New Dir" });
    expect(r.status).toBe(201);
    expect(fs.existsSync(path.join(root, "dir", "New Dir", ".yamlover", "body.yamlover"))).toBe(true);
    expect(call(h, "/api/json", { path: r.json.path }).json.format).toBe("x-yamlover-chapter");
  });

  it("rejects an unknown schema", async () => {
    const { h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/create", { schema: "::yamlover:$defs:nope", parent: ":doc", concrete: "yamlover" });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/unknown schema/);
  });

  it("rejects creation against a scalar (not a directory or compatible parent)", async () => {
    const root = tmpTree({ name: "Alice" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/create", { schema: CHAP, parent: ":name", concrete: "file/yamlover", title: "X" });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/only inside a directory or a compatible parent/);
  });
});

describe("/api/edit — standalone chapter file", () => {
  it("edits a chunk of a standalone *.yamlover chapter (Cyrillic)", async () => {
    const root = tmpTree({ "статья.yamlover": '!!<*::yamlover:$defs:chapter>\ntitle: "Заголовок"\nchunks:\n- Привет\n' });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const enc = ":" + encodeURIComponent("статья.yamlover") + ":chunks[0]";
    const r = await callBody(h, "POST", "/api/edit", { path: enc, op: "replace", text: "Пока" });
    expect(r.status).toBe(200);
    const src = fs.readFileSync(path.join(root, "статья.yamlover"), "utf8");
    expect(src).toContain("Пока"); // re-emitted losslessly (block scalar) — verify the parsed value
    expect(call(h, "/api/json", { path: enc }).json.value).toBe("Пока");
  });
});
