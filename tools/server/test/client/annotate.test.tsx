// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, waitFor, act, fireEvent } from "@testing-library/react";

// fetchNode no longer rides a `?path=` query (the ONE WIRE fetches /api/content/<slash-path>),
// so the liveness probes are mocked at the API layer, routed by the SAME per-test route table.
const { fetchNode } = vi.hoisted(() => ({ fetchNode: vi.fn() }));
vi.mock("../../src/client/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), fetchNode }));

import { AnnotationMenu, AnnotatedMaterial, useAnnotations, useAnnotationMenu, DEFAULT_ONTO, copyText } from "../../src/client/renderers/annotate";
import { _resetRecentsCacheForTests } from "../../src/client/recents";

// The annotation layer's live-refresh + remembered-tag hygiene: external changes arrive as a
// `yamlover:diff` window event (App re-broadcasts SSE diffs), and localStorage recents are
// pruned against the server so a deleted tag cannot linger as a clickable badge.

const ALIVE = { path: ":ontos:alive", name: "alive", color: null };
const DEAD = { path: ":ontos:dead", name: "dead", color: null };
// the PER-PROJECT recents key (recents.ts): /api/config and /api/info both 404 under
// mockFetch, so the project key resolves to the "local" fallback in every test here
const RECENT_KEY = "yo-recents:bookmarks:local";

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
  _resetRecentsCacheForTests();
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
    await waitFor(() => expect(badges()).toEqual(["alive"])); // the dead one pruned away
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
    const sel = () => [...container.querySelectorAll(".annotate-applied .tagtag.on")].map((b) => b.textContent);
    expect(sel()).toEqual(["alive"]); // only the assigned one is framed, in the APPLIED row
  });

  it("shows the assigned named tag even when it aged out of the recents", async () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify([ALIVE]));
    mockFetch({ ":ontos:alive": { path: ":ontos:alive", format: "x-yamlover-onto", value: {} } });
    const assigned = { path: ":ontos:forgotten", name: "forgotten", color: null };

    const { container } = render(
      <AnnotationMenu x={0} y={0} applied={[assigned]} mode="edit" onPick={vi.fn()} onClose={vi.fn()} />,
    );
    // the assigned tag stands in the APPLIED row (outlined) even though it aged out of the
    // bag; the surviving recent stays in the suggestion pane below
    await waitFor(() => expect([...container.querySelectorAll(".annotate-recents .tagtag")].map((b) => b.textContent)).toEqual(["alive"]));
    expect([...container.querySelectorAll(".annotate-applied .tagtag")].map((b) => b.textContent)).toEqual(["forgotten"]);
    expect(container.querySelector(".annotate-applied .tagtag.on")?.textContent).toBe("forgotten");
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

