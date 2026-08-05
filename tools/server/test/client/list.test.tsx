// @vitest-environment jsdom
// The LIST renderers (docs/documents/marklower/lists): x-yamlover-bullets → <ul>, x-yamlover-numbered →
// <ol>; an untagged container item is a nested sublist of the SAME kind at any depth, until an
// explicit tag switches (a tagged table item renders as an inline grid).
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { ListView } from "../../src/client/renderers/list";
import { getRenderer } from "../../src/client/renderers/registry";
import type { NodeJson } from "../../src/client/api";

afterEach(cleanup);

const marker = (entries: { key: string | null; value: unknown }[], format?: string) => ({
  $yamloverMixed: { kind: "array", ...(format ? { format } : {}), entries },
});

const listNode = (format: string, value: unknown): NodeJson => ({
  path: ":l",
  type: "variant",
  format,
  concrete: null,
  title: null,
  description: null,
  value,
});

describe("list renderers", () => {
  it("bullets and numbered are selected by format and offer inline chunk forms", () => {
    const b = getRenderer(listNode("x-yamlover-bullets", marker([{ key: null, value: "x" }], "x-yamlover-bullets")));
    expect(b?.name).toBe("bullets");
    expect(b?.depth).toBeNull(); // a list needs its whole subtree
    expect(b?.renderChunk).toBeTypeOf("function");
    const n = getRenderer(listNode("x-yamlover-numbered", marker([{ key: null, value: "x" }], "x-yamlover-numbered")));
    expect(n?.name).toBe("numbered");
  });

  it("renders bullets as <ul> with marklower items", () => {
    const value = marker([
      { key: null, value: "plain item" },
      { key: null, value: "a **bold** item" },
    ], "x-yamlover-bullets");
    const { container } = render(<ListView node={listNode("x-yamlover-bullets", value)} onNavigate={() => {}} />);
    const ul = container.querySelector("ul.yl-list-bullets")!;
    expect(ul).not.toBeNull();
    expect(ul.querySelectorAll(":scope > li").length).toBe(2);
    expect(ul.querySelector("strong")?.textContent).toBe("bold");
  });

  it("renders numbered as <ol>", () => {
    const value = marker([{ key: null, value: "step one" }], "x-yamlover-numbered");
    const { container } = render(<ListView node={listNode("x-yamlover-numbered", value)} onNavigate={() => {}} />);
    expect(container.querySelector("ol.yl-list-numbered li")?.textContent).toBe("step one");
  });

  it("an untagged nested container is a sublist of the SAME kind, at any depth", () => {
    // a stamped sublist marker and a depth-truncated bare array both nest as the same kind
    const value = marker([
      { key: null, value: "top" },
      { key: null, value: marker([
        { key: null, value: "nested" },
        { key: null, value: ["deeper"] }, // bare array — the unstamped fallback
      ], "x-yamlover-numbered") },
    ], "x-yamlover-numbered");
    const { container } = render(<ListView node={listNode("x-yamlover-numbered", value)} onNavigate={() => {}} />);
    const outer = container.querySelector("ol.yl-list")!;
    const nested = outer.querySelector(":scope > li > ol.yl-list")!;
    expect(nested).not.toBeNull(); // same kind: <ol> inside <ol>
    expect(nested.querySelector(":scope > li > ol > li")?.textContent).toBe("deeper");
  });

  it("an explicitly tagged table item renders as an inline grid, not a sublist", () => {
    const table = { $yamloverMixed: { kind: "mix", format: "x-yamlover-table", entries: [
      { key: "header", value: ["a", "b"] },
      { key: null, value: ["1", "2"] },
    ] } };
    const value = marker([
      { key: null, value: "before" },
      { key: null, value: table },
    ], "x-yamlover-bullets");
    const { container } = render(<ListView node={listNode("x-yamlover-bullets", value)} onNavigate={() => {}} />);
    const li = [...container.querySelectorAll("ul.yl-list > li")][1];
    expect(li.querySelector("table")).not.toBeNull();
    expect([...li.querySelectorAll("th")].map((e) => e.textContent)).toEqual(["a", "b"]);
  });

  it("a marker stamped with the OTHER list format switches kind", () => {
    const value = marker([
      { key: null, value: marker([{ key: null, value: "ordered inside" }], "x-yamlover-numbered") },
    ], "x-yamlover-bullets");
    const { container } = render(<ListView node={listNode("x-yamlover-bullets", value)} onNavigate={() => {}} />);
    expect(container.querySelector("ul.yl-list > li > ol.yl-list li")?.textContent).toBe("ordered inside");
  });

  // A nested item is an OMNI: nesting `- b` under `- a` makes `a` a container whose SELF-VALUE is
  // its own text and whose entries are `[b]` (the shape indentEntry produces). The item's own words
  // must render above its sublist, not vanish.
  it("an item with a sublist keeps its OWN text (the omni self-value)", () => {
    const omni = (self: string, subs: unknown[], format = "x-yamlover-bullets") => ({
      $yamloverMixed: { kind: "omni", value: self, format, entries: subs.map((value) => ({ key: null, value })) },
    });
    const value = marker([
      { key: null, value: "plain top" },
      { key: null, value: omni("parent item", ["child one", "child two"]) },
    ], "x-yamlover-bullets");
    const { container } = render(<ListView node={listNode("x-yamlover-bullets", value)} onNavigate={() => {}} />);
    const parentLi = container.querySelectorAll("ul.yl-list > li")[1]!;
    // the parent's own text is there, ABOVE its sublist
    expect(parentLi.textContent).toContain("parent item");
    const sub = parentLi.querySelector(":scope > ul.yl-list")!;
    expect(sub).not.toBeNull();
    expect([...sub.querySelectorAll(":scope > li")].map((li) => li.textContent)).toEqual(["child one", "child two"]);
  });

  it("a container item with NO self-value renders just the sublist (no phantom prose)", () => {
    const value = marker([
      { key: null, value: marker([{ key: null, value: "only child" }], "x-yamlover-bullets") },
    ], "x-yamlover-bullets");
    const { container } = render(<ListView node={listNode("x-yamlover-bullets", value)} onNavigate={() => {}} />);
    const li = container.querySelector("ul.yl-list > li")!;
    expect(li.querySelector(":scope > ul li")?.textContent).toBe("only child");
    expect(li.textContent).toBe("only child"); // nothing extra
  });
});
