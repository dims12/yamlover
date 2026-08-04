import { describe, it, expect } from "vitest";
import { createHandlers } from "./helpers";
import { applyTextEdits } from "../src/server/engine-api";
import { tmpTree } from "./helpers";
import { call, callBody } from "./http";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { decodeEnvelope } from "../src/client/content";
import { deriveNodeJson } from "../src/client/derive-node";
import { nodeJson } from "./node-json";

/** POST /api/preview now answers `text/yamlover` (the content envelope) — post the source and
 *  derive the NodeJson the way the client does. */
function previewNode(h: Parameters<typeof call>[0], source: string): Promise<{ status: number; node?: ReturnType<typeof deriveNodeJson>; error?: string }> {
  return new Promise((resolve) => {
    const req = Readable.from([Buffer.from(JSON.stringify({ source }))]) as unknown as IncomingMessage;
    (req as { method?: string }).method = "POST";
    const state = { statusCode: 200 };
    const res = {
      setHeader() {},
      get statusCode() { return state.statusCode; },
      set statusCode(v: number) { state.statusCode = v; },
      end(b: string) {
        if (state.statusCode !== 200) {
          let error = b;
          try { error = String((JSON.parse(b) as { error?: string }).error ?? b); } catch { /* raw */ }
          resolve({ status: state.statusCode, error });
          return;
        }
        resolve({ status: 200, node: deriveNodeJson(decodeEnvelope(b), null) });
      },
    } as unknown as ServerResponse;
    (h as unknown as (rq: IncomingMessage, rs: ServerResponse, u: URL) => void)(req, res, new URL("http://localhost/api/preview"));
  });
}

// POST /api/preview + /api/edit-text — the STANDALONE-document services behind the client's
// browser-settings page: the same projection and surgical-edit semantics as /api/json + /api/edit,
// over a text that lives nowhere on disk (the client keeps it in localStorage). Both stateless.

const TEMPLATE = `# Browser settings — this device only.
# Overrides the project settings.
!!<*yamlover:$defs:config>

width: 72   # reading width (ch)
tags: *:: taxonomy
`;

describe("/api/preview (standalone yamlover text)", () => {
  it("projects a browser-settings-like doc: value, head banner, root tag, format, unresolved pointer", async () => {
    const h = createHandlers(tmpTree({}), { gitignore: false });
    await h.ready;
    const r = await previewNode(h, TEMPLATE);
    expect(r.status).toBe(200);
    const n = r.node!;
    expect(n.path).toBe(":");
    expect(n.format).toBe("x-yamlover-config");
    expect(n.concrete).toBe("yamlover");
    expect((n.value as Record<string, unknown>).width).toBe(72);
    // the project-scope pointer has no target in a standalone doc → plain pointer text, no link
    expect((n.value as Record<string, unknown>).tags).toEqual({ $yamloverRef: { text: ":: taxonomy", path: null } });
    const comments = n.comments as Record<string, { tag?: string; trailing?: string[] } | string[]>;
    expect((comments.$head as string[])?.[0]).toContain("Browser settings");
    expect((comments[""] as { tag?: string }).tag).toBe("!!<*yamlover: $defs: config>"); // canonical spaced form
    expect((comments["/width"] as { trailing?: string[] }).trailing?.[0]).toContain("reading width");
    h.close();
  });

  it("400s on a parse error, and never touches the served tree", async () => {
    const h = createHandlers(tmpTree({ name: "Alice" }), { gitignore: false });
    await h.ready;
    const r = await previewNode(h, "a: [unclosed");
    expect(r.status).toBe(400);
    expect((await nodeJson(h, { path: ":name" })).json.value).toBe("Alice"); // tree unharmed
    h.close();
  });
});

describe("applyTextEdits (/api/edit-text)", () => {
  it("emplaces an existing key in place, preserving comments and the root tag", () => {
    const out = applyTextEdits(TEMPLATE, [{ path: ":width", op: "emplace", yamlover: "96" }]);
    expect(out).toContain("width: 96");
    expect(out).toContain("# Browser settings — this device only.");
    expect(out).toContain("!!<*yamlover:$defs:config>");
    expect(out).toContain("tags: *:: taxonomy");
  });

  it("emplace at a FRESH top-level key appends it", () => {
    const out = applyTextEdits(TEMPLATE, [{ path: ":sidecars", op: "emplace", yamlover: "project" }]);
    expect(out).toContain("sidecars: project");
    expect(out).toContain("width: 72"); // untouched
  });

  it("a COLON inside a trailing comment does not read as an inline mapping (regression)", () => {
    // `# ui palette: dark | light` made isContainerEntry classify the scalar entry as a container,
    // re-rendering the old value as a bogus child line — the corrupted result then failed to parse.
    // (The trailing-comment law now CARRIES the remark onto the re-rendered line — the user's
    // labour survives the value edit.)
    const src = "width: 124\ntheme: dark   # ui palette: dark | light\n";
    const out = applyTextEdits(src, [{ path: ":theme", op: "emplace", yamlover: "light" }]);
    expect(out).toBe("width: 124\ntheme: light   # ui palette: dark | light\n");
    // a GENUINE inline mapping under a `- ` item still classifies as one (comment and all)
    const doc = "- title: Sub   # note: keep\n  body: x\n";
    const out2 = applyTextEdits(doc, [{ path: "[0]:body", op: "emplace", yamlover: "y" }]);
    expect(out2).toContain("- title: Sub   # note: keep");
    expect(out2).toContain("body: y");
  });

  it("refuses a malformed payload (source untouched) and file-only fields", () => {
    expect(() => applyTextEdits(TEMPLATE, [{ path: ":width", op: "emplace", yamlover: "[unclosed" }])).toThrow();
    expect(() => applyTextEdits(TEMPLATE, [{ path: ":x", op: "emplace", yamlover: "1", concrete: "file/yamlover" }])).toThrow(/file-backed/);
  });

  it("serves the edit over HTTP and the result re-parses", async () => {
    const h = createHandlers(tmpTree({}), { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/edit-text", {
      source: TEMPLATE,
      edits: [{ path: ":width", op: "emplace", yamlover: "120" }],
    });
    expect(r.status).toBe(200);
    const p = await previewNode(h, r.json.source);
    expect((p.node!.value as Record<string, unknown>).width).toBe(120);
    h.close();
  });
});
