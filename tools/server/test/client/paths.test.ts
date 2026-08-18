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
  splitFragmentPath,
} from "../../src/client/paths";

describe("client paths", () => {
  it("encodes/decodes keys the same way as the server", () => {
    expect(segsToStr(["@vitejs/plugin-react"])).toBe(":%40vitejs%2Fplugin-react");
    expect(strToSegs(":%40vitejs%2Fplugin-react")).toEqual(["@vitejs/plugin-react"]);
    expect(strToSegs(segsToStr(["a/b", 2]))).toEqual(["a/b", 2]);
  });

  it("displayPath decodes keys for human display (tooltips), space after each colon, bare-digit indices", () => {
    // a Cyrillic key arrives percent-encoded in the canonical path; a spacey key rides QUOTED
    // (keyPortion); the display form shows the canonical tokens, a space after each colon
    const enc = segsToStr(["00. Периодика", 3, "a/b"]);
    expect(enc).toBe(":'00.%20%D0%9F%D0%B5%D1%80%D0%B8%D0%BE%D0%B4%D0%B8%D0%BA%D0%B0':3:a%2Fb");
    expect(displayPath(enc)).toBe(": '00. Периодика': 3: a/b");
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
    expect(isAncestorPath(":a", ":a:0")).toBe(true); // a position is a colon segment now
    expect(isAncestorPath(":a", ":a")).toBe(false); // self is not a strict ancestor
    expect(isAncestorPath(":a", ":ab")).toBe(false); // not a segment boundary
  });

  it("builds crumbs with and without a head", () => {
    expect(crumbs(":x:0", "root").map((c) => c.label)).toEqual(["root", "x", "0"]);
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

  it("a colon in the pathname is a KEY, never a separator — the URL is slash-transported", () => {
    // Links once rendered their canonical colon path straight into the href, so `/:meta` was
    // requestable. It is not a spelling this app serves: the URL is slashed, and a key that
    // really contains a colon rides percent-encoded (encodeURIComponent escapes `:` to %3A).
    // So `/:meta` reads as one key named `:meta`, which names no node — an honest miss.
    window.history.replaceState({}, "", "/:meta?format=chapter");
    expect(pathFromUrl()).toBe(segsToStr([":meta"]));
    writeUrl(segsToStr(["a:b"]), "yaml");
    expect(pathFromUrl()).toBe(segsToStr(["a:b"]));
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

  it("fragmentAnchorId is the material-relative tail, leading-slashed like chunk anchors (#/.yo/fragments/<slug>)", () => {
    // mirrors the chunk anchors (`<doc>#/chunks[n]`) so the `#` reads the same for both;
    // ALWAYS the canonical `.yo` spelling — the id is a page-internal key (paths.ts)
    expect(fragmentAnchorId(":72-images:eiffel-tower:IMG.jpg", "mr0zbe2l-rqyow7"))
      .toBe("/.yo/fragments/mr0zbe2l-rqyow7");
    // root material: still leading-slashed
    expect(fragmentAnchorId(":", "abc")).toBe("/.yo/fragments/abc");
  });

  it("splitFragmentPath reads <host>:.yo:fragments:<slug> — the legacy `yo` spelling included", () => {
    expect(splitFragmentPath(":72-images:eiffel-tower:IMG.jpg:.yo:fragments:abc"))
      .toEqual({ host: ":72-images:eiffel-tower:IMG.jpg", slug: "abc" });
    expect(splitFragmentPath(":72-images:eiffel-tower:IMG.jpg:yo:fragments:abc"))
      .toEqual({ host: ":72-images:eiffel-tower:IMG.jpg", slug: "abc" });
    expect(splitFragmentPath(":68-math-chapter:0:yo:fragments:mqgwoar6-xbn407"))
      .toEqual({ host: ":68-math-chapter:0", slug: "mqgwoar6-xbn407" });
    expect(splitFragmentPath(":68-math-chapter")).toBeNull();
    expect(splitFragmentPath(":doc:yo:other:x")).toBeNull();
  });
});
