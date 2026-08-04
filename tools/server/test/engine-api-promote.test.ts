import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHandlers, tmpTree } from "./helpers";
import { call, callBody } from "./http";
import { nodeJson } from "./node-json";

// THE SCALAR→CONTAINER PROMOTION (CONCRETES.md §Member encoding; concrete-rules.ts
// subchapterMaterializes). Building a keyed tree "by one" against a DIRECTORY-backed root: each
// node is born a scalar (a title), then grows children. The moment an inline keyed node in a
// dir-backed body gains its first CONTAINER content it must LIFT OUT into its own subdirectory — so
// birth order stops mattering and `world: World`-then-grow lands in the same shape as a `world`
// born already populated (the ex-66 layout). Reproduces the EmptyYamlover bug: everything landing
// in one file because the scalar was entered first.

const bodyAt = (root: string, ...segs: string[]) =>
  fs.readFileSync(path.join(root, ...segs, ".yo", "body.yo"), "utf8");
const hasBody = (root: string, ...segs: string[]) =>
  fs.existsSync(path.join(root, ...segs, ".yo", "body.yo"));
const edit = (h: unknown, body: Record<string, unknown>) => callBody(h as never, "POST", "/api/edit", body);
const leaf = async (h: unknown, p: string) => {
  const v = ((await nodeJson(h as never, { path: p })).json as { value: unknown }).value;
  const m = (v as { $yamloverMixed?: { value: unknown } })?.$yamloverMixed;
  return m ? m.value : v; // an omni node wraps its self-value under $yamloverMixed
};

describe("scalar-first, grow-by-one → directories (the EmptyYamlover shape)", () => {
  it("EMPLACE (the real omni first-child commit) promotes a titled scalar to its own directory", async () => {
    const root = tmpTree({ ".yo/settings.yo": "" }); // a bare dir-backed root
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    // 1. create `world: World` — born a scalar → lands INLINE in the root body
    expect((await edit(h, { path: ":", op: "insert", key: "world", yamlover: "World" })).status).toBe(200);
    expect(bodyAt(root)).toContain("world: World");
    expect(hasBody(root, "world")).toBe(false); // still inline, no directory yet

    // 2. the omni first-child commit: the client re-emplaces the WHOLE node (self + child). This is
    //    the scalar→container transition — world lifts out into its own directory.
    expect((await edit(h, { path: ":world", op: "emplace", yamlover: "World\neurasia: Eurasia" })).status).toBe(200);
    expect(hasBody(root, "world")).toBe(true); // world is now its own directory
    expect(bodyAt(root, "world")).toContain("World"); // its title survived the move
    expect(bodyAt(root, "world")).toContain("eurasia: Eurasia"); // a scalar leaf stays inline
    expect(bodyAt(root)).not.toContain("world"); // the old inline line is gone from the root body

    // 3. eurasia grows in turn — recursion: it becomes its own nested directory
    expect((await edit(h, { path: ":world:eurasia", op: "emplace", yamlover: "Eurasia\neurope: Europe\nasia: Asia" })).status).toBe(200);
    expect(hasBody(root, "world", "eurasia")).toBe(true);
    expect(bodyAt(root, "world")).not.toContain("eurasia: Eurasia"); // moved out of world's body
    expect(bodyAt(root, "world", "eurasia")).toContain("europe: Europe");

    // the root, whose body is now EMPTY (world moved out), must NOT read as a spurious null-valued
    // omni — an empty body.yo is an empty overlay, not a self-value (walk.ts applyBody)
    const rootJson = (await nodeJson(h as never, { path: ":" })).json as { type: string; value: unknown };
    expect(rootJson.type).toBe("object"); // a plain mapping, not "variant" (omni)
    expect((rootJson.value as { $yamloverMixed?: { value: unknown } }).$yamloverMixed?.value).toBeUndefined();

    // the whole tree reads back correctly through the resolver (leaves by direct path)
    expect(await leaf(h, ":world")).toBe("World");
    expect(await leaf(h, ":world:eurasia")).toBe("Eurasia");
    expect(await leaf(h, ":world:eurasia:europe")).toBe("Europe");
    expect(await leaf(h, ":world:eurasia:asia")).toBe("Asia");
  });

  it("INSERT (a child under a still-scalar member) promotes the same way", async () => {
    const root = tmpTree({ ".yo/settings.yo": "" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    await edit(h, { path: ":", op: "insert", key: "world", yamlover: "World" });
    // add `eurasia` under `world` directly — the scalar's self-value is read from the body and kept
    expect((await edit(h, { path: ":world", op: "insert", key: "eurasia", yamlover: "Eurasia" })).status).toBe(200);
    expect(hasBody(root, "world")).toBe(true);
    expect(bodyAt(root, "world")).toContain("World");
    expect(bodyAt(root, "world")).toContain("eurasia: Eurasia");
    expect(await leaf(h, ":world")).toBe("World");
    expect(await leaf(h, ":world:eurasia")).toBe("Eurasia");
  });

  it("stays INLINE when the enclosing document is a FILE (inline storage family)", async () => {
    // a file-backed document keeps its interior inline — no promotion, the pre-existing behavior
    const root = tmpTree({ "doc.yo": "world: World\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    expect((await edit(h, { path: ":doc.yo:world", op: "emplace", yamlover: "World\neurasia: Eurasia" })).status).toBe(200);
    expect(fs.existsSync(path.join(root, "world"))).toBe(false); // no directory materialized
    expect(fs.readFileSync(path.join(root, "doc.yo"), "utf8")).toContain("eurasia: Eurasia");
  });
});
