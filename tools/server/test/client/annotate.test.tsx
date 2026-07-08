// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, waitFor, act, fireEvent } from "@testing-library/react";
import { AnnotationMenu, AnnotatedMaterial, useAnnotations, useAnnotationMenu, DEFAULT_TAG, copyText } from "../../src/client/renderers/annotate";

// The annotation layer's live-refresh + remembered-tag hygiene: external changes arrive as a
// `yamlover:diff` window event (App re-broadcasts SSE diffs), and localStorage recents are
// pruned against the server so a deleted tag cannot linger as a clickable badge.

const ALIVE = { path: ":tags:alive", name: "alive", color: null };
const DEAD = { path: ":tags:dead", name: "dead", color: null };
const RECENT_KEY = "yo-annotate-recent-tags";

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
  it("drops recents whose node is gone; live ones stay", async () => {
    // (The last-used tag is no longer in localStorage — it lives in settings.yamlover, IMPORTS.md —
    // so only the recents list is pruned here.)
    localStorage.setItem(RECENT_KEY, JSON.stringify([ALIVE, DEAD]));
    mockFetch({ ":tags:alive": { path: ":tags:alive", format: "x-yamlover-tag", value: {} } }); // /tags/dead → 404

    const { container } = render(
      <AnnotationMenu x={0} y={0} applied={[DEFAULT_TAG]} mode="create" onPick={vi.fn()} onClose={vi.fn()} />,
    );
    const badges = () => [...container.querySelectorAll(".annotate-recents .tagtag")].map((b) => b.textContent);
    expect(badges()).toEqual(["alive", "dead"]); // stored list shows at once

    await waitFor(() => expect(badges()).toEqual(["alive"]));
    expect(JSON.parse(localStorage.getItem(RECENT_KEY)!)).toEqual([ALIVE]);
  });

  it("frames the assigned named tag (`sel`, like the selected color swatch)", async () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify([ALIVE, { path: ":tags:other", name: "other", color: null }]));
    mockFetch({
      ":tags:alive": { path: ":tags:alive", format: "x-yamlover-tag", value: {} },
      ":tags:other": { path: ":tags:other", format: "x-yamlover-tag", value: {} },
    });

    const { container } = render(
      <AnnotationMenu x={0} y={0} applied={[ALIVE]} mode="edit" onPick={vi.fn()} onClose={vi.fn()} />,
    );
    const sel = () => [...container.querySelectorAll(".annotate-recents .tagtag.on")].map((b) => b.textContent);
    expect(sel()).toEqual(["alive"]); // only the assigned one is framed
  });

  it("shows the assigned named tag even when it aged out of the recents", async () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify([ALIVE]));
    mockFetch({ ":tags:alive": { path: ":tags:alive", format: "x-yamlover-tag", value: {} } });
    const assigned = { path: ":tags:forgotten", name: "forgotten", color: null };

    const { container } = render(
      <AnnotationMenu x={0} y={0} applied={[assigned]} mode="edit" onPick={vi.fn()} onClose={vi.fn()} />,
    );
    const badges = [...container.querySelectorAll(".annotate-recents .tagtag")].map((b) => b.textContent);
    expect(badges).toEqual(["forgotten", "alive"]); // prepended, ahead of the recents
    expect(container.querySelector(".annotate-recents .tagtag.on")?.textContent).toBe("forgotten");
  });

  it("keeps a recent that exists but only while it IS a tag node", async () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify([{ path: ":notes", name: "notes", color: null }]));
    mockFetch({ ":notes": { path: ":notes", format: null, value: {} } }); // exists, not a tag

    const { container } = render(
      <AnnotationMenu x={0} y={0} applied={[DEFAULT_TAG]} mode="create" onPick={vi.fn()} onClose={vi.fn()} />,
    );
    await waitFor(() => expect(container.querySelectorAll(".annotate-recents .tagtag")).toHaveLength(0));
    expect(JSON.parse(localStorage.getItem(RECENT_KEY)!)).toEqual([]);
  });
});

