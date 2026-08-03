// yed-load — NodeJson (the /api/json projection) → parser IR: the conversion that makes the yed
// mount CONCRETE-AGNOSTIC. Pure; the fixtures mirror the wire shapes the server emits.
import { describe, it, expect } from "vitest";
import { irFromNodeJson } from "../src/client/renderers/yed-load";
import type { NodeJson } from "../src/client/api";
import { sourceOf, type Node } from "../../yed/src/state";
import { isPointer } from "../../parser/ts/src/ir.ts";

const nj = (value: unknown, comments?: NodeJson["comments"], extra?: Partial<NodeJson>): NodeJson =>
  ({ path: ":doc", type: "object", concrete: "file/yamlover", title: null, description: null, value, comments, ...extra }) as NodeJson;

describe("irFromNodeJson", () => {
  it("the worked OMNI fixture — self value, entries, the canonical pointer text", () => {
    const doc = irFromNodeJson(nj(
      { $yamloverMixed: { kind: "omni", value: "A Title", selfAt: 0, entries: [
        { key: "description", value: "the blurb" },
        { key: null, value: "chunk one" },
        { key: null, value: { $yamloverRef: { text: "*:pets:1", path: ":pets:1" } } },
      ] } },
      { "": { tag: "!!<*yamlover: $defs: chapter>" }, "/2": { pointer: ":pets:1" } },
    ));
    const root = doc.root as Node & { value?: unknown };
    expect(root.kind).toBe("scalar");
    expect(root.value).toBe("A Title");
    expect((root.entries ?? []).length).toBe(3);
    expect(root.entries![0].key).toBe("description");
    expect(root.entries![1].key).toBeNull();
    const ptr = root.entries![2].value;
    expect(isPointer(ptr)).toBe(true);
    expect((ptr as { raw?: string }).raw).toBe(":pets:1"); // the sidecar's canonical spelling wins
    // the serializer spells pointers in the CANONICAL spaced colon form — and the authored
    // `!!<…>` tag (bucket.tag → meta.schema) is re-emitted, no longer dropped on re-serialize
    expect(sourceOf(doc)).toBe("!!<*yamlover: $defs: chapter>\nA Title\ndescription: the blurb\n- chunk one\n- *: pets: 1\n");
  });

  it("authored raw SPELLINGS survive; absent raw spells the default", () => {
    const doc = irFromNodeJson(nj({ a: 255, b: 255 }, { "/a": { raw: "0xff" } }));
    expect(sourceOf(doc)).toBe("a: 0xff\nb: 255\n");
  });

  it("flow and K&R layout meta land at the node that carries them", () => {
    const doc = irFromNodeJson(nj({ f: [1, 2], k: [3] }, { "/f": { repr: "yaml/flow" }, "/k": { concrete: "json5p" } }));
    const src = sourceOf(doc);
    expect(src).toContain("f: [1, 2]");
    expect(src).toContain("k: [\n");
  });

  it("non-finite numbers spell their literals", () => {
    const doc = irFromNodeJson(nj({ a: { $yamloverNum: "Infinity" }, b: { $yamloverNum: "NaN" } }));
    expect(sourceOf(doc)).toBe("a: .inf\nb: .nan\n");
  });

  it("the EMPTY document is an empty container, not a null scalar", () => {
    const doc = irFromNodeJson(nj(null));
    expect((doc.root as Node).kind).toBe("mapping");
    expect(sourceOf(doc)).toBe("");
  });

  it("a top-level BINARY node is a blob, not a 2-key data object", () => {
    const doc = irFromNodeJson(nj({ size: 123, format: "image/png" }, undefined, { valueType: "binary" }));
    expect((doc.root as Node).kind).toBe("blob");
  });

  it("a nested blob link is an opaque atom node", () => {
    const doc = irFromNodeJson(nj({ img: { $yamloverLink: { kind: "binary", path: ":d:img", size: 9 } } }));
    expect(((doc.root as Node).entries![0].value as Node).kind).toBe("blob");
  });

  it("an ANCHORED positional member stays keyless with the wire key on the entry meta", () => {
    const doc = irFromNodeJson(nj({ $yamloverMixed: { kind: "mix", entries: [
      { key: "item01", value: "one", anchor: true },
      { key: "named", value: 2 },
    ] } }));
    const e = (doc.root as Node).entries!;
    expect(e[0].key).toBeNull();
    expect((e[0].meta as { anchorKey?: string }).anchorKey).toBe("item01");
    expect(e[1].key).toBe("named");
  });
});

