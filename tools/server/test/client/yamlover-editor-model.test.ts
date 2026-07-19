// The projectional editor's MODEL: build from the /api/json projection + comments sidecar, the
// absolute-index discipline (keyed entries consume indices, the self-value doesn't, client-side
// holes never shift server addresses), op emission per mutation, and the op-queue coalescing.
import { describe, it, expect } from "vitest";
import {
  buildModel, commitHoleAsSelf, commitSpine, dedentEntry, findEntry, indentEntry, insertHoleAfter,
  parseTag, removeEntry, serializeMNode, setMetaTag, setNodeToken, setSelfValue,
  type MNode,
} from "../../src/client/renderers/yamlover-editor/model";
import { enqueue, type OpQueue } from "../../src/client/renderers/yamlover-editor/ops";
import { classifyHoleInput, quoteSource, unquoteSource } from "../../src/client/renderers/yamlover-editor/keys";
import type { NodeJson } from "../../src/client/api";

/** A chapter-shaped omni fixture: self-value title, keyed description, two ordinal chunks, a
 *  pointer chunk — with a comments sidecar carrying the tag, a raw token, and the pointer text. */
function omniNode(): NodeJson {
  return {
    path: ":doc", type: "object", concrete: "dir/yamlover", title: null, description: null,
    value: {
      $yamloverMixed: {
        kind: "omni", value: "A Title", selfAt: 0,
        entries: [
          { key: "description", value: "the blurb" },
          { key: null, value: "chunk one" },
          { key: null, value: { $yamloverRef: { text: ":pets[1]", path: null } } },
        ],
      },
    },
    comments: {
      "": { tag: "!!<*yamlover: $defs: chapter>" },
      "/description": { raw: '"the blurb"' },
      "[2]": { pointer: ":pets[1]" },
    },
  };
}

describe("buildModel — projection + sidecar → cell model", () => {
  it("captures the omni shape: self-value, keyed+ordinal entries in ONE index space, tag, raw, pointer", () => {
    const root = buildModel(omniNode());
    expect(root.kind).toBe("container");
    expect(root.metaTag).toBe("*yamlover: $defs: chapter"); // !!<…> content, delimiters stripped
    expect(root.selfValue?.src).toBe("A Title"); // bare token
    expect(root.selfAt).toBe(0);
    expect(root.entries.map((e) => e.key)).toEqual(["description", null, null]);
    expect(root.entries[0].node.scalar?.src).toBe('"the blurb"'); // authored raw token, not the plain form
    expect(root.entries[2].node.kind).toBe("pointer");
    expect(root.entries[2].node.pointer?.raw).toBe(":pets[1]");
    expect(root.entries.every((e) => e.committed && e.decided)).toBe(true);
  });

  it("plain objects and arrays build keyed / ordinal containers; multiline strings go block-mode", () => {
    const obj = buildModel({ path: ":x", type: "object", concrete: null, title: null, description: null, value: { a: 1, b: true } });
    expect(obj.entries.map((e) => e.key)).toEqual(["a", "b"]);
    expect(obj.entries[0].node.scalar?.src).toBe("1");
    const arr = buildModel({ path: ":x", type: "array", concrete: null, title: null, description: null, value: ["x", "line1\nline2"] });
    expect(arr.entries.map((e) => e.key)).toEqual([null, null]);
    expect(arr.entries[1].node.scalar?.block).toBe(true);
    expect(arr.entries[1].node.scalar?.src).toBe("|-\n  line1\n  line2");
  });

  it("a lone scalar root (a legacy fresh-node body) builds a scalar node", () => {
    const root = buildModel({ path: ":n", type: "string", concrete: "dir/yamlover", title: null, description: null, value: "" });
    expect(root.kind).toBe("scalar");
    expect(root.scalar?.src).toBe('""'); // empty string needs its quotes
  });

  it("an EMPTY document (value null, no raw) builds an empty container — the root hole", () => {
    const root = buildModel({ path: ":n", type: "null", concrete: "file/yamlover", title: null, description: null, value: null });
    expect(root.kind).toBe("container");
    expect(root.entries).toHaveLength(0);
    expect(root.selfValue).toBeUndefined();
    // an AUTHORED `~` keeps its raw token and stays a null scalar
    const tilde = buildModel({ path: ":n", type: "null", concrete: "file/yamlover", title: null, description: null, value: null, comments: { "": { raw: "~" } } });
    expect(tilde.kind).toBe("scalar");
    expect(tilde.scalar?.src).toBe("~");
  });
});

