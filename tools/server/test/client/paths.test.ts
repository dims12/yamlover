// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  segsToStr,
  strToSegs,
  isAncestorPath,
  crumbs,
  pathFromUrl,
  formatFromUrl,
  writeUrl,
} from "../../src/client/paths";

describe("client paths", () => {
  it("encodes/decodes keys the same way as the server", () => {
    expect(segsToStr(["@vitejs/plugin-react"])).toBe("/%40vitejs%2Fplugin-react");
    expect(strToSegs("/%40vitejs%2Fplugin-react")).toEqual(["@vitejs/plugin-react"]);
    expect(strToSegs(segsToStr(["a/b", 2]))).toEqual(["a/b", 2]);
  });

  it("isAncestorPath", () => {
    expect(isAncestorPath("/", "/a")).toBe(true);
    expect(isAncestorPath("/a", "/a/b")).toBe(true);
    expect(isAncestorPath("/a", "/a[0]")).toBe(true);
    expect(isAncestorPath("/a", "/a")).toBe(false); // self is not a strict ancestor
    expect(isAncestorPath("/a", "/ab")).toBe(false); // not a segment boundary
  });

  it("builds crumbs with and without a head", () => {
    expect(crumbs("/x[0]", "root").map((c) => c.label)).toEqual(["root", "x", "[0]"]);
    expect(crumbs("/x", "").map((c) => c.label)).toEqual(["x"]); // head omitted when blank
  });

  it("reads and writes the URL (path + ?format=)", () => {
    writeUrl("/a/b", "json");
    expect(window.location.pathname).toBe("/a/b");
    expect(window.location.search).toBe("?format=json");
    expect(formatFromUrl("yaml-schema")).toBe("json");
    expect(pathFromUrl()).toBe("/a/b");
  });

  it("canonicalizes an encoded pathname on read", () => {
    writeUrl(segsToStr(["@vitejs/plugin-react"]), "yaml");
    expect(pathFromUrl()).toBe("/%40vitejs%2Fplugin-react");
  });
});
