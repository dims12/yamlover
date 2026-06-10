import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHandlers } from "../src/server/engine-api";
import { tmpTree } from "./helpers";
import { call, callBody } from "./http";

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
    await callBody(h, "POST", "/api/annotate", { target: "/name", tag: TAG, selector: SELECTOR });

    expect((await callBody(h, "POST", "/api/reindex", {})).status).toBe(200);
    const list = call(h, "/api/annotations", { path: "/name" }).json;
    expect(list).toHaveLength(1);
    expect(list[0].tag).toMatchObject({ path: TAG, name: "yellow", color: "#f9e2af" });
  });

  it("applies to the WHOLE node when no selector is given", async () => {
    const root = tmpTree({ name: "Alice", ...TAG_FILE });
    const h = createHandlers(root, { gitignore: false });
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

    const r = await callBody(h, "POST", "/api/annotate", { target: "/name", tag: TAG, selector: SELECTOR });
    expect(r.status).toBe(201);
    expect(r.json.path).toMatch(/^\/notes\/marks\/[^/]+\.yamlover$/);
    expect(fs.existsSync(path.join(root, "notes", "marks", path.basename(r.json.path)))).toBe(true);
    expect(call(h, "/api/annotations", { path: "/name" }).json).toHaveLength(1);
  });

  it("rejects an annotation without a target, without a tag, or with a non-tag tag path", async () => {
    const h = createHandlers(tmpTree({ name: "Alice", ...TAG_FILE }), { gitignore: false });
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
    expect(call(h, "/api/annotations", { path: "/name" }).json).toHaveLength(1); // found from anywhere

    const r = await callBody(h, "DELETE", "/api/annotate", undefined, { path: "/deep/dir/a1.yamlover" });
    expect(r.status).toBe(200);
    expect(fs.existsSync(path.join(root, "deep", "dir", "a1.yamlover"))).toBe(false);
    expect(call(h, "/api/annotations", { path: "/name" }).json).toHaveLength(0);
  });

  it("refuses to delete anything that is not an annotation node", async () => {
    const root = tmpTree({ name: "Alice", "plain.yamlover": "a: 1\n" });
    const h = createHandlers(root, { gitignore: false });

    for (const p of ["/plain.yamlover", "/name", "/../escape.yamlover"]) {
      const r = await callBody(h, "DELETE", "/api/annotate", undefined, { path: p });
      expect(r.status, p).toBe(400);
    }
    expect(fs.existsSync(path.join(root, "plain.yamlover"))).toBe(true);
    expect(fs.existsSync(path.join(root, "name"))).toBe(true);
  });
});

describe("/api/paste", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64");

  it("onto a directory: the file lands in it (no auto-open)", async () => {
    const root = tmpTree({ "dir/keep.txt": "x" });
    const h = createHandlers(root, { gitignore: false });

    const r = await callBody(h, "POST", "/api/paste", { path: "/dir", filename: "note.txt", contentBase64: b64("hello") });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ path: "/dir/note.txt", dir: "/dir", open: false });
    expect(fs.readFileSync(path.join(root, "dir", "note.txt"), "utf8")).toBe("hello");
  });

  it("onto a directory MEMBER: the file lands in the enclosing directory and opens", async () => {
    const root = tmpTree({ "dir/keep.txt": "x" });
    const h = createHandlers(root, { gitignore: false });

    const r = await callBody(h, "POST", "/api/paste", { path: "/dir/keep.txt", filename: "note.txt", contentBase64: b64("hi") });
    expect(r.json).toMatchObject({ path: "/dir/note.txt", dir: "/dir", open: true });
  });

  it("de-duplicates filenames (note.txt → note-1.txt)", async () => {
    const root = tmpTree({ "dir/keep.txt": "x" });
    const h = createHandlers(root, { gitignore: false });
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
    const r = await callBody(h, "POST", "/api/paste", { path: "/", filename: "x.txt", contentBase64: "" });
    expect(r.status).toBe(400);
  });
});