describe("parseTag", () => {
  it("splits `!!<…>` content and the `!!set` marker", () => {
    expect(parseTag("!!<*yamlover: $defs: chapter>")).toEqual({ metaTag: "*yamlover: $defs: chapter", setTag: false });
    expect(parseTag("!!<format: text/x-latex> !!set")).toEqual({ metaTag: "format: text/x-latex", setTag: true });
    expect(parseTag("!!set")).toEqual({ metaTag: null, setTag: true });
    expect(parseTag(undefined)).toEqual({ metaTag: null, setTag: false });
  });
});

describe("op emission — the absolute-index discipline", () => {
  it("scalar emplace addresses a keyed entry by KEY and stays index-neutral for the self-value", () => {
    const root = buildModel(omniNode());
    const descId = root.entries[0].node.id;
    expect(setNodeToken(":doc", root, descId, { src: '"new blurb"', value: "new blurb" }))
      .toEqual([{ path: ":doc:description", op: "emplace", yamlover: '"new blurb"' }]);
    expect(setSelfValue(":doc", root, root.id, { src: '"New Title"', value: "New Title" }))
      .toEqual([{ path: ":doc", op: "emplace", yamlover: '"New Title"' }]);
    expect(root.selfValue?.value).toBe("New Title");
  });

  it("an ordinal entry addresses by its index — keyed entries COUNT, the self-value does NOT", () => {
    const root = buildModel(omniNode());
    const chunkId = root.entries[1].node.id; // first ordinal chunk sits at absolute index 1 (after `description`)
    expect(setNodeToken(":doc", root, chunkId, { src: '"edited"', value: "edited" }))
      .toEqual([{ path: ":doc[1]", op: "emplace", yamlover: '"edited"' }]);
  });

  it("a client-side hole never shifts server addresses; its commit inserts at its server index", () => {
    const root = buildModel(omniNode());
    const hole = insertHoleAfter(root, root.id, root.entries[0].id)!; // between description and chunk one
    expect(root.entries[1].id).toBe(hole.id);
    // an edit BELOW the hole still addresses the pre-hole index space
    const chunkId = root.entries[2].node.id;
    expect(setNodeToken(":doc", root, chunkId, { src: "x", value: "x" })[0].path).toBe(":doc[1]");
    // the hole materializes: an ordinal scalar → insert at ITS server index (1)
    hole.decided = true;
    hole.node.kind = "scalar";
    hole.node.scalar = { src: '"fresh"', value: "fresh" };
    const edits = commitSpine(":doc", root, hole.id);
    expect(edits).toEqual([{ path: ":doc[1]", op: "insert", yamlover: '"fresh"' }]);
    expect(root.entries[1].committed).toBe(true);
    // AFTER the commit the later chunk's address counts it
    expect(setNodeToken(":doc", root, chunkId, { src: "y", value: "y" })[0].path).toBe(":doc[2]");
  });

  it("a keyed hole commits as a keyed INSERT at its position — authored order is kept", () => {
    const root = buildModel(omniNode());
    const hole = insertHoleAfter(root, root.id, root.entries[2].id)!; // at the end
    hole.decided = true;
    hole.key = "author";
    hole.node.kind = "scalar";
    hole.node.scalar = { src: "Bob", value: "Bob" };
    const edits = commitSpine(":doc", root, hole.id);
    expect(edits).toEqual([{ path: ":doc[3]", op: "insert", key: "author", yamlover: "Bob" }]);
    expect(root.entries[3].key).toBe("author"); // stays exactly where it was typed
    expect(root.entries[3].committed).toBe(true);
  });

  it("committing a leaf inside a client-side subtree pushes the WHOLE topmost uncommitted entry", () => {
    const root = buildModel(omniNode());
    const hole = insertHoleAfter(root, root.id, root.entries[2].id)!;
    hole.decided = true; // `- ` typed: an ordinal whose value became a container (`{`-style)
    hole.node.kind = "container";
    const inner = insertHoleAfter(root, hole.node.id, null)!;
    inner.decided = true;
    inner.key = "name";
    inner.node.kind = "scalar";
    inner.node.scalar = { src: "Rex", value: "Rex" };
    const edits = commitSpine(":doc", root, inner.id);
    expect(edits).toEqual([{ path: ":doc[3]", op: "insert", yamlover: "name: Rex" }]); // [3] past-end appends
    expect(hole.committed && inner.committed).toBe(true);
    // a second inner leaf now addresses THROUGH the committed subtree
    const inner2 = insertHoleAfter(root, hole.node.id, inner.id)!;
    inner2.decided = true;
    inner2.node.kind = "scalar";
    inner2.node.scalar = { src: "42", value: 42 };
    expect(commitSpine(":doc", root, inner2.id)).toEqual([{ path: ":doc[3][1]", op: "insert", yamlover: "42" }]);
  });

  it("a BARE token in an undecided hole becomes the container's SELF-VALUE (index-neutral)", () => {
    const root = buildModel({ path: ":d", type: "array", concrete: null, title: null, description: null, value: ["january"] });
    const hole = insertHoleAfter(root, root.id, root.entries[0].id)!;
    const edits = commitHoleAsSelf(":d", root, hole.id, { src: "31", value: 31 });
    // `at` carries the typed position so the LINE is saved there too (REPRESENTATION RULE)
    expect(edits).toEqual([{ path: ":d", op: "emplace", yamlover: "31", at: 1 }]);
    expect(root.entries).toHaveLength(1); // the hole left the index space — a self line consumes none
    expect(root.selfValue?.src).toBe("31");
    expect(root.selfAt).toBe(1); // displayed where it was typed
    // a SECOND bare scalar line is refused (the caller shows the error)
    const hole2 = insertHoleAfter(root, root.id, null)!;
    expect(commitHoleAsSelf(":d", root, hole2.id, { src: "x", value: "x" })).toEqual([]);
    expect(root.entries).toHaveLength(2); // the hole survives
  });

  it("remove: committed entries emit `remove` (key or index); holes vanish silently", () => {
    const root = buildModel(omniNode());
    expect(removeEntry(":doc", root, root.entries[2].id)).toEqual([{ path: ":doc[2]", op: "remove" }]);
    expect(root.entries).toHaveLength(2);
    const hole = insertHoleAfter(root, root.id, null)!;
    expect(removeEntry(":doc", root, hole.id)).toEqual([]);
    expect(removeEntry(":doc", root, root.entries[0].id)).toEqual([{ path: ":doc:description", op: "remove" }]);
  });

  it("meta tag: a meta-only emplace sets, null clears", () => {
    const root = buildModel(omniNode());
    expect(setMetaTag(":doc", root, root.entries[1].node.id, "format: text/x-latex"))
      .toEqual([{ path: ":doc[1]", op: "emplace", meta: "format: text/x-latex" }]);
    expect(root.entries[1].node.metaTag).toBe("format: text/x-latex");
    expect(setMetaTag(":doc", root, root.entries[1].node.id, null))
      .toEqual([{ path: ":doc[1]", op: "emplace", meta: null }]);
  });

  it("pointer: emplaces the bare `*` token", () => {
    const root = buildModel(omniNode());
    expect(setNodeToken(":doc", root, root.entries[2].node.id, { pointer: ":pets[0]" }))
      .toEqual([{ path: ":doc[2]", op: "emplace", yamlover: "*:pets[0]" }]);
  });
});

