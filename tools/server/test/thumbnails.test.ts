// Thumbnails: the per-type extractor product served by GET /api/thumb, stored the yamlover way —
// a content-addressed sidecar under thumbnails/ plus a `yamlover-thumbnails:[w, h]` omni overlay
// on the source blob. Covers: generation + serve, the overlay/sidecar side-effects, the node
// being indexed (overlay parses), the no-write cache hit, and the no-decoder 415 fallback.

import { describe, it, expect, onTestFinished } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHandlers } from "./helpers";
import { Store } from "../../engine/ts/src/store.ts";
import { tmpTree } from "./helpers.ts";
import { call, sseCapture } from "./http.ts";

function handlers(root: string) {
  const h = createHandlers(root, { gitignore: false });
  onTestFinished(() => h.close());
  return h;
}

/** Drive a handler whose response may be a STREAM (the /api/thumb byte path) or a JSON end() —
 *  collects the body and resolves on finish. (test/http.ts `call` only handles JSON end().) */
function callStream(
  h: ReturnType<typeof createHandlers>,
  pathname: string,
  params: Record<string, string>,
): Promise<{ status: number; type: string | undefined; body: Buffer }> {
  const url = new URL("http://localhost" + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const chunks: Buffer[] = [];
  const headers: Record<string, string> = {};
  return new Promise((resolve, reject) => {
    const res = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    }) as unknown as ServerResponse & { statusCode: number };
    res.statusCode = 200;
    res.setHeader = (k: string, v: number | string | string[]) => {
      headers[k.toLowerCase()] = String(v);
      return res;
    };
    (res as unknown as Writable).on("finish", () =>
      resolve({ status: res.statusCode, type: headers["content-type"], body: Buffer.concat(chunks) }),
    );
    (res as unknown as Writable).on("error", reject);
    h({} as IncomingMessage, res, url);
  });
}

/** Write a w×h gradient PNG into `root/name` and return its byte length. */
async function writePng(root: string, name: string, w: number, h: number): Promise<void> {
  const { Jimp } = await import("jimp");
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = x % 256;
      data[i + 1] = y % 256;
      data[i + 2] = 128;
      data[i + 3] = 255;
    }
  const png = await Jimp.fromBitmap({ data, width: w, height: h }).getBuffer("image/png");
  fs.writeFileSync(path.join(root, name), png);
}

const overlayFile = (root: string) => path.join(root, ".yamlover", "body.yamlover");

