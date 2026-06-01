import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import {
  loadEntity,
  getNode,
  strToSegs,
  toPlain,
  toSchema,
  buildRelations,
  buildTree,
  binaryContent,
  typeLabel,
  displayTypeLabel,
  nodeKind,
  setIgnoreFilter,
  YNode,
  Binary,
  LINK_KEY,
  BINARY_KEY,
} from "../src/server/yamlover";
import { REPO, ex } from "./helpers";

// Tests share the module-global ignore filter; keep it inert here.
beforeEach(() => setIgnoreFilter(() => false));

describe("materialization (toPlain values)", () => {
  it("renders the same object from schema / yaml / json / dir", () => {
    const want = { name: "Alice", age: 30, isAdmin: true };
    for (const n of [
      "01-object-in-schema",
      "02-object-in-yaml",
      "03-object-in-json",
      "04-object-in-dir",
    ]) {
      expect(toPlain(loadEntity(ex(n)))).toEqual(want);
    }
  });

  it("renders scalars (file and schema-pinned)", () => {
    expect(toPlain(loadEntity(ex("05-scalar-as-file")))).toBe(30);
    expect(toPlain(loadEntity(ex("07-scalar-in-schema")))).toBe(30);
  });

  it("renders an array of files with mixed concretes", () => {
    expect(toPlain(loadEntity(ex("10-array-of-files")))).toEqual(["Alice", 42, true]);
  });

  it("resolves $ref/$defs to the same value as the inline version", () => {
    const m12 = toPlain(getNode(loadEntity(ex("12-image-with-markup")), ["markup"]));
    const m13 = toPlain(getNode(loadEntity(ex("13-defs-and-refs")), ["markup"]));
    expect(m13).toEqual(m12);
    expect(m12).toEqual([
      { x: 25, y: 40, dx: 25, dy: 40 },
      { x: 25, y: 40, dx: 25, dy: 40 },
    ]);
  });
});

describe("link markers (one level deep)", () => {
  it("turns nested object/array/binary children into link markers", () => {
    const v = toPlain(loadEntity(ex("12-image-with-markup")), 1, []) as any;
    expect(v.markup[LINK_KEY]).toMatchObject({ kind: "array", count: 2, path: "/markup" });
    expect(v["object_detection.png"][LINK_KEY]).toMatchObject({ kind: "binary", format: "image/png" });
    expect(v["object_detection.png"][LINK_KEY].size).toBeGreaterThan(0);
  });

  it("uses the same markers in the schema view", () => {
    const s = toSchema(loadEntity(ex("12-image-with-markup")), 1, []) as any;
    expect(s.type).toBe("object");
    expect(s.properties.markup[LINK_KEY]).toMatchObject({ kind: "array", count: 2 });
  });

  it("detects an untyped file/yaml as an object and links it", () => {
    const root = loadEntity(ex("11-switch-schema-file-yaml"));
    const user = toPlain(getNode(root, ["user"]), 1, strToSegs("/user")) as any;
    // every child is a link one level deep: a scalar by its value, a container by summary
    expect(user.name[LINK_KEY]).toMatchObject({ kind: "scalar", value: "Alice", path: "/user/name" });
    expect(user.contact[LINK_KEY]).toMatchObject({ kind: "object", count: 2 });
    expect(user.contact[LINK_KEY].path).toBe("/user/contact");
  });
});

