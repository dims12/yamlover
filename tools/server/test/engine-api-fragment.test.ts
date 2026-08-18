import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHandlers } from "./helpers";
import { tmpTree } from "./helpers";
import { call, callBody } from "./http";
import { nodeJson } from "./node-json";

// A TEXT fragment lives ON the chunk it was drawn in (docs/annotations/storage), NOT the whole chapter:
// tagging a chunk's text turns that chunk into an omni node (its prose becomes a block-scalar
// self-value; the `.yo:` overlay becomes a keyed field). Synthetic temp
// trees only — never the repo's examples/.

const DEFS = {
  "$defs/chapter":
    "type: variant\nproperties:\n  title:\n    type: string\n  description:\n    type: string\nitems:\n  anyOf:\n    - *:: yamlover: $defs: chapter\n    - *:: yamlover: $defs: chunk\n",
  "$defs/chunk": "type: [string, binary]\nformat: text/marklower\n",
};
const TAG_FILE = { "ontos.yo": 'yellow: !!<*::yamlover:$defs:onto>\n  color: "#f9e2af"\n' };
const TAG = ":ontos.yo:yellow";
// title (store index 0) + two prose block chunks (indices 1, 2); "word" repeats in the title and [1].
const CHAPTER = "!!<*yamlover: $defs: chapter>\ntitle: The word in the title\n- |\n  the word appears here in a chunk\n- |\n  and again elsewhere\n";
const bodyOf = (root: string) => fs.readFileSync(path.join(root, "doc.yo"), "utf8");

async function chapterHandlers() {
  const root = tmpTree({ "doc.yo": CHAPTER, ...TAG_FILE, ...DEFS });
  const h = createHandlers(root, { gitignore: false });
  await h.ready;
  return { root, h };
}

async function tagChunk(h: ReturnType<typeof createHandlers>) {
  const frag = await callBody(h, "POST", "/api/fragment", {
    target: ":doc.yo[1]", // the first prose chunk (title consumes index 0)
    selector: { type: "text", exact: "word", prefix: "the ", suffix: " appears" },
  });
  expect(frag.status).toBe(201);
  const ann = await callBody(h, "POST", "/api/annotate", { target: frag.json.fragmentPath, tag: TAG });
  expect(ann.status).toBe(201);
  return frag.json as { slug: string; fragmentPath: string };
}

describe("chunk text fragments (docs/annotations/storage)", () => {
  it("stores the fragment ON the chunk (an omni node), carrying the tag — not on the chapter", async () => {
    const { root, h } = await chapterHandlers();
    const { slug, fragmentPath } = await tagChunk(h);

    const src = bodyOf(root);
    // the chunk became an omni node: block-scalar prose (indented one step deeper) + fields
    expect(src).toContain("fragments:");
    expect(src).toContain(':fragment> "word"'); // exact IS the member's self-value
    expect(src).toContain("&::ontos.yo:yellow:-");
    expect(src).not.toMatch(/^\.yo:/m); // NOT at the chapter root (column 0) — it hangs off the chunk
    expect(src).toMatch(/^ {2}\.yo:/m); // at the chunk's field indent (2)

    // the fragment node resolves at the chunk path
    expect((await nodeJson(h, { path: fragmentPath })).status).toBe(200);

    // /api/annotations on the CHAPTER aggregates the chunk fragment, carrying its owning node
    const list = call(h, "/api/annotations", { path: ":doc.yo" }).json as any[];
    const cf = list.find((a) => a.fragmentSlug === slug);
    expect(cf).toBeTruthy();
    expect(cf.node).toBe(":doc.yo:1");
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
    expect(src).not.toContain("fragments:"); // the emptied fragment map is gone
    expect(src).toContain("the word appears here in a chunk"); // prose intact
    expect(call(h, "/api/annotations", { path: ":doc.yo" }).json).toHaveLength(0);
    h.close();
  });

  it("refuses to tag a non-prose (pointer) chunk's text", async () => {
    const root = tmpTree({
      "doc.yo": "!!<*yamlover: $defs: chapter>\ntitle: T\n- *pic.png\n",
      "pic.png": "\x89PNG binary",
      ...TAG_FILE,
      ...DEFS,
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const r = await callBody(h, "POST", "/api/fragment", { target: ":doc.yo[1]", selector: { type: "text", exact: "x" } });
    expect(r.status).toBe(400);
    h.close();
  });
});

// A selection that CROSSES chunks belongs to neither of them: its text runs through both, so a
// single quote would be a string present in no chunk at all. It is stored as a W3C RangeSelector
// on the node that contains both — here, the chapter.
describe("range fragments (a selection spanning chunks)", () => {
  const RANGE = {
    type: "range",
    startSelector: { type: "text", exact: "appears here in a chunk", prefix: "the word ", suffix: "" },
    endSelector: { type: "text", exact: "and again", prefix: "", suffix: " elsewhere" },
  };

  it("writes both ends as nested selectors, each quote its own self-value", async () => {
    const { root, h } = await chapterHandlers();
    const frag = await callBody(h, "POST", "/api/fragment", { target: ":doc.yo", selector: RANGE });
    expect(frag.status).toBe(201);

    const src = bodyOf(root);
    expect(src).toContain('type: "range"');
    // the sub-selector is spelled like the fragment itself — the quote as the member's own value,
    // its context indented beneath. NOT `[object Object]`, which is what a flat write produced.
    expect(src).not.toContain("[object Object]");
    expect(src).toMatch(/startSelector: "appears here in a chunk"\n\s+type: "text"\n\s+prefix: "the word "/);
    expect(src).toMatch(/endSelector: "and again"\n\s+type: "text"\n\s+prefix: ""\n\s+suffix: " elsewhere"/);
    // …and the ends nest UNDER the fragment, deeper than its own fields
    expect(src).toMatch(/\n(\s+)startSelector: .*\n\1  type: "text"/);
    h.close();
  });

  it("hangs off the CHAPTER, and reads back as one fragment carrying its tag", async () => {
    const { h } = await chapterHandlers();
    const frag = await callBody(h, "POST", "/api/fragment", { target: ":doc.yo", selector: RANGE });
    const ann = await callBody(h, "POST", "/api/annotate", { target: frag.json.fragmentPath, tag: TAG });
    expect(ann.status).toBe(201);

    expect(frag.json.fragmentPath).toContain(":doc.yo:.yo:fragments:");
    const anns = call(h, "/api/annotations", { path: ":doc.yo" }).json as { selector?: Record<string, unknown> }[];
    expect(anns).toHaveLength(1);
    expect(anns[0].selector?.type).toBe("range");
    h.close();
  });
});
