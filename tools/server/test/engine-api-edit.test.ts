import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHandlers } from "../src/server/engine-api";
import { tmpTree } from "./helpers";
import { call, callBody } from "./http";

// The WRITE endpoint /api/edit — the unlocked WYSIWYG editor's surgical edits of a chapter's
// `.yamlover` source (set title/description, replace/insert/remove a prose chunk), against
// synthetic temp trees (never the repo's own examples/).
//
// A chapter is an OMNI node (CHAPTER.md): title/description (keyed) + a POSITIONAL body of chunk /
// subchapter items. An edit addresses a body element by its RANK among the positional items
// (`<chapter>[rank]`); a subchapter DESCENT uses absolute store indices (matching the node path).
// So the edit path `:doc[0]` (rank 0) reads back at its store path `:doc[2]` (title/description
// consume store indices 0/1 but not body ranks).

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
  it("sets a chapter title (replacing the existing line)", async () => {
    const { root, h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc:title", op: "set", text: "New Title" });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toContain('title: "New Title"');
    expect(call(h, "/api/json", { path: ":doc" }).json.title).toBe("New Title");
  });

  it("adds a description when the chapter has none", async () => {
    const { root, h } = await chapterHandlers({
      "doc/.yamlover/body.yamlover": "!!<*yamlover/$defs/chapter>\ntitle: T\n- Hello\n",
    });
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc:description", op: "set", text: "A subtitle" });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toContain('description: "A subtitle"');
    expect(call(h, "/api/json", { path: ":doc" }).json.description).toBe("A subtitle");
  });

  it("edits a subchapter title (descend to the subchapter at [4])", async () => {
    const { root, h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[4]:title", op: "set", text: "Renamed" });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toContain('title: "Renamed"');
    expect(call(h, "/api/json", { path: ":doc[4]", depth: "3" }).json.title).toBe("Renamed");
  });
});