describe("irFromNodeJson — format facts (the chapter projection's inputs)", () => {
  const metaOf = (v: unknown): Record<string, unknown> => ((v as Node).meta ?? {}) as Record<string, unknown>;

  it("a `$defs` tag lands as meta.schema (a parsed Pointer) + the folded derivedFormat", () => {
    const doc = irFromNodeJson(nj(
      { $yamloverMixed: { kind: "omni", value: "T", entries: [{ key: null, value: "p" }] } },
      { "": { tag: "!!<*yamlover: $defs: chapter>" } },
    ));
    const meta = metaOf(doc.root);
    expect(isPointer(meta.schema as Parameters<typeof isPointer>[0])).toBe(true);
    expect(meta.derivedFormat).toBe("x-yamlover-chapter");
  });

  it("the wire's stamped format WINS over the tag-folded one", () => {
    const doc = irFromNodeJson(nj(
      { $yamloverMixed: { kind: "omni", value: "T", format: "x-yamlover-task", entries: [] } },
      { "": { tag: "!!<*yamlover: $defs: chapter>" } },
    ));
    expect(metaOf(doc.root).derivedFormat).toBe("x-yamlover-task");
  });

  it("an inline `format:` tag stamps the PROSE format (the latex chunk)", () => {
    const doc = irFromNodeJson(nj({ $yamloverMixed: { kind: "mix", entries: [
      { key: null, value: "E = mc^2" },
    ] } }, { "/0": { tag: "!!<format: text/x-latex>" } }));
    const chunk = (doc.root as Node).entries![0].value;
    expect(metaOf(chunk).derivedFormat).toBe("text/x-latex");
    expect((metaOf(chunk).schema as Node).kind).toBe("mapping"); // the inline schema literal
  });

  it("the mount root's NodeJson.format stamps derivedFormat (it already folded everything)", () => {
    const doc = irFromNodeJson(nj({ a: 1 }, undefined, { format: "x-yamlover-chapter" }));
    expect(metaOf(doc.root).derivedFormat).toBe("x-yamlover-chapter");
  });

  it("a `$yamloverLink` atom keeps its navigable payload and its target's format", () => {
    const doc = irFromNodeJson(nj({ $yamloverMixed: { kind: "mix", entries: [
      { key: "01-child", value: { $yamloverLink: { kind: "object", path: ":doc:01-child", title: "Child", format: "x-yamlover-chapter" } }, anchor: true },
    ] } }));
    const atom = (doc.root as Node).entries![0].value as Node;
    expect(atom.kind).toBe("blob");
    expect(metaOf(atom).link).toEqual({ path: ":doc:01-child", title: "Child", format: "x-yamlover-chapter" });
    expect(metaOf(atom).derivedFormat).toBe("x-yamlover-chapter");
  });

  it("format facts are INERT to the diff: loaded → loaded is zero ops", async () => {
    const { diffToOps } = await import("../src/client/renderers/yed-sync");
    const wire = nj(
      { $yamloverMixed: { kind: "omni", value: "T", format: "x-yamlover-chapter", entries: [
        { key: "description", value: "d" },
        { key: null, value: "p1" },
      ] } },
      { "": { tag: "!!<*yamlover: $defs: chapter>" }, "/1": { tag: "!!<format: text/x-latex>" } },
    );
    const a = irFromNodeJson(wire);
    const b = irFromNodeJson(wire);
    const r = diffToOps(":doc", a, b);
    expect(r.ops).toEqual([]);
    expect(r.renames).toEqual([]);
  });

  it("a value RETYPE beside a tag emits only the value op — never a meta op", async () => {
    const { diffToOps } = await import("../src/client/renderers/yed-sync");
    const wire = nj(
      { $yamloverMixed: { kind: "omni", value: "T", entries: [{ key: null, value: "p1" }] } },
      { "": { tag: "!!<*yamlover: $defs: chapter>" } },
    );
    const a = irFromNodeJson(wire);
    const b = irFromNodeJson(wire);
    ((doc => (doc.root as Node).entries![0].value as Node & { value?: unknown })(b)).value = "p2";
    const r = diffToOps(":doc", a, b);
    expect(r.ops).toEqual([{ path: ":doc:0", op: "emplace", yamlover: "p2" }]);
  });
});

