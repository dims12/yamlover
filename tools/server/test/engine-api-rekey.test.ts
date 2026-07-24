import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHandlers, tmpTree } from "./helpers";
import { call, callBody } from "./http";

// /api/rekey — rename a key. One verb, two backends routed by the node's STORAGE: an fs-backed
// member (a real directory named by the key) is renamed on disk via `mv`; an INLINE keyed entry
// has its key token rewritten in the enclosing body. (YAMLOVER_EDITOR.yamlover: the concrete is
// not a state — the editor asks to rename, the server routes.)

const bodyAt = (root: string, ...segs: string[]) =>
  fs.readFileSync(path.join(root, ...segs, ".yamlover", "body.yamlover"), "utf8");
const edit = (h: unknown, body: Record<string, unknown>) => callBody(h as never, "POST", "/api/edit", body);
const rekey = (h: unknown, p: string, key: string) => callBody(h as never, "POST", "/api/rekey", { path: p, key });
const leaf = (h: unknown, p: string) => {
  const v = (call(h as never, "/api/json", { path: p }).json as { value: unknown }).value;
  const m = (v as { $yamloverMixed?: { value: unknown } })?.$yamloverMixed;
  return m ? m.value : v;
};

/** The world→eurasia→(europe,asia) tree: world & eurasia are directories, europe/asia inline. */
async function tree() {
  const root = tmpTree({ ".yamlover/settings.yamlover": "" });
  const h = createHandlers(root, { gitignore: false });
  await h.ready;
  await edit(h, { path: ":", op: "insert", key: "world", yamlover: "World" });
  await edit(h, { path: ":world", op: "emplace", yamlover: "World\neurasia: Eurasia" });
  await edit(h, { path: ":world:eurasia", op: "emplace", yamlover: "Eurasia\neurope: Europe\nasia: Asia" });
  return { root, h };
}

describe("/api/rekey", () => {
  it("renames an INLINE keyed entry — the key token is rewritten, the value kept", async () => {
    const { root, h } = await tree();
    const r = await rekey(h, ":world:eurasia:europe", "capital");
    expect(r.status).toBe(200);
    expect(bodyAt(root, "world", "eurasia")).toContain("capital: Europe");
    expect(bodyAt(root, "world", "eurasia")).not.toContain("europe:");
    expect(leaf(h, ":world:eurasia:capital")).toBe("Europe");
    expect(leaf(h, ":world:eurasia:asia")).toBe("Asia"); // the sibling is untouched
  });

  it("renames a DIRECTORY-backed member — the directory is moved on disk", async () => {
    const { root, h } = await tree();
    const r = await rekey(h, ":world:eurasia", "afroeurasia");
    expect(r.status).toBe(200);
    expect(fs.existsSync(path.join(root, "world", "afroeurasia"))).toBe(true);
    expect(fs.existsSync(path.join(root, "world", "eurasia"))).toBe(false);
    expect(leaf(h, ":world:afroeurasia")).toBe("Eurasia");
    expect(leaf(h, ":world:afroeurasia:europe")).toBe("Europe"); // children moved with it
  });

  it("renames a top-level directory member", async () => {
    const { root, h } = await tree();
    const r = await rekey(h, ":world", "earth");
    expect(r.status).toBe(200);
    expect(fs.existsSync(path.join(root, "earth"))).toBe(true);
    expect(fs.existsSync(path.join(root, "world"))).toBe(false);
    expect(leaf(h, ":earth:eurasia:asia")).toBe("Asia");
  });

  it("rejects a duplicate key", async () => {
    const { h } = await tree();
    const r = await rekey(h, ":world:eurasia:europe", "asia"); // asia already exists
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/already exists/);
  });

  it("rejects an empty or padded key", async () => {
    const { h } = await tree();
    expect((await rekey(h, ":world:eurasia:europe", "")).status).toBe(400);
    expect((await rekey(h, ":world:eurasia:europe", " x ")).status).toBe(400);
  });
});
