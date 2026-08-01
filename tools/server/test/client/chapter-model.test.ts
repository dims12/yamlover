import { describe, it, expect } from "vitest";
import { buildChapterModel, snapshotChapter, diffChapter, chapterFlow, flowText, bodyKindOf, anchorOf, childSlot, type ChapterModel, type ChunkPart } from "../../src/client/renderers/chapter-model";

/** An inlined `$yamloverLink` scalar chunk marker at body slot `i` of chapter `base` (its marker
 *  points at its OWN slot `<base>:i`, so the model classifies it as an editable inline chunk). */
const inlined = (base: string, i: number, value: string, format: string | null = "text/marklower") => ({
  $yamloverLink: { kind: "scalar", type: "string", path: `${base}:${i}`, format, concrete: "yamlover", value },
});
/** A linked (pointer) chunk marker — its path points OUT of its own slot (a separate file). */
const linkedImage = (targetPath: string) => ({
  $yamloverLink: { kind: "binary", type: "blob", path: targetPath, format: "image/png", concrete: "file/binary" },
});
/** A subchapter body element — a nested chapter, surfaced as a read-only navigable link. */
const subchapter = (base: string, i: number, title: string) => ({
  $yamloverLink: { kind: "mix", type: "variant", path: `${base}:${i}`, format: "x-yamlover-chapter", title },
});

/** A titled chapter is FULLY OMNI (CHAPTER.md): the title is the marker's `value` (the node's
 *  scalar self-value — it consumes NO index); the keyed `description` entry is [0], so the body
 *  starts at [1]. */
const node = (body: unknown[], title = "T", description = "D", path = ":doc") => ({
  path,
  title,
  description,
  format: "x-yamlover-chapter", // an ALREADY-tagged chapter — no first-edit schema stamp (needsMeta false)
  value: {
    $yamloverMixed: {
      kind: "omni",
      value: title,
      entries: [{ key: "description", value: description }, ...body.map((value) => ({ key: null, value }))],
    },
  },
});

describe("buildChapterModel", () => {
  it("classifies inlined prose as editable and extracts text", () => {
    const m = buildChapterModel(node([inlined(":doc", 1, "Hello"), inlined(":doc", 2, "# md", "text/markdown")]));
    expect(m.title).toBe("T");
    expect(m.description).toBe("D");
    expect(m.chunks.map((c) => c.editable)).toEqual([true, true]);
    expect(m.chunks.map((c) => c.text)).toEqual(["Hello", "# md"]);
    expect(m.chunks[1].format).toBe("text/markdown");
    expect(m.chunks.every((c) => !c.subchapter)).toBe(true);
  });

  it("marks a linked/pointer or non-prose chunk read-only", () => {
    const m = buildChapterModel(node([inlined(":doc", 1, "prose"), linkedImage(":doc:pic.png")]));
    expect(m.chunks.map((c) => c.editable)).toEqual([true, false]);
    expect(m.chunks[1].text).toBe(""); // read-only parts carry no editable text
  });

  it("surfaces a subchapter body element as a read-only part with its nav path + title", () => {
    const m = buildChapterModel(node([inlined(":doc", 1, "prose"), subchapter(":doc", 2, "Sub")]));
    expect(m.chunks.map((c) => c.subchapter)).toEqual([false, true]);
    expect(m.chunks[1].editable).toBe(false);
    expect(m.chunks[1].navPath).toBe(":doc:2");
    expect(m.chunks[1].title).toBe("Sub");
  });

  it("treats an inlined LaTeX chunk as editable (source)", () => {
    const latex = (i: number, value: string) => ({
      $yamloverLink: { kind: "scalar", type: "string", path: `:doc[${i}]`, format: "text/x-latex", concrete: "yamlover", value },
    });
    const m = buildChapterModel(node([latex(1, "e^{i\\pi}")]));
    expect(m.chunks[0].editable).toBe(true);
    expect(m.chunks[0].format).toBe("text/x-latex");
    expect(m.chunks[0].text).toBe("e^{i\\pi}");
  });

  it("reads a body projected as a plain array (an untitled chapter)", () => {
    const m = buildChapterModel({ path: ":doc", title: null, description: null, value: [inlined(":doc", 0, "solo")] });
    expect(m.title).toBe("");
    expect(m.chunks.map((c) => c.text)).toEqual(["solo"]);
  });
});