describe("indent / dedent (Tab / Shift-Tab)", () => {
  function twoChunks(): MNode {
    return buildModel({
      path: ":d", type: "array", concrete: null, title: null, description: null,
      value: ["alpha", "beta"],
    });
  }

  it("Tab under a SCALAR sibling turns it omni: remove + one whole-node emplace", () => {
    const root = twoChunks();
    const edits = indentEntry(":d", root, root.entries[1].id);
    expect(edits).toEqual([
      { path: ":d[1]", op: "remove" },
      { path: ":d[0]", op: "emplace", yamlover: "alpha\n- beta" },
    ]);
    expect(root.entries).toHaveLength(1);
    expect(root.entries[0].node.selfValue?.src).toBe("alpha");
    expect(root.entries[0].node.entries[0].node.scalar?.src).toBe("beta");
  });

  it("Tab under a CONTAINER sibling appends: remove + insert at the sibling's path", () => {
    const root = buildModel({
      path: ":d", type: "array", concrete: null, title: null, description: null,
      value: [{ $yamloverMixed: { kind: "mix", entries: [{ key: null, value: "kid" }] } }, "beta"],
    });
    const edits = indentEntry(":d", root, root.entries[1].id);
    expect(edits).toEqual([
      { path: ":d[1]", op: "remove" },
      { path: ":d[0]", op: "insert", yamlover: "beta" },
    ]);
    expect(root.entries[0].node.entries.map((e) => e.node.scalar?.src)).toEqual(["kid", "beta"]);
  });

  it("Shift-Tab moves the entry right after its parent in the grandparent", () => {
    const root = buildModel({
      path: ":d", type: "array", concrete: null, title: null, description: null,
      value: [{ $yamloverMixed: { kind: "mix", entries: [{ key: null, value: "x" }, { key: null, value: "y" }] } }, "tail"],
    });
    const yId = root.entries[0].node.entries[1].id;
    const edits = dedentEntry(":d", root, yId);
    expect(edits).toEqual([
      { path: ":d[0][1]", op: "remove" },
      { path: ":d[1]", op: "insert", yamlover: "y" },
    ]);
    expect(root.entries.map((e) => e.node.scalar?.src ?? "…")).toEqual(["…", "y", "tail"]);
  });

  it("no-ops: first sibling, keyed entries, root level", () => {
    const root = twoChunks();
    expect(indentEntry(":d", root, root.entries[0].id)).toEqual([]);
    expect(dedentEntry(":d", root, root.entries[0].id)).toEqual([]);
    const keyed = buildModel({ path: ":d", type: "object", concrete: null, title: null, description: null, value: { a: 1, b: 2 } });
    expect(indentEntry(":d", keyed, keyed.entries[1].id)).toEqual([]);
  });
});

