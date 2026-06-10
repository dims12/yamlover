// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

vi.mock("../../src/client/api", () => ({
  fetchNode: vi.fn(),
  fetchSchema: vi.fn(),
  fetchAnnotations: vi.fn().mockResolvedValue([]), // header badges hop via /api/annotations
}));
import { fetchNode, fetchSchema } from "../../src/client/api";
import { NodeView } from "../../src/client/NodeView";

const mNode = fetchNode as unknown as ReturnType<typeof vi.fn>;
const mSchema = fetchSchema as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mNode.mockReset();
  mSchema.mockReset();
});
afterEach(cleanup);

describe("NodeView", () => {
  it("renders the value with a link marker and reports tab switches", async () => {
    mNode.mockResolvedValue({
      path: "/x",
      type: "object",
      concrete: "yamlover",
      title: null,
      description: null,
      value: { name: "Alice", child: { $yamloverLink: { kind: "object", count: 2, path: "/x/child" } } },
    });
    const onFormat = vi.fn();
    render(<NodeView path="/x" format="yamlover" onFormat={onFormat} onNavigate={() => {}} />);

    expect(await screen.findByText("{ object with 2 properties }")).toBeTruthy();
    expect(screen.getByText("Alice")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "json5p" }));
    expect(onFormat).toHaveBeenCalledWith("json5p");
  });

  it("shows the relations panel (standard-title hyperlinks) above the value in a data view", async () => {
    mNode.mockResolvedValue({
      path: "/adam/cain",
      type: "object",
      concrete: "yaml-schema/instantiate",
      title: null,
      description: null,
      value: { enoch: { $yamloverLink: { kind: "object", count: 0, path: "/adam/cain/enoch" } } },
      relations: {
        father: { $yamloverLink: { kind: "object", count: 3, path: "/adam" } },
        mother: { $yamloverLink: { kind: "object", count: 3, path: "/eve" } },
      },
    });
    const onNav = vi.fn();
    render(<NodeView path="/adam/cain" format="yaml" onFormat={() => {}} onNavigate={onNav} />);

    // both relations render with the target's standard title (not a path)
    const links = await screen.findAllByText("{ object with 3 properties }");
    expect(links).toHaveLength(2);
    expect((links[0] as HTMLAnchorElement).getAttribute("href")).toBe("/adam");
    fireEvent.click(links[1]);
    expect(onNav).toHaveBeenCalledWith("/eve");

    expect(screen.getByText("mother")).toBeTruthy();
    expect(document.querySelector("hr.reldiv")).toBeTruthy(); // divider above the value
    expect(screen.getByText("enoch")).toBeTruthy(); // value still rendered below
  });

  it("does not show the relations panel in a schema view", async () => {
    mNode.mockResolvedValue({
      path: "/adam/cain",
      type: "object",
      concrete: "yaml-schema/instantiate",
      title: null,
      description: null,
      value: { enoch: null },
      relations: { "..": { $yamloverLink: { kind: "object", count: 3, path: "/adam" } } },
    });
    mSchema.mockResolvedValue({ type: "object", properties: { enoch: { const: null } } });
    render(<NodeView path="/adam/cain" format="yamlover/schema" onFormat={() => {}} onNavigate={() => {}} />);
    await screen.findByText("enoch");
    expect(document.querySelector("hr.reldiv")).toBeNull();
  });

  it("loads and shows a binary leaf as !!binary only when viewed", async () => {
    mNode.mockImplementation((_p: string, _d?: number, opts?: { binary?: boolean }) =>
      Promise.resolve(
        opts?.binary
          ? {
              path: "/img",
              type: "binary",
              concrete: "file/binary",
              title: null,
              description: null,
              value: { $yamloverBinary: { format: "image/png", size: 5, base64: "iVBOR" } },
            }
          : {
              path: "/img",
              type: "binary",
              concrete: "file/binary",
              title: null,
              description: null,
              value: "<binary image/png, 5 bytes>",
            },
      ),
    );
    render(<NodeView path="/img" format="yaml" onFormat={() => {}} onNavigate={() => {}} />);
    expect(await screen.findByText(/!!binary/)).toBeTruthy();
  });

  it("renders the instance schema in the yamlover/schema tab", async () => {
    mNode.mockResolvedValue({ path: "/x", type: "object", concrete: "yamlover", title: null, description: null, value: {} });
    mSchema.mockResolvedValue({ type: "object", properties: { name: { const: "Alice" } } });
    render(<NodeView path="/x" format="yamlover/schema" onFormat={() => {}} onNavigate={() => {}} />);
    expect(await screen.findByText("Alice")).toBeTruthy();
  });

  it("sets the document title to the node's schema title when it has one", async () => {
    mNode.mockResolvedValue({ path: "/book", type: "object", concrete: "yamlover", title: "My Book", description: null, value: {} });
    render(<NodeView path="/book" format="yaml" onFormat={() => {}} onNavigate={() => {}} />);
    await screen.findByText("{}");
    expect(document.title).toBe("My Book");
  });

  it("falls back to the node's path name when it has no title", async () => {
    mNode.mockResolvedValue({ path: "/chapters[2]", type: "object", concrete: "yamlover", title: null, description: null, value: {} });
    render(<NodeView path="/chapters[2]" format="yaml" onFormat={() => {}} onNavigate={() => {}} />);
    await screen.findByText("{}");
    expect(document.title).toBe("[2]");
  });
});
