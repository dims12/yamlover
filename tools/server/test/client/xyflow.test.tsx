// @vitest-environment jsdom
// The XYFLOW renderer (format `x-yamlover-xyflow`): a subtree read as the graph it is —
// self-values inside the nodes, a valueless node as a bare circle, relations titled by ordinal
// AND key, and three edge kinds (containment, `*` dereference, `&` anchor membership) with
// off-subtree ends as stubs.
import { describe, it, expect } from "vitest";
import { buildGraph, edgeLabel } from "../../src/client/renderers/xyflow-graph";
import { reseatInRelationOrder } from "../../src/client/renderers/xyflow";
import { getRenderer } from "../../src/client/renderers/registry";
import type { NodeJson } from "../../src/client/api";

const mixed = (entries: { key: string | null; value: unknown; anchor?: boolean }[], value?: unknown) => ({
  $yamloverMixed: { kind: value === undefined ? "mix" : "omni", ...(value === undefined ? {} : { value }), entries },
});
const ref = (path: string | null, text = "*x") => ({ $yamloverRef: { text, path } });

const graphNode = (value: unknown, comments?: NodeJson["comments"]): NodeJson => ({
  path: ":g",
  type: "variant",
  format: "x-yamlover-xyflow",
  concrete: null,
  documentPath: ":g", // a standalone tagged document: its root IS the graph
  title: null,
  description: null,
  value,
  comments,
});

// the examples/76 shape: keyed and positional relations, a valueless node, a `*` deref, an
// off-subtree `*` target
const fixture = mixed([
  { key: "ingest", value: "raw documents" },
  { key: "validate", value: mixed([{ key: "rules", value: "strict" }, { key: "quarantine", value: null }]) },
  { key: "classify", value: ["fast lane", "slow lane"] },
  { key: "review", value: mixed([{ key: "reads", value: ref(":g:validate", "*validate") }]) },
  { key: "glossary", value: ref(":description", "*: description") },
]);

const nodeAt = (g: ReturnType<typeof buildGraph>, id: string) => g.nodes.find((n) => n.id === id);
const edgeTo = (g: ReturnType<typeof buildGraph>, target: string) => g.edges.find((e) => e.target === target);

