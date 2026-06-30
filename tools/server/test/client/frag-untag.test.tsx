// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, waitFor, act } from "@testing-library/react";
import { useRef } from "react";
import { useMaterialAnnotations, MaterialAnnotations } from "../../src/client/renderers/annotate";
import { createHandlers } from "../../src/server/engine-api";
import { tmpTree } from "../helpers";
import { call, callBody } from "../http";

// Route the client's global fetch into the REAL engine handlers, so the hook's create/remove and
// the server's embed/unembed + reindex run end-to-end — the only way to catch a client reconcile
// bug that unit-mocked routes would hide.
// `gate`, when set, holds every POST (create/annotate) until released — so a test can remove a tag
// while its create is still in flight.
function routeFetchTo(h: any, gate?: { wait: () => Promise<void> }) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = String(input);
    const u = new URL("http://localhost" + raw);
    const method = (init?.method ?? "GET") as "GET" | "POST" | "DELETE";
    const params = Object.fromEntries(u.searchParams.entries());
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method === "POST" && gate) await gate.wait();
    const result = method === "GET" ? call(h, u.pathname, params) : await callBody(h, method, u.pathname, body, params);
    return { ok: result.status < 400, status: result.status, json: async () => result.json } as Response;
  });
  vi.stubGlobal("fetch", fn);
}

/** A manually-released gate: `wait()` blocks until `release()` is called. */
function makeGate() {
  let release!: () => void;
  const p = new Promise<void>((r) => (release = r));
  return { wait: () => p, release };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

let api: MaterialAnnotations | null = null;
function Probe({ path }: { path: string }) {
  const m = useMaterialAnnotations(path);
  api = m;
  const ref = useRef(m);
  ref.current = m;
  return <output>{m.annotations.filter((a) => a.tag).length}</output>;
}

const TAG = "::yamlover:tags:colors:yellow";
const SEL = { type: "rect", x: 1, y: 2, w: 3, h: 4 };

describe("REPRO: untag a fragment region via the client hook", () => {
  it("removing the region's tag persists (does not reappear)", async () => {
    const root = tmpTree({ "docs/pic.png": "\x89PNG binary", "tags.yamlover": "x: 1" });
    const h = createHandlers(root, { gitignore: false });
    await (h as any).ready;
    routeFetchTo(h);

    const { container } = render(<Probe path=":docs:pic.png" />);
    const count = () => container.querySelector("output")!.textContent;

    // tag the region (first tag → creates the fragment + annotates it)
    await act(async () => { api!.annotateRegion(SEL as any, { path: TAG, name: "yellow", color: "#f9e2af" }); });
    await waitFor(() => expect(count()).toBe("1"));

    // now remove that tag — find the fetched annotation for the region and remove it
    const victim = api!.annotations.find((a) => a.tag);
    expect(victim).toBeTruthy();
    await act(async () => { api!.remove(victim!); });

    // it must STAY gone (optimistic hide AND the server-confirmed refetch)
    await waitFor(() => expect(count()).toBe("0"));
    // and the server agrees — re-read directly
    const server = call(h, "/api/annotations", { path: ":docs:pic.png" }).json;
    expect(server.filter((a: { tag?: unknown }) => a.tag)).toHaveLength(0);
    (h as any).close();
  });

  it("removing a tag whose create is STILL IN FLIGHT also persists (the auto-apply race)", async () => {
    const root = tmpTree({ "docs/pic.png": "\x89PNG binary", "tags.yamlover": "x: 1" });
    const h = createHandlers(root, { gitignore: false });
    await (h as any).ready;
    const gate = makeGate();
    routeFetchTo(h, gate); // POSTs (create/annotate) hang until released

    const { container } = render(<Probe path=":docs:pic.png" />);
    const count = () => container.querySelector("output")!.textContent;

    // select-a-region: auto-apply the default tag → an optimistic (pending) entry, create gated
    await act(async () => { api!.annotateRegion(SEL as any, { path: TAG, name: "yellow", color: "#f9e2af" }); });
    expect(count()).toBe("1"); // shown optimistically while the create is in flight
    const pending = api!.annotations.find((a) => a.tag)!;
    expect(pending.path).toBe("(pending)"); // create has NOT landed yet

    // deselect it WHILE the create is still gated — mirrors the user's instant deselect
    await act(async () => { api!.remove(pending); });
    expect(count()).toBe("0"); // hidden at once

    // now let the create finish — the deferred delete must fire so it stays gone (no resurrection),
    // both in the UI and on the server
    await act(async () => { gate.release(); });
    await waitFor(() => {
      expect(count()).toBe("0");
      const server = call(h, "/api/annotations", { path: ":docs:pic.png" }).json;
      expect(server.filter((a: { tag?: unknown }) => a.tag)).toHaveLength(0);
    });
    (h as any).close();
  });
});
