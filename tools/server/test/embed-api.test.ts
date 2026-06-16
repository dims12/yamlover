import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHandlers } from "../src/server/engine-api";
import { tmpTree } from "./helpers";
import { call, callBody } from "./http";

// The EMBEDDED tags/fragments model (ANNOTATIONS.md): /api/annotate appends to a target's
// `yamlover-annotations`; /api/fragment adds a `yamlover-fragments` region; reads derive from
// those forward `*::tag` edges. Synthetic temp trees only — never the repo.

const TAG_FILE = { "tags.yamlover": 'yellow: !!<*::yamlover:$defs:tag>\n  color: "#f9e2af"\n' };
const TAG = ":tags.yamlover:yellow";

describe("embedded annotations", () => {
  it("tags a whole leaf node via the enclosing overlay (no untagged-omni source)", async () => {
    const root = tmpTree({ name: "Alice", ...TAG_FILE });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/annotate", { target: ":name", tag: TAG, description: "hi" });
    expect(r.status).toBe(201);

    // a scalar leaf file is NOT rewritten in place — its annotations live in the root overlay
    expect(fs.readFileSync(path.join(root, "name"), "utf8")).toBe("Alice");
    const overlay = fs.readFileSync(path.join(root, ".yamlover", "body.yamlover"), "utf8");
    expect(overlay).toContain("yamlover-annotations:");
    expect(overlay).toContain("*::tags.yamlover:yellow");

    const list = call(h, "/api/annotations", { path: ":name" }).json;
    expect(list).toHaveLength(1);
    expect(list[0].tag).toMatchObject({ path: TAG, name: "yellow", color: "#f9e2af" });
    expect(list[0].description).toBe("hi");
    expect(list[0].selector).toBeUndefined();
    h.close();
  });

  it("survives a full reindex and lists the material under the tag", async () => {
    const root = tmpTree({ name: "Alice", ...TAG_FILE });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    await callBody(h, "POST", "/api/annotate", { target: ":name", tag: TAG });

    expect((await callBody(h, "POST", "/api/reindex", {})).status).toBe(200);
    const list = call(h, "/api/annotations", { path: ":name" }).json;
    expect(list).toHaveLength(1);
    expect(list[0].tag.name).toBe("yellow");

    const tagged = call(h, "/api/tagged", { path: TAG }).json;
    expect(Array.isArray(tagged)).toBe(true);
    expect(tagged.length).toBe(1);
    h.close();
  });

  it("tags a blob file through its directory overlay keyed by filename", async () => {
    const root = tmpTree({ "docs/pic.png": "\x89PNG\r\n\x1a\n binary-ish", ...TAG_FILE });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/annotate", { target: ":docs:pic.png", tag: TAG });
    expect(r.status).toBe(201);
    const overlay = fs.readFileSync(path.join(root, "docs", ".yamlover", "body.yamlover"), "utf8");
    expect(overlay).toContain('"pic.png":');
    expect(overlay).toContain("*::tags.yamlover:yellow");

    const list = call(h, "/api/annotations", { path: ":docs:pic.png" }).json;
    expect(list).toHaveLength(1);
    expect(list[0].tag.name).toBe("yellow");
    h.close();
  });

  it("creates a fragment + tags it; the annotation carries the selector", async () => {
    const root = tmpTree({ "docs/pic.png": "\x89PNG binary", ...TAG_FILE });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const frag = await callBody(h, "POST", "/api/fragment", {
      target: ":docs:pic.png",
      selector: { type: "rect", x: 10, y: 20, w: 30, h: 40 },
    });
    expect(frag.status).toBe(201);
    expect(frag.json.slug).toBeTruthy();

    const ann = await callBody(h, "POST", "/api/annotate", { target: frag.json.fragmentPath, tag: TAG });
    expect(ann.status).toBe(201);

    const list = call(h, "/api/annotations", { path: ":docs:pic.png" }).json;
    expect(list).toHaveLength(1);
    expect(list[0].selector).toMatchObject({ type: "rect", x: 10, y: 20, w: 30, h: 40 });
    expect(list[0].fragmentSlug).toBe(frag.json.slug);
    expect(list[0].tag.name).toBe("yellow");
    h.close();
  });

  it("stores an image-like fragment's crop as a referenced sidecar blob", async () => {
    const root = tmpTree({ "docs/pic.png": "\x89PNG binary", ...TAG_FILE });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const png = Buffer.from("\x89PNG\r\n\x1a\nCROPDATA", "binary").toString("base64");
    const frag = await callBody(h, "POST", "/api/fragment", {
      target: ":docs:pic.png",
      selector: { type: "rect", x: 1, y: 2, w: 3, h: 4 },
      imageBase64: png,
    });
    expect(frag.status).toBe(201);
    // per-directory mode: the crop sidecar lands under the target dir's hidden .yamlover/fragments/
    expect(fs.existsSync(path.join(root, "docs", ".yamlover", "fragments", `${frag.json.slug}.png`))).toBe(true);

    await callBody(h, "POST", "/api/annotate", { target: frag.json.fragmentPath, tag: TAG });
    const list = call(h, "/api/annotations", { path: ":docs:pic.png" }).json;
    expect(list[0].imageUrl).toContain("/api/blob?path=");
    h.close();
  });

  it("deletes a tag application by { target, tag }", async () => {
    const root = tmpTree({ name: "Alice", ...TAG_FILE });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    await callBody(h, "POST", "/api/annotate", { target: ":name", tag: TAG });
    expect(call(h, "/api/annotations", { path: ":name" }).json).toHaveLength(1);

    const del = await callBody(h, "DELETE", `/api/annotate?target=${encodeURIComponent(":name")}&tag=${encodeURIComponent(TAG)}`, {});
    expect(del.status).toBe(200);
    expect(call(h, "/api/annotations", { path: ":name" }).json).toHaveLength(0);
    h.close();
  });
});

// Removing a HAND-AUTHORED annotation whose pointer is spaced + document-scope (`*: tags: …`) —
// not the canonical project-scope form the server writes. The delete matcher normalizes whitespace
// and matches the colon-path, so the explorer's right-click "untag" works on such pointers too.
describe("DELETE /api/annotate — tolerant pointer matching", () => {
  it("removes a spaced, document-scope `*: tags: …` annotation", async () => {
    const root = tmpTree({
      "doc.md": "# hi",
      ".yamlover/body.yamlover":
        '"doc.md":\n  yamlover-annotations:\n  - *: tags: field: math\n  - *: tags: genre: short\n' +
        "tags: !!<*yamlover:$defs:tag>\n  field:\n    math: Math\n  genre:\n    short: Short\n",
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    expect(call(h, "/api/annotations", { path: ":doc.md" }).json).toHaveLength(2);

    const del = await callBody(h, "DELETE", `/api/annotate?target=${encodeURIComponent(":doc.md")}&tag=${encodeURIComponent(":tags:field:math")}`, {});
    expect(del.status).toBe(200);
    // exactly one removed — the other spaced pointer survives (the matcher is path-specific)
    const left = call(h, "/api/annotations", { path: ":doc.md" }).json;
    expect(left.map((a: any) => a.tag?.path)).toEqual([":tags:genre:short"]);
    const body = fs.readFileSync(path.join(root, ".yamlover", "body.yamlover"), "utf8");
    expect(body).not.toContain("field: math");
    expect(body).toContain("genre: short");
    h.close();
  });
});