describe("xyflow renderer", () => {
  it("is selected for x-yamlover-xyflow and offers an inline chunk form", () => {
    const r = getRenderer(graphNode(fixture));
    expect(r?.name).toBe("xyflow");
    expect(r?.depth).toBeNull(); // the whole subtree is the drawing
    expect(r?.renderChunk).toBeTypeOf("function");
  });

  it("puts each node's self-value inside it and leaves a valueless node empty", () => {
    const g = buildGraph(graphNode(fixture));
    expect(nodeAt(g, ":g:ingest")).toMatchObject({ label: "raw documents", kind: "value" });
    expect(nodeAt(g, ":g:validate:quarantine")).toMatchObject({ label: "", kind: "empty" });
    expect(nodeAt(g, ":g:validate")?.kind).toBe("empty"); // a container with no self-value of its own
  });

  it("types each value so the drawing can ink it in the code palette", () => {
    const g = buildGraph(graphNode(mixed([
      { key: "name", value: "whiskers" },
      { key: "age", value: 30 },
      { key: "indoor", value: true },
      { key: "vet", value: null },
    ])));
    expect(nodeAt(g, ":g:name")?.valueType).toBe("string");
    expect(nodeAt(g, ":g:age")?.valueType).toBe("number");
    expect(nodeAt(g, ":g:indoor")?.valueType).toBe("boolean");
    expect(nodeAt(g, ":g:vet")).toMatchObject({ kind: "empty" });
    expect(nodeAt(g, ":g:vet")?.valueType).toBeUndefined(); // an empty circle inks nothing
  });

  it("titles a relation by its ordinal AND its key, and a positional one by the number alone", () => {
    const g = buildGraph(graphNode(fixture));
    expect(edgeTo(g, ":g:ingest")).toMatchObject({ label: "0: ingest", key: "ingest", ordinal: 0, kind: "contain" });
    expect(edgeTo(g, ":g:classify:0")).toMatchObject({ label: "0", key: null, ordinal: 0 });
    expect(edgeTo(g, ":g:classify:1")).toMatchObject({ label: "1", key: null, ordinal: 1 });
    expect(edgeLabel(3, null)).toBe("3");
    expect(edgeLabel(null, "latest")).toBe("latest");
  });

  it("draws a `*` dereference as an edge onto the target itself, adding no node", () => {
    const g = buildGraph(graphNode(fixture));
    const deref = g.edges.find((e) => e.kind === "deref" && e.source === ":g:review")!;
    expect(deref).toMatchObject({ target: ":g:validate", label: "0: reads" });
    expect(g.nodes.filter((n) => n.id === ":g:validate")).toHaveLength(1);
  });

  it("ends a `*` outside the subtree in a navigable stub", () => {
    const g = buildGraph(graphNode(fixture));
    const stub = nodeAt(g, ":description")!;
    // named from the project root — inside the graph a single `:` would mean the graph itself
    expect(stub).toMatchObject({ kind: "stub", path: ":description", label: ":: description" });
    expect(g.edges.find((e) => e.target === ":description")).toMatchObject({ kind: "deref", label: "4: glossary" });
  });

  it("keeps an unresolved pointer as a stub named by its authored text", () => {
    const g = buildGraph(graphNode(mixed([{ key: "nowhere", value: ref(null, "*: gone") }])));
    const stub = g.nodes.find((n) => n.kind === "stub")!;
    expect(stub).toMatchObject({ path: null, label: "*: gone" });
    expect(g.edges).toHaveLength(1);
  });

  it("reclassifies the entry an `&` anchor projects onto its host, rather than doubling it", () => {
    // `&: exports: shipped` on publish: the engine ALSO projects `shipped` as an entry on
    // exports, whose value is a ref back to publish — one relation, drawn once, anchor-styled.
    const value = mixed([
      { key: "exports", value: mixed([{ key: "latest", value: "the shelf" }, { key: "shipped", value: ref(":g:publish") }]) },
      { key: "publish", value: "to the shelf" },
    ]);
    const plain = buildGraph(graphNode(value));
    expect(plain.edges.find((e) => e.key === "shipped")).toMatchObject({ kind: "deref" });

    // the canonical spaced body a `&: exports: shipped` line records, document-scoped
    const anchored = buildGraph(graphNode(value, { "/publish": { anchors: [": exports: shipped"] } } as NodeJson["comments"]));
    const anchors = anchored.edges.filter((e) => e.kind === "anchor");
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({ source: ":g:exports", target: ":g:publish", key: "shipped", label: "1: shipped" });
  });

  it("draws an `&` anchor whose host lies outside the drawing as an edge from a stub", () => {
    const g = buildGraph(
      graphNode(mixed([{ key: "publish", value: "to the shelf" }]), {
        "/publish": { anchors: [": elsewhere: shipped"] },
      } as NodeJson["comments"]),
    );
    expect(g.edges.find((e) => e.kind === "anchor")).toMatchObject({
      source: ":g:elsewhere",
      target: ":g:publish",
      label: "shipped",
    });
    expect(g.nodes.find((n) => n.id === ":g:elsewhere")?.kind).toBe("stub");
  });

  it("treats a DERIVED storage anchor entry as an anchor membership too", () => {
    const g = buildGraph(graphNode(mixed([{ key: "item01", value: "a member", anchor: true }])));
    expect(g.edges[0]).toMatchObject({ kind: "anchor", label: "0: item01" });
  });

  it("seats a fan top to bottom in relation order, and keeps subtrees under their parents", () => {
    // dagre is free to hand relation 0 the bottom slot; the drawing must still read downwards
    const nodes = ["r", "a", "b", "a0", "b0"].map((id) => ({ id, path: `:${id}`, label: id, kind: "value" as const }));
    const edge = (id: string, source: string, target: string, ordinal: number) =>
      ({ id, source, target, kind: "contain" as const, key: null, ordinal, label: String(ordinal) });
    const graph = { nodes, edges: [edge("e0", "r", "a", 0), edge("e1", "r", "b", 1), edge("e2", "a", "a0", 0), edge("e3", "b", "b0", 0)] };
    // column 1 holds the fan upside down (a below b); column 2 holds their children likewise
    const place = new Map([
      ["r", { x: 0, y: 50 }],
      ["a", { x: 100, y: 80 }], ["b", { x: 100.5, y: 20 }],
      ["a0", { x: 200, y: 80 }], ["b0", { x: 200, y: 20 }],
    ]);
    reseatInRelationOrder(graph, place);
    expect(place.get("a")!.y).toBeLessThan(place.get("b")!.y); // relation 0 above relation 1
    expect(place.get("a0")!.y).toBeLessThan(place.get("b0")!.y); // and their children follow them
    expect([...place.values()].map((p) => p.y).sort((x, y) => x - y)).toEqual([20, 20, 50, 80, 80]); // dagre's own slots, only permuted
  });

  it("walks a cycle once and still draws the closing edge", () => {
    const g = buildGraph(
      graphNode(mixed([{ key: "a", value: mixed([{ key: "back", value: ref(":g", "*: g") }]) }])),
    );
    expect(g.nodes.map((n) => n.id)).toEqual([":g", ":g:a"]);
    expect(g.edges.find((e) => e.kind === "deref")).toMatchObject({ source: ":g:a", target: ":g" });
  });
});
