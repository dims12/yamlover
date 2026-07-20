// PASTE — clipboard yamlover source → parser IR → model entries + ops. Pure logic only (the
// onPaste DOM wiring is covered in yamlover-editor.test.tsx).
import { describe, it, expect } from "vitest";
import { parseYamlover } from "../../../parser/ts/src/yamlover.ts";
import { toPlain, type Node as IRNode, type Scalar as IRScalar } from "../../../parser/ts/src/ir.ts";
import {
  entryFromIR, isLoneScalar, metaTagFromIR, nodeFromIR, normalizeClipboard, pasteBlockers,
  pasteEntriesAt, pasteRootDocument, pasteValueAt, scalarFromIR, tryParse, MAX_PASTE,
} from "../../src/client/renderers/yamlover-editor/paste";
import { buildModel, insertHoleAfter, serializeMNode } from "../../src/client/renderers/yamlover-editor/model";
import type { NodeJson } from "../../src/client/api";

const root = (src: string): IRNode => parseYamlover(src, "<t>").root;

/** The model-test omni fixture: self-value title, keyed description, ordinal chunk, pointer. */
function omniNode(): NodeJson {
  return {
    path: ":doc", type: "object", concrete: "dir/yamlover", title: null, description: null,
    value: {
      $yamloverMixed: {
        kind: "omni", value: "A Title", selfAt: 0,
        entries: [
          { key: "description", value: "the blurb" },
          { key: null, value: "chunk one" },
        ],
      },
    },
  };
}

describe("clipboard normalization + parse guard", () => {
  it("CRLF → LF, the trailing newline run strips, inner blanks stay", () => {
    expect(normalizeClipboard("a: 1\r\nb: 2\r\n")).toBe("a: 1\nb: 2");
    expect(normalizeClipboard("a: 1\n\nb: 2\n\n\n")).toBe("a: 1\n\nb: 2");
  });
  it("tryParse: SyntaxError → null; oversized → null; valid → Document", () => {
    expect(tryParse("a: [unclosed")).toBeNull();
    expect(tryParse("x".repeat(MAX_PASTE + 1))).toBeNull();
    expect(tryParse("a: 1")?.root.kind).toBe("mapping");
  });
});

describe("IR → model conversion (THE REPRESENTATION RULE)", () => {
  it("scalars keep their AUTHORED tokens: bare, quoted, block, spelled numbers, ~", () => {
    const n = root('a: "quoted"\nb: \'sq\'\nc: |-\n  l1\n  l2\nd: 0xff\ne: ~');
    const s = (i: number) => scalarFromIR(n.entries![i].value as IRScalar);
    expect(s(0)).toMatchObject({ src: '"quoted"', value: "quoted", quote: '"' });
    expect(s(1)).toMatchObject({ src: "'sq'", value: "sq", quote: "'" });
    expect(s(2)).toMatchObject({ src: "|-\n  l1\n  l2", block: true });
    expect(s(3).src).toBe("0xff");
    expect(s(4).src).toBe("~");
  });

  it("a `- *ptr` entry becomes a pointer node with the authored raw", () => {
    const e = entryFromIR(root("- *pets[1]").entries![0]);
    expect(e.node.kind).toBe("pointer");
    expect(e.node.pointer).toEqual({ raw: "pets[1]", refPath: null });
    expect(e.decided && !e.committed).toBe(true);
  });

  it("an OMNI root converts to selfValue + entries at the authored selfAt", () => {
    const n = nodeFromIR(root("Title\ndesc: blurb\n- one"));
    expect(n.kind).toBe("container");
    expect(n.selfValue?.src).toBe("Title");
    expect(n.selfAt).toBe(0);
    expect(n.entries.map((e) => e.key)).toEqual(["desc", null]);
  });

  it("a key that cannot go bare is marked quotedKey; an inner-space key stays bare", () => {
    const e = entryFromIR(root('"- x": 1').entries![0]);
    expect(e.key).toBe("- x");
    expect(e.quotedKey).toBe(true); // `- x: 1` bare would re-read as an ordinal entry
    const bare = entryFromIR(root("a b: 1").entries![0]);
    expect(bare.key).toBe("a b");
    expect(bare.quotedKey).toBeUndefined(); // `a b: 1` round-trips bare
  });

  it("metaTagFromIR: pointer schema keeps its text; single-line inline renders; multi-line drops", () => {
    const tagged = root("k: !!<format: text/x-latex> v").entries![0].value as IRNode;
    expect(tagged.meta?.schema).toBeDefined();
    expect(metaTagFromIR(tagged.meta!.schema!)).toBe("format: text/x-latex");
    const multi = root("a: 1\nb: 2"); // an inline schema this shape would render on two lines
    expect(metaTagFromIR(multi)).toBeNull();
  });

  it("round-trip property: serializeMNode(nodeFromIR(parse(src))) reparses to the same graph", () => {
    for (const src of [
      "- name: Rex\n  age: 4\n- name: Tom",
      "pets:\n- Rex\n- Whiskers\nhumans:\n  alice:\n    role: admin",
      'x: "keep me quoted"\ny: |-\n  block\n  lines',
      "Self line\nk: v\n- chunk",
    ]) {
      const round = serializeMNode(nodeFromIR(root(src)));
      expect(toPlain(parseYamlover(round, "<round>").root)).toEqual(toPlain(root(src)));
    }
  });

  it("isLoneScalar: lone scalars yes, omni and mappings no", () => {
    expect(isLoneScalar(root("42"))).toBe(true);
    expect(isLoneScalar(root("|\n  text"))).toBe(true);
    expect(isLoneScalar(root("Self\nk: v"))).toBe(false);
    expect(isLoneScalar(root("k: v"))).toBe(false);
  });
});