describe("instance schema (toSchema)", () => {
  it("is const-only with x-yamlover provenance", () => {
    const s = toSchema(loadEntity(ex("04-object-in-dir"))) as any;
    expect(s.type).toBe("object");
    expect(s.properties.name.const).toBe("Alice");
    expect(s.properties.age.const).toBe(30);
    expect(s["x-yamlover"].concrete).toBe("yamlover");
    expect(s["x-yamlover"].os.path).toBe("04-object-in-dir");
  });

  it("carries the schema title", () => {
    const s = toSchema(loadEntity(ex("15-doc-tree")), 1) as any;
    expect(s.title).toBe("The Pet Keeper's Handbook");
  });

  it("surfaces x-yamlover for a schema-only node (no filesystem path)", () => {
    const root = loadEntity(ex("14-genealogy-dag"));
    const s = toSchema(getNode(root, ["eve"]), null, ["eve"], true, root) as any;
    expect(s["x-yamlover"].concrete).toBe("yaml-schema/instantiate");
    expect(s["x-yamlover"].os).toBeUndefined(); // not backed by a file/dir
  });

  it("emits rel pointers as hyperlinks resolved to their target location", () => {
    const root = loadEntity(ex("14-genealogy-dag"));

    // absolute (/…) pointers anchor at the enclosing yamlover entity (the root)
    const eve = toSchema(getNode(root, ["eve"]), null, ["eve"], true, root) as any;
    expect(eve["x-yamlover"].rel[".cain"]).toEqual({
      $yamloverRef: { text: "/adam/cain", path: "/adam/cain" },
    });

    // a `..`-relative pointer resolves from the node's own location
    const cain = toSchema(getNode(root, ["adam", "cain"]), null, ["adam", "cain"], true, root) as any;
    expect(cain["x-yamlover"].rel.father).toEqual({
      $yamloverRef: { text: "..", path: "/adam" },
    });
    expect(cain["x-yamlover"].rel.mother).toEqual({
      $yamloverRef: { text: "/eve", path: "/eve" },
    });
  });
});

describe("relations & virtual children (data views)", () => {
  const link = (path: string, count: number) => ({ $yamloverLink: { kind: "object", type: "object", path, count } });
  const scalarLink = (path: string, value: unknown) => ({ $yamloverLink: { kind: "scalar", type: "null", path, value } });

  it("builds a relations panel of named up-edges (standard titles), dropping `..` when covered", () => {
    const root = loadEntity(ex("14-genealogy-dag"));
    // cain's father resolves to its structural parent (/adam), so `..` is omitted;
    // each edge is shown with the target's standard `{ object … }` title, not a path
    expect(buildRelations(getNode(root, ["adam", "cain"]), ["adam", "cain"], root)).toEqual({
      father: link("/adam", 3),
      mother: link("/eve", 3),
    });
  });

  it("keeps `..` when a named edge points somewhere other than the parent", () => {
    // synthetic tree: /x has a `friend` edge to /y (not its parent, the root)
    const root = new YNode({}, "yamlover");
    const x = new YNode(null);
    x.rel = { friend: "/y" };
    root.value = { x, y: new YNode({}) };
    expect(buildRelations(x, ["x"], root)).toEqual({
      "..": link("/", 2),
      friend: link("/y", 0),
    });
  });

  it("shows only `..` when a node has no named relations, and nothing at the root", () => {
    const root = loadEntity(ex("14-genealogy-dag"));
    // eve's rel are all dot-prefixed (virtual children), so no named up-edges
    expect(buildRelations(getNode(root, ["eve"]), ["eve"], root)).toEqual({ "..": link("/", 2) });
    // the root has no parent → no relations panel
    expect(buildRelations(root, [], root)).toEqual({});
  });

  it("links every child — overlaid entities as objects, plain nulls as scalar links", () => {
    const root = loadEntity(ex("14-genealogy-dag"));
    // eve's children exist only virtually (.cain/.seth/.azura). cain has a real
    // child and azura a virtual one → objects; seth (only up-edges) stays a null
    // scalar, hyperlinked by its rendered value
    expect(toPlain(getNode(root, ["eve"]), 1, ["eve"], true, root)).toEqual({
      cain: link("/adam/cain", 1),
      seth: scalarLink("/adam/seth", null),
      azura: link("/adam/azura", 1),
    });
  });

  it("treats a virtual child like a real one (enoch is a null leaf either way)", () => {
    const root = loadEntity(ex("14-genealogy-dag"));
    // azura reaches enoch virtually, cain by containment; enoch is a null leaf, so
    // both render it as a scalar link titled by its value
    const azura = toPlain(getNode(root, ["adam", "azura"]), 1, ["adam", "azura"], true, root);
    const cain = toPlain(getNode(root, ["adam", "cain"]), 1, ["adam", "cain"], true, root);
    expect(azura).toEqual({ enoch: scalarLink("/adam/cain/enoch", null) });
    expect(cain).toEqual({ enoch: scalarLink("/adam/cain/enoch", null) });
  });

  it("overlays a null with virtual children as `object`, but leaves plain nulls null", () => {
    const root = loadEntity(ex("14-genealogy-dag"));
    expect(displayTypeLabel(getNode(root, ["adam", "azura"]))).toBe("object"); // has `.enoch`
    expect(displayTypeLabel(getNode(root, ["adam", "seth"]))).toBe("null"); // only up-edges
    expect(displayTypeLabel(getNode(root, ["adam", "cain", "enoch"]))).toBe("null");
  });
});

