// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { DepthControl, viewDepth } from "../../src/client/renderers/depth";

afterEach(cleanup);
beforeEach(() => window.history.replaceState({}, "", "/")); // clear ?depth= between cases

describe("render-depth control (a discrete slider: 1 2 4 8 16 then ∞)", () => {
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
    expect((screen.getByTitle("depth") as HTMLInputElement).value).toBe("5"); // rightmost = ∞
    unmount();
    window.history.replaceState({}, "", "/?depth=8");
    render(<DepthControl onChange={vi.fn()} />);
    expect((screen.getByTitle("depth") as HTMLInputElement).value).toBe("3"); // stop index of 8
  });

  it("a URL depth off the stops snaps the KNOB only — viewDepth keeps the truth", () => {
    window.history.replaceState({}, "", "/?depth=5");
    render(<DepthControl onChange={vi.fn()} />);
    // 5 sits between 4 and 8 — nearest is 4 (index 2)
    expect((screen.getByTitle("depth") as HTMLInputElement).value).toBe("2");
    expect(viewDepth()).toBe(5);
  });

  it("a URL depth past the last finite stop rests the knob on 16, not ∞", () => {
    window.history.replaceState({}, "", "/?depth=100");
    render(<DepthControl onChange={vi.fn()} />);
    expect((screen.getByTitle("depth") as HTMLInputElement).value).toBe("4"); // stop index of 16
    expect(viewDepth()).toBe(100);
  });

  it("sliding to a finite stop writes its DEPTH (not its index) and fires onChange to refetch", () => {
    const onChange = vi.fn();
    render(<DepthControl onChange={onChange} />);
    const input = screen.getByTitle("depth") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "3" } });
    expect(viewDepth()).toBe(8);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("sliding to the last stop drops the param — infinity is the default", () => {
    const onChange = vi.fn();
    window.history.replaceState({}, "", "/?depth=8");
    render(<DepthControl onChange={onChange} />);
    fireEvent.change(screen.getByTitle("depth"), { target: { value: "5" } });
    expect(window.location.search).toBe(""); // default → no ?depth=
    expect(viewDepth()).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("shows the tick labels 1 2 4 8 16 and ∞ under the track", () => {
    const { container } = render(<DepthControl onChange={vi.fn()} />);
    const ticks = container.querySelector(".depth-ticks")!;
    expect(ticks.textContent).toBe("124816∞");
  });
});
