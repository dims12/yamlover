// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { rtfToHtml } from "../../src/client/renderers/rtf";
import { getRenderer } from "../../src/client/renderers/registry";
import type { NodeJson } from "../../src/client/api";

const bin = (format: string): NodeJson => ({
  path: ":f",
  type: "binary",
  format,
  concrete: null,
  title: null,
  description: null,
  value: "",
});

describe("rtfToHtml", () => {
  it("wraps \\par-separated text in paragraphs", () => {
    expect(rtfToHtml(String.raw`{\rtf1 one\par two\par}`)).toBe("<p>one</p>\n<p>two</p>");
  });

  it("renders bold/italic/underline runs and closes them at group scope", () => {
    const html = rtfToHtml(String.raw`{\rtf1 a {\b bold} {\i it} {\ul ul} z\par}`);
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>it</em>");
    expect(html).toContain("<u>ul</u>");
    expect(html).toContain("z"); // styling does not leak past the group
    expect(html).not.toContain("<strong>z");
  });

  it("skips non-content destination groups (fonttbl, info, …)", () => {
    const html = rtfToHtml(String.raw`{\rtf1{\fonttbl{\f0 Helvetica;}}{\info{\title X}}hello\par}`);
    expect(html).toBe("<p>hello</p>");
  });

  it("decodes \\'xx (CP-1252) and \\uN Unicode escapes", () => {
    const BS = String.fromCharCode(92); // a literal backslash (avoids u-escapes in this source)
    expect(rtfToHtml(`{${BS}rtf1 caf${BS}'e9${BS}par}`)).toBe("<p>café</p>");
    // the euro sign via a u8364 escape; its single fallback char (?) is then skipped
    expect(rtfToHtml(`{${BS}rtf1 ${BS}u8364 ?${BS}par}`)).toBe("<p>€</p>");
  });

  it("escapes HTML in the text (no markup injection)", () => {
    expect(rtfToHtml(String.raw`{\rtf1 a < b & c\par}`)).toBe("<p>a &lt; b &amp; c</p>");
  });
});

describe("office renderer registry", () => {
  it("selects a renderer for each office (type, format)", () => {
    expect(getRenderer(bin("application/rtf"))?.name).toBe("rtf");
    expect(getRenderer(bin("application/msword"))?.name).toBe("doc");
    expect(getRenderer(bin("application/vnd.openxmlformats-officedocument.wordprocessingml.document"))?.name).toBe("docx");
    expect(getRenderer(bin("application/vnd.ms-excel"))?.name).toBe("spreadsheet");
    expect(getRenderer(bin("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))?.name).toBe("spreadsheet");
  });

  it("every office renderer offers an inline chunk form (so it can sit in a chapter)", () => {
    for (const f of [
      "application/rtf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ])
      expect(getRenderer(bin(f))?.renderChunk, `${f} needs renderChunk`).toBeTypeOf("function");
  });
});
