// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

vi.mock("../../src/client/api", () => ({
  fetchConfig: vi.fn().mockResolvedValue({ source: "", settings: { exports: [], annotations: ":annotations", tags: ":tags", sidecars: "per-directory" }, path: ":.yamlover:settings.yamlover" }),
  fetchTagged: vi.fn(),
  thumbUrl: (p: string, w: number, h: number) => `/api/thumb?path=${encodeURIComponent(p)}&w=${w}&h=${h}`,
  blobUrl: (p: string) => `/api/blob?path=${encodeURIComponent(p)}`,
  // the grid mounts the tag menu, whose palette/recents validate their tags on mount (fetchNode)
  fetchNode: vi.fn().mockResolvedValue({ format: "x-yamlover-tag" }),
  query: vi.fn().mockResolvedValue([]),
  fetchAnnotations: vi.fn().mockResolvedValue([]),
  annotate: vi.fn().mockResolvedValue({ ok: true }),
  deleteAnnotation: vi.fn().mockResolvedValue(undefined),
}));
import { fetchTagged } from "../../src/client/api";
import type { NodeJson } from "../../src/client/api";
import { ExplorerView, generalItems, tagItems, buildExplorerItems } from "../../src/client/renderers/explorer";
import type { Link } from "../../src/client/render";

const mTagged = fetchTagged as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mTagged.mockReset();
  mTagged.mockResolvedValue([]);
});
afterEach(cleanup);

const node = (over: Partial<NodeJson>): NodeJson => ({
  path: ":dir",
  type: "object",
  format: null,
  concrete: "dir",
  title: null,
  description: null,
  value: {},
  ...over,
});

const link = (info: Record<string, unknown>) => ({ $yamloverLink: info });

const items = () => Array.from(document.querySelectorAll(".dirview-item"));

