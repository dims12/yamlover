// READ-ONLY MODE (`--read-only` / Options.readOnly): the backend guarantee. Every user-data-
// mutating route answers 403 with the one policy body, the safe POSTs and every read keep
// working, a thumbnail miss degrades to 415 instead of generating, and a reconcile never
// rewrites source files over an inferred move. Content read-only: the server's own index
// (.yo/index.db) is still maintained — tree snapshots below exclude it.

import { describe, it, expect, onTestFinished } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHandlers } from "./helpers";
import { tmpTree } from "./helpers.ts";
import { call, callBody, callText, callBytes } from "./http.ts";
import { allowedInReadOnly, READ_ONLY_ERROR, SAFE_POSTS } from "../src/server/read-only-policy";

async function handlers(root: string, opts: Parameters<typeof createHandlers>[1] = {}) {
  const h = createHandlers(root, { gitignore: false, readOnly: true, ...opts });
  onTestFinished(() => h.close());
  await h.ready;
  return h;
}

/** Every user-content byte under `root` — the index's own files are permitted housekeeping. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, d.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (rel.startsWith(".yo/index.db")) continue;
      if (d.isDirectory()) walk(abs);
      else out[rel] = fs.readFileSync(abs).toString("hex");
    }
  };
  walk(root);
  return out;
}

/** POST a JSON body and await the raw TEXT response (`/api/preview` answers text/yamlover). */
function postText(
  h: ReturnType<typeof createHandlers>,
  pathname: string,
  body: unknown,
): Promise<{ status: number; text: string }> {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  (req as { method?: string }).method = "POST";
  return new Promise((resolve) => {
    const state = { statusCode: 200 };
    const res = {
      setHeader() {},
      get statusCode() { return state.statusCode; },
      set statusCode(v: number) { state.statusCode = v; },
      end(b: string) { resolve({ status: state.statusCode, text: b ?? "" }); },
    } as unknown as ServerResponse;
    h(req, res, new URL("http://localhost" + pathname));
  });
}

/** Write a w×h gradient PNG into `root/name` (same fixture as thumbnails.test.ts). */
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

describe("the route allowlist (read-only-policy.ts)", () => {
  it("GET/HEAD always pass — including a method-less test-harness request", () => {
    expect(allowedInReadOnly("GET", "/api/edit")).toBe(true); // method rules, not the route name
    expect(allowedInReadOnly("HEAD", "/api/tree")).toBe(true);
    expect(allowedInReadOnly(undefined, "/api/tree")).toBe(true);
  });

  it("only the safe POSTs pass; everything else — present or future — is blocked", () => {
    for (const p of SAFE_POSTS) expect(allowedInReadOnly("POST", p)).toBe(true);
    expect(allowedInReadOnly("POST", "/api/edit")).toBe(false);
    expect(allowedInReadOnly("DELETE", "/api/annotate")).toBe(false);
    expect(allowedInReadOnly("POST", "/api/some-future-route")).toBe(false);
    expect(allowedInReadOnly("PUT", "/api/tree")).toBe(false);
  });
});