describe("chapterFlow", () => {
  const keyed = (key: string, value: unknown) => ({ key, value });
  const keyless = (value: unknown) => ({ key: null, value });
  const mixed = (...entries: unknown[]) => ({ $yamloverMixed: { kind: "mix", entries } });
  const omni = (value: string, selfAt: number | undefined, ...entries: unknown[]) => ({
    $yamloverMixed: { kind: "omni", value, ...(selfAt === undefined ? {} : { selfAt }), entries },
  });

  it("streams title, description, chunks and subchapters in SOURCE order — no hoisting, no forcing to the end", () => {
    // author order: an intro chunk FIRST, then the title (the self-value, authored at `selfAt` 1),
    // a subchapter, then a closing chunk
    const value = omni(
      "The Title",
      1,
      keyless(inlined(":doc", 0, "intro")),
      keyed("description", "A subtitle"),
      keyless(subchapter(":doc", 2, "Dogs")),
      keyless(inlined(":doc", 3, "afterword")), // base-level text BACK after a subchapter
    );
    const flow = chapterFlow(value);
    expect(flow.map((f) => f.kind)).toEqual(["chunk", "title", "description", "subchapter", "chunk"]);
    expect(flowText(flow[1].value)).toBe("The Title");
    expect(flowText(flow[2].value)).toBe("A subtitle");
  });

  it("places a title with no `selfAt` FIRST, and one past every entry LAST", () => {
    const first = omni("T", undefined, keyless(inlined(":doc", 0, "body")));
    expect(chapterFlow(first).map((f) => f.kind)).toEqual(["title", "chunk"]);
    const last = omni("T", 1, keyless(inlined(":doc", 0, "body")));
    expect(chapterFlow(last).map((f) => f.kind)).toEqual(["chunk", "title"]);
  });

  it("skips other keyed entries (directory members / task fields) — they are not chapter body content", () => {
    const value = omni(
      "T",
      0,
      keyed("dogs", subchapter(":doc", 9, "Dogs")), // a directory-member key (dup of the body ref) — skipped
      keyed("priority", "high"), // a task planning field — skipped
      keyless(inlined(":doc", 2, "body")),
      keyless(subchapter(":doc", 3, "Dogs")), // the SAME subchapter, placed positionally — kept
    );
    expect(chapterFlow(value).map((f) => f.kind)).toEqual(["title", "chunk", "subchapter"]);
  });

  it("flows a BODY-ANCHORED member (`anchor: true`) as a positional body element — the key is storage provenance", () => {
    // the dir-chapter shape (examples/66): the body's `- *: dogs` / `- *: cover-paw.png` pointers are
    // consumed, and the projection surfaces the members as keyed entries carrying `anchor: true`
    const anchored = (key: string, value: unknown) => ({ key, value, anchor: true });
    const value = omni(
      "T",
      0,
      keyed("description", "A subtitle"),
      anchored("cover-paw.png", { $yamloverLink: { kind: "scalar", type: "binary", path: ":cover-paw.png", format: "image/png" } }),
      anchored("dogs", subchapter(":dogs", 2, "Dogs")),
      keyed("unconsumed", "a keyed-only member — still skipped"),
    );
    expect(chapterFlow(value).map((f) => f.kind)).toEqual(["title", "description", "chunk", "subchapter"]);
  });

  it("keeps an anchored member named `title`/`description` a BODY element — storage names never steal the heading", () => {
    const value = omni("Real Title", 0, { key: "title", value: subchapter(":title", 0, "A dir named title"), anchor: true });
    expect(chapterFlow(value).map((f) => f.kind)).toEqual(["title", "subchapter"]);
  });

  it("still flows a LEGACY keyed `title` entry as the title (an unmigrated file)", () => {
    const value = mixed(keyed("title", "T"), keyless(inlined(":doc", 1, "body")));
    const flow = chapterFlow(value);
    expect(flow.map((f) => f.kind)).toEqual(["title", "chunk"]);
    expect(flowText(flow[0].value)).toBe("T");
  });

  it("reads an untitled chapter projected as a plain array (all keyless)", () => {
    const flow = chapterFlow([inlined(":doc", 0, "solo"), subchapter(":doc", 1, "Sub")]);
    expect(flow.map((f) => f.kind)).toEqual(["chunk", "subchapter"]);
  });
});

