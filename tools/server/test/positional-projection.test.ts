import { describe, it, expect } from "vitest";
import { createHandlers, tmpTree } from "./helpers";
import { call } from "./http";

// The POSITIONAL PREFIX projection (walk.ts applyBody + node-kind.ts positionalOf): a dir-backed
// node whose `body.yamlover` is a pointer-array grants positions ONLY to the members it names.
// Named members project as `$yamloverMixed` entries flagged `anchor: true` (the client renders
// `- &key value`, the anchor dimmed); unreferenced children are the KEYED-ONLY remainder — plain
// keyed entries after the prefix, never invented positions.

const TREE_56 = {
  "d/.yamlover/body.yamlover": "- *anyfile01\n- *alsoany02\n- *andany03.json\n",
  "d/anyfile01": "Alice\n",
  "d/alsoany02": "42\n",
  "d/andany03.json": "true\n",
  "d/andany04.json": '"string"\n', // on disk, NOT in the body — keyed-only
};

async function handlers(tree: Record<string, string>) {
  const root = tmpTree(tree);
  const h = createHandlers(root, { gitignore: false });
  await h.ready;
  return h;
}

type MixedEntry = { key: string | null; value: unknown; anchor?: boolean };
const mixedOf = (json: { value: unknown }) =>
  (json.value as { $yamloverMixed?: { kind: string; entries: MixedEntry[] } }).$yamloverMixed;

describe("/api/json — positional prefix (dir-backed pointer-array body)", () => {
  it("named members carry anchor:true in body order; the unreferenced file is a keyed-only tail", async () => {
    const h = await handlers(TREE_56);
    const json = call(h, "/api/json", { path: ":d", depth: ".inf" }).json;
    const m = mixedOf(json);
    expect(m).toBeTruthy();
    expect(m!.kind).toBe("mix"); // prefix + keyed remainder = an honest mix
    expect(m!.entries).toEqual([
      { key: "anyfile01", value: "Alice", anchor: true },
      { key: "alsoany02", value: 42, anchor: true },
      { key: "andany03.json", value: true, anchor: true },
      { key: "andany04.json", value: "string" }, // no anchor — never granted a position
    ]);
  });

  it("a FULLY referenced dir still projects as an array kind, each member anchored", async () => {
    const { "d/andany04.json": _omit, ...referencedOnly } = TREE_56;
    const h = await handlers(referencedOnly);
    const json = call(h, "/api/json", { path: ":d", depth: ".inf" }).json;
    const m = mixedOf(json);
    expect(m).toBeTruthy();
    expect(m!.kind).toBe("array");
    expect(m!.entries).toEqual([
      { key: "anyfile01", value: "Alice", anchor: true },
      { key: "alsoany02", value: 42, anchor: true },
      { key: "andany03.json", value: true, anchor: true },
    ]);
  });

  it("inline elements and dangling pointers keep their positions without anchors", async () => {
    const h = await handlers({
      "d/.yamlover/body.yamlover": "- *b\n- 42\n- *missing\n",
      "d/a": "alpha\n",
      "d/b": "beta\n",
    });
    const json = call(h, "/api/json", { path: ":d", depth: ".inf" }).json;
    const m = mixedOf(json);
    expect(m).toBeTruthy();
    expect(m!.kind).toBe("mix");
    const [b, inline, dangling, a] = m!.entries;
    expect(b).toEqual({ key: "b", value: "beta", anchor: true });
    expect(inline).toEqual({ key: null, value: 42 }); // inline element — no key, no anchor
    expect(dangling.key).toBeNull(); // the dangling `*missing` stays a positional ref marker
    expect(a).toEqual({ key: "a", value: "alpha" }); // unreferenced → keyed-only
  });

  it("facets report the prefix as ordinal and only the remainder as keyed", async () => {
    const h = await handlers(TREE_56);
    const json = call(h, "/api/json", { path: ":d" }).json;
    expect(json.type).toBe("mixed");
    expect(json.hasOrdinal ?? json.facets?.hasOrdinal).not.toBe(false);
  });
});
