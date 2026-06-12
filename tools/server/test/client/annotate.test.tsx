// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, waitFor, act } from "@testing-library/react";
import { AnnotationMenu, useAnnotations, DEFAULT_TAG } from "../../src/client/renderers/annotate";

// The annotation layer's live-refresh + remembered-tag hygiene: external changes arrive as a
// `yamlover:diff` window event (App re-broadcasts SSE diffs), and localStorage recents are
// pruned against the server so a deleted tag cannot linger as a clickable badge.

const ALIVE = { path: ":tags:alive", name: "alive", color: null };
const DEAD = { path: ":tags:dead", name: "dead", color: null };
const RECENT_KEY = "yo-annotate-recent-tags";
const TAG_KEY = "yo-annotate-tag";

/** Route fetches by their decoded `path` query param; undefined → a 404 {error} response. */
function mockFetch(routes: Record<string, unknown>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const p = new URLSearchParams(url.split("?")[1] ?? "").get("path") ?? "";
    const hit = url.startsWith("/api/annotations")
      ? routes[`annotations:${p}`]
      : routes[p];
    return {
      ok: hit !== undefined,
      status: hit !== undefined ? 200 : 404,
      json: async () => (hit !== undefined ? hit : { error: "no such node" }),
    } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Probe({ path }: { path: string }) {
  const anns = useAnnotations(path);
  return <output>{anns.length}</output>;
}

describe("useAnnotations live refresh", () => {
  it("refetches when a diff touches a .yamlover file (an external delete clears the marks)", async () => {
    const routes: Record<string, unknown> = { "annotations::img.png": [{ path: ":annotations:a1.yamlover" }] };
    const fetchFn = mockFetch(routes);
    const { container } = render(<Probe path=":img.png" />);
    await waitFor(() => expect(container.querySelector("output")!.textContent).toBe("1"));

    routes["annotations::img.png"] = []; // the annotation file vanished server-side
    act(() => {
      window.dispatchEvent(new CustomEvent("yamlover:diff", {
        detail: { paths: [":annotations:a1.yamlover"], removed: [":annotations:a1.yamlover"] },
      }));
    });
    await waitFor(() => expect(container.querySelector("output")!.textContent).toBe("0"));
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("ignores diffs that touch no .yamlover file (a photo import must not refetch)", async () => {
    const fetchFn = mockFetch({ "annotations::img.png": [] });
    render(<Probe path=":img.png" />);
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(new CustomEvent("yamlover:diff", {
        detail: { paths: [":photos:new.jpg"], removed: [] },
      }));
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("AnnotationMenu remembered-tag pruning", () => {
  it("drops recents (and the remembered tag) whose node is gone; live ones stay", async () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify([ALIVE, DEAD]));
    localStorage.setItem(TAG_KEY, JSON.stringify(DEAD));
    mockFetch({ ":tags:alive": { path: ":tags:alive", format: "x-yamlover-tag", value: {} } }); // /tags/dead → 404

    const { container } = render(
      <AnnotationMenu x={0} y={0} tag={DEFAULT_TAG} mode="create" onPick={vi.fn()} onTrash={vi.fn()} />,
    );
    const badges = () => [...container.querySelectorAll(".annotate-recents .tagtag")].map((b) => b.textContent);
    expect(badges()).toEqual(["alive", "dead"]); // stored list shows at once

    await waitFor(() => expect(badges()).toEqual(["alive"]));
    expect(JSON.parse(localStorage.getItem(RECENT_KEY)!)).toEqual([ALIVE]);
    await waitFor(() => expect(localStorage.getItem(TAG_KEY)).toBeNull());
  });

  it("frames the assigned named tag (`sel`, like the selected color swatch)", async () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify([ALIVE, { path: ":tags:other", name: "other", color: null }]));
    mockFetch({
      ":tags:alive": { path: ":tags:alive", format: "x-yamlover-tag", value: {} },
      ":tags:other": { path: ":tags:other", format: "x-yamlover-tag", value: {} },
    });

    const { container } = render(
      <AnnotationMenu x={0} y={0} tag={ALIVE} mode="edit" onPick={vi.fn()} onTrash={vi.fn()} />,
    );
    const sel = () => [...container.querySelectorAll(".annotate-recents .tagframe.sel")].map((b) => b.textContent);
    expect(sel()).toEqual(["alive"]); // only the assigned one is framed
  });

  it("shows the assigned named tag even when it aged out of the recents", async () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify([ALIVE]));
    mockFetch({ ":tags:alive": { path: ":tags:alive", format: "x-yamlover-tag", value: {} } });
    const assigned = { path: ":tags:forgotten", name: "forgotten", color: null };

    const { container } = render(
      <AnnotationMenu x={0} y={0} tag={assigned} mode="edit" onPick={vi.fn()} onTrash={vi.fn()} />,
    );
    const badges = [...container.querySelectorAll(".annotate-recents .tagtag")].map((b) => b.textContent);
    expect(badges).toEqual(["forgotten", "alive"]); // prepended, ahead of the recents
    expect(container.querySelector(".annotate-recents .tagframe.sel")?.textContent).toBe("forgotten");
  });

  it("keeps a recent that exists but only while it IS a tag node", async () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify([{ path: ":notes", name: "notes", color: null }]));
    mockFetch({ ":notes": { path: ":notes", format: null, value: {} } }); // exists, not a tag

    const { container } = render(
      <AnnotationMenu x={0} y={0} tag={DEFAULT_TAG} mode="create" onPick={vi.fn()} onTrash={vi.fn()} />,
    );
    await waitFor(() => expect(container.querySelectorAll(".annotate-recents .tagtag")).toHaveLength(0));
    expect(JSON.parse(localStorage.getItem(RECENT_KEY)!)).toEqual([]);
  });
});
