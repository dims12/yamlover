// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Render } from "../../src/client/render";

afterEach(cleanup);

describe("Render", () => {
  it("renders scalars as YAML", () => {
    render(<Render value={{ name: "Alice", n: 5, ok: true }} syntax="yaml" onNavigate={() => {}} />);
    const txt = document.body.textContent ?? "";
    expect(txt).toContain("name");
    expect(txt).toContain("Alice");
    expect(txt).toContain("5");
    expect(txt).toContain("true");
  });

  it("renders an object link marker as a labelled hyperlink that navigates", () => {
    const onNav = vi.fn();
    render(
      <Render
        value={{ child: { $yamloverLink: { kind: "object", count: 3, path: ":child" } } }}
        syntax="yaml"
        onNavigate={onNav}
      />,
    );
    const link = screen.getByText("{ object with 3 properties }");
    expect(link.getAttribute("href")).toBe(":child");
    fireEvent.click(link);
    expect(onNav).toHaveBeenCalledWith(":child");
  });

  it("labels array/binary markers and handles singular/plural", () => {
    render(
      <Render
        value={{
          a: { $yamloverLink: { kind: "array", count: 1, path: ":a" } },
          b: { $yamloverLink: { kind: "binary", size: 1234, path: ":b" } },
          c: { $yamloverLink: { kind: "object", count: 1, path: ":c" } },
        }}
        syntax="yaml"
        onNavigate={() => {}}
      />,
    );
    expect(screen.getByText("[ array with 1 item ]")).toBeTruthy();
    expect(screen.getByText("< binary of 1234 bytes >")).toBeTruthy();
    expect(screen.getByText("{ object with 1 property }")).toBeTruthy();
  });

  it("renders a scalar link by its value (syntax-aware) as a navigating hyperlink", () => {
    const onNav = vi.fn();
    // null → `~` in YAML
    const { rerender } = render(
      <Render
        value={{ seth: { $yamloverLink: { kind: "scalar", value: null, path: ":adam:seth" } } }}
        syntax="yaml"
        onNavigate={onNav}
      />,
    );
    const yamlLink = screen.getByText("~");
    expect(yamlLink.tagName).toBe("A");
    expect(yamlLink.getAttribute("href")).toBe(":adam:seth");
    fireEvent.click(yamlLink);
    expect(onNav).toHaveBeenCalledWith(":adam:seth");

    // null → `null`, string quoted in JSON
    rerender(
      <Render
        value={{ seth: { $yamloverLink: { kind: "scalar", value: null, path: ":adam:seth" } }, name: { $yamloverLink: { kind: "scalar", value: "Alice", path: ":name" } } }}
        syntax="json"
        onNavigate={onNav}
      />,
    );
    expect(screen.getByText("null").tagName).toBe("A");
    expect(screen.getByText('"Alice"').tagName).toBe("A");
  });

  it("renders a binary payload as a YAML !!binary block", () => {
    render(
      <Render
        value={{ $yamloverBinary: { format: "image/png", size: 9, base64: "iVBORw0KGgo" } }}
        syntax="yaml"
        onNavigate={() => {}}
      />,
    );
    const txt = document.body.textContent ?? "";
    expect(txt).toContain("!!binary");
    expect(txt).toContain("image/png");
    expect(txt).toContain("iVBORw0KGgo");
  });

  it("renders a rel ref as a hyperlink to its resolved path", () => {
    const onNav = vi.fn();
    render(
      <Render
        value={{ "x-yamlover": { rel: { mother: { $yamloverRef: { text: ":eve", path: ":eve" } } } } }}
        syntax="yaml"
        onNavigate={onNav}
      />,
    );
    const link = screen.getByText(":eve");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe(":eve");
    fireEvent.click(link);
    expect(onNav).toHaveBeenCalledWith(":eve");
  });

  it("renders an unresolved rel ref as plain text (no link)", () => {
    render(
      <Render
        value={{ rel: { ghost: { $yamloverRef: { text: "*anchor", path: null } } } }}
        syntax="yaml"
        onNavigate={() => {}}
      />,
    );
    const el = screen.getByText("*anchor");
    expect(el.tagName).not.toBe("A");
  });

  it("renders JSON syntax with quoted keys/strings", () => {
    render(<Render value={{ name: "Alice" }} syntax="json" onNavigate={() => {}} />);
    const txt = document.body.textContent ?? "";
    expect(txt).toContain('"name"');
    expect(txt).toContain('"Alice"');
  });

  it("shows an inline nested container expanded by default, and folds it to a summary on toggle (YAML)", () => {
    render(<Render value={{ outer: { inner: "deep" } }} syntax="yaml" onNavigate={() => {}} />);
    // expanded by default: the nested value is visible
    expect(screen.getByText("inner")).toBeTruthy();
    expect(screen.getByText("deep")).toBeTruthy();
    // a fold toggle exists; click it to collapse
    const toggle = document.querySelector("button.fold-gutter") as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    fireEvent.click(toggle);
    // collapsed: children gone, an in-place summary shown (not a navigating hyperlink)
    expect(screen.queryByText("inner")).toBeNull();
    const summary = screen.getByText("{ 1 property }");
    expect(summary.tagName).not.toBe("A");
    // toggling back restores the children
    fireEvent.click(document.querySelector("button.fold-gutter") as HTMLButtonElement);
    expect(screen.getByText("inner")).toBeTruthy();
  });

  it("marks the YAML array dash with its own class so it can be styled distinctly", () => {
    render(<Render value={{ list: ["a", "b"] }} syntax="yaml" onNavigate={() => {}} />);
    const dashes = document.querySelectorAll(".yaml-dash");
    expect(dashes).toHaveLength(2); // one per array item
    expect(dashes[0].textContent).toBe("-");
  });

  it("renders an array of objects in compact YAML block style — first key on the dash line, not wrapped below", () => {
    render(<Render value={{ pets: [{ name: "Rex", species: "dog" }] }} syntax="yaml" onNavigate={() => {}} />);
    const txt = document.body.textContent ?? "";
    expect(txt).toContain("- name:"); // dash and first key share the line (like JetBrains / real YAML)
    expect(txt).not.toMatch(/-\s*\n\s*name/); // NOT a bare dash then the key wrapped onto the next line
    expect(screen.getByText("Rex")).toBeTruthy();
    expect(screen.getByText("species")).toBeTruthy(); // the rest of the mapping still renders
  });

  it("folds an inline nested array to an item-count summary (JSON)", () => {
    render(<Render value={{ list: [1, 2, 3] }} syntax="json" onNavigate={() => {}} />);
    fireEvent.click(document.querySelector("button.fold-gutter") as HTMLButtonElement);
    expect(screen.getByText("[ 3 items ]")).toBeTruthy();
  });

  it("renders a NESTED mixed/omni marker as an omni block (not a literal $yamloverMixed key)", () => {
    render(
      <Render
        value={{ file: { $yamloverMixed: { kind: "omni", value: null, entries: [{ key: "tag", value: "x" }] } } }}
        syntax="yaml"
        onNavigate={() => {}}
      />,
    );
    const txt = document.body.textContent ?? "";
    expect(txt).not.toContain("$yamloverMixed"); // the marker is interpreted, not shown raw
    expect(screen.getByText("tag")).toBeTruthy(); // its field renders
    // folding it shows the omni summary
    fireEvent.click(document.querySelector("button.fold-gutter") as HTMLButtonElement);
    expect(screen.getByText("{ variant ~ + 1 field }")).toBeTruthy();
  });

  it("keeps a continuation link marker a navigating hyperlink, not a fold toggle", () => {
    const onNav = vi.fn();
    render(
      <Render
        value={{ child: { $yamloverLink: { kind: "object", count: 2, path: ":child" } } }}
        syntax="yaml"
        onNavigate={onNav}
      />,
    );
    expect(document.querySelector("button.fold-gutter")).toBeNull(); // a link marker is not collapsible
    const link = screen.getByText("{ object with 2 properties }");
    expect(link.tagName).toBe("A");
    fireEvent.click(link);
    expect(onNav).toHaveBeenCalledWith(":child");
  });
});
