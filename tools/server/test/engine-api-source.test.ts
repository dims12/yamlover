// GET /api/source (the yed editor's LOAD) and the root-emplace WHOLE-BODY branch (its FLUSH).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHandlers, tmpTree } from "./helpers";
import { call, callBody } from "./http";

describe("GET /api/source", () => {
  it("a document root answers the RAW body; a deeper node the re-serialized subtree", async () => {
    const root = tmpTree({ "note.yamlover": "a: 1\nb:\n  c: 2\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    expect(call(h, "/api/source", { path: ":note.yamlover" }).json).toEqual({ source: "a: 1\nb:\n  c: 2\n" });
    expect(call(h, "/api/source", { path: ":note.yamlover:b" }).json).toEqual({ source: "c: 2\n" });
    const bad = call(h, "/api/source", { path: ":note.yamlover:zzz" });
    expect(bad.status).toBe(404);
    expect(String((bad.json as { error?: string }).error)).toContain("zzz");
  });
});

describe("root emplace with ENTRY facets — the whole-body flush", () => {
  it("replaces the body; the leading comments stand; the payload is validated first", async () => {
    const root = tmpTree({ "doc.yamlover": "# the lead comment\nold: 1\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const file = path.join(root, "doc.yamlover");
    const ok = await callBody(h, "POST", "/api/edit", { path: ":doc.yamlover", op: "emplace", yamlover: "x: 1\ny: 2" });
    expect(ok.status).toBe(200);
    expect(fs.readFileSync(file, "utf8")).toBe("# the lead comment\nx: 1\ny: 2\n");
    const bad = await callBody(h, "POST", "/api/edit", { path: ":doc.yamlover", op: "emplace", yamlover: "x: [unclosed" });
    expect(bad.status).toBe(400);
    expect(fs.readFileSync(file, "utf8")).toBe("# the lead comment\nx: 1\ny: 2\n"); // untouched
  });
});
