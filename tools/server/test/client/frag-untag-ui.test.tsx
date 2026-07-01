// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, waitFor, act, fireEvent } from "@testing-library/react";
import { useMaterialAnnotations, useAnnotationMenu } from "../../src/client/renderers/annotate";
import { createHandlers } from "../../src/server/engine-api";
import { tmpTree } from "../helpers";
import { call, callBody } from "../http";

function routeFetchTo(h: any) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL("http://localhost" + String(input));
    const method = (init?.method ?? "GET") as "GET" | "POST" | "DELETE";
    const params = Object.fromEntries(u.searchParams.entries());
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const r = method === "GET" ? call(h, u.pathname, params) : await callBody(h, method, u.pathname, body, params);
    return { ok: r.status < 400, status: r.status, json: async () => r.json } as Response;
  }));
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

let ext: any = null;
function Harness({ path }: { path: string }) {
  const m = useMaterialAnnotations(path);
  const menu = useAnnotationMenu(m, path);
  ext = { m, menu };
  return <div>{menu.palette}<output>{m.annotations.filter((a) => a.tag).length}</output></div>;
}

// A named tag (renders as a `.tagtag.on` chip when applied — easy to click).
const TAG_FILE = { "tags.yamlover": "field:\n  math: !!<*::yamlover:$defs:tag>\n" };
const TAG = ":tags.yamlover:field:math";
const SEL = { type: "rect", x: 10, y: 20, w: 30, h: 40 };

describe("UI: untag a fragment region by clicking its applied tag in the menu", () => {
  it("removes it from the server (region + tag gone)", async () => {
    const root = tmpTree({ "docs/pic.png": "\x89PNG binary", ...TAG_FILE });
    const h = createHandlers(root, { gitignore: false });
    await (h as any).ready;
    routeFetchTo(h);

    const { container } = render(<Harness path=":docs:pic.png" />);
    const count = () => container.querySelector("output")!.textContent;

    // tag the region
    await act(async () => { ext.m.annotateRegion(SEL, { path: TAG, name: "math", color: null }); });
    await waitFor(() => expect(count()).toBe("1"));

    // open the EDIT menu on the region's annotation (what clicking the mark does)
    const ann = ext.m.annotations.find((a: any) => a.tag);
    await act(async () => { ext.menu.openEdit(ann, { x: 100, y: 100 }); });

    // the applied tag renders OUTLINED (`.on`); clicking it must UNtag (not re-add)
    const onChip = await waitFor(() => {
      const el = container.querySelector(".tagtag.on, .annotate-swatch.on");
      if (!el) throw new Error("no applied (.on) tag in the menu");
      return el as HTMLElement;
    });
    await act(async () => { fireEvent.click(onChip); });

    await waitFor(() => {
      expect(count()).toBe("0");
      const server = call(h, "/api/annotations", { path: ":docs:pic.png" }).json;
      expect(server.filter((a: { tag?: unknown }) => a.tag)).toHaveLength(0);
    });
    (h as any).close();
  });

  it("after untagging an EXISTING region, no preview keeps it drawn (it disappears)", async () => {
    const root = tmpTree({ "docs/pic.png": "\x89PNG binary", ...TAG_FILE });
    const h = createHandlers(root, { gitignore: false });
    await (h as any).ready;
    routeFetchTo(h);

    render(<Harness path=":docs:pic.png" />);
    await act(async () => { ext.m.annotateRegion(SEL, { path: TAG, name: "math", color: null }); });
    await waitFor(() => expect(ext.m.annotations.filter((a: any) => a.tag).length).toBe(1));

    // open the region for EDIT, then remove its only tag
    const ann = ext.m.annotations.find((a: any) => a.tag);
    await act(async () => { ext.menu.openEdit(ann, { x: 10, y: 10 }); });
    await act(async () => { ext.m.remove(ann); });

    // the region is gone from the material AND no synthetic preview re-draws it (the renderer would
    // otherwise keep the marquee, making "uncheck all" look like a no-op)
    await waitFor(() => {
      expect(ext.m.annotations.filter((a: any) => a.tag)).toHaveLength(0);
      expect(ext.menu.preview).toBeNull();
    });
    (h as any).close();
  });

  it("closes the menu on a wheel gesture (image/map/PDF pan fires wheel, not scroll)", async () => {
    const root = tmpTree({ "docs/pic.png": "\x89PNG binary", ...TAG_FILE });
    const h = createHandlers(root, { gitignore: false });
    await (h as any).ready;
    routeFetchTo(h);

    const { container } = render(<Harness path=":docs:pic.png" />);
    await act(async () => { ext.m.annotateRegion(SEL, { path: TAG, name: "math", color: null }); });
    await waitFor(() => expect(container.querySelector("output")!.textContent).toBe("1"));
    const ann = ext.m.annotations.find((a: any) => a.tag);
    await act(async () => { ext.menu.openEdit(ann, { x: 100, y: 100 }); });
    await waitFor(() => expect(container.querySelector(".annotate-menu")).toBeTruthy());

    // a wheel anywhere outside the menu (the viewer panning) closes it
    await act(async () => { window.dispatchEvent(new WheelEvent("wheel", { bubbles: true })); });
    await waitFor(() => expect(container.querySelector(".annotate-menu")).toBeFalsy());
    (h as any).close();
  });
});
