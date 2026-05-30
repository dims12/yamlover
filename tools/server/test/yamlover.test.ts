import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import {
  loadEntity,
  getNode,
  strToSegs,
  toPlain,
  toSchema,
  buildTree,
  binaryContent,
  typeLabel,
  nodeKind,
  setIgnoreFilter,
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
    expect(user.name).toBe("Alice");
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
    expect(s.title).toBe("The Yamlover Handbook");
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
    const t = buildTree(root, [], root.title || "doc", 3);
    expect(t.label).toBe("The Yamlover Handbook");
    const installation = t.children.find((c) => c.label === "Installation");
    expect(installation).toBeTruthy();
    expect(installation!.children.find((c) => c.label === "Prerequisites")).toBeTruthy();
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
