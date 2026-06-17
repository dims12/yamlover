// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { DepthControl, viewDepth, DEFAULT_DEPTH } from "../../src/client/renderers/depth";

afterEach(cleanup);
beforeEach(() => window.history.replaceState({}, "", "/")); // clear ?depth= between cases

describe("render-depth control", () => {
  it("defaults to 2 and reads ?depth= from the URL (out-of-range ignored)", () => {
    expect(viewDepth()).toBe(DEFAULT_DEPTH);
    window.history.replaceState({}, "", "/?depth=4");
    expect(viewDepth()).toBe(4);
    window.history.replaceState({}, "", "/?depth=99"); // above MAX → default
    expect(viewDepth()).toBe(DEFAULT_DEPTH);
    window.history.replaceState({}, "", "/?depth=0"); // below MIN → default
    expect(viewDepth()).toBe(DEFAULT_DEPTH);
  });

  it("writes a valid depth to the URL and fires onChange to refetch", () => {
    const onChange = vi.fn();
    render(<DepthControl onChange={onChange} />);
    const input = screen.getByTitle("depth") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "5" } });
    expect(viewDepth()).toBe(5);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("drops the param (back to default) when set to 2, and ignores an invalid value", () => {
    const onChange = vi.fn();
    window.history.replaceState({}, "", "/?depth=5");
    render(<DepthControl onChange={onChange} />);
    const input = screen.getByTitle("depth") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2" } });
    expect(window.location.search).toBe(""); // default → no ?depth=
    expect(viewDepth()).toBe(DEFAULT_DEPTH);
    onChange.mockClear();
    fireEvent.change(input, { target: { value: "abc" } });
    expect(onChange).not.toHaveBeenCalled(); // invalid → not applied
    expect(input.className).toContain("invalid");
  });
});
