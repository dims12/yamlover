import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHandlers } from "../src/server/engine-api";
import { tmpTree } from "./helpers";
import { call, callBody } from "./http";

// A TEXT fragment lives ON the chunk it was drawn in (ANNOTATIONS.md §3), NOT the whole chapter:
// tagging a chunk's text turns that chunk into an omni node (its prose becomes a block-scalar
// self-value; `yamlover-fragments:`/`yamlover-annotations:` become keyed fields). Synthetic temp
// trees only — never the repo's examples/.

const DEFS = {
  "$defs/chapter":
    "type: variant\nproperties:\n  title:\n    type: string\n  description:\n    type: string\nitems:\n  anyOf:\n    - *//yamlover/$defs/chapter\n    - *//yamlover/$defs/chunk\n",
  "$defs/chunk": "type: [string, binary]\nformat: text/marklower\n",
};
const TAG_FILE = { "tags.yamlover": 'yellow: !!<*::yamlover:$defs:tag>\n  color: "#f9e2af"\n' };
const TAG = ":tags.yamlover:yellow";
// title (store index 0) + two prose block chunks (indices 1, 2); "word" repeats in the title and [1].
const CHAPTER = "!!<*yamlover/$defs/chapter>\ntitle: The word in the title\n- |\n  the word appears here in a chunk\n- |\n  and again elsewhere\n";
const bodyOf = (root: string) => fs.readFileSync(path.join(root, "doc.yamlover"), "utf8");

async function chapterHandlers() {
  const root = tmpTree({ "doc.yamlover": CHAPTER, ...TAG_FILE, ...DEFS });
  const h = createHandlers(root, { gitignore: false });
  await h.ready;
  return { root, h };
}

async function tagChunk(h: ReturnType<typeof createHandlers>) {
  const frag = await callBody(h, "POST", "/api/fragment", {
    target: ":doc.yamlover[1]", // the first prose chunk (title consumes index 0)
    selector: { type: "text", exact: "word", prefix: "the ", suffix: " appears" },
  });
  expect(frag.status).toBe(201);
  const ann = await callBody(h, "POST", "/api/annotate", { target: frag.json.fragmentPath, tag: TAG });
  expect(ann.status).toBe(201);
  return frag.json as { slug: string; fragmentPath: string };
}

describe("chunk text fragments (ANNOTATIONS.md §3)", () => {
  it("stores the fragment ON the chunk (an omni node), carrying the tag — not on the chapter", async () => {
    const { root, h } = await chapterHandlers();
    const { slug, fragmentPath } = await tagChunk(h);

    const src = bodyOf(root);
    // the chunk became an omni node: block-scalar prose (indented one step deeper) + fields
    expect(src).toContain("yamlover-fragments:");
    expect(src).toContain('exact: "word"');
    expect(src).toContain("*::tags.yamlover:yellow");
    expect(src).not.toMatch(/^yamlover-fragments:/m); // NOT at the chapter root (column 0) — it hangs off the chunk
    expect(src).toMatch(/^ {2}yamlover-fragments:/m); // at the chunk's field indent (2)

    // the fragment node resolves at the chunk path
    expect(call(h, "/api/json", { path: fragmentPath }).status).toBe(200);

    // /api/annotations on the CHAPTER aggregates the chunk fragment, carrying its owning node
    const list = call(h, "/api/annotations", { path: ":doc.yamlover" }).json as any[];
    const cf = list.find((a) => a.fragmentSlug === slug);
    expect(cf).toBeTruthy();
    expect(cf.node).toBe(":doc.yamlover[1]");
    expect(cf.selector).toMatchObject({ type: "text", exact: "word" });
    expect(cf.tag.name).toBe("yellow");
    h.close();
  });

  it("removing the last tag collapses the chunk back to a plain prose block", async () => {
    const { root, h } = await chapterHandlers();
    const { fragmentPath } = await tagChunk(h);

    const del = await callBody(h, "DELETE", "/api/annotate", undefined, { target: fragmentPath, tag: TAG });
    expect(del.status).toBe(200);

    const src = bodyOf(root);
    expect(src).not.toContain("yamlover-fragments:"); // the emptied fragment map is gone
    expect(src).toContain("the word appears here in a chunk"); // prose intact
    expect(call(h, "/api/annotations", { path: ":doc.yamlover" }).json).toHaveLength(0);
    h.close();
  });

  it("refuses to tag a non-prose (pointer) chunk's text", async () => {
    const root = tmpTree({
      "doc.yamlover": "!!<*yamlover/$defs/chapter>\ntitle: T\n- *pic.png\n",
      "pic.png": "\x89PNG binary",
      ...TAG_FILE,
      ...DEFS,
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/fragment", { target: ":doc.yamlover[1]", selector: { type: "text", exact: "x" } });
    expect(r.status).toBe(400);
    h.close();
  });
});
