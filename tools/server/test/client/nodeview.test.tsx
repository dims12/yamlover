// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";

vi.mock("../../src/client/api", () => ({
  fetchConfig: vi.fn().mockResolvedValue({ source: "", settings: { exports: [], annotations: ":annotations", tags: ":tags", sidecars: "per-directory" }, path: ":.yo:settings.yo" }),
  fetchNode: vi.fn(),
  fetchSchema: vi.fn(),
  fetchSource: vi.fn().mockResolvedValue({ source: "a: 1\n" }), // the yed mount's load
  editChunks: vi.fn().mockResolvedValue({ ok: true }),          // …and its flush
  fetchAnnotations: vi.fn().mockResolvedValue([]), // header badges hop via /api/annotations
  pasteFile: vi.fn(),
  pasteText: vi.fn(),
  pasteRich: vi.fn(),
}));
import { fetchNode, fetchSchema, pasteFile, pasteRich, pasteText } from "../../src/client/api";
import { NodeView } from "../../src/client/NodeView";

const mNode = fetchNode as unknown as ReturnType<typeof vi.fn>;
const mSchema = fetchSchema as unknown as ReturnType<typeof vi.fn>;
const mPasteFile = pasteFile as unknown as ReturnType<typeof vi.fn>;
const mPasteText = pasteText as unknown as ReturnType<typeof vi.fn>;
const mPasteRich = pasteRich as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mNode.mockReset();
  mSchema.mockReset();
  mPasteFile.mockReset();
  mPasteText.mockReset();
  mPasteRich.mockReset();
});
afterEach(cleanup);