/** Deep-clone a model so a "current" can be mutated without touching the committed snapshot. */
const clone = (m: ChapterModel): ChapterModel => ({ ...m, chunks: m.chunks.map((c) => ({ ...c })) });
const part = (id: string, text: string, absIndex = -1): ChunkPart => ({ id, rev: 0, editable: true, text, format: "text/marklower", concrete: "yamlover", subchapter: false, marker: null, absIndex });
/** A model built by hand: `chunks` at absolute indices 0.., no keyed entries. */
const model = (chunks: ChunkPart[]): ChapterModel => ({ path: ":doc", title: "T", description: "D", chunks, entryCount: chunks.length, legacyTitleKeyed: false, needsMeta: false });

describe("diffChapter", () => {
  const base = (): ChapterModel => buildChapterModel(node([inlined(":doc", 1, "one"), inlined(":doc", 2, "two")]));

  it("no change → no edits", () => {
    const m = base();
    expect(diffChapter(snapshotChapter(m), m)).toEqual([]);
  });

  it("title change → an emplace of the chapter node ITSELF (the self-value consumes no index)", () => {
    const committed = base();
    const current = clone(committed);
    current.title = "New";
    expect(diffChapter(committed, current)).toEqual([{ path: ":doc", op: "emplace", yamlover: '"New"' }]);
  });

  it("an emptied title emplaces an empty self-value (the server drops the line) — NO index shifts", () => {
    const committed = base(); // entries: description(0), one(1), two(2) — the title is no entry
    const current = clone(committed);
    current.title = "";
    current.chunks[1].text = "TWO";
    expect(diffChapter(committed, current)).toEqual([
      { path: ":doc", op: "emplace", yamlover: '""' },
      { path: ":doc:2", op: "emplace", yamlover: "|-\n  TWO" }, // stays [2]: the title consumed no index
    ]);
  });

  it("an emptied DESCRIPTION removes the key, and every later entry slides down one", () => {
    const committed = base(); // entries: description(0), one(1), two(2)
    const current = clone(committed);
    current.description = "";
    current.chunks[1].text = "TWO";
    expect(diffChapter(committed, current)).toEqual([
      { path: ":doc:description", op: "remove" },
      { path: ":doc:1", op: "emplace", yamlover: "|-\n  TWO" }, // was [2] before the description went
    ]);
  });

  it("a LEGACY keyed `title:` migrates out on the first title edit (remove the key, entries slide)", () => {
    const legacy = buildChapterModel({
      path: ":doc",
      title: "T",
      description: null,
      format: "x-yamlover-chapter", // an unmigrated file is still a TAGGED chapter — no schema stamp
      value: { $yamloverMixed: { kind: "mix", entries: [{ key: "title", value: "T" }, { key: null, value: inlined(":doc", 1, "one") }] } },
    });
    expect(legacy.legacyTitleKeyed).toBe(true);
    const current = clone(legacy);
    current.title = "New";
    current.chunks[0].text = "ONE";
    expect(diffChapter(legacy, current)).toEqual([
      { path: ":doc", op: "emplace", yamlover: '"New"' }, // the self-value (index-neutral)
      { path: ":doc:title", op: "remove" }, // the keyed title migrates out…
      { path: ":doc:0", op: "emplace", yamlover: "|-\n  ONE" }, // …so `one` slid from [1] to [0]
    ]);
  });

  // The chunks sit at ABSOLUTE indices 1 and 2 — the keyed `description` consumes index 0; the
  // title, being the self-value, consumes none (CHAPTER.md).
  it("edited chunk text → an emplace at its absolute index", () => {
    const committed = base();
    const current = clone(committed);
    current.chunks[1].text = "TWO";
    expect(diffChapter(committed, current)).toEqual([{ path: ":doc:2", op: "emplace", yamlover: "|-\n  TWO" }]);
  });

  it("SPLIT: chunk 0 'onetwo' → head 'one' + new tail 'two' (the reported bug)", () => {
    // committed: [onetwo, x] at abs 0,1; current: [one(head, same id), TAIL(new id), x]
    const committed = model([part("a", "onetwo", 0), part("b", "x", 1)]);
    const current = model([part("a", "one", 0), part("tail", "two"), part("b", "x", 1)]);
    expect(diffChapter(committed, current)).toEqual([
      { path: ":doc:1", op: "insert", yamlover: "|-\n  two" }, // before x, which slides to 2
      { path: ":doc:0", op: "emplace", yamlover: "|-\n  one" },
    ]);
  });

  it("prepend a chunk → insert before the first body element", () => {
    const committed = base();
    const current = clone(committed);
    current.chunks.unshift(part("new", "top"));
    expect(diffChapter(committed, current)).toEqual([{ path: ":doc:1", op: "insert", yamlover: "|-\n  top" }]);
  });

  it("append a chunk → the path names the chapter, which the server reads as APPEND", () => {
    const committed = base();
    const current = clone(committed);
    current.chunks.push(part("new", "last"));
    expect(diffChapter(committed, current)).toEqual([{ path: ":doc", op: "insert", yamlover: "|-\n  last" }]);
  });

  it("remove a chunk → a remove at its absolute index", () => {
    const committed = base();
    const current = clone(committed);
    current.chunks.splice(0, 1); // drop 'one' (abs 1)
    expect(diffChapter(committed, current)).toEqual([{ path: ":doc:1", op: "remove" }]);
  });

  it("remove chunk 0 AND edit chunk 1 → remove then emplace at the SHIFTED index", () => {
    const committed = model([part("a", "one", 0), part("b", "two", 1)]);
    const current = model([part("b", "TWO", 1)]);
    expect(diffChapter(committed, current)).toEqual([
      { path: ":doc:0", op: "remove" },
      { path: ":doc:0", op: "emplace", yamlover: "|-\n  TWO" }, // b slid down to 0
    ]);
  });

  it("a read-only element in the middle keeps the absolute indices correct", () => {
    const m = buildChapterModel(node([inlined(":doc", 1, "a"), subchapter(":doc", 2, "Mid"), inlined(":doc", 3, "c")]));
    const current = clone(m);
    current.chunks[2].text = "C"; // edit the prose AFTER the subchapter
    expect(diffChapter(m, current)).toEqual([{ path: ":doc:3", op: "emplace", yamlover: "|-\n  C" }]);
  });

  it("assigns a freshly inserted part its absolute index, so the NEXT diff addresses it", () => {
    const committed = base();
    const current = clone(committed);
    current.chunks.push(part("new", "last"));
    diffChapter(committed, current);
    expect(current.chunks.map((c) => c.absIndex)).toEqual([1, 2, 3]);
    expect(current.entryCount).toBe(4);
  });

  it("multiline prose becomes a block scalar; leading whitespace falls back to a quoted line", () => {
    const committed = base();
    const a = clone(committed);
    a.chunks[0].text = "one\ntwo";
    expect(diffChapter(committed, a)).toEqual([{ path: ":doc:1", op: "emplace", yamlover: "|-\n  one\n  two" }]);
    const b = clone(committed);
    b.chunks[0].text = "  indented";
    expect(diffChapter(committed, b)).toEqual([{ path: ":doc:1", op: "emplace", yamlover: '"  indented"' }]);
  });

  // An ANNOTATED title projects as an omni marker — the tag applications laid over the scalar
  // (ANNOTATIONS.md). Unpeeled it stringifies, and the chapter's heading reads "[object Object]".
  it("flowText peels an annotation overlay off a title", () => {
    const omni = { $yamloverMixed: { kind: "omni", entries: [{ key: "yamlover-annotations", value: [] }], value: "The Title" } };
    expect(flowText(omni)).toBe("The Title");
    const omniLink = { $yamloverLink: { kind: "omni", type: "variant", path: ":doc:title", concrete: "yamlover", value: "The Title" } };
    expect(flowText(omniLink)).toBe("The Title");
  });
});

