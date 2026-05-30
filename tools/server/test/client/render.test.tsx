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
        value={{ child: { $yamloverLink: { kind: "object", count: 3, path: "/child" } } }}
        syntax="yaml"
        onNavigate={onNav}
      />,
    );
    const link = screen.getByText("{ object with 3 properties }");
    expect(link.getAttribute("href")).toBe("/child");
    fireEvent.click(link);
    expect(onNav).toHaveBeenCalledWith("/child");
  });

  it("labels array/binary markers and handles singular/plural", () => {
    render(
      <Render
        value={{
          a: { $yamloverLink: { kind: "array", count: 1, path: "/a" } },
          b: { $yamloverLink: { kind: "binary", size: 1234, path: "/b" } },
          c: { $yamloverLink: { kind: "object", count: 1, path: "/c" } },
        }}
        syntax="yaml"
        onNavigate={() => {}}
      />,
    );
    expect(screen.getByText("[ array with 1 item ]")).toBeTruthy();
    expect(screen.getByText("< binary of 1234 bytes >")).toBeTruthy();
    expect(screen.getByText("{ object with 1 property }")).toBeTruthy();
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

  it("renders JSON syntax with quoted keys/strings", () => {
    render(<Render value={{ name: "Alice" }} syntax="json" onNavigate={() => {}} />);
    const txt = document.body.textContent ?? "";
    expect(txt).toContain('"name"');
    expect(txt).toContain('"Alice"');
  });
});
