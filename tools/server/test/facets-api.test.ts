import { describe, it, expect } from "vitest";
import { createHandlers } from "./helpers";
import { tmpTree } from "./helpers";
import { call, callBody } from "./http";
import { nodeJson } from "./node-json";

// The TYPE FACETS the projection exposes for renderer dispatch (docs/language/logical-graph/matching): valueType / hasKeyed
// / hasOrdinal. The regression they fix: tagging a node turns it omni, but its value facet (format,
// valueType) must survive so the client still routes it (e.g. markdown stays markdown).

const TAG_FILE = { "ontos.yo": 'yellow: !!<*::yamlover:$defs:onto>\n  color: "#f9e2af"\n' };
const TAG = ":ontos.yo:yellow";

describe("type facets in /api/json", () => {
  it("a plain markdown string exposes a string value facet, no elements", async () => {
    const root = tmpTree({ "note.yo": "!!<format: text/markdown>\nHello markdown\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const j = (await nodeJson(h, { path: ":note.yo" })).json;
    expect(j.valueType).toBe("string");
    expect(j.hasKeyed).toBe(false);
    expect(j.hasOrdinal).toBe(false);
    h.close();
  });

  it("a FILED node keeps its exact shape — a membership bookmark adds nothing", async () => {
    // a markdown doc, then file it under an onto → the bookmark is an edge, never an entry
    const root = tmpTree({ "note.yo": "!!<format: text/markdown>\nHello markdown\n", ...TAG_FILE });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    expect((await callBody(h, "POST", "/api/annotate", { target: ":note.yo", tag: TAG })).status).toBe(201);

    const j = (await nodeJson(h, { path: ":note.yo" })).json;
    expect(j.type).toBe("string"); // the kind is UNCHANGED — no renderer can be broken by filing
    expect(j.format).toBe("text/markdown");
    expect(j.valueType).toBe("string");
    expect(j.hasKeyed).toBe(false); // no entries appeared
    h.close();
  });

  it("a blob exposes a binary value facet", async () => {
    const root = tmpTree({ "docs/pic.png": "\x89PNG\r\n\x1a\n bytes" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const j = (await nodeJson(h, { path: ":docs:pic.png" })).json;
    expect(j.valueType).toBe("binary");
    expect(j.hasKeyed).toBe(false);
    h.close();
  });

  it("a plain object has no value facet but owns keyed elements", async () => {
    const root = tmpTree({ "obj.yo": "a: 1\nb: 2\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const j = (await nodeJson(h, { path: ":obj.yo" })).json;
    expect(j.valueType).toBeNull();
    expect(j.hasKeyed).toBe(true);
    expect(j.hasOrdinal).toBe(false);
    h.close();
  });
});