// A body element's kind is STRUCTURAL (CHAPTER.md): a container is a subchapter unless an explicit
// tag says it is content. This is what lets a page inline subchapters — an inlined one arrives as a
// `$yamloverMixed` marker carrying no `path`, where the old link-marker-only test saw a chunk.
describe("bodyKindOf — inlined containers", () => {
  const mixedOf = (format: string | null) => ({ $yamloverMixed: { kind: "omni", value: "Sub", format, entries: [] } });

  it("a link marker routes on its own format", () => {
    expect(bodyKindOf(subchapter(":doc", 1, "Sub"))).toBe("subchapter");
    expect(bodyKindOf(inlined(":doc", 1, "prose"))).toBe("chunk");
  });

  it("an INLINED chapter marker (no path) is a subchapter, not a chunk", () => {
    expect(bodyKindOf(mixedOf("x-yamlover-chapter"))).toBe("subchapter");
    expect(bodyKindOf(mixedOf("x-yamlover-task"))).toBe("subchapter");
  });

  it("an UNTAGGED inlined container is a subchapter (structural recognition)", () => {
    const withBody = { $yamloverMixed: { kind: "omni", value: "Sub", format: null, entries: [{ key: null, value: "a chunk" }] } };
    expect(bodyKindOf(withBody)).toBe("subchapter");
    expect(bodyKindOf(["a", "b"])).toBe("subchapter");
  });

  it("an UNTAGGED container LINK (depth boundary of a not-yet-stamped chapter) is a subchapter too", () => {
    // exactly what the server sends for a nested container in a tagless document: an omni link
    // with ordinal entries and NO format — the structural rule must hold at the boundary as well
    const untaggedOmni = { $yamloverLink: { kind: "omni", type: "variant", hasKeyed: false, hasOrdinal: true, path: "[4]", concrete: "yamlover", count: 4, value: "Подчасть" } };
    expect(bodyKindOf(untaggedOmni)).toBe("subchapter");
    // …while an untagged link with only KEYED entries (an annotated scalar's overlays) stays a chunk
    const annotatedLink = { $yamloverLink: { kind: "omni", type: "variant", hasKeyed: true, hasOrdinal: false, path: "[2]", concrete: "yamlover", value: "prose" } };
    expect(bodyKindOf(annotatedLink)).toBe("chunk");
  });

  it("an ANNOTATED chunk stays a chunk — overlay keys are not body (CHAPTER.md)", () => {
    const annotated = (key: string) => ({ $yamloverMixed: { kind: "omni", value: "a **bold** chunk", entries: [{ key, value: [] }] } });
    expect(bodyKindOf(annotated("yamlover-annotations"))).toBe("chunk");
    expect(bodyKindOf(annotated("yamlover-fragments"))).toBe("chunk");
    // …but a real body entry alongside the overlay DOES make it a subchapter
    const both = { $yamloverMixed: { kind: "omni", value: "T", entries: [{ key: "yamlover-annotations", value: [] }, { key: null, value: "body" }] } };
    expect(bodyKindOf(both)).toBe("subchapter");
  });

  it("an empty untagged container is a chunk — nothing says it is a chapter", () => {
    expect(bodyKindOf(mixedOf(null))).toBe("chunk");
  });

  it("a TAGGED table / list container is content, not a subchapter", () => {
    expect(bodyKindOf(mixedOf("x-yamlover-table"))).toBe("chunk");
    expect(bodyKindOf(mixedOf("x-yamlover-bullets"))).toBe("chunk");
    expect(bodyKindOf(mixedOf("x-yamlover-numbered"))).toBe("chunk");
  });

  it("a bare scalar is always a chunk", () => {
    expect(bodyKindOf("prose")).toBe("chunk");
    expect(bodyKindOf(42)).toBe("chunk");
  });

  it("a `!!yo` mark trumps everything — a DATA island at both depths, whatever the shape", () => {
    // the depth-boundary link marker (the normal chapter fetch)
    const yoLink = { $yamloverLink: { kind: "omni", type: "variant", hasKeyed: true, hasOrdinal: true, path: "[3]", concrete: "yamlover", yo: true, value: 5 } };
    expect(bodyKindOf(yoLink)).toBe("data");
    // an inlined marker (a deeper fetch) — yo wins over format AND over the structural rule
    const yoMixed = { $yamloverMixed: { kind: "omni", value: 5, format: "x-yamlover-chapter", yo: true, entries: [{ key: null, value: "solid" }] } };
    expect(bodyKindOf(yoMixed)).toBe("data");
    // a yo-marked pure container (no self-value) is data too, never a subchapter
    const yoContainer = { $yamloverMixed: { kind: "mix", format: null, yo: true, entries: [{ key: "species", value: "cat" }] } };
    expect(bodyKindOf(yoContainer)).toBe("data");
  });
});

