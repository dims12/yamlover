// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

vi.mock("../../src/client/api", () => ({
  fetchTagged: vi.fn(),
}));
import { fetchTagged } from "../../src/client/api";
import type { NodeJson } from "../../src/client/api";
import { ExplorerView } from "../../src/client/renderers/explorer";

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
    render(<ExplorerView node={dir} onNavigate={() => {}} />);
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
    render(<ExplorerView node={dir} onNavigate={() => {}} />);
    const byText = (t: string) => items().find((el) => el.textContent?.includes(t))!;
    expect(byText("age:").textContent).toContain("42"); // a scalar member, value shown
    expect(byText("sub").querySelector(".dirview-icon")?.textContent).toBe("📁"); // a child folder
    expect(byText("pic.png").querySelector(".dirview-icon")?.textContent).toBe("🖼️"); // a binary, by format
    expect(mTagged).not.toHaveBeenCalled(); // not a tag page
  });

  it("a file-like scalar (media-type format) shows just its name, not its content", () => {
    render(<ExplorerView node={dir} onNavigate={() => {}} />);
    const md = items().find((el) => el.textContent?.includes("FUTURE.md"))!;
    expect(md.textContent).toBe("📝FUTURE.md"); // the parsed document's text stays out
  });

  it("a format-less binary keeps the boxed-bits glyph (the TOC's binary mark)", () => {
    render(<ExplorerView node={dir} onNavigate={() => {}} />);
    const bin = items().find((el) => el.textContent?.includes("blob.fdmdownload"))!;
    const icon = bin.querySelector(".dirview-icon")!;
    expect(icon.textContent).toBe("0110");
    expect(icon.className).toContain("binsq"); // the styled square, not raw text
  });

  it("navigates on click", () => {
    const onNav = vi.fn();
    render(<ExplorerView node={dir} onNavigate={onNav} />);
    fireEvent.click(items().find((el) => el.textContent?.includes("sub"))!);
    expect(onNav).toHaveBeenCalledWith(":dir:sub");
  });

  it("tooltips show the decoded path (the href keeps the canonical encoded one)", () => {
    const cyr = node({
      value: { "Папка": link({ kind: "object", type: "object", path: ":dir:%D0%9F%D0%B0%D0%BF%D0%BA%D0%B0", count: 1, concrete: "dir" }) },
    });
    render(<ExplorerView node={cyr} onNavigate={() => {}} />);
    const it_ = items().find((el) => el.textContent?.includes("Папка"))!;
    expect(it_.getAttribute("title")).toBe(":dir:Папка");
    expect(it_.getAttribute("href")).toBe(":dir:%D0%9F%D0%B0%D0%BF%D0%BA%D0%B0");
  });

  it("notes an empty directory", () => {
    render(<ExplorerView node={node({ value: {} })} onNavigate={() => {}} />);
    expect(screen.getByText("empty")).toBeTruthy();
  });

  it("defaults to the large-icons view; `?view=small` switches to small icons", () => {
    render(<ExplorerView node={dir} onNavigate={() => {}} />);
    expect(document.querySelector(".dirview")!.className).toContain("dirview-lg");
    cleanup();

    window.history.replaceState({}, "", ":dir?view=small");
    try {
      render(<ExplorerView node={dir} onNavigate={() => {}} />);
      expect(document.querySelector(".dirview")!.className).not.toContain("dirview-lg");
    } finally {
      window.history.replaceState({}, "", ":dir");
    }
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
    render(<ExplorerView node={tag} onNavigate={() => {}} />);
    expect(mTagged).toHaveBeenCalledWith(":tags.yamlover:yellow");
    await screen.findByText("name:"); // the material arrived

    const hrefs = items().map((el) => el.getAttribute("href"));
    expect(hrefs).toContain(":name");
    expect(hrefs).not.toContain(":annotations:a1.yamlover"); // the annotation stays out
    expect(hrefs.filter((h) => h === ":tags.yamlover:yellow:pale")).toHaveLength(1); // deduped
  });

  it("shows the description in the header (no badge — the bar already names the tag) and badge-styled subtags", () => {
    render(<ExplorerView node={tag} onNavigate={() => {}} />);
    expect(document.querySelector(".dirhead .tagtag-current")).toBeNull();
    expect(screen.getByText("things to revisit")).toBeTruthy();
    // the subtag renders as a colored badge inside its grid item
    const pale = items().find((el) => el.textContent?.includes("pale"))!;
    expect(pale.querySelector(".tagtag")).toBeTruthy();
  });
});
