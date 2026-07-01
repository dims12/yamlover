import { describe, it, expect } from "vitest";
import { buildChapterModel, snapshotChapter, diffChapter, type ChapterModel, type ChunkPart } from "../../src/client/renderers/chapter-model";

/** An inlined `$yamloverLink` scalar chunk marker at slot `i` of chapter `base`. */
const inlined = (base: string, i: number, value: string, format: string | null = "text/marklower") => ({
  $yamloverLink: { kind: "scalar", type: "string", path: `${base}:chunks[${i}]`, format, concrete: "yamlover", value },
});
/** A linked (pointer) chunk marker — its path points OUT of its own slot (a separate file). */
const linkedImage = (targetPath: string) => ({
  $yamloverLink: { kind: "binary", type: "blob", path: targetPath, format: "image/png", concrete: "file/binary" },
});

const node = (chunks: unknown[], title = "T", description = "D", path = ":doc") => ({ path, title, description, value: { chunks } });

describe("buildChapterModel", () => {
  it("classifies inlined prose as editable and extracts text", () => {
    const m = buildChapterModel(node([inlined(":doc", 0, "Hello"), inlined(":doc", 1, "# md", "text/markdown")]));
    expect(m.title).toBe("T");
    expect(m.description).toBe("D");
    expect(m.chunks.map((c) => c.editable)).toEqual([true, true]);
    expect(m.chunks.map((c) => c.text)).toEqual(["Hello", "# md"]);
    expect(m.chunks[1].format).toBe("text/markdown");
    expect(m.chunks.every((c) => c.path === undefined)).toBe(true); // inlined ⇒ no linked path
  });

  it("marks a linked/pointer or non-prose chunk read-only and records its linked path", () => {
    const m = buildChapterModel(node([inlined(":doc", 0, "prose"), linkedImage(":doc:pic.png")]));
    expect(m.chunks.map((c) => c.editable)).toEqual([true, false]);
    expect(m.chunks[1].path).toBe(":doc:pic.png"); // linked location recorded
    expect(m.chunks[1].text).toBe(""); // read-only parts carry no editable text
  });

  it("treats an inlined LaTeX chunk as editable (source)", () => {
    const latex = (i: number, value: string) => ({
      $yamloverLink: { kind: "scalar", type: "string", path: `:doc:chunks[${i}]`, format: "text/x-latex", concrete: "yamlover", value },
    });
    const m = buildChapterModel(node([latex(0, "e^{i\\pi}")]));
    expect(m.chunks[0].editable).toBe(true);
    expect(m.chunks[0].format).toBe("text/x-latex");
    expect(m.chunks[0].text).toBe("e^{i\\pi}");
  });
});

/** Deep-clone a model so a "current" can be mutated without touching the committed snapshot. */
const clone = (m: ChapterModel): ChapterModel => ({ ...m, chunks: m.chunks.map((c) => ({ ...c })) });
const part = (id: string, text: string): ChunkPart => ({ id, rev: 0, editable: true, text, format: "text/marklower", concrete: "yamlover", marker: null });

describe("diffChapter", () => {
  const base = (): ChapterModel => buildChapterModel(node([inlined(":doc", 0, "one"), inlined(":doc", 1, "two")]));

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

  it("edited chunk text → a replace at its index", () => {
    const committed = base();
    const current = clone(committed);
    current.chunks[1].text = "TWO";
    expect(diffChapter(committed, current)).toEqual([{ path: ":doc:chunks[1]", op: "replace", text: "TWO" }]);
  });

  it("SPLIT: chunk 0 'onetwo' → head 'one' + new tail 'two' (the reported bug)", () => {
    // committed: [onetwo, x]; current: [one(head, same id), TAIL(new id), x]
    const committed: ChapterModel = { path: ":doc", title: "T", description: "D", chunks: [part("a", "onetwo"), part("b", "x")] };
    const current: ChapterModel = { path: ":doc", title: "T", description: "D", chunks: [part("a", "one"), part("tail", "two"), part("b", "x")] };
    expect(diffChapter(committed, current)).toEqual([
      { path: ":doc:chunks", op: "insert", index: 1, text: "two" },
      { path: ":doc:chunks[0]", op: "replace", text: "one" },
    ]);
  });

  it("prepend a chunk → insert at index 0", () => {
    const committed = base();
    const current = clone(committed);
    current.chunks.unshift(part("new", "top"));
    expect(diffChapter(committed, current)).toEqual([{ path: ":doc:chunks", op: "insert", index: 0, text: "top" }]);
  });

  it("remove a chunk → a remove at its index", () => {
    const committed = base();
    const current = clone(committed);
    current.chunks.splice(0, 1); // drop 'one'
    expect(diffChapter(committed, current)).toEqual([{ path: ":doc:chunks[0]", op: "remove" }]);
  });

  it("remove chunk 0 AND edit chunk 1 → remove then replace at the SHIFTED index", () => {
    const committed: ChapterModel = { path: ":doc", title: "T", description: "D", chunks: [part("a", "one"), part("b", "two")] };
    const current: ChapterModel = { path: ":doc", title: "T", description: "D", chunks: [part("b", "TWO")] };
    expect(diffChapter(committed, current)).toEqual([
      { path: ":doc:chunks[0]", op: "remove" },
      { path: ":doc:chunks[0]", op: "replace", text: "TWO" }, // b is now at index 0
    ]);
  });

  it("a read-only chunk in the middle keeps prose indices correct", () => {
    const m = buildChapterModel(node([inlined(":doc", 0, "a"), linkedImage(":doc:pic.png"), inlined(":doc", 2, "c")]));
    const current = clone(m);
    current.chunks[2].text = "C"; // edit the prose AFTER the image
    expect(diffChapter(m, current)).toEqual([{ path: ":doc:chunks[2]", op: "replace", text: "C" }]);
  });
});
