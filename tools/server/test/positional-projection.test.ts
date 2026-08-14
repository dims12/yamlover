import { describe, it, expect } from "vitest";
import { createHandlers, tmpTree } from "./helpers";
import { call } from "./http";
import { nodeJson } from "./node-json";

// The POSITIONAL PREFIX projection (walk.ts applyBody + node-kind.ts positionalOf): a dir-backed
// node whose `body.yo` is a pointer-array grants positions ONLY to the members it names.
// Named members project as `$yamloverMixed` entries flagged `anchor: true` (the client renders
// `- &key value`, the anchor dimmed); unreferenced children are the KEYED-ONLY remainder — plain
// keyed entries after the prefix, never invented positions.

const TREE_56 = {
  "d/.yo/body.yo": "- *anyfile01\n- *alsoany02\n- *andany03.json\n",
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
  (json.value as { $yamloverMixed?: { kind: string; value?: unknown; entries: MixedEntry[] } }).$yamloverMixed;

describe("/api/json — positional prefix (dir-backed pointer-array body)", () => {
  it("named members carry anchor:true in body order; the unreferenced file is a keyed-only tail", async () => {
    const h = await handlers(TREE_56);
    const json = (await nodeJson(h, { path: ":d", depth: ".inf" })).json;
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
    const json = (await nodeJson(h, { path: ":d", depth: ".inf" })).json;
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
      "d/.yo/body.yo": "- *b\n- 42\n- *missing\n",
      "d/a": "alpha\n",
      "d/b": "beta\n",
    });
    const json = (await nodeJson(h, { path: ":d", depth: ".inf" })).json;
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
    const json = (await nodeJson(h, { path: ":d" })).json;
    expect(json.type).toBe("kseq");
    expect(json.hasOrdinal ?? json.facets?.hasOrdinal).not.toBe(false);
  });
});

// A body's positional flow is the SAME facet whatever else the body carries. A directory whose
// body is a scalar self-value plus a pointer element (`World` / `- *: item01` — what the editor
// writes when a list is nested by typing) consumes the pointer exactly as a pure pointer-array
// body does: the member appears ONCE, anchored at its body position. Before this it appeared
// TWICE — as a plain keyed child AND as an unconsumed `- *: item01` element beside it.
describe("/api/json — a member ordered from an OMNI or MIXED body is consumed too", () => {
  it("a scalar-self-value body consumes its pointer element at every depth", async () => {
    const h = await handlers({
      ".yo/body.yo": "- *: item01\n",
      "item01/.yo/body.yo": "World\n- *: item01\n",
      "item01/item01/.yo/body.yo": "Eurasia\n- Europe\n- Asia\n",
    });
    const m = mixedOf((await nodeJson(h, { path: ":", depth: ".inf" })).json);
    expect(m!.entries).toEqual([
      {
        key: "item01",
        anchor: true,
        value: {
          $yamloverMixed: {
            kind: "omni",
            value: "World",
            entries: [
              {
                key: "item01",
                anchor: true,
                value: { $yamloverMixed: { kind: "omni", value: "Eurasia", entries: [{ key: null, value: "Europe" }, { key: null, value: "Asia" }] } },
              },
            ],
          },
        },
      },
    ]);
  });

  it("a MIXED body keeps keyed fields, the flow's source order, and the anchors together", async () => {
    const h = await handlers({
      "doc/.yo/body.yo": "Title\ndescription: Sub\n- one\n- *: pic.png\n- two\n- *: sub\n",
      "doc/pic.png": "PNG",
      "doc/sub/.yo/body.yo": "Deep\n",
      "doc/unlisted.txt": "x", // never named by the body → keyed remainder, no anchor
    });
    const m = mixedOf((await nodeJson(h, { path: ":doc", depth: "2" })).json);
    expect(m!.kind).toBe("omni");
    expect(m!.value).toBe("Title");
    expect(m!.entries.map((e) => [e.key, e.anchor ?? false])).toEqual([
      ["description", false],
      [null, false], // "one"
      ["pic.png", true],
      [null, false], // "two"
      ["sub", true],
      ["unlisted.txt", false], // trails the body's own order, in filesystem order
    ]);
  });
});
