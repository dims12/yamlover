// FLOW, END TO END: the op the editor emits for `[12, 13, 14]` → a real handler → the bytes on
// disk → re-read → the wire says `yaml/flow` again. Each half is unit-tested elsewhere; this pins
// the seam, which is where a representation concrete would quietly evaporate.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHandlers, tmpTree } from "./helpers";
import { call, callBody } from "./http";

const bodyOf = (root: string, ...segs: string[]): string =>
  fs.readFileSync(path.join(root, ...segs, ".yo", "body.yo"), "utf8");

type Wire = { value: unknown; comments: Record<string, { repr?: string }> };

describe("flow round-trip, end to end", () => {
  it("the editor's op lands verbatim and re-reads as yaml/flow", async () => {
    const root = tmpTree({ "d/.yo/body.yo": "" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    // exactly what the editor emits after typing `[12,13,14]` (yamlover-editor.test.tsx pins it)
    const r = await callBody(h, "POST", "/api/edit", { path: ":d", op: "emplace", yamlover: "[12, 13, 14]" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(bodyOf(root, "d")).toBe("[12, 13, 14]\n"); // byte-for-byte, no block flattening

    const j = call(h, "/api/json", { path: ":d", depth: ".inf" }).json as Wire;
    expect(j.value).toEqual([12, 13, 14]);
    expect(j.comments[""]?.repr).toBe("yaml/flow"); // the style survived the walk + the index
  });

  it("a nested flow map keeps its style at every level", async () => {
    const root = tmpTree({ "d/.yo/body.yo": "" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    expect((await callBody(h, "POST", "/api/edit", { path: ":d", op: "emplace", yamlover: "{a: [1, 2], b: 3}" })).status).toBe(200);
    expect(bodyOf(root, "d")).toBe("{a: [1, 2], b: 3}\n");
    const j = call(h, "/api/json", { path: ":d", depth: ".inf" }).json as Wire;
    expect(j.value).toEqual({ a: [1, 2], b: 3 });
    expect(j.comments[""]?.repr).toBe("yaml/flow");
    expect(j.comments["/a"]?.repr).toBe("yaml/flow"); // per NODE — nested flow needs its own bit
  });

  it("editing ONE cell rewrites the whole line and leaves its neighbours alone", async () => {
    const root = tmpTree({ "d/.yo/body.yo": "before: 1\nk: [1, 2]   # a trailing note\nafter: 2\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    // the whole-token emplace the editor emits for an edit inside a persisted flow container
    const r = await callBody(h, "POST", "/api/edit", { path: ":d:k", op: "emplace", yamlover: "[1, 99]" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const body = bodyOf(root, "d");
    expect(body).toContain("k: [1, 99]");
    expect(body).toContain("before: 1"); // the splice is one line wide
    expect(body).toContain("after: 2");
  });

  it("BLOCK stays block — the style is authored, never inferred", async () => {
    const root = tmpTree({ "d/.yo/body.yo": "k:\n  - 1\n  - 2\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const j = call(h, "/api/json", { path: ":d", depth: ".inf" }).json as Wire;
    expect(j.value).toEqual({ k: [1, 2] });
    expect(j.comments["/k"]?.repr).toBeUndefined(); // block is the default and costs nothing
  });
});