describe("readOnly: true — mutating routes answer 403, the tree stays byte-identical", () => {
  it("rejects every write route with the one policy body and touches nothing", async () => {
    const root = tmpTree({ "doc.yo": "x: 1\n", "note.md": "# hi" });
    const h = await handlers(root);
    const before = snapshot(root);

    const blocked: Array<["POST" | "DELETE", string]> = [
      ["POST", "/api/edit"],
      ["POST", "/api/annotate"],
      ["DELETE", "/api/annotate"],
      ["POST", "/api/fragment"],
      ["POST", "/api/tag"],
      ["POST", "/api/board"],
      ["POST", "/api/paste"],
      ["POST", "/api/mv"],
      ["POST", "/api/rekey"],
      ["POST", "/api/agent-docs"],
      ["POST", "/api/some-future-route"], // the allowlist property: unknown ≠ admitted
    ];
    for (const [method, route] of blocked) {
      const r = await callBody(h, method, route, {});
      expect(r, `${method} ${route}`).toEqual({ status: 403, json: READ_ONLY_ERROR });
    }
    expect(snapshot(root)).toEqual(before);
  });

  it("reads still answer, and /api/info reports the posture", async () => {
    const root = tmpTree({ "doc.yo": "x: 1\n" });
    const h = await handlers(root);
    expect(call(h, "/api/info").json).toMatchObject({ readOnly: true });
    expect(call(h, "/api/tree", { path: ":", depth: "1" }).status).toBe(200);
    expect((await callText(h, "/api/content", { path: ":doc.yo" })).status).toBe(200);
    expect((await callBytes(h, "/api/blob", { path: ":doc.yo" })).status).toBe(200);
  });

  it("a writable server reports readOnly: false", async () => {
    const root = tmpTree({ "doc.yo": "x: 1\n" });
    const h = await handlers(root, { readOnly: false });
    expect(call(h, "/api/info").json).toMatchObject({ readOnly: false });
  });

  it("the stateless POSTs keep working: /api/preview, /api/edit-text, /api/reindex", async () => {
    const root = tmpTree({ "doc.yo": "x: 1\n" });
    const h = await handlers(root);

    const preview = await postText(h, "/api/preview", { source: "a: 1\n" });
    expect(preview.status).toBe(200);
    expect(preview.text).toContain("a:");

    const edited = await callBody(h, "POST", "/api/edit-text", {
      source: "a: 1\n",
      edits: [{ path: ":a", op: "emplace", yamlover: "2" }],
    });
    expect(edited.status).toBe(200);
    expect(edited.json.source).toBe("a: 2\n");

    fs.writeFileSync(path.join(root, "new.md"), "# new");
    const r = await callBody(h, "POST", "/api/reindex");
    expect(r.status).toBe(200);
    expect(r.json.added).toEqual(["new.md"]);
  });
});

describe("readOnly: true — the GET-that-writes traps", () => {
  it("a thumbnail miss answers 415 and generates nothing", async () => {
    const root = tmpTree({ "note.md": "# hi" });
    await writePng(root, "pic.png", 64, 48);
    const h = await handlers(root);
    const before = snapshot(root);

    const r = await callText(h, "/api/thumb", { path: ":pic.png", w: "32", h: "24" });
    expect(r.status).toBe(415);
    expect(JSON.parse(r.text).error).toContain("read-only");
    expect(fs.existsSync(path.join(root, "thumbnails"))).toBe(false);
    expect(snapshot(root)).toEqual(before);
  });

  it("a PRE-generated thumbnail still serves", async () => {
    const root = tmpTree({ "note.md": "# hi" });
    await writePng(root, "pic.png", 64, 48);
    // generate on a WRITABLE server first…
    const writable = createHandlers(root, { gitignore: false });
    await writable.ready;
    const made = await callBytes(writable, "/api/thumb", { path: ":pic.png", w: "32", h: "24" });
    expect(made.status).toBe(200);
    writable.close();
    // …then the read-only reopen serves the sidecar from the no-write fast path
    const h = await handlers(root);
    const r = await callBytes(h, "/api/thumb", { path: ":pic.png", w: "32", h: "24" });
    expect(r.status).toBe(200);
    expect(r.bytes.length).toBeGreaterThan(0);
    expect(r.bytes.equals(made.bytes)).toBe(true);
  });

  it("an inferred external move is indexed but NOT relinked — no source rewrite", async () => {
    const root = tmpTree({ "old.md": "# unique doc", "refs.yo": "link: *:: old.md\n" });
    const h = await handlers(root);

    fs.renameSync(path.join(root, "old.md"), path.join(root, "new.md"));
    const r = await callBody(h, "POST", "/api/reindex");
    expect(r.status).toBe(200);
    expect(r.json.moved).toEqual([{ from: "old.md", to: "new.md" }]);
    // the writable path would rewrite refs.yo to `new.md` (reconcile.test.ts) — here it must not
    expect(fs.readFileSync(path.join(root, "refs.yo"), "utf8")).toBe("link: *:: old.md\n");
  });
});
