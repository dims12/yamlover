// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act, waitFor, fireEvent } from "@testing-library/react";
import { ErrorBoundary } from "../../src/client/ErrorBoundary";

// A controllable EventSource stand-in so we can simulate the SSE dropping and RECONNECTING (which is
// what a server restart looks like to the client).
class MockEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  url: string;
  static instances: MockEventSource[] = [];
  constructor(url: string) { this.url = url; MockEventSource.instances.push(this); }
  close() {}
}

const api = await import("../../src/client/api");
vi.mock("../../src/client/api", async (orig) => {
  const real = await orig<Record<string, unknown>>();
  return {
    ...real,
    fetchConfig: vi.fn().mockResolvedValue({ source: "", settings: { exports: [], annotations: ":annotations", tags: ":tags", sidecars: "per-directory" }, path: ":.yamlover:settings.yamlover" }),
    saveLastTag: vi.fn().mockResolvedValue({ ok: true }),
    fetchInfo: vi.fn().mockResolvedValue({ root: "myroot" }),
    fetchTree: vi.fn().mockResolvedValue({ path: ":", label: "root", type: "object", format: null, concrete: null, hasChildren: true, children: [{ path: ":a", label: "a", type: "string", format: null, concrete: null, hasChildren: false, children: [] }] }),
    fetchNode: vi.fn().mockResolvedValue({ path: ":", type: "object", concrete: "dir/yamlover", title: null, description: null, value: {} }),
    fetchSchema: vi.fn().mockResolvedValue({ type: "object" }),
    fetchAnnotations: vi.fn().mockResolvedValue([]),
    fetchTasks: vi.fn().mockResolvedValue([]),
  };
});
import { App } from "../../src/client/App";

beforeEach(() => {
  MockEventSource.instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("SSE reconnect (server restart) resync", () => {
  it("refetches the tree + current node when the stream reconnects", async () => {
    render(<App />);
    await screen.findByText("a"); // initial load done
    const es = MockEventSource.instances[0];
    act(() => es.onopen?.()); // initial connect — must NOT resync

    (api.fetchTree as unknown as ReturnType<typeof vi.fn>).mockClear();
    (api.fetchNode as unknown as ReturnType<typeof vi.fn>).mockClear();

    act(() => es.onopen?.()); // a RECONNECT (server came back)
    await waitFor(() => {
      expect(api.fetchTree).toHaveBeenCalledWith(":", 1); // tree re-synced
      expect(api.fetchNode).toHaveBeenCalled(); // current node re-fetched
    });
  });
});

describe("ErrorBoundary", () => {
  const Boom = () => { throw new Error("kaboom"); };
  it("shows a recoverable message instead of a blank page when a child throws", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(container.querySelector(".crash")).not.toBeNull();
    expect(container.textContent).toContain("kaboom");
    expect(container.querySelector(".crash-actions")).not.toBeNull();
    spy.mockRestore();
  });

  it("'Try again' clears the error and re-renders the children", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let boom = true;
    const Maybe = () => { if (boom) throw new Error("once"); return <div>recovered</div>; };
    const { container, getByText } = render(
      <ErrorBoundary>
        <Maybe />
      </ErrorBoundary>,
    );
    expect(container.querySelector(".crash")).not.toBeNull();
    boom = false;
    fireEvent.click(getByText("Try again"));
    expect(container.textContent).toContain("recovered");
    spy.mockRestore();
  });
});
