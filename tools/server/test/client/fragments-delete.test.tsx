// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, waitFor, act, fireEvent } from "@testing-library/react";
import { Fragments, FragmentGroup } from "../../src/client/Fragments";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const GROUP: FragmentGroup = {
  slug: "abc123",
  selector: { type: "text", exact: "directories" },
  tags: [
    { path: ":yamlover:tags:fifth tag", label: "fifth tag", color: null },
    { path: ":yamlover:tags:forth tag", label: "forth tag", color: null },
  ],
};

describe("Fragments panel — delete from the RHS", () => {
  it("✕ deletes every tag of the fragment (server untag) and hides the row", async () => {
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    }));

    const { container } = render(
      <Fragments path=":60-doc.yamlover" groups={[GROUP]} width={300} onNavigate={() => {}} />,
    );
    expect(container.querySelector(".fragment-row")).toBeTruthy();

    await act(async () => { fireEvent.click(container.querySelector(".fragment-delete")!); });

    // both tags deleted, targeting the fragment's node path (decode params — space may be `+` or %20)
    await waitFor(() => expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(2));
    const params = calls.map((c) => new URL("http://x" + c.url.replace(/^[^?]*/, "")).searchParams);
    expect(params.every((p) => p.get("target") === ":60-doc.yamlover:yamlover-fragments:abc123")).toBe(true);
    const tags = params.map((p) => p.get("tag"));
    expect(tags).toContain(":yamlover:tags:fifth tag");
    expect(tags).toContain(":yamlover:tags:forth tag");

    // the row hides optimistically → the panel (its only fragment gone) renders nothing
    await waitFor(() => expect(container.querySelector(".fragment-row")).toBeFalsy());
  });
});