describe("pasteBlockers — only the unrepresentable refuses", () => {
  it("a deprecated ~ back edge blocks; anchors, !!set and comments pass (dropped extras)", () => {
    expect(pasteBlockers(root("a:\n  ~owner: *: b\nb: {}"))).toMatch(/back edge/);
    expect(pasteBlockers(root("boss: &: chief\n  name: Rex"))).toBeNull();
    expect(pasteBlockers(root("# hello\na: 1"))).toBeNull();
  });
});

describe("pasteEntriesAt — sibling splice with per-entry inserts", () => {
  it("splices 2 entries at the index: 2 ordered inserts, key carried, committed marks set", () => {
    const model = buildModel(omniNode());
    const edits = pasteEntriesAt(":doc", model, model.id, 1, root("- pasted one\nowner: alice"));
    expect(edits).toEqual([
      { path: ":doc[1]", op: "insert", yamlover: "pasted one" },
      { path: ":doc[2]", op: "insert", key: "owner", yamlover: "alice" },
    ]);
    expect(model.entries.map((e) => e.key)).toEqual(["description", null, "owner", null]);
    expect(model.entries[1].committed && model.entries[2].committed).toBe(true);
  });

  it("inside an UNCOMMITTED subtree the first commit carries the whole ancestor — one insert", () => {
    const model = buildModel(omniNode());
    const holder = insertHoleAfter(model, model.id, null)!; // a fresh `- ` container being typed
    holder.decided = true;
    holder.node.kind = "container";
    const edits = pasteEntriesAt(":doc", model, holder.node.id, 0, root("a: 1\nb: 2"));
    expect(edits).toEqual([{ path: ":doc[2]", op: "insert", yamlover: "a: 1\nb: 2" }]);
    expect(holder.committed).toBe(true); // the subtree went out whole; the second commit was a no-op
  });

  it("a pasted SELF line lands as the omni line at its position; refusals leave the model untouched", () => {
    const plain = buildModel({ path: ":d", type: "array", concrete: null, title: null, description: null, value: ["x"] });
    const edits = pasteEntriesAt(":d", plain, plain.id, 1, root("Pasted Self\n- tail"));
    expect(edits).toEqual([
      { path: ":d[1]", op: "insert", yamlover: "tail" },
      { path: ":d", op: "emplace", yamlover: "Pasted Self", at: 1 },
    ]);
    expect(plain.selfValue?.src).toBe("Pasted Self");
    // refusal: the omni fixture already HAS a self line
    const omni = buildModel(omniNode());
    const before = omni.entries.length;
    expect(pasteEntriesAt(":doc", omni, omni.id, 0, root("Second Self\n- x"))).toBeNull();
    expect(omni.entries).toHaveLength(before);
    // refusal: duplicate key against a decided existing entry
    expect(pasteEntriesAt(":doc", omni, omni.id, 0, root("description: dup"))).toBeNull();
    expect(omni.entries).toHaveLength(before);
    // refusal: duplicate key WITHIN the paste itself would collide after landing
    expect(pasteEntriesAt(":d", plain, plain.id, 0, root("k: 1\nk: 2"))).toBeNull();
  });
});