describe("serializeMNode", () => {
  it("emits self-value at selfAt, keyed/ordinal markers, tags, and nested indent", () => {
    const root = buildModel(omniNode());
    expect(serializeMNode(root)).toBe('A Title\ndescription: "the blurb"\n- chunk one\n- *:pets[1]');
  });
});

describe("op queue coalescing", () => {
  it("adjacent same-path value emplaces keep the last; structural ops break the chain", () => {
    const q: OpQueue = { pending: [] };
    enqueue(q, [{ path: ":d[1]", op: "emplace", yamlover: "a" }]);
    enqueue(q, [{ path: ":d[1]", op: "emplace", yamlover: "ab" }]);
    expect(q.pending).toEqual([{ path: ":d[1]", op: "emplace", yamlover: "ab" }]);
    enqueue(q, [{ path: ":d[2]", op: "remove" }]);
    enqueue(q, [{ path: ":d[1]", op: "emplace", yamlover: "abc" }]);
    expect(q.pending).toHaveLength(3);
    // meta emplaces never fold into value emplaces
    enqueue(q, [{ path: ":d[1]", op: "emplace", meta: "t" }]);
    expect(q.pending).toHaveLength(4);
  });
});

describe("classifyHoleInput — the typing grammar", () => {
  it("recognizes each opener", () => {
    expect(classifyHoleInput("- ", true)).toEqual({ kind: "ordinal" });
    expect(classifyHoleInput("-", true)).toBeNull(); // could be a negative number
    expect(classifyHoleInput('"', true)).toEqual({ kind: "quote", quote: '"', rest: "" });
    expect(classifyHoleInput("'hi", false)).toEqual({ kind: "quote", quote: "'", rest: "hi" });
    expect(classifyHoleInput("{", false)).toEqual({ kind: "flowMap" });
    expect(classifyHoleInput("[", false)).toEqual({ kind: "flowSeq" });
    expect(classifyHoleInput("*pets", false)).toEqual({ kind: "pointer", rest: "pets" });
    expect(classifyHoleInput("!!<", true)).toEqual({ kind: "metaTag" });
    expect(classifyHoleInput("!!", true)).toBeNull(); // still building the sigil
    expect(classifyHoleInput("!!<", false)).toEqual({ kind: "text" }); // value stage: not a tag site
    expect(classifyHoleInput("|", false)).toEqual({ kind: "block" });
  });
  it("keyed needs the colon plus a space or Enter", () => {
    expect(classifyHoleInput("name", true)).toEqual({ kind: "text" });
    expect(classifyHoleInput("name:", true)).toBeNull();
    expect(classifyHoleInput("name: ", true)).toEqual({ kind: "keyed", key: "name", viaEnter: false });
    expect(classifyHoleInput("name:", true, true)).toEqual({ kind: "keyed", key: "name", viaEnter: true });
  });
  it("quote round-trip helpers", () => {
    expect(quoteSource('a "b"', '"')).toBe('"a \\"b\\""');
    expect(quoteSource("it's", "'")).toBe("'it''s'");
    expect(unquoteSource('"a b"')).toEqual({ inner: "a b", quote: '"' });
    expect(unquoteSource("'it''s'")).toEqual({ inner: "it's", quote: "'" });
    expect(unquoteSource("plain")).toBeNull();
  });
});