describe("NodeView", () => {
  it("renders the value with a link marker and reports tab switches", async () => {
    mNode.mockResolvedValue({
      path: ":x.json",
      type: "object",
      concrete: "json", // a json-family file → the json5p tab is offered
      title: null,
      description: null,
      value: { name: "Alice", child: { $yamloverLink: { kind: "object", count: 2, path: ":x.json:child" } } },
    });
    const onFormat = vi.fn();
    render(<NodeView path=":x.json" format="yamlover" onFormat={onFormat} onNavigate={() => {}} />);

    expect(await screen.findByText("{ object with 2 properties }")).toBeTruthy();
    expect(screen.getByText("Alice")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "json5p" }));
    expect(onFormat).toHaveBeenCalledWith("json5p");
  });

  it("a data-file container exposes the unified tab bar in order and DEFAULTS to yamlover", async () => {
    mNode.mockResolvedValue({
      path: ":x.yaml", type: "object", concrete: "file/yaml", hasKeyed: true,
      title: null, description: null, value: { name: "Alice" },
    });
    // format="" is not a real tab → falls to the node's natural default (a data file → yamlover)
    render(<NodeView path=":x.yaml" format="" onFormat={() => {}} onNavigate={() => {}} />);
    expect(await screen.findByText("Alice")).toBeTruthy(); // the yamlover data view, by default
    // the unified bar, in order: icon views, the FIXED data views, then the trailing plaintext
    for (const t of ["thumbnails", "large icons", "small icons", "details", "yamlover", "json5p", "yamlover/schema", "plaintext"])
      expect(screen.getByRole("button", { name: t })).toBeTruthy();
    // yaml is not json-family: the json5p tab stays IN PLACE (a stable bar), just disabled
    expect((screen.getByRole("button", { name: "json5p" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "yamlover" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "plaintext" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a PDF page shows the SAME families as a directory — the explorer tabs in place, disabled", async () => {
    // the user's case: `/?format=large-icons` (a dir) vs `/x.pdf?format=pdf` must not differ in
    // the tab families — only the single leading primary slot (pdf) is node-specific
    mNode.mockResolvedValue({ path: ":a.pdf", type: "binary", format: "application/pdf", concrete: "file/binary", title: null, description: null, value: null });
    render(<NodeView path=":a.pdf" format="yamlover" onFormat={() => {}} onNavigate={() => {}} />);
    await screen.findByRole("button", { name: "pdf" });
    expect((screen.getByRole("button", { name: "pdf" }) as HTMLButtonElement).disabled).toBe(false);
    for (const t of ["thumbnails", "large icons", "small icons", "details"])
      expect((screen.getByRole("button", { name: t }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a directory keeps the raw-source tab in place, DISABLED; a .txt never doubles it", async () => {
    mNode.mockResolvedValue({ path: ":d", type: "object", concrete: "dir", title: null, description: null,
      value: { f: { $yamloverLink: { kind: "object", type: "object", path: ":d:f", count: 1 } } } });
    const r1 = render(<NodeView path=":d" format="large-icons" onFormat={() => {}} onNavigate={() => {}} />);
    await screen.findByRole("button", { name: "plaintext" });
    expect((screen.getByRole("button", { name: "plaintext" }) as HTMLButtonElement).disabled).toBe(true);
    r1.unmount();
    // a .txt LEADS with plaintext — exactly ONE plaintext tab (the leading renderer's), enabled.
    // (Shown in the yamlover data view: the bar is the same and no real blob fetch is mounted.)
    mNode.mockResolvedValue({ path: ":a.txt", type: "binary", format: "text/plain", concrete: "file/binary", title: null, description: null, value: null });
    render(<NodeView path=":a.txt" format="yamlover" onFormat={() => {}} onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "plaintext" })).toHaveLength(1));
    expect((screen.getByRole("button", { name: "plaintext" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("fetches a DATA view at the ?depth= setting, but a RENDERER at its OWN depth (regression: the explorer needs depth 1)", async () => {
    window.history.replaceState({}, "", "/?depth=6"); // a high data-view depth setting
    try {
      // (1) a data view (plain object → yamlover tab) honours the setting → deep fetch at 6
      mNode.mockResolvedValue({ path: ":x", type: "object", concrete: null, title: null, description: null, value: { a: 1 } });
      const r1 = render(<NodeView path=":x" format="yamlover" onFormat={() => {}} onNavigate={() => {}} />);
      await waitFor(() => expect(mNode).toHaveBeenCalledWith(":x", 6));
      r1.unmount();

      // (2) the explorer (a directory) gets its OWN depth 1 — NEVER the setting — so its members stay
      // `$yamloverLink` markers (navigable, icons, thumbnails). No deeper refetch at all.
      mNode.mockReset();
      mNode.mockResolvedValue({ path: ":d", type: "object", concrete: "dir", title: null, description: null,
        value: { f: { $yamloverLink: { kind: "object", type: "object", path: ":d:f", count: 1 } } } });
      const r2 = render(<NodeView path=":d" format="large-icons" onFormat={() => {}} onNavigate={() => {}} />);
      await waitFor(() => expect(mNode).toHaveBeenCalledWith(":d"));
      expect(mNode).not.toHaveBeenCalledWith(":d", 6);
      expect(mNode).not.toHaveBeenCalledWith(":d", expect.any(Number)); // only the depth-1 fetch
      r2.unmount();

      // (3) a chapter gets its own depth 1 (its body elements are direct children), not the setting 6.
      // A FILE-backed chapter's settle fetch is unlimited, so it refetches at exactly 1.
      mNode.mockReset();
      mNode.mockResolvedValue({ path: ":c", type: "variant", format: "x-yamlover-chapter", concrete: "file/yamlover",
        title: null, description: null, value: { $yamloverMixed: { kind: "mix", entries: [] } } });
      render(<NodeView path=":c" format="chapter" onFormat={() => {}} onNavigate={() => {}} />);
      await waitFor(() => expect(mNode).toHaveBeenCalledWith(":c", 1));
      expect(mNode).not.toHaveBeenCalledWith(":c", 6);

      // (4) an INLINE-DATA container (a yamlover-concrete fragment / sub-object — NOT a directory)
      // shown in the explorer MUST refetch at depth 1. Its settle fetch used the server's per-concrete
      // default, which for inline data is UNLIMITED — so members would inline as raw scalars / refs
      // instead of `$yamloverLink` markers and stop being navigable (the облако-tag fragment bug).
      mNode.mockReset();
      mNode.mockResolvedValue({ path: ":frag", type: "object", format: "x-yamlover-fragment", concrete: "yamlover",
        title: null, description: null, value: { type: "rect" } });
      render(<NodeView path=":frag" format="large-icons" onFormat={() => {}} onNavigate={() => {}} />);
      await waitFor(() => expect(mNode).toHaveBeenCalledWith(":frag", 1)); // explicit depth-1 refetch
      expect(mNode).not.toHaveBeenCalledWith(":frag", 6);
    } finally {
      window.history.replaceState({}, "", "/");
    }
  });

  it("a DIRECTORY-backed chapter's DATA view refetches at .inf — the full document, not the depth-1 settle", async () => {
    // regression: a dir chapter settled at depth 1, where its body items arrive as `$yamloverLink`
    // markers and a multiline chunk rendered as invalid inline multiline text. No `?depth=` → default `.inf`.
    window.history.replaceState({}, "", "/");
    mNode.mockReset();
    mNode.mockResolvedValue({ path: ":66", type: "variant", format: "x-yamlover-chapter", concrete: "dir/yamlover",
      title: null, description: null, value: { $yamloverMixed: { kind: "mix", entries: [] } } });
    render(<NodeView path=":66" format="yamlover" onFormat={() => {}} onNavigate={() => {}} />);
    await waitFor(() => expect(mNode).toHaveBeenCalledWith(":66", null)); // .inf refetch past the depth-1 settle
  });

  it("ENABLES the json5p tab only for a json-family file — elsewhere it stays in place, disabled", async () => {
    mNode.mockResolvedValue({
      path: ":x", type: "object", concrete: "dir/yamlover", title: null, description: null, value: { name: "Alice" },
    });
    render(<NodeView path=":x" format="yamlover" onFormat={() => {}} onNavigate={() => {}} />);
    await screen.findByText("Alice");
    expect((screen.getByRole("button", { name: "json5p" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "yamlover" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "yamlover/schema" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the relations panel (standard-title hyperlinks) above the value in a data view", async () => {
    mNode.mockResolvedValue({
      path: ":adam:cain",
      type: "object",
      concrete: "yaml-schema/instantiate",
      title: null,
      description: null,
      value: { enoch: { $yamloverLink: { kind: "object", count: 0, path: ":adam:cain:enoch" } } },
      relations: {
        father: { $yamloverLink: { kind: "object", count: 3, path: ":adam" } },
        mother: { $yamloverLink: { kind: "object", count: 3, path: ":eve" } },
      },
    });
    const onNav = vi.fn();
    render(<NodeView path=":adam:cain" format="yaml" onFormat={() => {}} onNavigate={onNav} />);

    // both relations render with the target's standard title (not a path)
    const links = await screen.findAllByText("{ object with 3 properties }");
    expect(links).toHaveLength(2);
    expect((links[0] as HTMLAnchorElement).getAttribute("href")).toBe(":adam");
    fireEvent.click(links[1]);
    expect(onNav).toHaveBeenCalledWith(":eve");

    expect(screen.getByText("mother")).toBeTruthy();
    expect(document.querySelector("hr.reldiv")).toBeTruthy(); // divider above the value
    expect(screen.getByText("enoch")).toBeTruthy(); // value still rendered below
  });

  it("does not show the relations panel in a schema view", async () => {
    mNode.mockResolvedValue({
      path: ":adam:cain",
      type: "object",
      concrete: "yaml-schema/instantiate",
      title: null,
      description: null,
      value: { enoch: null },
      relations: { "..": { $yamloverLink: { kind: "object", count: 3, path: ":adam" } } },
    });
    mSchema.mockResolvedValue({ type: "object", properties: { enoch: { const: null } } });
    render(<NodeView path=":adam:cain" format="yamlover/schema" onFormat={() => {}} onNavigate={() => {}} />);
    await screen.findByText("enoch");
    expect(document.querySelector("hr.reldiv")).toBeNull();
  });

  it("loads and shows a binary leaf as !!binary only when viewed", async () => {
    mNode.mockImplementation((_p: string, _d?: number, opts?: { binary?: boolean }) =>
      Promise.resolve(
        opts?.binary
          ? {
              path: ":img",
              type: "binary",
              concrete: "file/binary",
              title: null,
              description: null,
              value: { $yamloverBinary: { format: "image/png", size: 5, base64: "iVBOR" } },
            }
          : {
              path: ":img",
              type: "binary",
              concrete: "file/binary",
              title: null,
              description: null,
              value: "<binary image/png, 5 bytes>",
            },
      ),
    );
    render(<NodeView path=":img" format="yaml" onFormat={() => {}} onNavigate={() => {}} />);
    expect(await screen.findByText(/!!binary/)).toBeTruthy();
  });

  it("renders the instance schema in the yamlover/schema tab", async () => {
    mNode.mockResolvedValue({ path: ":x", type: "object", concrete: "dir/yamlover", title: null, description: null, value: {} });
    mSchema.mockResolvedValue({ type: "object", properties: { name: { const: "Alice" } } });
    render(<NodeView path=":x" format="yamlover/schema" onFormat={() => {}} onNavigate={() => {}} />);
    expect(await screen.findByText("Alice")).toBeTruthy();
  });

  it("sets the document title to `<schema title> - <ancestor path>` when the node has one", async () => {
    // a dir-concrete node now defaults to the explorer view (an empty grid here)
    mNode.mockResolvedValue({ path: ":book", type: "object", concrete: "dir/yamlover", title: "My Book", description: null, value: {} });
    render(<NodeView path=":book" format="yaml" rootLabel="examples" onFormat={() => {}} onNavigate={() => {}} />);
    await screen.findByText("empty");
    expect(document.title).toBe("My Book - examples");
  });

  it("falls back to the node's path name when it has no title", async () => {
    mNode.mockResolvedValue({ path: ":chapters[2]", type: "object", concrete: "dir/yamlover", title: null, description: null, value: {} });
    render(<NodeView path=":chapters[2]" format="yaml" rootLabel="examples" onFormat={() => {}} onNavigate={() => {}} />);
    await screen.findByText("empty");
    expect(document.title).toBe("2 - examples: chapters");
  });

  it("the ancestor path drops its separator while the root label hasn't loaded yet", async () => {
    mNode.mockResolvedValue({ path: ":a:b", type: "object", concrete: "dir/yamlover", title: null, description: null, value: {} });
    render(<NodeView path=":a:b" format="yaml" onFormat={() => {}} onNavigate={() => {}} />);
    await screen.findByText("empty");
    expect(document.title).toBe("b - a");
  });

  it("the root (no path) shows its title alone", async () => {
    mNode.mockResolvedValue({ path: ":", type: "object", concrete: "dir/yamlover", title: "My Root", description: null, value: {} });
    render(<NodeView path=":" format="yaml" onFormat={() => {}} onNavigate={() => {}} />);
    await screen.findByText("empty");
    expect(document.title).toBe("My Root");
  });

  it("a titleless root falls back to the CLI ROOT's label (the TOC's first row)", async () => {
    mNode.mockResolvedValue({ path: ":", type: "object", concrete: "dir/yamlover", title: null, description: null, value: {} });
    render(<NodeView path=":" format="yaml" rootLabel="yamlover-examples" onFormat={() => {}} onNavigate={() => {}} />);
    await screen.findByText("empty");
    expect(document.title).toBe("yamlover-examples");
  });

  it("an editable (chapter) page shows a captioned Edit toggle leading the buttons (after the chips) that unlocks on click", async () => {
    mNode.mockResolvedValue({ path: ":c", type: "variant", format: "x-yamlover-chapter", concrete: "file/yamlover",
      title: "Doc", description: null, value: { $yamloverMixed: { kind: "mix", entries: [{ key: "title", value: "Doc" }] } } });
    render(<NodeView path=":c" format="chapter" onFormat={() => {}} onNavigate={() => {}} />);

    // read-only: the toggle reads "Edit", is not pressed, and is the LEFTMOST button (before the tabs)
    const edit = await screen.findByRole("button", { name: /Edit/ });
    expect(edit.classList.contains("lockbtn")).toBe(true);
    expect(edit.getAttribute("aria-pressed")).toBe("false");
    const buttons = [...document.querySelectorAll(".nodehead button")];
    expect(buttons[0]).toBe(edit); // leftmost of the buttons — before the representation tabs
    // …but it sits AFTER the type/concrete chips: the chips (.nodemeta) precede it in the bar
    const meta = document.querySelector(".nodemeta")!;
    expect(meta.compareDocumentPosition(edit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // clicking unlocks: the caption flips to "Done" and aria-pressed goes true
    fireEvent.click(edit);
    const done = await screen.findByRole("button", { name: /Done/ });
    expect(done.getAttribute("aria-pressed")).toBe("true");
  });

  it("a .yo data page shows the Edit toggle; unlocking mounts YED (the default editor)", async () => {
    mNode.mockResolvedValue({ path: ":x.yo", type: "object", concrete: "file/yamlover", hasKeyed: true, title: null, description: null, value: { a: 1 } });
    render(<NodeView path=":x.yo" format="yamlover" onFormat={() => {}} onNavigate={() => {}} />);
    await screen.findByText("a");
    const edit = await screen.findByRole("button", { name: /Edit/ });
    expect(edit.classList.contains("lockbtn")).toBe(true);
    // LOCKED: the scalar is read-only (a plain highlighted span, not contentEditable).
    // Scope to the code pane — the depth slider's tick labels also spell digits.
    const scalar = () => within(document.querySelector("pre.code, .yed") as HTMLElement).getByText("1");
    expect(scalar().getAttribute("contenteditable")).toBeNull();
    // UNLOCK: the yed cell projection takes the pane (loaded via the mocked /api/source)
    fireEvent.click(edit);
    await screen.findByRole("button", { name: /Done/ });
    await waitFor(() => expect(document.querySelector("[data-testid=y2-doc]")).toBeTruthy());
  });

  it("…and `?yedEditor=legacy` still unlocks the DEPRECATED inline editor", async () => {
    window.history.replaceState({}, "", "/?yedEditor=legacy");
    try {
      mNode.mockResolvedValue({ path: ":x.yo", type: "object", concrete: "file/yamlover", hasKeyed: true, title: null, description: null, value: { a: 1 } });
      render(<NodeView path=":x.yo" format="yamlover" onFormat={() => {}} onNavigate={() => {}} />);
      await screen.findByText("a");
      const edit = await screen.findByRole("button", { name: /Edit/ });
      fireEvent.click(edit);
      await screen.findByRole("button", { name: /Done/ });
      const field = within(document.querySelector("pre.code, .yed") as HTMLElement).getByText("1");
      expect(field.getAttribute("contenteditable")).toBe("true");
      expect(field.classList.contains("editable")).toBe(true);
    } finally {
      window.history.replaceState({}, "", "/");
    }
  });

  it("the derived schema view is read-only — the Edit toggle stays IN PLACE, disabled", async () => {
    mNode.mockResolvedValue({ path: ":x.yo", type: "object", concrete: "file/yamlover", hasKeyed: true, title: null, description: null, value: { a: 1 } });
    mSchema.mockResolvedValue({ widgetkey: "wv" });
    render(<NodeView path=":x.yo" format="yamlover/schema" onFormat={() => {}} onNavigate={() => {}} />);
    await screen.findByText("wv");
    const edit = screen.getByRole("button", { name: /Edit/ }) as HTMLButtonElement;
    expect(edit.disabled).toBe(true); // present (a stable bar) but inert
  });

  it("a plain .yaml data page shows the Edit toggle (yaml-family, yaml-syntax view)", async () => {
    mNode.mockResolvedValue({ path: ":x.yaml", type: "object", concrete: "file/yaml", hasKeyed: true, title: null, description: null, value: { a: 1 } });
    render(<NodeView path=":x.yaml" format="yamlover" onFormat={() => {}} onNavigate={() => {}} />);
    await screen.findByText("a");
    expect(await screen.findByRole("button", { name: /Edit/ })).toBeTruthy();
  });

  it("a .json file IS editable in the yamlover view (universal edit surface) but NOT the json5p view", async () => {
    const node = { path: ":x.json", type: "object", concrete: "file/json", hasKeyed: true, title: null, description: null, value: { a: 1 } };
    // the yamlover renderer edits any data file (the server writes JSON for a json-family target); the
    // json5p view is not the yamlover renderer, so the Edit toggle is disabled there
    mNode.mockResolvedValue(node);
    const { unmount } = render(<NodeView path=":x.json" format="yamlover" onFormat={() => {}} onNavigate={() => {}} />);
    await screen.findByText("a");
    expect(await screen.findByRole("button", { name: /Edit/ })).toBeTruthy();
    unmount();
    mNode.mockResolvedValue(node);
    render(<NodeView path=":x.json" format="json5p" onFormat={() => {}} onNavigate={() => {}} />);
    await waitFor(() => expect(within(document.querySelector("pre.code") as HTMLElement).getByText("1")).toBeTruthy());
    expect((screen.getByRole("button", { name: /Edit/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("the settings node (x-yamlover-config) falls back to the editable data view (custom renderer dropped)", async () => {
    // no renderer claims x-yamlover-config anymore → the default yamlover data view, which is editable
    mNode.mockResolvedValue({ path: ":.yo:settings.yo", type: "object", format: "x-yamlover-config", concrete: "file/yamlover", hasKeyed: true, title: null, description: null, value: { sidecars: "per-directory" } });
    render(<NodeView path=":.yo:settings.yo" format="yamlover" onFormat={() => {}} onNavigate={() => {}} />);
    await screen.findByText("sidecars"); // the raw data view, not the old settings textarea
    expect(await screen.findByRole("button", { name: /Edit/ })).toBeTruthy();
  });

  it("a dir-backed pointer-array renders positional members as `- &key value` with DIMMED derived anchors; the unreferenced remainder as plain keyed rows", async () => {
    // the 56-array-of-files shape: three members named by the body (anchor: true), one file on
    // disk the body never referenced — a keyed-only tail, never granted a position
    mNode.mockResolvedValue({
      path: ":d", type: "mixed", concrete: "dir", hasKeyed: true, hasOrdinal: true,
      title: null, description: null,
      value: {
        $yamloverMixed: {
          kind: "mix",
          entries: [
            { key: "anyfile01", value: "Alice", anchor: true },
            { key: "alsoany02", value: 42, anchor: true },
            { key: "andany04.json", value: "string" },
          ],
        },
      },
    });
    const { container } = render(<NodeView path=":d" format="yamlover" onFormat={() => {}} onNavigate={() => {}} />);
    await screen.findByText("Alice");
    const anchors = Array.from(container.querySelectorAll<HTMLElement>(".anchor.derived"));
    expect(anchors.map((a) => a.textContent)).toEqual(["&anyfile01", "&alsoany02"]);
    expect(container.querySelectorAll(".yaml-dash")).toHaveLength(2); // one dash per positional member
    // the remainder is an ordinary `key: value` row — no dash, no anchor
    expect(Array.from(container.querySelectorAll(".k")).map((k) => k.textContent)).toContain("andany04.json");
    const text = container.textContent!;
    expect(text).toContain("- &anyfile01 Alice");
    expect(text).toContain("andany04.json:");
  });
});

describe("chapter media drop — targets the ENCLOSING chapter section", () => {
  const mixed = (o: Record<string, unknown>) => ({ $yamloverMixed: { kind: "mix", entries: [], ...o } });
  const chapterPage = () => {
    const sub = mixed({ kind: "omni", value: "Dogs", selfAt: 0, entries: [{ key: null, value: "woof" }] });
    mNode.mockResolvedValue({
      path: ":doc", type: "mixed", format: "x-yamlover-chapter", concrete: "dir/yamlover", documentPath: ":doc",
      title: "Book", description: null,
      value: mixed({
        kind: "omni", value: "Book", selfAt: 0, format: "x-yamlover-chapter",
        entries: [{ key: null, value: "intro" }, { key: null, value: sub }],
      }),
    });
    mPasteFile.mockResolvedValue({ path: ":doc:bone.png", chapter: ":doc" });
  };
  const dropOn = (el: Element) => {
    const file = new File(["PNG"], "bone.png", { type: "image/png" });
    fireEvent.drop(el, { dataTransfer: { types: ["Files"], files: [file] } });
  };

  it("a drop INSIDE an inlined subchapter section uploads to THAT chapter's path", async () => {
    chapterPage();
    render(<NodeView path=":doc" format="chapter" onFormat={() => {}} onNavigate={() => {}} />);
    await waitFor(() => expect(document.querySelector("section.chapter-sub")).toBeTruthy());
    dropOn(document.querySelector("section.chapter-sub .chapter-prose")!);
    // the unified confirm popup names the drop; confirm uploads to the SUBCHAPTER's path
    fireEvent.click(await screen.findByRole("button", { name: "Upload" }));
    await waitFor(() => expect(mPasteFile).toHaveBeenCalledWith(":doc:1", "bone.png", expect.any(String)));
  });

  it("a drop OUTSIDE any section targets the page root", async () => {
    chapterPage();
    render(<NodeView path=":doc" format="chapter" onFormat={() => {}} onNavigate={() => {}} />);
    await waitFor(() => expect(document.querySelector("h1.chapter-title")).toBeTruthy());
    dropOn(document.querySelector("h1.chapter-title")!);
    fireEvent.click(await screen.findByRole("button", { name: "Upload" }));
    await waitFor(() => expect(mPasteFile).toHaveBeenCalledWith(":doc", "bone.png", expect.any(String)));
  });
});

describe("link paste (arXiv, tweets)", () => {
  it("pasting an arXiv link downloads the PDF and uploads it via the file-paste flow", async () => {
    mNode.mockResolvedValue({ path: ":papers", type: "object", concrete: "dir/yamlover", title: null, description: null, value: {} });
    mPasteFile.mockResolvedValue({ path: ":papers:arxiv-2605.00615.pdf", dir: ":papers", open: false });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(["PDF"], { type: "application/pdf" }) });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const onContentChanged = vi.fn();
      render(<NodeView path=":papers" format="yaml" onFormat={() => {}} onNavigate={() => {}} onContentChanged={onContentChanged} />);
      await screen.findByText("empty");

      fireEvent.paste(document, { clipboardData: { files: [], items: [], getData: () => "https://arxiv.org/abs/2605.00615" } });

      await screen.findByText("uploaded"); // the toast settles once the file-paste flow finished
      expect(fetchMock).toHaveBeenCalledWith("https://arxiv.org/pdf/2605.00615");
      expect(mPasteFile).toHaveBeenCalledTimes(1);
      const [path, name, b64] = mPasteFile.mock.calls[0];
      expect([path, name]).toEqual([":papers", "arxiv-2605.00615.pdf"]);
      expect(atob(b64)).toBe("PDF"); // the downloaded bytes, base64'd by the normal flow
      expect(onContentChanged).toHaveBeenCalledWith(":papers");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a failed download reports and never uploads", async () => {
    mNode.mockResolvedValue({ path: ":papers", type: "object", concrete: "dir/yamlover", title: null, description: null, value: {} });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    try {
      render(<NodeView path=":papers" format="yaml" onFormat={() => {}} onNavigate={() => {}} />);
      await screen.findByText("empty");
      fireEvent.paste(document, { clipboardData: { files: [], items: [], getData: () => "https://arxiv.org/abs/2605.99999" } });
      await screen.findByText(/download failed: HTTP 404/);
      expect(mPasteFile).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("pasting an HTML selection with an image and a heading goes through the RICH flow", async () => {
    mNode.mockResolvedValue({ path: ":wiki", type: "object", concrete: "dir/yamlover", title: null, description: null, value: {} });
    mPasteRich.mockResolvedValue({ path: ":wiki", chapter: ":wiki" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(["JPG"], { type: "image/jpeg" }) }));

    try {
      render(<NodeView path=":wiki" format="yaml" onFormat={() => {}} onNavigate={() => {}} />);
      await screen.findByText("empty");
      const html = '<p>intro</p><img src="https://upload.wikimedia.org/cat.jpg" alt="cat"><h2>Etymology</h2><p>From Latin.</p>';
      fireEvent.paste(document, {
        clipboardData: { files: [], items: [], getData: (t: string) => (t === "text/html" ? html : "intro Etymology From Latin.") },
      });

      await screen.findByText("chunks added");
      expect(mPasteText).not.toHaveBeenCalled(); // the html flavor won over the plain text
      const [target, rich] = mPasteRich.mock.calls[0];
      expect(target).toBe(":wiki");
      expect(rich.chunks[0]).toEqual({ text: "intro" });
      expect(rich.chunks[1].file.name).toBe("cat.jpg");
      expect(atob(rich.chunks[1].file.contentBase64)).toBe("JPG");
      expect(rich.children).toEqual([{ title: "Etymology", chunks: [{ text: "From Latin." }], children: [] }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("formatted HTML without images or headings still pastes as plain TEXT", async () => {
    mNode.mockResolvedValue({ path: ":notes", type: "object", concrete: "dir/yamlover", title: null, description: null, value: {} });
    mPasteText.mockResolvedValue({ path: ":notes", chapter: ":notes" });

    render(<NodeView path=":notes" format="yaml" onFormat={() => {}} onNavigate={() => {}} />);
    await screen.findByText("empty");
    fireEvent.paste(document, {
      clipboardData: { files: [], items: [], getData: (t: string) => (t === "text/html" ? "<p>just <b>bold</b></p>" : "just bold") },
    });

    await screen.findByText("chunk added");
    expect(mPasteRich).not.toHaveBeenCalled();
    expect(mPasteText).toHaveBeenCalledWith(":notes", "just bold");
  });

  it("dropping an OS file shows the unified confirm popup — uploading only on confirm", async () => {
    mNode.mockResolvedValue({ path: ":notes", type: "object", concrete: "dir/yamlover", title: null, description: null, value: {} });
    mPasteFile.mockResolvedValue({ path: ":notes:x.png", dir: ":notes", open: false });

    render(<NodeView path=":notes" format="yaml" onFormat={() => {}} onNavigate={() => {}} />);
    await screen.findByText("empty");
    const file = new File(["PNG"], "x.png", { type: "image/png" });
    fireEvent.drop(document, { dataTransfer: { types: ["Files"], files: [file] } });

    // the drop no longer uploads directly — the popup describes it and waits
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain('Upload file onto');
    expect(dialog.textContent).toContain("x.png");
    expect(mPasteFile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    await screen.findByText("uploaded");
    expect(mPasteFile).toHaveBeenCalledTimes(1);
    expect(mPasteFile.mock.calls[0].slice(0, 2)).toEqual([":notes", "x.png"]);
  });

  it("cancelling the drop confirm uploads nothing", async () => {
    mNode.mockResolvedValue({ path: ":notes", type: "object", concrete: "dir/yamlover", title: null, description: null, value: {} });

    render(<NodeView path=":notes" format="yaml" onFormat={() => {}} onNavigate={() => {}} />);
    await screen.findByText("empty");
    fireEvent.drop(document, { dataTransfer: { types: ["Files"], files: [new File(["PNG"], "x.png", { type: "image/png" })] } });

    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mPasteFile).not.toHaveBeenCalled();
  });

  it("pasting a tweet link fetches the full message via oEmbed and pastes it as TEXT", async () => {
    mNode.mockResolvedValue({ path: ":notes", type: "object", concrete: "dir/yamlover", title: null, description: null, value: {} });
    mPasteText.mockResolvedValue({ path: ":notes", chapter: ":notes" });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        url: "https://x.com/tsoding/status/2065098226374443051",
        author_name: "Тsфdiиg",
        author_url: "https://x.com/tsoding",
        html: '<blockquote><p>claude code spawning subagents</p>&mdash; Тsфdiиg (@tsoding) <a href="#">June 11, 2026</a></blockquote>',
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      render(<NodeView path=":notes" format="yaml" onFormat={() => {}} onNavigate={() => {}} />);
      await screen.findByText("empty");
      fireEvent.paste(document, { clipboardData: { files: [], items: [], getData: () => "https://x.com/tsoding/status/2065098226374443051" } });

      await screen.findByText("chunk added");
      expect(fetchMock.mock.calls[0][0]).toContain("publish.x.com/oembed");
      expect(mPasteText).toHaveBeenCalledWith(
        ":notes",
        "claude code spawning subagents\n\n— Тsфdiиg @tsoding, June 11, 2026\nhttps://x.com/tsoding/status/2065098226374443051",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