describe("region window (title from the fragment path)", () => {
  it("openEdit titles the window with the clicked fragment's path (the bug: it was blank)", async () => {
    vi.stubGlobal("fetch", mockFetch({})); // all internal lookups 404 → hooks fall back quietly
    const material = { annotations: [], create: vi.fn(), remove: vi.fn(), annotateRegion: vi.fn() };
    let menu: ReturnType<typeof useAnnotationMenu>;
    function Harness() {
      menu = useAnnotationMenu(material as never, ":img.png");
      return <>{menu.palette}</>;
    }
    const { container } = render(<Harness />);
    act(() => menu.openEdit({ selector: { type: "rect" }, tag: { path: ":t", name: "t", color: null }, fragmentSlug: "abc123" }, { x: 5, y: 5 }));
    await waitFor(() => expect(container.querySelector(".annotate-titlebar")).not.toBeNull());
    const title = container.querySelector(".annotate-title")!.textContent!;
    expect(title).toContain("yamlover-fragments"); // the fragment's node path, not blank
    expect(title).toContain("abc123");
    // the close ✕ sits at the top-right, OUTSIDE the path cell (a sibling in the top bar)
    expect(container.querySelector(".annotate-topbar button.close")).not.toBeNull();
    expect(container.querySelector(".annotate-titlebar button.close")).toBeNull();
    // the path is wrapped in <bdi> for LEFT-truncation (right tail visible)
    expect(container.querySelector(".annotate-title bdi")).not.toBeNull();
  });
});

describe("chunk text highlighting (prefix/suffix anchoring + per-chunk scope)", () => {
  it("marks the SELECTED occurrence in the RIGHT chunk — not a same-word match in the title or another chunk", async () => {
    // the reported bug: tagging the 2nd "word" (in a chunk) used to mark the 1st (in the title)
    const ann = {
      node: ":doc[1]",
      selector: { type: "text", exact: "word", prefix: "the ", suffix: " appears" },
      fragmentSlug: "f1",
      tag: { path: ":tags:green", name: "green", color: "#0f0" },
    };
    mockFetch({ "annotations::doc": [ann] });
    const { container } = render(
      <AnnotatedMaterial path=":doc">
        <h1 className="chapter-title">A word in the title</h1>
        <div className="chunk" data-node-path=":doc[1]"><p>the word appears here</p></div>
        <div className="chunk" data-node-path=":doc[2]"><p>another word elsewhere</p></div>
      </AnnotatedMaterial>,
    );
    // the mark lands in the [1] chunk, on ITS "word"
    await waitFor(() => expect(container.querySelector('[data-node-path=":doc[1]"] mark.yo-annotation')).not.toBeNull());
    expect(container.querySelector('[data-node-path=":doc[1]"] mark.yo-annotation')!.textContent).toBe("word");
    // NOT the title, NOT the other chunk
    expect(container.querySelector("h1 mark.yo-annotation")).toBeNull();
    expect(container.querySelector('[data-node-path=":doc[2]"] mark.yo-annotation')).toBeNull();
  });
});

describe('"copy text to clipboard (don\'t annotate)" works in secure AND insecure contexts', () => {
  const origClipboard = Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard")
    ?? Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const origExec = document.execCommand;
  const setClipboard = (v: unknown) => Object.defineProperty(navigator, "clipboard", { value: v, configurable: true });
  afterEach(() => {
    if (origClipboard) Object.defineProperty(navigator, "clipboard", { ...origClipboard, configurable: true });
    else delete (navigator as { clipboard?: unknown }).clipboard;
    document.execCommand = origExec;
  });

  it("uses navigator.clipboard.writeText in a secure context (https / localhost)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    expect(await copyText("hello")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to execCommand when navigator.clipboard is undefined (plain-HTTP LAN access)", async () => {
    setClipboard(undefined); // the insecure-context reality that made the button silently no-op
    const exec = vi.fn().mockReturnValue(true);
    document.execCommand = exec as typeof document.execCommand;
    expect(await copyText("plain http")).toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
  });

  it("falls back to execCommand when writeText rejects (permission/focus denied)", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    setClipboard({ writeText });
    const exec = vi.fn().mockReturnValue(true);
    document.execCommand = exec as typeof document.execCommand;
    expect(await copyText("retry")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("retry");
    expect(exec).toHaveBeenCalledWith("copy");
  });
});

describe("text material right-click", () => {
  it("right-clicking a live selection opens the tag window (titled with the material path)", async () => {
    mockFetch({}); // no existing annotations; region create fetches 404 silently
    const { container } = render(
      <AnnotatedMaterial path=":doc"><p className="chapter-prose">hello world foo</p></AnnotatedMaterial>,
    );
    const textNode = container.querySelector("p")!.firstChild!;
    const sel = window.getSelection()!;
    const r = document.createRange();
    r.setStart(textNode, 6);
    r.setEnd(textNode, 11); // "world"
    sel.removeAllRanges();
    sel.addRange(r);
    const inner = container.querySelector(".annotated > div") as HTMLElement;
    fireEvent.contextMenu(inner, { clientX: 10, clientY: 10 });
    await waitFor(() => expect(container.querySelector(".annotate-menu")).not.toBeNull());
    expect(container.querySelector(".annotate-title")?.textContent).toContain("doc");
  });
});
