import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHandlers } from "./helpers";
import { tmpTree } from "./helpers";
import { call, callBody } from "./http";

// The EMBEDDED tags/fragments model (docs/server/annotations): /api/annotate appends to a target's
// `yamlover-annotations`; /api/fragment adds a `yamlover-fragments` region; reads derive from
// those forward `*::tag` edges. Synthetic temp trees only — never the repo.

const TAG_FILE = { "tags.yo": 'yellow: !!<*::yamlover:$defs:tag>\n  color: "#f9e2af"\n' };
const TAG = ":tags.yo:yellow";

describe("embedded annotations", () => {
  it("tags a whole leaf node via the enclosing overlay (no untagged-omni source)", async () => {
    const root = tmpTree({ name: "Alice", ...TAG_FILE });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/annotate", { target: ":name", tag: TAG, description: "hi" });
    expect(r.status).toBe(201);

    // a scalar leaf file is NOT rewritten in place — its annotations live in the root overlay
    expect(fs.readFileSync(path.join(root, "name"), "utf8")).toBe("Alice");
    const overlay = fs.readFileSync(path.join(root, ".yo", "body.yo"), "utf8");
    expect(overlay).toContain("yamlover-annotations:");
    expect(overlay).toContain("*::tags.yo:yellow");

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
    const overlay = fs.readFileSync(path.join(root, "docs", ".yo", "body.yo"), "utf8");
    expect(overlay).toContain('"pic.png":');
    expect(overlay).toContain("*::tags.yo:yellow");

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
    // per-directory mode: the crop sidecar lands under the target dir's hidden .yo/fragments/
    expect(fs.existsSync(path.join(root, "docs", ".yo", "fragments", `${frag.json.slug}.png`))).toBe(true);

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

  it("untagging the LAST tag leaves no orphans — no `yamlover-annotations:` husk, no empty host key", async () => {
    const root = tmpTree({ "docs/a.pdf": "%PDF-1.4 a", "docs/b.pdf": "%PDF-1.4 b" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    // tag one PDF with the other, then untag at once (the right-click → TOC-click → uncheck flow)
    await callBody(h, "POST", "/api/annotate", { target: ":docs:a.pdf", tag: ":docs:b.pdf" });
    const overlayFile = path.join(root, "docs", ".yo", "body.yo");
    expect(fs.readFileSync(overlayFile, "utf8")).toContain("yamlover-annotations:");
    const del = await callBody(h, "DELETE", `/api/annotate?target=${encodeURIComponent(":docs:a.pdf")}&tag=${encodeURIComponent(":docs:b.pdf")}`, {});
    expect(del.status).toBe(200);
    const overlay = fs.readFileSync(overlayFile, "utf8");
    expect(overlay).not.toContain("yamlover-annotations"); // no null-valued husk…
    expect(overlay).not.toContain("a.pdf"); // …and no empty filename host key left behind either
    h.close();
  });

  it("untagging ONE of two tags keeps the host key and the other annotation", async () => {
    const root = tmpTree({
      name: "Alice",
      "tags.yo": 'yellow: !!<*::yamlover:$defs:tag>\n  color: "#f9e2af"\ngreen: !!<*::yamlover:$defs:tag>\n  color: "#a6e3a1"\n',
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    await callBody(h, "POST", "/api/annotate", { target: ":name", tag: ":tags.yo:yellow" });
    await callBody(h, "POST", "/api/annotate", { target: ":name", tag: ":tags.yo:green" });
    await callBody(h, "DELETE", `/api/annotate?target=${encodeURIComponent(":name")}&tag=${encodeURIComponent(":tags.yo:yellow")}`, {});
    const overlay = fs.readFileSync(path.join(root, ".yo", "body.yo"), "utf8");
    expect(overlay).toContain("yamlover-annotations:"); // one tag remains — nothing pruned
    expect(overlay).toContain("green");
    expect(call(h, "/api/annotations", { path: ":name" }).json).toHaveLength(1);
    h.close();
  });

  it("in an in-place DOCUMENT only the husk goes — a pre-existing empty data key survives untag", async () => {
    // `stub:` is the USER's key (empty mapping) inside a real document — tagging must pass
    // through it without adopting it: after untag the husk goes but `stub:` stays
    const root = tmpTree({ "doc.yo": "stub:\nkeep: 1\n", ...TAG_FILE });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    await callBody(h, "POST", "/api/annotate", { target: ":doc.yo:stub", tag: TAG });
    expect(fs.readFileSync(path.join(root, "doc.yo"), "utf8")).toContain("yamlover-annotations:");
    await callBody(h, "DELETE", `/api/annotate?target=${encodeURIComponent(":doc.yo:stub")}&tag=${encodeURIComponent(TAG)}`, {});
    const doc = fs.readFileSync(path.join(root, "doc.yo"), "utf8");
    expect(doc).not.toContain("yamlover-annotations"); // the husk is gone…
    expect(doc).toContain("stub:"); // …but the user's empty key is NOT swallowed with it
    expect(doc).toContain("keep: 1");
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
      ".yo/body.yo":
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
    const body = fs.readFileSync(path.join(root, ".yo", "body.yo"), "utf8");
    expect(body).not.toContain("field: math");
    expect(body).toContain("genre: short");
    h.close();
  });
});
