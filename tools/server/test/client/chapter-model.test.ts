import { describe, it, expect } from "vitest";
import { buildChapterModel, snapshotChapter, diffChapter, chapterFlow, flowText, type ChapterModel, type ChunkPart } from "../../src/client/renderers/chapter-model";

/** An inlined `$yamloverLink` scalar chunk marker at body slot `i` of chapter `base` (its marker
 *  points at its OWN slot `<base>[i]`, so the model classifies it as an editable inline chunk). */
const inlined = (base: string, i: number, value: string, format: string | null = "text/marklower") => ({
  $yamloverLink: { kind: "scalar", type: "string", path: `${base}[${i}]`, format, concrete: "yamlover", value },
});
/** A linked (pointer) chunk marker — its path points OUT of its own slot (a separate file). */
const linkedImage = (targetPath: string) => ({
  $yamloverLink: { kind: "binary", type: "blob", path: targetPath, format: "image/png", concrete: "file/binary" },
});
/** A subchapter body element — a nested chapter, surfaced as a read-only navigable link. */
const subchapter = (base: string, i: number, title: string) => ({
  $yamloverLink: { kind: "mix", type: "variant", path: `${base}[${i}]`, format: "x-yamlover-chapter", title },
});

/** A titled chapter projects its body as a `$yamloverMixed` marker's KEYLESS entries. */
const node = (body: unknown[], title = "T", description = "D", path = ":doc") => ({
  path,
  title,
  description,
  value: { $yamloverMixed: { kind: "mix", entries: [{ key: "title", value: title }, ...body.map((value) => ({ key: null, value }))] } },
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
    expect(m.chunks[1].navPath).toBe(":doc[2]");
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

  it("streams title, description, chunks and subchapters in SOURCE order — no hoisting, no forcing to the end", () => {
    // author order: an intro chunk FIRST, then the title mid-flow, a subchapter, then a closing chunk
    const value = mixed(
      keyless(inlined(":doc", 0, "intro")),
      keyed("title", "The Title"),
      keyed("description", "A subtitle"),
      keyless(subchapter(":doc", 3, "Dogs")),
      keyless(inlined(":doc", 4, "afterword")), // base-level text BACK after a subchapter
    );
    const flow = chapterFlow(value);
    expect(flow.map((f) => f.kind)).toEqual(["chunk", "title", "description", "subchapter", "chunk"]);
    expect(flowText(flow[1].value)).toBe("The Title");
    expect(flowText(flow[2].value)).toBe("A subtitle");
  });

  it("skips other keyed entries (directory members / task fields) — they are not chapter body content", () => {
    const value = mixed(
      keyed("dogs", subchapter(":doc", 9, "Dogs")), // a directory-member key (dup of the body ref) — skipped
      keyed("priority", "high"), // a task planning field — skipped
      keyed("title", "T"),
      keyless(inlined(":doc", 2, "body")),
      keyless(subchapter(":doc", 3, "Dogs")), // the SAME subchapter, placed positionally — kept
    );
    expect(chapterFlow(value).map((f) => f.kind)).toEqual(["title", "chunk", "subchapter"]);
  });

  it("reads an untitled chapter projected as a plain array (all keyless)", () => {
    const flow = chapterFlow([inlined(":doc", 0, "solo"), subchapter(":doc", 1, "Sub")]);
    expect(flow.map((f) => f.kind)).toEqual(["chunk", "subchapter"]);
  });
});

/** Deep-clone a model so a "current" can be mutated without touching the committed snapshot. */
const clone = (m: ChapterModel): ChapterModel => ({ ...m, chunks: m.chunks.map((c) => ({ ...c })) });
const part = (id: string, text: string): ChunkPart => ({ id, rev: 0, editable: true, text, format: "text/marklower", concrete: "yamlover", subchapter: false, marker: null });

describe("diffChapter", () => {
  const base = (): ChapterModel => buildChapterModel(node([inlined(":doc", 1, "one"), inlined(":doc", 2, "two")]));

  it("no change → no edits", () => {
    const m = base();
    expect(diffChapter(snapshotChapter(m), m)).toEqual([]);
  });

  it("title change → a set", () => {
    const committed = base();
    const current = clone(committed);
    current.title = "New";
    expect(diffChapter(committed, current)).toEqual([{ path: ":doc:title", op: "set", text: "New" }]);
  });

  it("edited chunk text → a replace at its body rank", () => {
    const committed = base();
    const current = clone(committed);
    current.chunks[1].text = "TWO";
    expect(diffChapter(committed, current)).toEqual([{ path: ":doc[1]", op: "replace", text: "TWO" }]);
  });

  it("SPLIT: chunk 0 'onetwo' → head 'one' + new tail 'two' (the reported bug)", () => {
    // committed: [onetwo, x]; current: [one(head, same id), TAIL(new id), x]
    const committed: ChapterModel = { path: ":doc", title: "T", description: "D", chunks: [part("a", "onetwo"), part("b", "x")] };
    const current: ChapterModel = { path: ":doc", title: "T", description: "D", chunks: [part("a", "one"), part("tail", "two"), part("b", "x")] };
    expect(diffChapter(committed, current)).toEqual([
      { path: ":doc", op: "insert", index: 1, text: "two" },
      { path: ":doc[0]", op: "replace", text: "one" },
    ]);
  });

  it("prepend a chunk → insert at rank 0 (the chapter itself)", () => {
    const committed = base();
    const current = clone(committed);
    current.chunks.unshift(part("new", "top"));
    expect(diffChapter(committed, current)).toEqual([{ path: ":doc", op: "insert", index: 0, text: "top" }]);
  });

  it("remove a chunk → a remove at its rank", () => {
    const committed = base();
    const current = clone(committed);
    current.chunks.splice(0, 1); // drop 'one'
    expect(diffChapter(committed, current)).toEqual([{ path: ":doc[0]", op: "remove" }]);
  });

  it("remove chunk 0 AND edit chunk 1 → remove then replace at the SHIFTED rank", () => {
    const committed: ChapterModel = { path: ":doc", title: "T", description: "D", chunks: [part("a", "one"), part("b", "two")] };
    const current: ChapterModel = { path: ":doc", title: "T", description: "D", chunks: [part("b", "TWO")] };
    expect(diffChapter(committed, current)).toEqual([
      { path: ":doc[0]", op: "remove" },
      { path: ":doc[0]", op: "replace", text: "TWO" }, // b is now at rank 0
    ]);
  });

  it("a read-only element in the middle keeps prose ranks correct", () => {
    const m = buildChapterModel(node([inlined(":doc", 1, "a"), subchapter(":doc", 2, "Mid"), inlined(":doc", 3, "c")]));
    const current = clone(m);
    current.chunks[2].text = "C"; // edit the prose AFTER the subchapter (rank 2)
    expect(diffChapter(m, current)).toEqual([{ path: ":doc[2]", op: "replace", text: "C" }]);
  });
});
