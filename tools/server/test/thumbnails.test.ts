// Thumbnails: the per-type extractor product served by GET /api/thumb, stored the yamlover way —
// a content-addressed sidecar under thumbnails/ plus a `yamlover-thumbnails:[w, h]` omni overlay
// on the source blob. Covers: generation + serve, the overlay/sidecar side-effects, the node
// being indexed (overlay parses), the no-write cache hit, and the no-decoder 415 fallback.

import { describe, it, expect, onTestFinished } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHandlers } from "../src/server/engine-api.ts";
import { Store } from "../../engine/ts/src/store.ts";
import { tmpTree } from "./helpers.ts";

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

    // a content-addressed sidecar landed under thumbnails/
    const sidecars = fs.readdirSync(path.join(root, "thumbnails"));
    expect(sidecars).toHaveLength(1);
    expect(sidecars[0]).toMatch(/^xxh64-[0-9a-f]+-320x240\.jpg$/);

    // the overlay grew a yamlover-thumbnails entry keyed by the [w, h] tuple, pointing at it
    const body = fs.readFileSync(overlayFile(root), "utf8");
    expect(body).toContain("yamlover-thumbnails:");
    expect(body).toMatch(/\[320, 240\]: \*::thumbnails:/);

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
    expect(fs.readdirSync(path.join(root, "thumbnails"))).toHaveLength(1);
  });

  it("returns 415 for a format with no decoder (the explorer falls back to the glyph)", async () => {
    const root = tmpTree({});
    // a tiny non-image blob with a known-but-undecodable format (PDF magic)
    fs.writeFileSync(path.join(root, "doc.pdf"), Buffer.from("%PDF-1.4\n%fake\n"));
    const h = handlers(root);
    await h.ready;

    const r = await callStream(h, "/api/thumb", { path: ":doc.pdf", w: "256", h: "256" });
    expect(r.status).toBe(415);
    expect(fs.existsSync(path.join(root, "thumbnails"))).toBe(false);
  });
});
