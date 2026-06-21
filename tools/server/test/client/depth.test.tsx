// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { DepthControl, viewDepth } from "../../src/client/renderers/depth";

afterEach(cleanup);
beforeEach(() => window.history.replaceState({}, "", "/")); // clear ?depth= between cases

describe("render-depth control", () => {
  it("defaults to infinity (null) and reads ?depth= from the URL", () => {
    expect(viewDepth()).toBeNull(); // default = .inf
    window.history.replaceState({}, "", "/?depth=4");
    expect(viewDepth()).toBe(4);
    window.history.replaceState({}, "", "/?depth=.inf");
    expect(viewDepth()).toBeNull(); // explicit .inf
    window.history.replaceState({}, "", "/?depth=0"); // below MIN → default (inf)
    expect(viewDepth()).toBeNull();
    window.history.replaceState({}, "", "/?depth=abc"); // malformed → default (inf)
    expect(viewDepth()).toBeNull();
  });

  it("writes a valid finite depth to the URL and fires onChange to refetch", () => {
    const onChange = vi.fn();
    render(<DepthControl onChange={onChange} />);
    const input = screen.getByTitle("depth") as HTMLInputElement;
    expect(input.value).toBe(".inf"); // default shown
    fireEvent.change(input, { target: { value: "5" } });
    expect(viewDepth()).toBe(5);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("drops the param (back to .inf) when set to .inf, and ignores an invalid value", () => {
    const onChange = vi.fn();
    window.history.replaceState({}, "", "/?depth=5");
    render(<DepthControl onChange={onChange} />);
    const input = screen.getByTitle("depth") as HTMLInputElement;
    fireEvent.change(input, { target: { value: ".inf" } });
    expect(window.location.search).toBe(""); // default → no ?depth=
    expect(viewDepth()).toBeNull();
    onChange.mockClear();
    fireEvent.change(input, { target: { value: "abc" } });
    expect(onChange).not.toHaveBeenCalled(); // invalid → not applied
    expect(input.className).toContain("invalid");
  });
});
