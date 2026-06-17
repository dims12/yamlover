// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

vi.mock("../../src/client/api", () => ({
  fetchNode: vi.fn(),
  fetchSchema: vi.fn(),
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

      // (3) a chapter gets its own depth 2, even though the setting is 6
      mNode.mockReset();
      mNode.mockResolvedValue({ path: ":c", type: "object", format: "x-yamlover-chapter", concrete: "yamlover",
        title: null, description: null, value: { title: "T", chunks: [], children: [] } });
      render(<NodeView path=":c" format="chapter" onFormat={() => {}} onNavigate={() => {}} />);
      await waitFor(() => expect(mNode).toHaveBeenCalledWith(":c", 2));
      expect(mNode).not.toHaveBeenCalledWith(":c", 6);
    } finally {
      window.history.replaceState({}, "", "/");
    }
  });

  it("offers the json5p tab only for a json-family file", async () => {
    mNode.mockResolvedValue({
      path: ":x", type: "object", concrete: "yamlover", title: null, description: null, value: { name: "Alice" },
    });
    render(<NodeView path=":x" format="yamlover" onFormat={() => {}} onNavigate={() => {}} />);
    await screen.findByText("Alice");
    expect(screen.queryByRole("button", { name: "json5p" })).toBeNull();
    expect(screen.getByRole("button", { name: "yamlover" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "yamlover/schema" })).toBeTruthy();
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
    mNode.mockResolvedValue({ path: ":x", type: "object", concrete: "yamlover", title: null, description: null, value: {} });
    mSchema.mockResolvedValue({ type: "object", properties: { name: { const: "Alice" } } });
    render(<NodeView path=":x" format="yamlover/schema" onFormat={() => {}} onNavigate={() => {}} />);
    expect(await screen.findByText("Alice")).toBeTruthy();
  });

  it("sets the document title to the node's schema title when it has one", async () => {
    // a dir-concrete node now defaults to the explorer view (an empty grid here)
    mNode.mockResolvedValue({ path: ":book", type: "object", concrete: "yamlover", title: "My Book", description: null, value: {} });
    render(<NodeView path=":book" format="yaml" onFormat={() => {}} onNavigate={() => {}} />);
    await screen.findByText("empty");
    expect(document.title).toBe("My Book");
  });

  it("falls back to the node's path name when it has no title", async () => {
    mNode.mockResolvedValue({ path: ":chapters[2]", type: "object", concrete: "yamlover", title: null, description: null, value: {} });
    render(<NodeView path=":chapters[2]" format="yaml" onFormat={() => {}} onNavigate={() => {}} />);
    await screen.findByText("empty");
    expect(document.title).toBe("[2]");
  });
});

describe("link paste (arXiv, tweets)", () => {
  it("pasting an arXiv link downloads the PDF and uploads it via the file-paste flow", async () => {
    mNode.mockResolvedValue({ path: ":papers", type: "object", concrete: "yamlover", title: null, description: null, value: {} });
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
    mNode.mockResolvedValue({ path: ":papers", type: "object", concrete: "yamlover", title: null, description: null, value: {} });
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
    mNode.mockResolvedValue({ path: ":wiki", type: "object", concrete: "yamlover", title: null, description: null, value: {} });
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
    mNode.mockResolvedValue({ path: ":notes", type: "object", concrete: "yamlover", title: null, description: null, value: {} });
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

  it("pasting a tweet link fetches the full message via oEmbed and pastes it as TEXT", async () => {
    mNode.mockResolvedValue({ path: ":notes", type: "object", concrete: "yamlover", title: null, description: null, value: {} });
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
