// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { DepthControl, viewDepth } from "../../src/client/renderers/depth";

afterEach(cleanup);
beforeEach(() => window.history.replaceState({}, "", "/")); // clear ?depth= between cases

describe("render-depth control (a discrete slider: 1..6 then ∞)", () => {
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

  it("rests at the LAST stop (∞) by default and reflects a URL depth on mount", () => {
    const { unmount } = render(<DepthControl onChange={vi.fn()} />);
    expect((screen.getByTitle("depth") as HTMLInputElement).value).toBe("7"); // rightmost = ∞
    unmount();
    window.history.replaceState({}, "", "/?depth=5");
    render(<DepthControl onChange={vi.fn()} />);
    expect((screen.getByTitle("depth") as HTMLInputElement).value).toBe("5");
  });

  it("a URL depth past the finite stops clamps the KNOB only — viewDepth keeps the truth", () => {
    window.history.replaceState({}, "", "/?depth=12");
    render(<DepthControl onChange={vi.fn()} />);
    expect((screen.getByTitle("depth") as HTMLInputElement).value).toBe("6");
    expect(viewDepth()).toBe(12);
  });

  it("sliding to a finite stop writes the URL and fires onChange to refetch", () => {
    const onChange = vi.fn();
    render(<DepthControl onChange={onChange} />);
    const input = screen.getByTitle("depth") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "5" } });
    expect(viewDepth()).toBe(5);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("sliding to the last stop drops the param — infinity is the default", () => {
    const onChange = vi.fn();
    window.history.replaceState({}, "", "/?depth=5");
    render(<DepthControl onChange={onChange} />);
    fireEvent.change(screen.getByTitle("depth"), { target: { value: "7" } });
    expect(window.location.search).toBe(""); // default → no ?depth=
    expect(viewDepth()).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("shows the tick labels 1..6 and ∞ under the track", () => {
    const { container } = render(<DepthControl onChange={vi.fn()} />);
    const ticks = container.querySelector(".depth-ticks")!;
    expect(ticks.textContent).toBe("123456∞");
  });
});