describe("chapterFlow — absIndex", () => {
  it("carries each entry's ABSOLUTE index; the self-value title consumes none (-1)", () => {
    const flow = chapterFlow(node([inlined(":doc", 1, "one"), subchapter(":doc", 2, "Sub")]).value);
    expect(flow.map((f) => [f.kind, f.absIndex])).toEqual([
      ["title", -1], // the omni self-value
      ["description", 0],
      ["chunk", 1],
      ["subchapter", 2],
    ]);
  });

  it("an untitled chapter (plain array) indexes from 0", () => {
    const flow = chapterFlow([inlined(":doc", 0, "solo"), subchapter(":doc", 1, "Sub")]);
    expect(flow.map((f) => f.absIndex)).toEqual([0, 1]);
  });
});

describe("anchorOf / childSlot", () => {
  it("a page root anchors everything by PATH — `#/1`-style slash continuations", () => {
    expect(anchorOf(":", ":1", "/1")).toBe("/1");
    expect(anchorOf(":", ":3:1", "/3/1")).toBe("/3/1");
    expect(anchorOf(":", ":dogs", "/6")).toBe("/dogs"); // a pointer subchapter under the root
  });

  it("a descendant of a non-root page still anchors by path", () => {
    expect(anchorOf(":doc", ":doc:2", "/2")).toBe("/2");
  });

  it("a node OUTSIDE the page's subtree falls back to the render slot", () => {
    // `fragmentOf` is a blind prefix-length slice — it would return "" here and collide
    expect(anchorOf(":a:b", ":dogs", "/2")).toBe("/2");
    expect(anchorOf(":a:b", ":z:deep:er", "/0/1")).toBe("/0/1");
  });

  it("childSlot chains render positions", () => {
    expect(childSlot("", 3)).toBe("/3");
    expect(childSlot("/3", 1)).toBe("/3/1");
  });
});

