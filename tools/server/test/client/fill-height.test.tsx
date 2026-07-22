// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { useRef } from "react";
import { useFillHeight } from "../../src/client/renderers/paged";

// The PDF/DjVu scroll frame fills the window from its own measured TOP edge down to the bottom
// (minus the pane's bottom padding) — replacing the stylesheet's `calc(100vh - 160px)` guess,
// which left a dead band below the frame whenever the chrome above wasn't exactly 160px tall.

function Frame() {
  const ref = useRef<HTMLDivElement>(null);
  useFillHeight(ref);
  return <div className="filepdf" ref={ref} />;
}

afterEach(cleanup);

describe("useFillHeight — the viewer frame fills to the window bottom", () => {
  it("sizes the frame from its measured top edge and refits on window resize", () => {
    const { container } = render(<div className="pane"><Frame /></div>);
    const el = container.querySelector(".filepdf") as HTMLDivElement;
    // mounted with jsdom's zero layout: top 0 → innerHeight(768) - 0 - 14
    expect(el.style.height).toBe(`${window.innerHeight - 14}px`);
    // the bar above wraps taller (top edge moves down) — a resize re-measures
    el.getBoundingClientRect = () => ({ top: 100 } as DOMRect);
    window.dispatchEvent(new Event("resize"));
    expect(el.style.height).toBe(`${window.innerHeight - 100 - 14}px`);
  });

  it("never squeezes below the 360px usability floor", () => {
    const { container } = render(<div className="pane"><Frame /></div>);
    const el = container.querySelector(".filepdf") as HTMLDivElement;
    el.getBoundingClientRect = () => ({ top: window.innerHeight - 50 } as DOMRect);
    window.dispatchEvent(new Event("resize"));
    expect(el.style.height).toBe("360px");
  });
});
