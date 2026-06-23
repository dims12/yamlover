// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { PlaintextView } from "../../src/client/renderers/plaintext";
import type { NodeJson } from "../../src/client/api";

const node = (over: Partial<NodeJson>): NodeJson => ({
  path: ":", type: "string", format: null, valueType: "string", hasKeyed: false, hasOrdinal: false,
  concrete: null, title: null, description: null, value: "", ...over,
});

afterEach(cleanup);

describe("PlaintextView", () => {
  it("renders an INLINE string node's value verbatim, with NO /api/blob fetch", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    // an inline markdown string (no source file): concrete is not file-backed
    render(<PlaintextView node={node({ concrete: "yamlover", format: "text/markdown", value: "# Heading\nbody _text_" })} />);
    expect(screen.getByText(/# Heading/)).toBeTruthy();
    expect(screen.getByText(/body _text_/)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled(); // inline → no blob round-trip
    fetchSpy.mockRestore();
  });

  it("fetches /api/blob for a FILE-backed node", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new TextEncoder().encode("raw file bytes")),
    );
    render(<PlaintextView node={node({ path: ":doc.txt", concrete: "file/binary", format: "text/plain" })} />);
    await waitFor(() => expect(screen.getByText("raw file bytes")).toBeTruthy());
    expect(fetchSpy).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
