// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, waitFor, act, fireEvent } from "@testing-library/react";
import { Fragments, FragmentGroup } from "../../src/client/Fragments";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const GROUP: FragmentGroup = {
  slug: "abc123",
  selector: { type: "text", exact: "directories" },
  tags: [
    { path: ":yamlover:ontos:fifth tag", label: "fifth tag", color: null },
    { path: ":yamlover:ontos:forth tag", label: "forth tag", color: null },
  ],
};

describe("Fragments panel — delete from the RHS", () => {
  it("🗑 asks first; confirm deletes every tag of the fragment and hides the row", async () => {
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    }));

    const { container } = render(
      <Fragments path=":60-doc.yo" groups={[GROUP]} width={300} onNavigate={() => {}} />,
    );
    expect(container.querySelector(".fragment-row")).toBeTruthy();
    expect(container.querySelector(".fragments-title")).toBeNull();

    await act(async () => { fireEvent.click(container.querySelector(".fragment-delete")!); });
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0); // trash is gated
    const dialog = container.querySelector('[role="dialog"][aria-label="confirm delete"]');
    expect(dialog).toBeTruthy();

    await act(async () => { fireEvent.click(dialog!.querySelector("button")!); }); // Delete

    // both tags deleted, targeting the fragment's node path (decode params — space may be `+` or %20)
    await waitFor(() => expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(2));
    const params = calls.map((c) => new URL("http://x" + c.url.replace(/^[^?]*/, "")).searchParams);
    expect(params.every((p) => p.get("target") === ":60-doc.yo:yo:fragments:abc123")).toBe(true);
    const tags = params.map((p) => p.get("tag"));
    expect(tags).toContain(":yamlover:ontos:fifth tag");
    expect(tags).toContain(":yamlover:ontos:forth tag");

    // the row hides optimistically → the panel (its only fragment gone) renders nothing
    await waitFor(() => expect(container.querySelector(".fragment-row")).toBeFalsy());
  });

  it("cancel leaves the fragment and deletes nothing", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) } as Response));
    vi.stubGlobal("fetch", fetchFn);

    const { container } = render(
      <Fragments path=":60-doc.yo" groups={[GROUP]} width={300} onNavigate={() => {}} />,
    );
    await act(async () => { fireEvent.click(container.querySelector(".fragment-delete")!); });
    const dialog = container.querySelector('[role="dialog"][aria-label="confirm delete"]')!;
    await act(async () => { fireEvent.click(dialog.querySelectorAll("button")[1]); }); // Cancel

    expect(fetchFn).not.toHaveBeenCalled();
    expect(container.querySelector(".fragment-row")).toBeTruthy();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("clicking a tag locates the fragment (hash), and does not navigate to the tag", async () => {
    window.history.replaceState(null, "", "/");
    const onNavigate = vi.fn();
    const { container } = render(
      <Fragments path=":60-doc.yo" groups={[GROUP]} width={300} onNavigate={onNavigate} />,
    );
    const tag = container.querySelector(".tagtag, .tagswatch") as HTMLElement;
    expect(tag).toBeTruthy();
    await act(async () => { fireEvent.click(tag); });
    expect(onNavigate).not.toHaveBeenCalled();
    expect(decodeURIComponent(window.location.hash.slice(1))).toBe("/yo/fragments/abc123");
  });

  it("a PDF region shows its crop, not a type label", () => {
    const { container } = render(
      <Fragments
        path=":doc"
        groups={[{ slug: "p1", selector: { type: "pdf" }, imageUrl: "/crop.png", tags: [] }]}
        width={300}
        onNavigate={() => {}}
      />,
    );
    expect(container.querySelector(".fragment-thumb")?.getAttribute("src")).toBe("/crop.png");
    expect(container.textContent).not.toMatch(/PDF|fragment/i);
  });
});