describe("GET /api/thumb", () => {
  it("generates a fitted JPEG, stores a sidecar + overlay, and indexes the thumbnail node", async () => {
    const root = tmpTree({ "note.md": "# hi" });
    await writePng(root, "pic.png", 800, 600);
    const h = handlers(root);
    await h.ready;

    const r = await callStream(h, "/api/thumb", { path: ":pic.png", w: "320", h: "240" });
    expect(r.status).toBe(200);
    expect(r.type).toBe("image/jpeg");

    // the served bytes are a real JPEG, fitted within the box (aspect preserved → 320×240)
    const { Jimp } = await import("jimp");
    const decoded = await Jimp.read(r.body);
    expect(decoded.bitmap.width).toBe(320);
    expect(decoded.bitmap.height).toBe(240);

    // a content-addressed sidecar landed under the hidden .yamlover/thumbnails/ (per-directory mode)
    const sidecars = fs.readdirSync(path.join(root, ".yamlover", "thumbnails"));
    expect(sidecars).toHaveLength(1);
    expect(sidecars[0]).toMatch(/^xxh64-[0-9a-f]+-320x240\.jpg$/);

    // the overlay grew a yamlover-thumbnails entry keyed by the [w, h] tuple, with a
    // DOCUMENT-relative pointer into the hidden .yamlover/ subtree
    const body = fs.readFileSync(overlayFile(root), "utf8");
    expect(body).toContain("yamlover-thumbnails:");
    expect(body).toMatch(/\[320, 240\]: \*:\.yamlover:thumbnails:/);

    // and the overlay parsed: the thumbnail is a real node in the graph under the source blob — a
    // `[320, 240]` ref edge (the `*` pointer) resolving to the sidecar's image/jpeg blob.
    const probe = new Store(path.join(root, ".yamlover", "index.db"));
    onTestFinished(() => probe.close());
    const edge = probe.relationships(":pic.png:yamlover-thumbnails").out.find((e) => e.label === "[320, 240]");
    expect(edge?.kind).toBe("ref");
    expect(probe.node(edge!.to)?.format).toBe("image/jpeg");
  });

  it("serves the cached sidecar on the second request without re-encoding", async () => {
    const root = tmpTree({});
    await writePng(root, "pic.png", 400, 400);
    const h = handlers(root);
    await h.ready;

    const a = await callStream(h, "/api/thumb", { path: ":pic.png", w: "128", h: "128" });
    const b = await callStream(h, "/api/thumb", { path: ":pic.png", w: "128", h: "128" });
    expect(a.status).toBe(200);
    expect(b.body.equals(a.body)).toBe(true);
    // exactly one sidecar — the second request hit the fast path, not a fresh encode
    expect(fs.readdirSync(path.join(root, ".yamlover", "thumbnails"))).toHaveLength(1);
  });

  it("returns 415 for a format with no decoder (the explorer falls back to the glyph)", async () => {
    const root = tmpTree({});
    // a tiny non-image blob with a known-but-undecodable format (PDF magic)
    fs.writeFileSync(path.join(root, "doc.pdf"), Buffer.from("%PDF-1.4\n%fake\n"));
    const h = handlers(root);
    await h.ready;

    const r = await callStream(h, "/api/thumb", { path: ":doc.pdf", w: "256", h: "256" });
    expect(r.status).toBe(415);
    expect(fs.existsSync(path.join(root, ".yamlover", "thumbnails"))).toBe(false);
  });

  it("project mode writes the sidecar to the ROOT .yamlover/ with a project-scoped pointer", async () => {
    const root = tmpTree({ ".yamlover/settings.yamlover": "sidecars: project\n" });
    fs.mkdirSync(path.join(root, "sub"));
    await writePng(root, "sub/pic.png", 400, 300); // a NESTED source image
    const h = handlers(root);
    await h.ready;

    const r = await callStream(h, "/api/thumb", { path: ":sub:pic.png", w: "128", h: "128" });
    expect(r.status).toBe(200);
    // the sidecar lands in the ROOT .yamlover/ (centralized), not beside the source
    expect(fs.readdirSync(path.join(root, ".yamlover", "thumbnails"))).toHaveLength(1);
    expect(fs.existsSync(path.join(root, "sub", ".yamlover", "thumbnails"))).toBe(false);
    // and the overlay pointer is PROJECT-scoped (double colon)
    const body = fs.readFileSync(path.join(root, "sub", ".yamlover", "body.yamlover"), "utf8");
    expect(body).toMatch(/\[128, 128\]: \*::\.yamlover:thumbnails:/);
  });

  it("the .yamlover overlay subtree is resolvable but HIDDEN from /api/json + /api/tree", async () => {
    const root = tmpTree({});
    await writePng(root, "pic.png", 200, 200);
    const h = handlers(root);
    await h.ready;
    await callStream(h, "/api/thumb", { path: ":pic.png", w: "64", h: "64" }); // creates .yamlover/thumbnails

    // the root's member list omits .yamlover…
    const rootJson = call(h, "/api/json", { path: ":" }).json;
    expect(Object.keys(rootJson.value)).not.toContain(".yamlover");
    // …and so does the TOC
    const tree = call(h, "/api/tree", { path: ":", depth: "2" }).json;
    expect(tree.children.map((c: { label: string }) => c.label)).not.toContain(".yamlover");
    // but the sidecar blob inside it is still resolvable by direct path
    const name = fs.readdirSync(path.join(root, ".yamlover", "thumbnails"))[0];
    const blob = call(h, "/api/json", { path: `:.yamlover:thumbnails:${name}` }).json;
    expect(blob.type).toBe("binary");
  });

  it("surfaces a coalesced 'building thumbnails' task over SSE while generating", async () => {
    const root = tmpTree({});
    fs.mkdirSync(path.join(root, "pics"));
    await writePng(root, "pics/a.png", 200, 150);
    await writePng(root, "pics/b.png", 200, 150);
    const h = handlers(root);
    await h.ready;
    const sse = sseCapture(h);
    onTestFinished(() => sse.close());

    // a directory load fires several thumbnail requests at once
    await Promise.all([
      callStream(h, "/api/thumb", { path: ":pics:a.png", w: "128", h: "128" }),
      callStream(h, "/api/thumb", { path: ":pics:b.png", w: "128", h: "128" }),
    ]);

    const built = sse
      .frames()
      .filter((f) => f.type === "task" && f.task.label === "building thumbnails")
      .map((f) => f.task);
    expect(built.length).toBeGreaterThan(0); // the task was announced (same strip as index/hasher)
    expect(built.at(-1).state).toBe("done"); // and cleared when the burst drained
  });
});