describe("binary leaves", () => {
  it("are lazy (size via stat, bytes unread) until requested", () => {
    const node = getNode(loadEntity(ex("12-image-with-markup")), ["object_detection.png"]);
    expect(typeLabel(node)).toBe("binary");
    expect(nodeKind(node)).toBe("binary");

    const bin = node.value as Binary; // triggers a stat-only load
    expect(bin.size).toBeGreaterThan(0);
    expect(bin.data).toBeNull(); // the blob itself is not read

    const payload = binaryContent(node) as any;
    expect(payload[BINARY_KEY].format).toBe("image/png");
    expect(payload[BINARY_KEY].size).toBe(bin.size);
    expect(payload[BINARY_KEY].base64.startsWith("iVBOR")).toBe(true); // PNG signature
  });
});

describe("non-YAML files fall back to raw text", () => {
  it("reads a Markdown file as a string", () => {
    const node = loadEntity(path.join(REPO, "tools", "README.md"));
    expect(typeLabel(node)).toBe("string");
    expect(String(node.value).startsWith("# tools")).toBe(true);
  });

  it("reads a Python source file as a string", () => {
    const node = loadEntity(path.join(REPO, "tools", "walker", "walker.py"));
    expect(typeLabel(node)).toBe("string");
    expect(String(node.value)).toContain("#!/usr/bin/env python3");
  });
});

describe("table of contents (buildTree)", () => {
  it("lists every node, scalars included", () => {
    const t = buildTree(loadEntity(ex("04-object-in-dir")), [], "root", 3);
    expect(t.hasChildren).toBe(true);
    expect(t.children.map((c) => c.label)).toEqual(["name", "age", "isAdmin"]);
    const name = t.children.find((c) => c.label === "name")!;
    expect(name.type).toBe("string");
    expect(name.hasChildren).toBe(false);
  });

  it("labels array elements by index", () => {
    const t = buildTree(loadEntity(ex("10-array-of-files")), [], "root", 3);
    expect(t.children.map((c) => c.label)).toEqual(["[0]", "[1]", "[2]"]);
  });

  it("uses titles for labels (recursively)", () => {
    const root = loadEntity(ex("15-doc-tree"));
    // Puppies is four levels deep now (root → children → Dogs → children → Puppies).
    const t = buildTree(root, [], root.title || "doc", 5);
    expect(t.label).toBe("The Pet Keeper's Handbook");
    // subchapters live under the `children` array wrapper (labelled by its key)
    const children = t.children.find((c) => c.label === "children")!;
    const dogs = children.children.find((c) => c.label === "Dogs");
    expect(dogs).toBeTruthy();
    expect(dogs!.type).toBe("object");
    expect(dogs!.format).toBe("x-yamlover-chapter");
    const dogsChildren = dogs!.children.find((c) => c.label === "children")!;
    expect(dogsChildren.children.find((c) => c.label === "Puppies")).toBeTruthy();
  });

  it("depth-limits, flagging hasChildren past the boundary, and carries format", () => {
    const t = buildTree(loadEntity(ex("12-image-with-markup")), [], "root", 1);
    const markup = t.children.find((c) => c.label === "markup")!;
    expect(markup.type).toBe("array");
    expect(markup.hasChildren).toBe(true);
    expect(markup.children).toEqual([]); // not loaded past depth 1
    const img = t.children.find((c) => c.label === "object_detection.png")!;
    expect(img.format).toBe("image/png");
    expect(img.hasChildren).toBe(false);
  });
});

describe("getNode", () => {
  it("navigates objects and arrays", () => {
    const root = loadEntity(ex("12-image-with-markup"));
    expect(toPlain(getNode(root, ["markup", 0]))).toEqual({ x: 25, y: 40, dx: 25, dy: 40 });
  });

  it("throws on a bad path", () => {
    const root = loadEntity(ex("12-image-with-markup"));
    expect(() => getNode(root, ["nope"])).toThrow();
    expect(() => getNode(root, ["markup", 9])).toThrow();
  });
});