describe("ExplorerView (a directory)", () => {
  const dir = node({
    value: {
      age: link({ kind: "scalar", type: "integer", path: ":dir:age", value: 42 }),
      sub: link({ kind: "object", type: "object", path: ":dir:sub", count: 1, concrete: "dir" }),
      "pic.png": link({ kind: "binary", type: "binary", path: ":dir:pic.png", size: 5, format: "image/png" }),
      "FUTURE.md": link({
        kind: "scalar", type: "string", path: ":dir:FUTURE.md", format: "text/markdown",
        value: "# FUTURE — plans\n\nlots of prose…",
      }),
      "blob.fdmdownload": link({ kind: "binary", type: "binary", path: ":dir:blob.fdmdownload", size: 9 }),
    },
    relations: {
      "..": link({ kind: "object", type: "object", path: ":", count: 3 }),
      "//eve": link({ kind: "object", type: "object", path: ":eve", count: 2 }),
    },
  });

  it("leads with the uplinks (`..` first), styled distinct", () => {
    render(<ExplorerView node={dir} view="large" onNavigate={() => {}} />);
    const all = items();
    expect(all).toHaveLength(7);
    expect(all[0].className).toContain("dirview-up");
    expect(all[0].textContent).toContain("..");
    expect(all[0].getAttribute("href")).toBe(":");
    expect(all[1].className).toContain("dirview-up");
    expect(all[1].textContent).toContain("//eve");
    expect(all[2].className).not.toContain("dirview-up");
  });

  it("shows EVERY member: a scalar reads `key: value`, containers and binaries get icons", () => {
    render(<ExplorerView node={dir} view="large" onNavigate={() => {}} />);
    const byText = (t: string) => items().find((el) => el.textContent?.includes(t))!;
    expect(byText("age:").textContent).toContain("42"); // a scalar member, value shown
    expect(byText("sub").querySelector(".dirview-icon")?.textContent).toBe("📁"); // a child folder
    // a raster image renders a real thumbnail (server /api/thumb) in the large (default) view,
    // in place of the 🖼️ glyph
    expect(byText("pic.png").querySelector("img.dirview-thumb")?.getAttribute("src")).toContain("/api/thumb?path=");
    expect(mTagged).not.toHaveBeenCalled(); // not a tag page
  });

  it("a file-like scalar (media-type format) shows just its name, not its content", () => {
    render(<ExplorerView node={dir} view="large" onNavigate={() => {}} />);
    const md = items().find((el) => el.textContent?.includes("FUTURE.md"))!;
    expect(md.textContent).toBe("📝FUTURE.md"); // the parsed document's text stays out
  });

  it("a format-less binary keeps the boxed-bits glyph (the TOC's binary mark)", () => {
    render(<ExplorerView node={dir} view="large" onNavigate={() => {}} />);
    const bin = items().find((el) => el.textContent?.includes("blob.fdmdownload"))!;
    const icon = bin.querySelector(".dirview-icon")!;
    expect(icon.textContent).toBe("0110");
    expect(icon.className).toContain("binsq"); // the styled square, not raw text
  });

  it("navigates on click", () => {
    const onNav = vi.fn();
    render(<ExplorerView node={dir} view="large" onNavigate={onNav} />);
    fireEvent.click(items().find((el) => el.textContent?.includes("sub"))!);
    expect(onNav).toHaveBeenCalledWith(":dir:sub");
  });

  it("a PDF (and any typed) member uses the SHARED icon (icons.ts) — `📕`, never the `•` fallback — and navigates", () => {
    const onNav = vi.fn();
    const d = node({
      value: { "paper.pdf": link({ kind: "binary", type: "binary", path: ":dir:paper.pdf", size: 9, format: "application/pdf" }) },
    });
    render(<ExplorerView node={d} view="large" onNavigate={onNav} />);
    const pdf = items().find((el) => el.textContent?.includes("paper.pdf"))!;
    expect(pdf.querySelector(".dirview-icon")?.textContent).toBe("📕"); // typeIcon(application/pdf), not a bullet
    fireEvent.click(pdf);
    expect(onNav).toHaveBeenCalledWith(":dir:paper.pdf");
  });

  it("never shows the bare `•` bullet for normal members (regression: depth-1 link markers keep their icons)", () => {
    render(<ExplorerView node={dir} view="large" onNavigate={() => {}} />);
    const bullets = items().filter((el) => el.querySelector(".dirview-icon")?.textContent === "•");
    expect(bullets).toHaveLength(0);
  });

  it("autofocuses the first item; arrows walk the grid and Enter opens the selected one", () => {
    // (Up/Down are geometry-based — jsdom has no layout, so only the index moves are asserted here)
    const onNav = vi.fn();
    render(<ExplorerView node={dir} view="large" onNavigate={onNav} />);
    const all = items();
    expect(document.activeElement).toBe(all[0]); // grabbed focus so arrows work immediately

    fireEvent.keyDown(all[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(all[1]);
    fireEvent.keyDown(all[1], { key: "End" });
    expect(document.activeElement).toBe(all[all.length - 1]);
    fireEvent.keyDown(all[all.length - 1], { key: "Home" });
    expect(document.activeElement).toBe(all[0]);
    fireEvent.keyDown(all[0], { key: "ArrowLeft" }); // clamps at the first item
    expect(document.activeElement).toBe(all[0]);

    fireEvent.keyDown(all[0], { key: "Enter" }); // opens the active item (the `..` uplink → ":")
    expect(onNav).toHaveBeenCalledWith(":");
  });

  it("leaves Ctrl/Alt+arrows alone so the global TOC nav handles them", () => {
    render(<ExplorerView node={dir} view="large" onNavigate={() => {}} />);
    const all = items();
    expect(document.activeElement).toBe(all[0]);
    fireEvent.keyDown(all[0], { key: "ArrowRight", ctrlKey: true });
    expect(document.activeElement).toBe(all[0]); // selection unchanged — the window handler steps the TOC
  });

  it("tooltips show the decoded path (the href keeps the canonical encoded one)", () => {
    const cyr = node({
      value: { "Папка": link({ kind: "object", type: "object", path: ":dir:%D0%9F%D0%B0%D0%BF%D0%BA%D0%B0", count: 1, concrete: "dir" }) },
    });
    render(<ExplorerView node={cyr} view="large" onNavigate={() => {}} />);
    const it_ = items().find((el) => el.textContent?.includes("Папка"))!;
    expect(it_.getAttribute("title")).toBe(": dir: Папка"); // space after each colon
    expect(it_.getAttribute("href")).toBe(":dir:%D0%9F%D0%B0%D0%BF%D0%BA%D0%B0");
  });

  it("notes an empty directory", () => {
    render(<ExplorerView node={node({ value: {} })} view="large" onNavigate={() => {}} />);
    expect(screen.getByText("empty")).toBeTruthy();
  });

  it("the large view tiles (dirview-lg); the small view drops it for rows", () => {
    render(<ExplorerView node={dir} view="large" onNavigate={() => {}} />);
    expect(document.querySelector(".dirview")!.className).toContain("dirview-lg");
    cleanup();

    render(<ExplorerView node={dir} view="small" onNavigate={() => {}} />);
    expect(document.querySelector(".dirview")!.className).not.toContain("dirview-lg");
  });

  it("the thumbnails view is a gallery: the dirview-thumbs grid + larger (512px) thumbnails", () => {
    render(<ExplorerView node={dir} view="thumbnails" onNavigate={() => {}} />);
    const grid = document.querySelector(".dirview")!;
    expect(grid.className).toContain("dirview-lg"); // shares the column-tile layout
    expect(grid.className).toContain("dirview-thumbs"); // …enlarged into a gallery
    // a raster image asks the server for the bigger 512px crop (vs 256 in large view)
    const img = items().find((el) => el.textContent?.includes("pic.png"))!.querySelector("img.dirview-thumb");
    expect(img?.getAttribute("src")).toContain("/api/thumb?path=");
    expect(img?.getAttribute("src")).toContain("w=512");
  });
});

describe("ExplorerView (a tag)", () => {
  const tag = node({
    path: ":tags.yamlover:yellow",
    format: "x-yamlover-tag",
    concrete: null,
    description: "things to revisit",
    value: {
      color: link({ kind: "scalar", type: "string", path: ":tags.yamlover:yellow:color", value: "#f9e2af" }),
      pale: link({
        kind: "object", type: "object", format: "x-yamlover-tag",
        path: ":tags.yamlover:yellow:pale", count: 0, color: "#fdf3c4",
      }),
      // the raw back-edge member downstreamEntries appends — the mediating annotation node
      a1: link({ kind: "object", type: "object", format: "x-yamlover-annotation", path: ":annotations:a1.yamlover", count: 3 }),
    },
  });

  it("shows the materials from /api/tagged instead of the annotation nodes, deduped", async () => {
    mTagged.mockResolvedValue([
      link({ kind: "scalar", type: "string", path: ":name", value: "Alice" }),
      // a directly-tagged subtag-like member already present as an owned field — dedup by path
      link({ kind: "object", type: "object", format: "x-yamlover-tag", path: ":tags.yamlover:yellow:pale", count: 0 }),
    ]);
    render(<ExplorerView node={tag} view="large" onNavigate={() => {}} />);
    expect(mTagged).toHaveBeenCalledWith(":tags.yamlover:yellow");
    await screen.findByText("name:"); // the material arrived

    const hrefs = items().map((el) => el.getAttribute("href"));
    expect(hrefs).toContain(":name");
    expect(hrefs).not.toContain(":annotations:a1.yamlover"); // the annotation stays out
    expect(hrefs.filter((h) => h === ":tags.yamlover:yellow:pale")).toHaveLength(1); // deduped
  });

  it("shows NO uplinks (a tag lists its materials, not a folder to ascend from)", () => {
    const tagWithRel = node({
      path: ":tags.yamlover:yellow",
      format: "x-yamlover-tag",
      concrete: null,
      value: { color: link({ kind: "scalar", type: "string", path: ":tags.yamlover:yellow:color", value: "#f9e2af" }) },
      relations: { "..": link({ kind: "object", type: "object", path: ":tags.yamlover", count: 1 }) },
    });
    render(<ExplorerView node={tagWithRel} view="large" onNavigate={() => {}} />);
    expect(items().every((el) => !el.className.includes("dirview-up"))).toBe(true);
    expect(items().map((el) => el.getAttribute("href"))).not.toContain(":tags.yamlover");
  });

  it("previews a tagged FRAGMENT by its crop image (the link's `preview`), not a generic glyph", async () => {
    const crop = ":72-images:eiffel-tower:.yamlover:fragments:abc.png";
    mTagged.mockResolvedValue([
      link({
        kind: "object", type: "object", format: "x-yamlover-fragment",
        path: ":72-images:eiffel-tower:IMG.jpg:yamlover-fragments:abc", count: 7, preview: crop,
      }),
    ]);
    render(<ExplorerView node={tag} view="large" onNavigate={() => {}} />);
    // the fragment material arrives (async) and renders its crop through /api/thumb — the fragment
    // node itself is not file-backed, so it thumbnails its `preview` crop instead of a generic glyph
    await waitFor(() => expect(document.querySelector("img.dirview-thumb")).toBeTruthy());
    const img = document.querySelector("img.dirview-thumb")!;
    expect(img.getAttribute("src")).toBe(`/api/thumb?path=${encodeURIComponent(crop)}&w=256&h=256`);
  });

  it("shows the description in the header (no badge — the bar already names the tag) and badge-styled subtags", () => {
    render(<ExplorerView node={tag} view="large" onNavigate={() => {}} />);
    expect(document.querySelector(".dirhead .tagtag-current")).toBeNull();
    expect(screen.getByText("things to revisit")).toBeTruthy();
    // the subtag renders as a colored badge inside its grid item
    const pale = items().find((el) => el.textContent?.includes("pale"))!;
    expect(pale.querySelector(".tagtag")).toBeTruthy();
  });
});

describe("explorer projection mappers (the single source all views draw from)", () => {
  it("generalItems: uplinks first, then members", () => {
    const n = node({
      value: { a: link({ kind: "scalar", path: ":dir:a", value: 1 }) },
      relations: { "..": link({ kind: "object", path: ":", count: 0 }) },
    });
    const out = generalItems(n);
    expect(out[0].up).toBe(true);
    expect(out[0].key).toBe("..");
    expect(out[1].up).toBeFalsy();
    expect(out[1].key).toBe("a");
  });

  it("tagItems: no uplinks; drops annotation members; merges tagged materials, deduped by path", () => {
    const n = node({
      format: "x-yamlover-tag",
      value: {
        pale: link({ kind: "object", format: "x-yamlover-tag", path: ":t:pale", count: 0 }),
        a1: link({ kind: "object", format: "x-yamlover-annotation", path: ":annotations:a1", count: 1 }),
      },
      relations: { "..": link({ kind: "object", path: ":tags", count: 1 }) },
    });
    const tagged: Link[] = [
      { kind: "scalar", path: ":name", value: "Alice" },
      { kind: "object", format: "x-yamlover-tag", path: ":t:pale", count: 0 }, // dup of an owned field
    ];
    const out = tagItems(n, tagged);
    expect(out.some((it) => it.up)).toBe(false); // no uplinks
    const paths = out.map((it) => it.link?.path);
    expect(paths).not.toContain(":annotations:a1"); // annotation node dropped
    expect(paths).toContain(":name"); // material merged in
    expect(paths.filter((p) => p === ":t:pale")).toHaveLength(1); // deduped
  });

  it("buildExplorerItems dispatches by node.format (tag → no uplinks, else general)", () => {
    const dir = node({ value: {}, relations: { "..": link({ kind: "object", path: ":", count: 0 }) } });
    expect(buildExplorerItems(dir, []).some((it) => it.up)).toBe(true);
    const tag = node({ format: "x-yamlover-tag", value: {}, relations: { "..": link({ kind: "object", path: ":", count: 0 }) } });
    expect(buildExplorerItems(tag, []).some((it) => it.up)).toBe(false);
  });
});
