import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHandlers } from "../src/server/engine-api";
import { tmpTree } from "./helpers";
import { call, callBody } from "./http";

// The WRITE endpoints (/api/annotate, /api/paste), against synthetic temp trees — never the
// repo. Fixtures are minimal and explicit, so they cannot break when examples/ evolves.

const SELECTOR = { type: "text", exact: "Alice" };

describe("/api/annotate (create)", () => {
  it("creates the annotation file under the default location and reverse-links the material", async () => {
    const root = tmpTree({ name: "Alice" });
    const h = createHandlers(root, { gitignore: false });

    const r = await callBody(h, "POST", "/api/annotate", { target: "/name", selector: SELECTOR });
    expect(r.status).toBe(201);
    expect(r.json.path).toMatch(/^\/annotations\/[^/]+\.yamlover$/);
    expect(fs.existsSync(path.join(root, r.json.path.slice(1)))).toBe(true);

    // the material lists it (the incoming `target` edge), with the selector intact
    const list = call(h, "/api/annotations", { path: "/name" }).json;
    expect(list).toHaveLength(1);
    expect(list[0].path).toBe(r.json.path);
    expect(list[0].selector.exact).toBe("Alice");
  });

  it("honors the settings.yamlover annotation location", async () => {
    const root = tmpTree({
      name: "Alice",
      ".yamlover/settings.yamlover": "annotations:\n  location: /notes/marks\n",
    });
    const h = createHandlers(root, { gitignore: false });

    const r = await callBody(h, "POST", "/api/annotate", { target: "/name", selector: SELECTOR });
    expect(r.status).toBe(201);
    expect(r.json.path).toMatch(/^\/notes\/marks\/[^/]+\.yamlover$/);
    expect(fs.existsSync(path.join(root, "notes", "marks", path.basename(r.json.path)))).toBe(true);
    expect(call(h, "/api/annotations", { path: "/name" }).json).toHaveLength(1);
  });

  it("rejects an annotation without a target or selector", async () => {
    const h = createHandlers(tmpTree({ name: "Alice" }), { gitignore: false });
    const r = await callBody(h, "POST", "/api/annotate", { target: "/name" });
    expect(r.status).toBe(400);
    expect(r.json.error).toBeTruthy();
  });
});

describe("/api/annotate (delete)", () => {
  it("deletes a created annotation (file + index rows)", async () => {
    const root = tmpTree({ name: "Alice" });
    const h = createHandlers(root, { gitignore: false });
    const created = await callBody(h, "POST", "/api/annotate", { target: "/name", selector: SELECTOR });

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