describe("region window (the yamlover-shaped header)", () => {
  it("openEdit shows the fragment's KEY in the header (`key:`), the full path as the tooltip", async () => {
    vi.stubGlobal("fetch", mockFetch({})); // all internal lookups 404 → hooks fall back quietly
    const material = { annotations: [], create: vi.fn(), remove: vi.fn(), annotateRegion: vi.fn() };
    let menu: ReturnType<typeof useAnnotationMenu>;
    function Harness() {
      menu = useAnnotationMenu(material as never, ":img.png");
      return <>{menu.palette}</>;
    }
    const { container } = render(<Harness />);
    act(() => menu.openEdit({ selector: { type: "rect" }, tag: { path: ":t", name: "t", color: null }, fragmentSlug: "abc123" }, { x: 5, y: 5 }));
    await waitFor(() => expect(container.querySelector(".annotate-topbar")).not.toBeNull());
    const bar = container.querySelector(".annotate-topbar") as HTMLElement;
    expect(bar.title).toContain("yo"); // the fragment's node path rides the tooltip
    expect(bar.title).toContain("abc123");
    // the header spells `key:` — the fragment's slug in the key field, the uneditable colon after
    expect((container.querySelector(".annotate-key") as HTMLInputElement).value).toBe("abc123");
    expect(container.querySelector(".annotate-colon")?.textContent).toBe(":");
    // the entry row below leads with the uneditable `&` sigil
    expect(container.querySelector(".annotate-entry .annotate-amp")?.textContent).toBe("&");
    // the ⏎ apply and ✕ close sit docked at the header's right
    expect(container.querySelector(".annotate-topbar button.ok")).not.toBeNull();
    expect(container.querySelector(".annotate-topbar button.close")).not.toBeNull();
  });

  it("renaming the KEY of an existing fragment rekeys it in place", async () => {
    vi.stubGlobal("fetch", mockFetch({ ":img.png:.yo:fragments:named": { path: ":img.png:.yo:fragments:named" } }));
    const material = { annotations: [], create: vi.fn(), remove: vi.fn(), annotateRegion: vi.fn() };
    let menu: ReturnType<typeof useAnnotationMenu>;
    function Harness() {
      menu = useAnnotationMenu(material as never, ":img.png");
      return <>{menu.palette}</>;
    }
    const { container } = render(<Harness />);
    act(() => menu.openEdit({ selector: { type: "rect" }, tag: { path: ":t", name: "t", color: null }, fragmentSlug: "abc123" }, { x: 5, y: 5 }));
    await waitFor(() => expect(container.querySelector(".annotate-key")).not.toBeNull());
    const key = container.querySelector(".annotate-key") as HTMLInputElement;
    const rekeyed = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/rekey")) {
        rekeyed(JSON.parse(String(init?.body)));
        return { ok: true, status: 200, json: async () => ({ path: ":img.png:.yo:fragments:named" }) } as Response;
      }
      return { ok: false, status: 404, json: async () => ({ error: "no" }) } as Response;
    }));
    fireEvent.change(key, { target: { value: "named" } });
    fireEvent.keyDown(key, { key: "Enter" });
    await waitFor(() => expect(rekeyed).toHaveBeenCalledWith({ path: ":img.png:.yo:fragments:abc123", key: "named" }));
    await waitFor(() => expect((container.querySelector(".annotate-topbar") as HTMLElement).title).toContain("named"));
  });

  it("a FRESH region's typed key becomes the fragment's slug at the first pick", async () => {
    vi.stubGlobal("fetch", mockFetch({}));
    const annotateRegion = vi.fn();
    const material = { annotations: [], create: vi.fn(), remove: vi.fn(), annotateRegion };
    let menu: ReturnType<typeof useAnnotationMenu>;
    function Harness() {
      menu = useAnnotationMenu(material as never, ":img.png");
      return <>{menu.palette}</>;
    }
    const { container } = render(<Harness />);
    act(() => menu.openCreate({ type: "rect" }, { x: 5, y: 5 }));
    await waitFor(() => expect(container.querySelector(".annotate-key")).not.toBeNull());
    const key = container.querySelector(".annotate-key") as HTMLInputElement;
    expect(key.value).toBe(""); // unborn — no key yet, the placeholder invites one
    fireEvent.change(key, { target: { value: "my region" } });
    fireEvent.keyDown(key, { key: "Enter" });
    // the first pick carries the chosen name as the fragment slug
    act(() => {
      const chip = container.querySelector(".annotate-swatch") as HTMLElement;
      fireEvent.click(chip);
    });
    expect(annotateRegion).toHaveBeenCalledTimes(1);
    expect(annotateRegion.mock.calls[0][2]).toMatchObject({ slug: "my region" });
  });

  it("the dialog leads with the path entry, then applied, then the recents pane, palette", async () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify([{ path: ":ontos:some", name: "some", color: null }]));
    mockFetch({ ":ontos:some": { path: ":ontos:some", value: {} } });
    const { container } = render(
      <AnnotationMenu x={0} y={0} applied={[ALIVE]} mode="create" onPick={vi.fn()} onClose={vi.fn()} />,
    );
    await waitFor(() => expect(container.querySelector(".annotate-bag")).not.toBeNull());
    const menu = container.querySelector(".annotate-menu")!;
    const order = [...menu.children].map((el) => el.className.split(" ")[0]);
    const at = (cls: string) => order.indexOf(cls);
    expect(at("annotate-topbar")).toBe(0);
    expect(at("annotate-entry")).toBeGreaterThan(at("annotate-topbar")); // the `& <path>` row
    expect(at("annotate-applied")).toBeGreaterThan(at("annotate-entry"));
    expect(at("annotate-bag")).toBeGreaterThan(at("annotate-applied"));
    expect(at("annotate-palette")).toBeGreaterThan(at("annotate-bag"));
  });

  it("the recents pane CLOSES to its header and the preference is remembered", async () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify([{ path: ":ontos:some", name: "some", color: null }]));
    mockFetch({ ":ontos:some": { path: ":ontos:some", value: {} } });
    const { container } = render(
      <AnnotationMenu x={0} y={0} applied={[]} mode="create" onPick={vi.fn()} onClose={vi.fn()} />,
    );
    await waitFor(() => expect(container.querySelectorAll(".annotate-recents .tagtag").length).toBe(1));
    fireEvent.click(container.querySelector(".annotate-bag-close")!);
    expect(container.querySelectorAll(".annotate-recents .tagtag").length).toBe(0); // collapsed…
    expect(container.querySelector(".annotate-bag-toggle")!.textContent).toContain("recent"); // …to its header
    expect(localStorage.getItem("yo-recents-pane:picker")).toBe("off");
    fireEvent.click(container.querySelector(".annotate-bag-toggle")!); // the header reopens it
    expect(container.querySelectorAll(".annotate-recents .tagtag").length).toBe(1);
    expect(localStorage.getItem("yo-recents-pane:picker")).toBe("on");
  });

  it("ESCAPE closes the popup (the dropdown first when it is open)", async () => {
    mockFetch({});
    const onClose = vi.fn();
    render(<AnnotationMenu x={0} y={0} applied={[]} mode="create" onPick={vi.fn()} onClose={onClose} />);
    // no dropdown up: the FIRST Escape closes the window — from any host (TOC menu, prose,
    // a PDF region), since the listener rides the document in CAPTURE
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ENTER with NOTHING TYPED confirms and closes (after a TOC pick the entry stands empty)", async () => {
    mockFetch({});
    const onClose = vi.fn();
    const { container } = render(<AnnotationMenu x={0} y={0} applied={[]} mode="create" onPick={vi.fn()} onClose={onClose} />);
    await waitFor(() => expect(container.querySelector(".annotate-cells .crumb-cell")).not.toBeNull());
    const cell = [...container.querySelectorAll<HTMLElement>(".annotate-cells .crumb-cell")].pop()!;
    fireEvent.focus(cell);
    // empty entry — Enter is "done", never a dead key (the reported can't-press-Enter)
    fireEvent.keyDown(cell, { key: "Enter" });
    expect(onClose).toHaveBeenCalledTimes(1);
    // …but with TEXT typed, Enter belongs to the cells (it applies the query)
    onClose.mockClear();
    cell.textContent = "done";
    fireEvent.input(cell);
    fireEvent.keyDown(cell, { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
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
    expect((container.querySelector(".annotate-topbar") as HTMLElement).title).toContain("doc");
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

  // GETTING THE TEXT OUT. Opening the popup plants the caret in its query cells, which takes the
  // browser's one selection with it — so a plain Ctrl+C has nothing to copy, and the ⧉ button was
  // the only way. These pin the two halves of the fix.
  describe("copying the selected text", () => {
    const openOn = async (container: HTMLElement) => {
      const text = container.querySelector("p")!.firstChild!;
      selectAndRelease(container, text, 6, text, 11); // "world"
      await waitFor(() => expect(container.querySelector(".annotate-menu")).not.toBeNull());
    };

    it("Ctrl+C copies the captured text while the popup stands", async () => {
      mockFetch({});
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
      const { container } = render(
        <AnnotatedMaterial path=":doc"><p className="chapter-prose">hello world foo</p></AnnotatedMaterial>,
      );
      await openOn(container);
      // the popup already took the selection — exactly the state a real user is in
      window.getSelection()!.removeAllRanges();
      fireEvent.keyDown(document, { key: "c", ctrlKey: true });
      await waitFor(() => expect(writeText).toHaveBeenCalledWith("world"));
    });

    it("Cmd+C does the same, and a bare C does not", async () => {
      mockFetch({});
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
      const { container } = render(
        <AnnotatedMaterial path=":doc"><p className="chapter-prose">hello world foo</p></AnnotatedMaterial>,
      );
      await openOn(container);
      window.getSelection()!.removeAllRanges();
      fireEvent.keyDown(document, { key: "c" });
      expect(writeText).not.toHaveBeenCalled();
      fireEvent.keyDown(document, { key: "c", metaKey: true });
      await waitFor(() => expect(writeText).toHaveBeenCalledWith("world"));
    });

    it("stands aside for a field the user is editing — that Ctrl+C is theirs", async () => {
      mockFetch({});
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
      const { container } = render(
        <AnnotatedMaterial path=":doc"><p className="chapter-prose">hello world foo</p></AnnotatedMaterial>,
      );
      await openOn(container);
      window.getSelection()!.removeAllRanges();
      const key = container.querySelector(".annotate-key") as HTMLInputElement;
      fireEvent.change(key, { target: { value: "typed name" } });
      key.focus();
      key.setSelectionRange(0, 5);
      fireEvent.keyDown(document, { key: "c", ctrlKey: true });
      expect(writeText).not.toHaveBeenCalled();
    });

    it("copies the WHOLE cross-chunk selection, not just one chunk's share", async () => {
      mockFetch({});
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
      const { container } = render(
        <AnnotatedMaterial path=":doc">
          <div className="chunk" data-node-path=":doc[1]"><p>alpha beta</p></div>
          <div className="chunk" data-node-path=":doc[2]"><p>gamma delta</p></div>
        </AnnotatedMaterial>,
      );
      const a = container.querySelectorAll("p")[0].firstChild!;
      const b = container.querySelectorAll("p")[1].firstChild!;
      selectAndRelease(container, a, 6, b, 5); // "beta" … "gamma"
      await waitFor(() => expect(container.querySelector(".annotate-menu")).not.toBeNull());
      window.getSelection()!.removeAllRanges();
      fireEvent.keyDown(document, { key: "c", ctrlKey: true });
      await waitFor(() => expect(writeText).toHaveBeenCalledWith("betagamma"));
    });

    // The ✓/✕ pair is this window's commit and dismiss; a third button between them reads as a
    // third member of the pair.
    it("docks copy OUTSIDE the apply/close pair", async () => {
      mockFetch({});
      const { container } = render(
        <AnnotatedMaterial path=":doc"><p className="chapter-prose">hello world foo</p></AnnotatedMaterial>,
      );
      await openOn(container);
      const tools = [...container.querySelectorAll(".annotate-topbar button")].map((b) => b.className.split(" ").pop());
      expect(tools).toEqual(["copy", "ok", "close"]);
    });
  });

  // A selection crossing chunks used to be captured as a text fragment whose `exact` was both
  // chunks' text run together — a string present in neither, so the preview mark could never be
  // drawn and the selection simply vanished with nothing to say what would be bookmarked.
  describe("a selection spanning several chunks", () => {
    const twoChunks = (
      <AnnotatedMaterial path=":doc">
        <div className="chunk" data-node-path=":doc[1]"><p>alpha beta</p></div>
        <div className="chunk" data-node-path=":doc[2]"><p>gamma delta</p></div>
      </AnnotatedMaterial>
    );

    const spanTwo = (container: HTMLElement) => {
      const a = container.querySelectorAll("p")[0].firstChild!;
      const b = container.querySelectorAll("p")[1].firstChild!;
      selectAndRelease(container, a, 6, b, 5); // "beta" … "gamma"
    };

    it("becomes a W3C range: each end quoted in its OWN chunk", async () => {
      mockFetch({});
      const annotateRegion = vi.fn();
      const material = { annotations: [], create: vi.fn(), remove: vi.fn(), annotateRegion };
      let menu: ReturnType<typeof useAnnotationMenu>;
      function Harness() {
        menu = useAnnotationMenu(material as never, ":doc");
        return <>{menu.palette}</>;
      }
      render(<Harness />);
      // drive the hook the way AnnotatedMaterial does for a cross-chunk selection
      act(() =>
        menu.openCreate(
          {
            type: "range",
            startSelector: { type: "text", exact: "beta", prefix: "alpha ", suffix: "" },
            endSelector: { type: "text", exact: "gamma", prefix: "", suffix: " delta" },
          },
          { x: 5, y: 5 },
          undefined,
          undefined,
          ":doc",
        ),
      );
      await waitFor(() => expect(menu!.preview).not.toBeNull());
      expect(menu!.preview!.selector.type).toBe("range");
      // the material, not either chunk — a range belongs to the node that contains both
      expect(menu!.preview!.node).toBe(":doc");
    });

    it("captures both ends from the live selection and hangs the fragment off the material", async () => {
      mockFetch({});
      const { container } = render(twoChunks);
      spanTwo(container);
      await waitFor(() => expect(container.querySelector(".annotate-menu")).not.toBeNull());
      // the header names the MATERIAL — either chunk on its own would be the wrong home
      const bar = container.querySelector(".annotate-topbar") as HTMLElement;
      expect(bar.title).toBe(": doc");
    });

    it("draws the whole span, every chunk between the ends included", async () => {
      mockFetch({});
      const { container } = render(twoChunks);
      spanTwo(container);
      await waitFor(() => expect(container.querySelectorAll("mark.yo-annotation").length).toBeGreaterThan(0));
      // the preview marks BOTH ends — the selection stays visible instead of disappearing
      const marked = [...container.querySelectorAll("mark.yo-annotation")].map((m) => m.textContent).join("|");
      expect(marked).toContain("beta");
      expect(marked).toContain("gamma");
      // …and never bleeds past the end quote
      expect(marked).not.toContain("delta");
    });

    it("a selection inside ONE chunk is still an ordinary text fragment", async () => {
      mockFetch({});
      const { container } = render(twoChunks);
      const a = container.querySelectorAll("p")[0].firstChild!;
      selectAndRelease(container, a, 6, a, 10); // "beta"
      await waitFor(() => expect(container.querySelector(".annotate-menu")).not.toBeNull());
      const bar = container.querySelector(".annotate-topbar") as HTMLElement;
      expect(bar.title).toBe(": doc: 1"); // the chunk, not the material
    });
  });
});
