import { describe, it, expect } from "vitest";
import { createHandlers } from "../src/server/engine-api";
import { tmpTree } from "./helpers";
import { call, callBody } from "./http";

// The TYPE FACETS the projection exposes for renderer dispatch (TYPES.md §9): valueType / hasKeyed
// / hasOrdinal. The regression they fix: tagging a node turns it omni, but its value facet (format,
// valueType) must survive so the client still routes it (e.g. markdown stays markdown).

const TAG_FILE = { "tags.yamlover": 'yellow: !!<*::yamlover:$defs:tag>\n  color: "#f9e2af"\n' };
const TAG = ":tags.yamlover:yellow";

describe("type facets in /api/json", () => {
  it("a plain markdown string exposes a string value facet, no elements", async () => {
    const root = tmpTree({ "note.yamlover": "!!<format: text/markdown>\nHello markdown\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const j = call(h, "/api/json", { path: ":note.yamlover" }).json;
    expect(j.valueType).toBe("string");
    expect(j.hasKeyed).toBe(false);
    expect(j.hasOrdinal).toBe(false);
    h.close();
  });

  it("a TAGGED node stays an omni with its value facet intact (the renderer-breakage fix)", async () => {
    // a markdown doc, then annotate it → it gains a `yamlover-annotations` key (becomes omni)
    const root = tmpTree({ "note.yamlover": "!!<format: text/markdown>\nHello markdown\n", ...TAG_FILE });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    expect((await callBody(h, "POST", "/api/annotate", { target: ":note.yamlover", tag: TAG })).status).toBe(201);

    const j = call(h, "/api/json", { path: ":note.yamlover" }).json;
    expect(j.type).toBe("variant"); // the KIND flipped to omni…
    expect(j.format).toBe("text/markdown"); // …but the value facet's format SURVIVES
    expect(j.valueType).toBe("string"); // and its value type
    expect(j.hasKeyed).toBe(true); // it now owns the yamlover-annotations element
    // → the client's byFormat("text/markdown") matcher still claims it (see registry.test.ts)
    h.close();
  });

  it("a blob exposes a binary value facet", async () => {
    const root = tmpTree({ "docs/pic.png": "\x89PNG\r\n\x1a\n bytes" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const j = call(h, "/api/json", { path: ":docs:pic.png" }).json;
    expect(j.valueType).toBe("binary");
    expect(j.hasKeyed).toBe(false);
    h.close();
  });

  it("a plain object has no value facet but owns keyed elements", async () => {
    const root = tmpTree({ "obj.yamlover": "a: 1\nb: 2\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const j = call(h, "/api/json", { path: ":obj.yamlover" }).json;
    expect(j.valueType).toBeNull();
    expect(j.hasKeyed).toBe(true);
    expect(j.hasOrdinal).toBe(false);
    h.close();
  });
});
