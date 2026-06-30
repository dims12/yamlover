// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  segsToStr,
  strToSegs,
  isAncestorPath,
  crumbs,
  displayPath,
  displayKey,
  pathFromUrl,
  formatFromUrl,
  writeUrl,
  pageFromUrl,
  writePageToUrl,
  fragmentAnchorId,
} from "../../src/client/paths";

describe("client paths", () => {
  it("encodes/decodes keys the same way as the server", () => {
    expect(segsToStr(["@vitejs/plugin-react"])).toBe(":%40vitejs%2Fplugin-react");
    expect(strToSegs(":%40vitejs%2Fplugin-react")).toEqual(["@vitejs/plugin-react"]);
    expect(strToSegs(segsToStr(["a/b", 2]))).toEqual(["a/b", 2]);
  });

  it("displayPath decodes keys for human display (tooltips), space after each colon, keeping [i] indices", () => {
    // a Cyrillic key arrives percent-encoded in the canonical path; the display
    // form shows the real characters, colon-separated with a space after each colon
    const enc = segsToStr(["00. Периодика", 3, "a/b"]);
    expect(enc).toBe(":00.%20%D0%9F%D0%B5%D1%80%D0%B8%D0%BE%D0%B4%D0%B8%D0%BA%D0%B0[3]:a%2Fb");
    expect(displayPath(enc)).toBe(": 00. Периодика[3]: a/b");
    expect(displayPath(":")).toBe(":");
  });

  it("displayKey decodes a relation key in place, keeping its structure verbatim", () => {
    expect(displayKey("..")).toBe(".."); // displayPath would mangle these two
    expect(displayKey("//%D0%9F%D0%B0%D0%BF%D0%BA%D0%B0/file")).toBe("//Папка/file");
    expect(displayKey(":eve")).toBe(":eve");
  });

  it("isAncestorPath", () => {
    expect(isAncestorPath(":", ":a")).toBe(true);
    expect(isAncestorPath(":a", ":a:b")).toBe(true);
    expect(isAncestorPath(":a", ":a[0]")).toBe(true);
    expect(isAncestorPath(":a", ":a")).toBe(false); // self is not a strict ancestor
    expect(isAncestorPath(":a", ":ab")).toBe(false); // not a segment boundary
  });

  it("builds crumbs with and without a head", () => {
    expect(crumbs(":x[0]", "root").map((c) => c.label)).toEqual(["root", "x", "[0]"]);
    expect(crumbs(":x", "").map((c) => c.label)).toEqual(["x"]); // head omitted when blank
  });

  it("reads and writes the URL (path + ?format=)", () => {
    writeUrl(":a:b", "json");
    expect(window.location.pathname).toBe("/a/b"); // the URL stays slash-transported
    expect(window.location.search).toBe("?format=json");
    expect(formatFromUrl("yaml-schema")).toBe("json");
    expect(pathFromUrl()).toBe(":a:b");
  });

  it("canonicalizes an encoded pathname on read", () => {
    writeUrl(segsToStr(["@vitejs/plugin-react"]), "yaml");
    expect(pathFromUrl()).toBe(":%40vitejs%2Fplugin-react");
  });

  it("tracks the page in ?page= (1 is implicit, never written)", () => {
    writeUrl(":doc.pdf", "pdf"); // start clean — no ?page=
    expect(pageFromUrl()).toBe(1);
    writePageToUrl(12);
    expect(window.location.search).toBe("?format=pdf&page=12");
    expect(pageFromUrl()).toBe(12);
    writePageToUrl(1); // back to page 1 → param dropped
    expect(window.location.search).toBe("?format=pdf");
    expect(pageFromUrl()).toBe(1);
  });

  it("page survives a format switch (replace) but is dropped on navigation (push)", () => {
    writeUrl(":doc.pdf", "pdf");
    writePageToUrl(7);
    writeUrl(":doc.pdf", "yamlover", true); // format switch (replace) keeps the page
    expect(formatFromUrl("x")).toBe("yamlover");
    expect(pageFromUrl()).toBe(7);
    writeUrl(":other.pdf", "pdf"); // navigate to another node (push) drops it
    expect(pageFromUrl()).toBe(1);
    expect(window.location.search).toBe("?format=pdf");
  });

  it("fragmentAnchorId is the material-relative tail (#yamlover-fragments/<slug>, no leading slash)", () => {
    // the `#` of `<material-url>#<id>` stands in for the leading `/` of the direct fragment-node URL
    expect(fragmentAnchorId(":72-images:eiffel-tower:IMG.jpg", "mr0zbe2l-rqyow7"))
      .toBe("yamlover-fragments/mr0zbe2l-rqyow7");
    // root material: still no leading slash
    expect(fragmentAnchorId(":", "abc")).toBe("yamlover-fragments/abc");
  });
});
