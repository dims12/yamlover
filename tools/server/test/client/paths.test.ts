// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  segsToStr,
  strToSegs,
  isAncestorPath,
  crumbs,
  displayPath,
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

  it("displayPath decodes keys for human display (tooltips), keeping [i] indices", () => {
    // a Cyrillic key arrives percent-encoded in the canonical path; the display
    // form shows the real characters
    const enc = segsToStr(["00. Периодика", 3, "a/b"]);
    expect(enc).toBe("/00.%20%D0%9F%D0%B5%D1%80%D0%B8%D0%BE%D0%B4%D0%B8%D0%BA%D0%B0[3]/a%2Fb");
    expect(displayPath(enc)).toBe("/00. Периодика[3]/a/b");
    expect(displayPath("/")).toBe("/");
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
