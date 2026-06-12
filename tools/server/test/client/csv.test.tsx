// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { parseDelimited, CsvView, CsvControls } from "../../src/client/renderers/csv";
import { getRenderer } from "../../src/client/renderers/registry";
import type { NodeJson } from "../../src/client/api";

afterEach(cleanup);

const node = (value: string, format = "text/csv"): NodeJson => ({
  path: ":data",
  type: "string",
  format,
  concrete: null,
  title: null,
  description: null,
  value,
});

describe("parseDelimited", () => {
  it("splits rows and fields on the separator", () => {
    expect(parseDelimited("a,b\n1,2", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("honours quoted fields containing the separator and newlines", () => {
    expect(parseDelimited('a,"b,c"\n"line\n2",x', ",")).toEqual([
      ["a", "b,c"],
      ["line\n2", "x"],
    ]);
  });

  it("treats a doubled quote inside a quoted field as a literal quote", () => {
    expect(parseDelimited('"she said ""hi"""', ",")).toEqual([['she said "hi"']]);
  });

  it("handles CRLF line endings and ignores a trailing newline", () => {
    expect(parseDelimited("a,b\r\n1,2\r\n", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("splits on a tab for TSV", () => {
    expect(parseDelimited("a\tb\n1\t2", "\t")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("csv renderer", () => {
  it("is selected for (string, text/csv) and (string, text/tab-separated-values)", () => {
    expect(getRenderer(node("a,b"))?.name).toBe("csv");
    expect(getRenderer(node("a\tb", "text/tab-separated-values"))?.name).toBe("csv");
    expect(getRenderer(node("a,b"))?.renderChunk).toBeTypeOf("function"); // usable as a chapter chunk
  });

  it("renders a header row and body cells, auto-detecting the separator", () => {
    window.history.replaceState({}, "", "/data?format=csv");
    const { container } = render(<CsvView node={node("name;city\nAlice;Berlin")} />);
    const heads = [...container.querySelectorAll("thead th")].map((e) => e.textContent);
    expect(heads).toEqual(["name", "city"]); // ';' auto-detected
    const firstCell = container.querySelector("tbody td");
    expect(firstCell?.textContent).toBe("Alice");
  });

  it("reads the separator and header flag from the URL query", () => {
    window.history.replaceState({}, "", "/data?format=csv&sep=,&header=false");
    const { container } = render(<CsvView node={node("a,b\n1,2")} />);
    expect(container.querySelector("thead")).toBeNull(); // header=false → no header row
    expect(container.querySelectorAll("tbody tr").length).toBe(2);
  });

  it("a node-bar control change writes the option back into the URL", () => {
    window.history.replaceState({}, "", "/data?format=csv");
    const { container } = render(<CsvControls rerender={() => {}} />);
    fireEvent.click(container.querySelector('input[type="checkbox"]')!); // turn header off
    expect(new URLSearchParams(window.location.search).get("header")).toBe("false");
    expect(window.location.pathname).toBe("/data"); // path preserved (URL stays slash)
  });

  it("the csv renderer exposes the controls as its node-bar config", () => {
    expect(getRenderer(node("a,b"))?.config).toBeTypeOf("function");
  });
});
