import { describe, it, expect } from "vitest";
import { createHandlers } from "../src/server/engine-api";
import { tmpTree } from "./helpers";
import { call, callBody } from "./http";

// The explorer renderer's server side: the stat-derived `concrete` (dir | yamlover | null)
// on /api/json, link markers, and the TOC — and GET /api/tagged, a tag's materials with
// annotations resolved to their `target`.

const TAG_FILE = { "tags.yamlover": 'yellow: !!<*yamlover/$defs/tag>\n  color: "#f9e2af"\n' };
const TAG = ":tags.yamlover:yellow";

describe("concrete (stat-derived)", () => {
  it("reports the per-node concrete: dir / dir/yamlover / file-backed / inlined language", async () => {
    const root = tmpTree({
      "sub/name": "Alice",
      "d/.yamlover/body.yamlover": "m:\n  x: 1\n",
      top: "42",
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    expect(call(h, "/api/json", { path: ":sub" }).json.concrete).toBe("dir");
    expect(call(h, "/api/json", { path: ":d" }).json.concrete).toBe("dir/yamlover");
    // a stray extensionless text file → a file-backed scalar
    expect(call(h, "/api/json", { path: ":top" }).json.concrete).toBe("file/yaml");
    // an interior mapping (inside the d document) reports the document's inlined language
    expect(call(h, "/api/json", { path: ":d:m" }).json.concrete).toBe("yamlover");
    // the served root is a `.yamlover`-backed directory
    expect(call(h, "/api/json", { path: ":" }).json.concrete).toBe("dir/yamlover");
  });

  it("rides the member link markers and the TOC tree", async () => {
    const root = tmpTree({
      "sub/name": "Alice",
      "d/.yamlover/body.yamlover": "m:\n  x: 1\n",
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const value = call(h, "/api/json", { path: ":" }).json.value;
    expect(value.sub.$yamloverLink.concrete).toBe("dir");
    expect(value.d.$yamloverLink.concrete).toBe("dir/yamlover");

    const tree = call(h, "/api/tree", { path: ":" }).json;
    const byLabel = Object.fromEntries(tree.children.map((c: { label: string }) => [c.label, c]));
    expect(byLabel.sub.concrete).toBe("dir");
    expect(byLabel.d.concrete).toBe("dir/yamlover");
    const m = byLabel.d.children.find((c: { label: string }) => c.label === "m");
    expect(m.concrete).toBe("yamlover"); // interior of the d document → its inlined language
  });
});

describe("GET /api/tagged", () => {
  it("resolves annotation-mediated memberships to their target material", async () => {
    const h = createHandlers(tmpTree({ name: "Alice", ...TAG_FILE }), { gitignore: false });
    await h.ready;
    await callBody(h, "POST", "/api/annotate", { target: ":name", tag: TAG });

    const r = call(h, "/api/tagged", { path: TAG });
    expect(r.status).toBe(200);
    expect(r.json).toHaveLength(1);
    expect(r.json[0].$yamloverLink.path).toBe(":name");
  });

  it("dedups: two annotations applying the same tag to one material show it once", async () => {
    const h = createHandlers(tmpTree({ name: "Alice", ...TAG_FILE }), { gitignore: false });
    await h.ready;
    await callBody(h, "POST", "/api/annotate", { target: ":name", tag: TAG, description: "first" });
    await callBody(h, "POST", "/api/annotate", { target: ":name", tag: TAG, description: "second" });

    const r = call(h, "/api/tagged", { path: TAG });
    expect(r.json).toHaveLength(1);
    expect(r.json[0].$yamloverLink.path).toBe(":name");
  });

  it("a directly-tagged node (authoring `~-` itself) appears as itself — once, even when also annotated", async () => {
    const root = tmpTree({
      ...TAG_FILE,
      "direct.yamlover": 'title: "D"\n~- *//tags.yamlover/yellow\n',
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    expect(call(h, "/api/tagged", { path: TAG }).json.map((m: any) => m.$yamloverLink.path)).toEqual([
      ":direct.yamlover",
    ]);

    // an annotation applying the same tag to the same node does not duplicate it
    await callBody(h, "POST", "/api/annotate", { target: ":direct.yamlover", tag: TAG });
    expect(call(h, "/api/tagged", { path: TAG }).json).toHaveLength(1);
  });

  it("subtags are containment children, not memberships — they never appear", async () => {
    const root = tmpTree({
      name: "Alice",
      "tags.yamlover":
        'yellow: !!<*yamlover/$defs/tag>\n  color: "#f9e2af"\n  pale: !!<*yamlover/$defs/tag>\n    color: "#fdf3c4"\n',
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    await callBody(h, "POST", "/api/annotate", { target: ":name", tag: TAG });

    expect(call(h, "/api/tagged", { path: TAG }).json.map((m: any) => m.$yamloverLink.path)).toEqual([":name"]);
  });

  it("404s for a path that is not a tag node", async () => {
    const h = createHandlers(tmpTree({ name: "Alice", ...TAG_FILE }), { gitignore: false });
    await h.ready;
    expect(call(h, "/api/tagged", { path: ":name" }).status).toBe(404);
    expect(call(h, "/api/tagged", { path: ":nowhere" }).status).toBe(404);
  });
});
