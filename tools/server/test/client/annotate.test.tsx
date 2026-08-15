// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, waitFor, act, fireEvent } from "@testing-library/react";

// fetchNode no longer rides a `?path=` query (the ONE WIRE fetches /api/content/<slash-path>),
// so the liveness probes are mocked at the API layer, routed by the SAME per-test route table.
const { fetchNode } = vi.hoisted(() => ({ fetchNode: vi.fn() }));
vi.mock("../../src/client/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), fetchNode }));

import { AnnotationMenu, AnnotatedMaterial, useAnnotations, useAnnotationMenu, DEFAULT_ONTO, copyText } from "../../src/client/renderers/annotate";

// The annotation layer's live-refresh + remembered-tag hygiene: external changes arrive as a
// `yamlover:diff` window event (App re-broadcasts SSE diffs), and localStorage recents are
// pruned against the server so a deleted tag cannot linger as a clickable badge.

const ALIVE = { path: ":ontos:alive", name: "alive", color: null };
const DEAD = { path: ":ontos:dead", name: "dead", color: null };
const RECENT_KEY = "yo-annotate-recent-tags";

/** Route fetches by their decoded `path` query param; undefined → a 404 {error} response.
 *  `fetchNode` (the pruning/liveness probes) is mocked off the same table: a listed path
 *  resolves to its NodeJson, an unlisted one rejects like the old 404 did. */
function mockFetch(routes: Record<string, unknown>): ReturnType<typeof vi.fn> {
  fetchNode.mockImplementation(async (p: string) => {
    const hit = routes[p];
    if (hit === undefined) throw new Error("no such node");
    return hit as never;
  });
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

beforeEach(() => {
  localStorage.clear();
  fetchNode.mockReset().mockRejectedValue(new Error("no routes — call mockFetch first"));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Probe({ path }: { path: string }) {
  const anns = useAnnotations(path);
  return <output>{anns.length}</output>;
}

describe("useAnnotations live refresh", () => {
  it("refetches when a diff touches a .yo file (an external delete clears the marks)", async () => {
    const routes: Record<string, unknown> = { "annotations::img.png": [{ path: ":annotations:a1.yo" }] };
    const fetchFn = mockFetch(routes);
    const { container } = render(<Probe path=":img.png" />);
    await waitFor(() => expect(container.querySelector("output")!.textContent).toBe("1"));

    routes["annotations::img.png"] = []; // the annotation file vanished server-side
    act(() => {
      window.dispatchEvent(new CustomEvent("yamlover:diff", {
        detail: { paths: [":annotations:a1.yo"], removed: [":annotations:a1.yo"] },
      }));
    });
    await waitFor(() => expect(container.querySelector("output")!.textContent).toBe("0"));
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("ignores diffs that touch no .yo file (a photo import must not refetch)", async () => {
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
    // (The last-used tag is no longer in localStorage — it lives in settings.yo, IMPORTS.md —
    // so only the recents list is pruned here.)
    localStorage.setItem(RECENT_KEY, JSON.stringify([ALIVE, DEAD]));
    mockFetch({ ":ontos:alive": { path: ":ontos:alive", format: "x-yamlover-onto", value: {} } }); // /tags/dead → 404

    const { container } = render(
      <AnnotationMenu x={0} y={0} applied={[DEFAULT_ONTO]} mode="create" onPick={vi.fn()} onClose={vi.fn()} />,
    );
    const badges = () => [...container.querySelectorAll(".annotate-recents .tagtag")].map((b) => b.textContent);
    expect(badges()).toEqual(["alive", "dead"]); // stored list shows at once

    await waitFor(() => expect(badges()).toEqual(["alive"]));
    expect(JSON.parse(localStorage.getItem(RECENT_KEY)!)).toEqual([ALIVE]);
  });

  it("frames the assigned named tag (`sel`, like the selected color swatch)", async () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify([ALIVE, { path: ":ontos:other", name: "other", color: null }]));
    mockFetch({
      ":ontos:alive": { path: ":ontos:alive", format: "x-yamlover-onto", value: {} },
      ":ontos:other": { path: ":ontos:other", format: "x-yamlover-onto", value: {} },
    });

    const { container } = render(
      <AnnotationMenu x={0} y={0} applied={[ALIVE]} mode="edit" onPick={vi.fn()} onClose={vi.fn()} />,
    );
    const sel = () => [...container.querySelectorAll(".annotate-recents .tagtag.on")].map((b) => b.textContent);
    expect(sel()).toEqual(["alive"]); // only the assigned one is framed
  });

  it("shows the assigned named tag even when it aged out of the recents", async () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify([ALIVE]));
    mockFetch({ ":ontos:alive": { path: ":ontos:alive", format: "x-yamlover-onto", value: {} } });
    const assigned = { path: ":ontos:forgotten", name: "forgotten", color: null };

    const { container } = render(
      <AnnotationMenu x={0} y={0} applied={[assigned]} mode="edit" onPick={vi.fn()} onClose={vi.fn()} />,
    );
    const badges = [...container.querySelectorAll(".annotate-recents .tagtag")].map((b) => b.textContent);
    expect(badges).toEqual(["forgotten", "alive"]); // prepended, ahead of the recents
    expect(container.querySelector(".annotate-recents .tagtag.on")?.textContent).toBe("forgotten");
  });

  it("keeps a recent that exists even when it is NOT a tag-format node (any node can be a tag)", async () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify([{ path: ":notes", name: "notes", color: null }]));
    mockFetch({ ":notes": { path: ":notes", format: null, value: {} } }); // exists — that is enough

    const { container } = render(
      <AnnotationMenu x={0} y={0} applied={[DEFAULT_ONTO]} mode="create" onPick={vi.fn()} onClose={vi.fn()} />,
    );
    // liveness is EXISTENCE now: the non-tag node survives the prune (still a valid annotation ref)
    await new Promise((r) => setTimeout(r, 30));
    await waitFor(() => expect([...container.querySelectorAll(".annotate-recents .tagtag")].map((b) => b.textContent)).toEqual(["notes"]));
    expect(JSON.parse(localStorage.getItem(RECENT_KEY)!)).toEqual([{ path: ":notes", name: "notes", color: null }]);
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
      tag: { path: ":ontos:green", name: "green", color: "#0f0" },
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

describe("selection never annotates page chrome", () => {
  /** Drop a left-button text selection from `start` to `end` and release, the way the create menu
   *  listens for it. */
  const selectAndRelease = (container: HTMLElement, start: Node, so: number, end: Node, eo: number) => {
    const sel = window.getSelection()!;
    const r = document.createRange();
    r.setStart(start, so);
    r.setEnd(end, eo);
    // jsdom stubs neither; the create handler reads a rect to place the menu
    (r as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () => ({ left: 10, bottom: 10 }) as DOMRect;
    sel.removeAllRanges();
    sel.addRange(r);
    fireEvent.mouseUp(container.querySelector(".annotated > div")!, { button: 0, clientX: 10, clientY: 10 });
  };

  it("selecting a chunk's §N gutter does NOT open the tag menu", async () => {
    mockFetch({});
    const { container } = render(
      <AnnotatedMaterial path=":doc">
        <div className="chunk" data-node-path=":doc[1]">
          <a className="chunk-index" href="#[1]">§0</a>
          <div className="chunk-body"><p>real prose here</p></div>
        </div>
      </AnnotatedMaterial>,
    );
    const gutter = container.querySelector(".chunk-index")!.firstChild!;
    selectAndRelease(container, gutter, 0, gutter, 2);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(container.querySelector(".annotate-menu")).toBeNull();
  });

  it("selecting a `data-yo-chrome` technical note does NOT open the tag menu", async () => {
    mockFetch({});
    const { container } = render(
      <AnnotatedMaterial path=":doc">
        <p className="chapter-prose">body <span className="chapter-link-note" data-yo-chrome>failed to load</span></p>
      </AnnotatedMaterial>,
    );
    const note = container.querySelector("[data-yo-chrome]")!.firstChild!;
    selectAndRelease(container, note, 0, note, 6);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(container.querySelector(".annotate-menu")).toBeNull();
  });

  it("selecting real prose STILL opens it (the guard is scoped to chrome)", async () => {
    mockFetch({});
    const { container } = render(
      <AnnotatedMaterial path=":doc"><p className="chapter-prose">hello world foo</p></AnnotatedMaterial>,
    );
    const text = container.querySelector("p")!.firstChild!;
    selectAndRelease(container, text, 6, text, 11); // "world"
    await waitFor(() => expect(container.querySelector(".annotate-menu")).not.toBeNull());
  });
});
