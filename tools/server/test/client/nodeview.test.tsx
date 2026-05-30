// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

vi.mock("../../src/client/api", () => ({
  fetchNode: vi.fn(),
  fetchSchema: vi.fn(),
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
    render(<NodeView path="/x" format="yaml" onFormat={onFormat} onNavigate={() => {}} />);

    expect(await screen.findByText("{ object with 2 properties }")).toBeTruthy();
    expect(screen.getByText("Alice")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "json" }));
    expect(onFormat).toHaveBeenCalledWith("json");
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

  it("renders the instance schema in the yaml-schema tab", async () => {
    mNode.mockResolvedValue({ path: "/x", type: "object", concrete: "yamlover", title: null, description: null, value: {} });
    mSchema.mockResolvedValue({ type: "object", properties: { name: { const: "Alice" } } });
    render(<NodeView path="/x" format="yaml-schema" onFormat={() => {}} onNavigate={() => {}} />);
    expect(await screen.findByText("Alice")).toBeTruthy();
  });
});