describe("irFromNodeJson — identity marks (!!set, & anchors) ride the IR", () => {
  const metaOf = (v: unknown): Record<string, unknown> => ((v as Node).meta ?? {}) as Record<string, unknown>;

  it("a `!!set` beside the tag loads meta.set", () => {
    const doc = irFromNodeJson(nj({ $yamloverMixed: { kind: "mix", entries: [{ key: null, value: "x" }] } },
      { "": { tag: "!!<*yamlover: $defs: chapter> !!set" } }));
    expect(metaOf(doc.root).set).toBe(true);
    expect(metaOf(doc.root).schema).toBeDefined();
  });

  it("a standalone `!!set` loads too", () => {
    const doc = irFromNodeJson(nj({ $yamloverMixed: { kind: "mix", entries: [{ key: null, value: "x" }] } },
      { "": { tag: "!!set" } }));
    expect(metaOf(doc.root).set).toBe(true);
  });

  it("sidecar anchor BODIES load as parsed meta.anchors, round-tripping through the serializer", () => {
    const doc = irFromNodeJson(nj({ a: 1 }, { "/a": { anchors: [": p: q"] } }));
    const a = metaOf((doc.root as Node).entries![0].value).anchors as unknown[];
    expect(a).toHaveLength(1);
    // the serializer re-emits the anchor line from the parsed form
    const src = sourceOf(doc);
    expect(src).toContain("&: p: q");
  });

  it("an unparseable anchor body loads as NOTHING — never a throw", () => {
    const doc = irFromNodeJson(nj({ a: 1 }, { "/a": { anchors: ["§not a pointer§"] } }));
    expect(metaOf((doc.root as Node).entries![0].value).anchors).toBeUndefined();
  });
});

describe("irFromNodeJson — COMMENTS and blank lines carried for display", () => {
  it("buckets land in the parser-IR shapes: entry leading/trailing, blankBefore, tail, $head/$tail", () => {
    const doc = irFromNodeJson(nj(
      { a: 1, b: 2 },
      {
        $head: ["banner"],
        $tail: ["leftover"],
        "": { tail: ["the end"] },
        "/a": { trailing: ["note"], blankBefore: true },
        "/b": { leading: ["about b"] },
      },
    ));
    const root = doc.root as Node;
    const e0 = root.entries![0].meta as { comments?: { text: string; placement: string }[]; blankBefore?: boolean };
    expect(e0.blankBefore).toBe(true);
    expect(e0.comments).toEqual([expect.objectContaining({ text: "note", placement: "trailing" })]);
    const e1 = root.entries![1].meta as { comments?: { text: string; placement: string }[] };
    expect(e1.comments).toEqual([expect.objectContaining({ text: "about b", placement: "leading" })]);
    const rm = root.meta as { comments?: { text: string; placement: string }[] };
    expect(rm.comments).toEqual([
      expect.objectContaining({ text: "the end", placement: "leading" }),
      expect.objectContaining({ text: "leftover", placement: "leading" }),
    ]);
    expect((doc as { head?: { text: string }[] }).head).toEqual([expect.objectContaining({ text: "banner" })]);
  });

  it("comment carriage NEVER changes the serialized source (payload parity at the loader)", () => {
    const bare = irFromNodeJson(nj({ a: 1, f: [1, 2] }, { "/f": { repr: "yaml/flow" } }));
    const commented = irFromNodeJson(nj(
      { a: 1, f: [1, 2] },
      { $head: ["banner"], "": { tail: ["the end"] }, "/a": { trailing: ["note"], blankBefore: true }, "/f": { repr: "yaml/flow", leading: ["about f"] } },
    ));
    expect(sourceOf(commented)).toBe(sourceOf(bare));
    expect(sourceOf(commented)).toContain("f: [1, 2]"); // the flow layout survives the comments
  });
});