describe("diffChapter — the first-edit schema stamp (a plain folder written as a chapter)", () => {
  /** An untagged, empty directory opened in the chapter view: no format, no body. */
  const folder = () => buildChapterModel({ path: ":", title: null, description: null, value: {}, format: null });

  it("an untagged node needs the stamp; a tagged chapter or task does not", () => {
    expect(folder().needsMeta).toBe(true);
    expect(buildChapterModel(node([])).needsMeta).toBe(false);
    expect(buildChapterModel({ path: ":t", title: "T", description: null, value: {}, format: "x-yamlover-task" }).needsMeta).toBe(false);
  });

  it("the first title edit carries the tag on the SAME op", () => {
    const committed = folder();
    const current = clone(committed);
    current.title = "My book";
    expect(diffChapter(committed, current)).toEqual([
      { path: ":", op: "emplace", yamlover: '"My book"', meta: "*::yamlover:$defs:chapter" },
    ]);
    expect(current.needsMeta).toBe(false); // migrated — the next batch carries no meta
  });

  it("a first edit that is NOT a title still stamps, as its own leading op", () => {
    const committed = folder();
    const current = clone(committed);
    current.chunks = [part("c1", "first paragraph")];
    const edits = diffChapter(committed, current);
    expect(edits[0]).toEqual({ path: ":", op: "emplace", meta: "*::yamlover:$defs:chapter" });
    expect(edits[1]).toEqual({ path: ":", op: "insert", yamlover: "|-\n  first paragraph" });
  });

  it("no edits → no stamp (merely opening the editor writes nothing)", () => {
    const committed = folder();
    expect(diffChapter(committed, clone(committed))).toEqual([]);
    expect(committed.needsMeta).toBe(true);
  });

  it("an already-tagged chapter never carries meta", () => {
    const committed = buildChapterModel(node([inlined(":doc", 1, "one")]));
    const current = clone(committed);
    current.title = "New";
    expect(diffChapter(committed, current)).toEqual([{ path: ":doc", op: "emplace", yamlover: '"New"' }]);
  });
});