describe("pasteValueAt — a decided value hole takes the parsed root", () => {
  function keyedHole(committed: boolean) {
    const model = buildModel(omniNode());
    const hole = insertHoleAfter(model, model.id, null)!;
    hole.decided = true;
    hole.key = "pets";
    hole.committed = committed;
    return { model, hole };
  }

  it("uncommitted entry → the standard keyed subtree insert", () => {
    const { model, hole } = keyedHole(false);
    const edits = pasteValueAt(":doc", model, hole.id, root("- name: Rex\n- name: Tom"));
    expect(edits).toEqual([{ path: ":doc[2]", op: "insert", key: "pets", yamlover: "- name: Rex\n- name: Tom" }]);
    expect(hole.node.kind).toBe("container");
  });

  it("committed entry (the `key: \"\"` placeholder) → one emplace of the subtree at its path", () => {
    const { model, hole } = keyedHole(true);
    const edits = pasteValueAt(":doc", model, hole.id, root("- Rex\n- Tom"));
    expect(edits).toEqual([{ path: ":doc:pets", op: "emplace", yamlover: "- Rex\n- Tom" }]);
    expect(hole.node.entries.every((e) => e.committed)).toBe(true);
  });
});

describe("pasteRootDocument — the EMPTY document takes the ops typing would produce", () => {
  const emptyDoc = () =>
    buildModel({ path: ":n", type: "null", concrete: "file/yamlover", title: null, description: null, value: null });

  it("per-entry inserts (a root emplace takes no structure); comments/anchors drop", () => {
    const text = "# a comment\nboss: &: chief\n  name: Rex\nteam: *: boss";
    const model = emptyDoc();
    const edits = pasteRootDocument(":n", model, parseYamlover(text, "<paste>"));
    expect(edits).toEqual([
      { path: ":n[0]", op: "insert", key: "boss", yamlover: "name: Rex" }, // no `&`, no comment
      { path: ":n[1]", op: "insert", key: "team", yamlover: "*:boss" },
    ]);
    expect(model.entries.map((e) => e.key)).toEqual(["boss", "team"]);
    expect(model.entries.every((e) => e.committed)).toBe(true);
  });

  it("the user's pets document: ONE keyed insert carrying the whole nested subtree", () => {
    const text = "pets:\n  - name: Rex\n    species: dog\n  - name: Whiskers\n    species: cat";
    const edits = pasteRootDocument(":n", emptyDoc(), parseYamlover(text, "<paste>"));
    expect(edits).toEqual([
      { path: ":n[0]", op: "insert", key: "pets", yamlover: "- name: Rex\n  species: dog\n- name: Whiskers\n  species: cat" },
    ]);
  });

  it("a SELF-line document lands the entries then the legal scalar-only root emplace", () => {
    const text = "A Title\nk: v";
    const model = emptyDoc();
    const edits = pasteRootDocument(":n", model, parseYamlover(text, "<paste>"));
    expect(edits).toEqual([
      { path: ":n[0]", op: "insert", key: "k", yamlover: "v" },
      { path: ":n", op: "emplace", yamlover: "A Title" },
    ]);
    expect(model.selfValue?.src).toBe("A Title");
  });

  it("the LEGACY `\"\"` scalar root clears its line first; a real root scalar refuses", () => {
    const legacy = buildModel({ path: ":n", type: "string", concrete: "file/yamlover", title: null, description: null, value: "" });
    expect(legacy.kind).toBe("scalar");
    const edits = pasteRootDocument(":n", legacy, parseYamlover("k: v", "<paste>"));
    expect(edits).toEqual([
      { path: ":n", op: "emplace", yamlover: '""' }, // the `""` line LEAVES before entries land
      { path: ":n[0]", op: "insert", key: "k", yamlover: "v" },
    ]);
    expect(legacy.kind).toBe("container");
    const real = buildModel({ path: ":n", type: "string", concrete: "file/yamlover", title: null, description: null, value: "content" });
    expect(pasteRootDocument(":n", real, parseYamlover("k: v", "<paste>"))).toBeNull(); // never clobber silently
    expect(real.kind).toBe("scalar");
  });

  it("a lone block-scalar document becomes the root scalar", () => {
    const model = emptyDoc();
    const edits = pasteRootDocument(":n", model, parseYamlover("|-\n  line one\n  line two", "<paste>"));
    expect(edits).toEqual([{ path: ":n", op: "emplace", yamlover: "|-\n  line one\n  line two" }]);
    expect(model.kind).toBe("scalar");
    expect(model.scalar?.block).toBe(true);
  });
});