describe("/api/edit — chunks", () => {
  it("replaces an inline chunk with new prose", async () => {
    const { h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[0]", op: "replace", text: "Goodbye **world**" });
    expect(r.status).toBe(200);
    expect(body(call(h, "/api/json", { path: ":doc", depth: "3" }).json)[0]).toBe("Goodbye **world**");
    // the block chunk (rank 1) is untouched
    expect(body(call(h, "/api/json", { path: ":doc", depth: "3" }).json)[1]).toBe("first line\nsecond line\n");
  });

  it("replaces a multi-line block-scalar chunk whole", async () => {
    const { h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[1]", op: "replace", text: "one\ntwo\nthree" });
    expect(r.status).toBe(200);
    const b = body(call(h, "/api/json", { path: ":doc", depth: "3" }).json);
    expect(b[0]).toBe("Hello");
    expect(b[1]).toBe("one\ntwo\nthree");
  });

  it("inserts a new chunk at the given body rank", async () => {
    const { h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc", op: "insert", index: 1, text: "inserted" });
    expect(r.status).toBe(200);
    const b = body(call(h, "/api/json", { path: ":doc", depth: "3" }).json);
    expect(b.slice(0, 3)).toEqual(["Hello", "inserted", "first line\nsecond line\n"]);
  });

  it("prepends a chunk (rank 0) and appends (rank past the end)", async () => {
    const { h } = await chapterHandlers();
    await callBody(h, "POST", "/api/edit", { path: ":doc", op: "insert", index: 0, text: "top" });
    await callBody(h, "POST", "/api/edit", { path: ":doc", op: "insert", index: 99, text: "bottom" });
    const b = body(call(h, "/api/json", { path: ":doc", depth: "3" }).json);
    // "bottom" lands after the last positional item (the subchapter), so it is the final body element
    expect(b[0]).toBe("top");
    expect(b[1]).toBe("Hello");
    expect(b[b.length - 1]).toBe("bottom");
  });

  it("removes a chunk", async () => {
    const { h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[0]", op: "remove" });
    expect(r.status).toBe(200);
    const b = body(call(h, "/api/json", { path: ":doc", depth: "3" }).json);
    expect(b[0]).toBe("first line\nsecond line\n");
  });

  it("edits a chunk inside a subchapter (descend [4], body rank 0)", async () => {
    const { h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[4][0]", op: "replace", text: "Deep edit" });
    expect(r.status).toBe(200);
    expect(body(call(h, "/api/json", { path: ":doc[4]", depth: "3" }).json)[0]).toBe("Deep edit");
  });
});

describe("/api/edit — batch", () => {
  it("applies a batch of ops in order in one call (a split: replace head + insert tail)", async () => {
    const { h } = await chapterHandlers();
    // simulate splitting chunk 0 "Hello" at a caret → head "Hel", tail "lo"
    const r = await callBody(h, "POST", "/api/edit", {
      edits: [
        { path: ":doc[0]", op: "replace", text: "Hel" },
        { path: ":doc", op: "insert", index: 1, text: "lo" },
      ],
    });
    expect(r.status).toBe(200);
    const b = body(call(h, "/api/json", { path: ":doc", depth: "3" }).json);
    // the head is truncated AND the tail is a new chunk — the v1 bug (head un-truncated) is gone
    expect(b.slice(0, 3)).toEqual(["Hel", "lo", "first line\nsecond line\n"]);
  });

  it("batches a title set + a chunk replace + a remove together", async () => {
    const { root, h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", {
      edits: [
        { path: ":doc:title", op: "set", text: "Batched" },
        { path: ":doc[0]", op: "replace", text: "H2" },
        { path: ":doc[1]", op: "remove" },
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
        { path: ":a[0]", op: "replace", text: "one!" },
        { path: ":b:title", op: "set", text: "B2" },
      ],
    });
    expect(r.status).toBe(200);
    expect(body(call(h, "/api/json", { path: ":a", depth: "3" }).json)[0]).toBe("one!");
    expect(call(h, "/api/json", { path: ":b" }).json.title).toBe("B2");
  });
});

describe("/api/edit — guards & formats", () => {
  it("preserves an inline schema tag on a markdown chunk", async () => {
    const { root, h } = await chapterHandlers({
      "doc/.yamlover/body.yamlover": "!!<*yamlover/$defs/chapter>\ntitle: T\n- !!<format: text/markdown> |\n  # Head\n",
    });
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[0]", op: "replace", text: "# New Head\n\nbody" });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toContain("!!<format: text/markdown>");
    expect(call(h, "/api/json", { path: ":doc[1]" }).json.format).toBe("text/markdown");
  });

  it("edits a LaTeX chunk (keeps its inline schema tag)", async () => {
    const { root, h } = await chapterHandlers({
      "doc/.yamlover/body.yamlover": "!!<*yamlover/$defs/chapter>\ntitle: T\n- !!<format: text/x-latex> |\n  e^{i\\pi}\n",
    });
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[0]", op: "replace", text: "\\sqrt{2}" });
    expect(r.status).toBe(200);
    expect(bodyOf(root)).toContain("!!<format: text/x-latex>");
    expect(call(h, "/api/json", { path: ":doc[1]" }).json.format).toBe("text/x-latex");
    expect(body(call(h, "/api/json", { path: ":doc", depth: "3" }).json)[0]).toBe("\\sqrt{2}");
  });

  it("still rejects editing a non-text (image/pointer) chunk", async () => {
    const { h } = await chapterHandlers({
      "doc/pic.png": "PNG",
      "doc/.yamlover/body.yamlover": '!!<*yamlover/$defs/chapter>\ntitle: T\n- !!<format: image/png> "x"\n',
    });
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[0]", op: "replace", text: "hi" });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/non-text/);
  });

  it("rejects editing a file/pointer chunk as text", async () => {
    const { h } = await chapterHandlers({
      "doc/pic.png": "PNG",
      "doc/.yamlover/body.yamlover": "!!<*yamlover/$defs/chapter>\ntitle: T\n- */pic.png\n",
    });
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc[0]", op: "replace", text: "hi" });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/pointer/);
  });

  it("rejects an unsupported edit target", async () => {
    const { h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/edit", { path: ":doc", op: "set", text: "x" });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/title\/description/);
  });
});

describe("/api/create — objects of a schema", () => {
  const CHAP = "::yamlover:$defs:chapter";
  const dirTree = () => tmpTree({ "dir/keep.txt": "x", ...DEFS });

  it("child inline: appends a subchapter (one empty chunk) to a chapter's body", async () => {
    const { root, h } = await chapterHandlers();
    const r = await callBody(h, "POST", "/api/create", { schema: CHAP, parent: ":doc", concrete: "yamlover", title: "Fresh" });
    expect(r.status).toBe(201);
    expect(r.json.path).toBe(":doc[5]"); // appended after title(0)/description(1)/Hello(2)/block(3)/Sub(4)
    expect(bodyOf(root)).toContain('title: "Fresh"');
    const node = call(h, "/api/json", { path: ":doc[5]", depth: "3" });
    expect(node.json.format).toBe("x-yamlover-chapter");
    expect(body(node.json)).toEqual([""]); // one empty, immediately-editable chunk
  });

  it("child linked file: writes a .yamlover doc beside the parent + a pointer in the body", async () => {
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
    const root = tmpTree({ "статья.yamlover": '!!<*::yamlover:$defs:chapter>\ntitle: "Заголовок"\n- Привет\n' });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const edit = ":" + encodeURIComponent("статья.yamlover") + "[0]"; // body rank 0
    const r = await callBody(h, "POST", "/api/edit", { path: edit, op: "replace", text: "Пока" });
    expect(r.status).toBe(200);
    const src = fs.readFileSync(path.join(root, "статья.yamlover"), "utf8");
    expect(src).toContain("Пока"); // re-emitted losslessly (block scalar) — verify the parsed value
    const read = ":" + encodeURIComponent("статья.yamlover") + "[1]"; // store index 1 (title is 0)
    expect(call(h, "/api/json", { path: read }).json.value).toBe("Пока");
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
});
