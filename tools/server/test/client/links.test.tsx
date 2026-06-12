// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { resolveLink, NavLink } from "../../src/client/links";

afterEach(cleanup);

describe("resolveLink (the shared link interpreter)", () => {
  it("resolves `/path` relative to the document it appears in", () => {
    expect(resolveLink(":chunks[2]", ":examples:19-math").path).toBe(":examples:19-math:chunks[2]");
    expect(resolveLink(":children[0]:chunks[1]", ":doc").path).toBe(":doc:children[0]:chunks[1]");
  });

  it("resolves `//path` relative to the project (served) root", () => {
    expect(resolveLink("//examples/other", ":examples:19-math").path).toBe(":examples:other");
    expect(resolveLink("//a/b", ":anything").href).toBeNull();
  });

  it("treats a scheme target (http/https/mailto) as an external link", () => {
    expect(resolveLink("https://example.com/x", ":doc")).toEqual({ path: null, href: "https://example.com/x" });
    expect(resolveLink("mailto:a@b.c", ":doc").href).toBe("mailto:a@b.c");
  });

  it("does not resolve an empty or unrecognized target", () => {
    expect(resolveLink("", ":doc")).toEqual({ path: null, href: null });
    expect(resolveLink("relative/no/slash", ":doc")).toEqual({ path: null, href: null });
  });

  it("defaults the document anchor to root when none is given", () => {
    expect(resolveLink(":a:b").path).toBe(":a:b");
  });
});

describe("NavLink", () => {
  it("renders an internal `.descend` anchor that navigates on click", () => {
    const onNavigate = vi.fn();
    const { container } = render(
      <NavLink target=":chunks[1]" documentPath=":doc" onNavigate={onNavigate}>go</NavLink>,
    );
    const a = container.querySelector("a.descend") as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe(":doc:chunks[1]");
    fireEvent.click(a);
    expect(onNavigate).toHaveBeenCalledWith(":doc:chunks[1]");
  });

  it("renders an external `.extlink` that does not call onNavigate", () => {
    const onNavigate = vi.fn();
    const { container } = render(
      <NavLink target="https://example.com" documentPath=":doc" onNavigate={onNavigate}>site</NavLink>,
    );
    const a = container.querySelector("a.extlink") as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe("https://example.com");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(container.querySelector("a.descend")).toBeNull();
  });

  it("falls back to plain (non-clickable) children when the target doesn't resolve", () => {
    const { container } = render(<NavLink target="" onNavigate={() => {}}>label</NavLink>);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("label");
  });
});
