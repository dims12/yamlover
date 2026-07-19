import { describe, it, expect } from "vitest";
import { createHandlers } from "./helpers";
import { tmpExample, tmpTree } from "./helpers";
import { call } from "./http";

// Read endpoints, against DISPOSABLE COPIES of the example fixtures (indexing writes the
// .yamlover/index.db cache into the served tree, so even reads must not target the repo).

describe("api endpoints (engine-backed)", () => {
  it("/api/info returns the served root's directory name", async () => {
    const h = createHandlers(tmpExample("51-object-in-dir"), { gitignore: false });
    await h.ready;
    expect(call(h, "/api/info").json).toEqual({ root: "51-object-in-dir" });
  });

  it("/api/tree lists scalars and respects depth", async () => {
    const h = createHandlers(tmpExample("51-object-in-dir"), { gitignore: false });
    await h.ready;
    const { json } = call(h, "/api/tree", { depth: "3" });
    // filesystem order = sorted names (no body.yamlover to impose another); the `yamlover`
    // self-import graft is HIDDEN plumbing and never appears in the listing
    expect(json.children.map((c: any) => c.label)).toEqual(["age", "isAdmin", "name"]);
  });

  it("the `yamlover` self-import graft is HIDDEN from listings yet fully REACHABLE", async () => {
    const h = createHandlers(tmpExample("51-object-in-dir"), { gitignore: false });
    await h.ready;
    // hidden: not in the TOC (asserted above), not among the root projection's entries
    const rootJson = call(h, "/api/json", { path: ":", depth: "1" }).json;
    expect(Object.keys(rootJson.value as object)).not.toContain("yamlover");
    // reachable: direct navigation works and serves the grafted taxonomy
    const tags = call(h, "/api/json", { path: ":yamlover:tags:colors" });
    expect(tags.status).toBe(200);
    // reachable: project-scope pointers into it still resolve (schema application shows it)
    const y = call(h, "/api/json", { path: ":yamlover" });
    expect(y.status).toBe(200);
    expect(Object.keys(y.json.value as object)).toContain("$defs");
  });

  it("/api/tree: a chunks-only chapter is a LEAF (no expand chevron); one with a subchapter expands", async () => {
    // MINITODO: 68-math-chapter (chunks + a root fragment, no subchapters) must not show a chevron
    // that expands to nothing. A chapter's TOC hint counts SUBCHAPTERS only, not chunks/overlay.
    const DEFS = {
      "$defs/chapter": "type: variant\nproperties:\n  title:\n    type: string\nitems:\n  anyOf:\n    - *//yamlover/$defs/chapter\n    - *//yamlover/$defs/chunk\n",
      "$defs/chunk": "type: [string, binary]\nformat: text/marklower\n",
    };
    const h = createHandlers(tmpTree({
      "chunks-only.yamlover": "!!<*yamlover/$defs/chapter>\ntitle: Only Chunks\n- one\n- two\n",
      "with-sub.yamlover": "!!<*yamlover/$defs/chapter>\ntitle: Has Sub\n- intro\n- title: A Subchapter\n  - nested\n",
      ...DEFS,
    }), { gitignore: false });
    await h.ready;
    const co = call(h, "/api/tree", { path: ":chunks-only.yamlover", depth: "2" }).json;
    expect(co.format).toBe("x-yamlover-chapter");
    expect(co.hasChildren).toBe(false); // only chunks/overlay → a leaf
    const ws = call(h, "/api/tree", { path: ":with-sub.yamlover", depth: "2" }).json;
    expect(ws.hasChildren).toBe(true); // has a subchapter → expandable
    expect(ws.children.some((c: { format?: string }) => c.format === "x-yamlover-chapter")).toBe(true);
  });

  it("/api/tree: an UNTITLED chapter is labeled by its first chunk's text, not `[index]`", async () => {
    const DEFS = {
      "$defs/chapter": "type: variant\nvalue:\n  type: string\nitems:\n  anyOf:\n    - *//yamlover/$defs/chapter\n    - *//yamlover/$defs/chunk\n",
      "$defs/chunk": "type: [string, binary]\nformat: text/marklower\n",
    };
    const h = createHandlers(tmpTree({
      // a titled chapter whose body holds an UNTITLED subchapter (compact `- - ` form)
      "doc.yamlover": "!!<*yamlover/$defs/chapter>\nTitled\n- intro\n- - the first chunk of an untitled subchapter tells you what it is\n  - more\n",
      ...DEFS,
    }), { gitignore: false });
    await h.ready;
    const doc = call(h, "/api/tree", { path: ":doc.yamlover", depth: "2" }).json;
    expect(doc.label).toBe("Titled");
    const sub = doc.children.find((c: { format?: string }) => c.format === "x-yamlover-chapter");
    expect(sub.label).toBe("the first chunk of an untitled subchapt…"); // clipped first-chunk text
  });

  it("/api/json is one level deep with link markers", async () => {
    // an object with a nested array child → the child projects as an array link marker
    const h = createHandlers(tmpTree({ ".yamlover/body.yamlover": "markup:\n- x: 1\n  y: 2\n- x: 3\n  y: 4\n" }), { gitignore: false });
    await h.ready;
    const { json } = call(h, "/api/json", { path: ":" });
    expect(json.type).toBe("object");
    expect(json.value.markup.$yamloverLink.kind).toBe("array");
  });

  it("/api/json?binary=1 returns base64 for a binary node (even one with overlay entries)", async () => {
    // a png typed via meta, carrying embedded fragment overlay entries in body
    const h = createHandlers(tmpTree({
      "pic.png": "pretend-png-bytes",
      ".yamlover/meta.yamlover": "properties:\n  pic.png:\n    type: binary\n    format: image/png\n    concrete: file/binary\n",
      ".yamlover/body.yamlover": "\"pic.png\":\n  yamlover-fragments:\n    f1:\n      type: rect\n      x: 1\n      y: 2\n      w: 3\n      h: 4\n",
    }), { gitignore: false });
    await h.ready;
    const { json } = call(h, "/api/json", { path: ":pic.png", binary: "1" });
    // the png owns embedded overlay entries (fragments), so it reads as `variant` — but its
    // binary VALUE facet is intact, so ?binary=1 still streams the bytes. The omni projection is
    // KEPT: the bytes fill the mixed marker's self-value slot, alongside the overlay entries.
    expect(json.type).toBe("variant");
    const mixed = json.value.$yamloverMixed;
    expect(mixed.value.$yamloverBinary.format).toBe("image/png");
    expect(Buffer.from(mixed.value.$yamloverBinary.base64, "base64").toString()).toBe("pretend-png-bytes");
    expect(mixed.entries.map((e: { key: string }) => e.key)).toContain("yamlover-fragments");
  });

  it("/api/schema returns the instance schema", async () => {
    const h = createHandlers(tmpExample("51-object-in-dir"), { gitignore: false });
    await h.ready;
    const { json } = call(h, "/api/schema", { path: ":" });
    expect(json.type).toBe("object");
    expect(json.properties.name.const).toBe("Alice");
  });

  it("reports an unknown path as a 404", async () => {
    const h = createHandlers(tmpExample("51-object-in-dir"), { gitignore: false });
    await h.ready;
    const { status, json } = call(h, "/api/json", { path: ":nope" });
    expect(status).toBe(404);
    expect(json.error).toBeTruthy();
  });
});

describe("comment projection (/api/json)", () => {
  const tree = () =>
    tmpTree({
      ".yamlover/body.yamlover":
        "# banner\n\n# the name\nname: Alice # who\nuser:\n  # nested\n  role: admin\n# bye\n",
    });

  it("returns comments keyed by each node's fragment (leading/trailing/nested)", async () => {
    const h = createHandlers(tree(), { gitignore: false });
    await h.ready;
    const { json } = call(h, "/api/json", { path: ":", depth: ".inf" });
    expect(json.comments.$head).toEqual([" banner"]); // head-of-file banner (carried onto the root)
    // `name` has a blank line before its comment block (banner ⏎⏎ # the name)
    expect(json.comments["/name"]).toEqual({ leading: [" the name"], trailing: [" who"], blankBefore: true });
    expect(json.comments["/user/role"]).toEqual({ leading: [" nested"] }); // nested, needs .inf depth
    expect(json.comments.$tail).toEqual([" bye"]); // a trailing-of-file comment, kept on the root
  });

  it("only projects comments within the depth budget (nested past it is omitted)", async () => {
    const h = createHandlers(tree(), { gitignore: false });
    await h.ready;
    const { json } = call(h, "/api/json", { path: ":", depth: "1" });
    expect(json.comments["/name"]).toEqual({ leading: [" the name"], trailing: [" who"], blankBefore: true });
    expect(json.comments["/user/role"]).toBeUndefined(); // user's child is a link marker at depth 1
  });

  it("projects pointer tokens, anchors and type tags (yamlover syntax fidelity)", async () => {
    const h = createHandlers(
      tmpTree({
        ".yamlover/body.yamlover": "boss: &: chief\n  name: Rex\nteam:\n  lead: *: chief\ncrew: !!set\n  - *: boss\n",
      }),
      { gitignore: false },
    );
    await h.ready;
    const { json } = call(h, "/api/json", { path: ":", depth: ".inf" });
    expect((json.comments["/boss"] as any).anchors).toEqual([": chief"]); // the `&: chief` path anchor
    expect((json.comments["/team/lead"] as any).pointer).toBe(": chief"); // authored pointer (colon form)
    expect((json.comments["/crew"] as any).tag).toBe("!!set"); // the `!!set` type tag
  });

  it("carries a block scalar's AUTHORED token in `raw` (header + de-indented lines)", async () => {
    const h = createHandlers(
      tmpTree({
        ".yamlover/body.yamlover": "clip: |\n  one\n  two\nstrip: |-\n  solo\n  duo\nfold: >\n  a\n  b\noneline: |-\n  alone\n",
      }),
      { gitignore: false },
    );
    await h.ready;
    const { json } = call(h, "/api/json", { path: ":", depth: ".inf" });
    // the representation lives in the concrete — the renderer reproduces it, never re-derives
    expect((json.comments["/clip"] as any).raw).toBe("|\none\ntwo");
    expect((json.comments["/strip"] as any).raw).toBe("|-\nsolo\nduo");
    expect((json.comments["/fold"] as any).raw).toBe(">\na\nb");
    // a block whose VALUE is one line normalizes to its inline form — no block raw carried
    expect((json.comments["/oneline"] as any)?.raw).toBeUndefined();
    expect(json.value.clip).toBe("one\ntwo\n"); // values keep their chomping semantics
    expect(json.value.strip).toBe("solo\nduo");
    expect(json.value.fold).toBe("a b\n");
    expect(json.value.oneline).toBe("alone");
  });

  it("flags entries preceded by a blank source line (for empty-line rendering)", async () => {
    const h = createHandlers(
      tmpTree({ ".yamlover/body.yamlover": "a: 1\nb: 2\n\nc: 3\n" }),
      { gitignore: false },
    );
    await h.ready;
    const { json } = call(h, "/api/json", { path: ":", depth: ".inf" });
    expect((json.comments["/c"] as any)?.blankBefore).toBe(true); // blank line before c
    expect(json.comments["/b"]).toBeUndefined(); // b directly follows a — no blank
  });

  it("scopes comment keys to the viewed node", async () => {
    const h = createHandlers(tree(), { gitignore: false });
    await h.ready;
    const { json } = call(h, "/api/json", { path: ":user", depth: ".inf" });
    // relative to :user, the nested comment lands at /role (no /user prefix)
    expect(json.comments["/role"]).toEqual({ leading: [" nested"] });
  });
});

describe("reverse positional membership (~-) projection", () => {
  const tree = () =>
    tmpTree({
      ".yamlover/body.yamlover":
        "items:\n- alpha\nmember:\n  name: m\n  ~- */items\n  ~- */unique\n" +
        "dup:\n  ~- */items\n  ~- */items\nunique: !!set\n- */member\n",
    });

  it("appends reverse members after owned entries, lexicographically, ADDITIVE (repetition kept)", async () => {
    const h = createHandlers(tree(), { gitignore: false });
    await h.ready;
    const { json } = call(h, "/api/json", { path: ":items", depth: "2" });
    const items = json.value as any[];
    expect(items[0]).toBe("alpha"); // owned entry first
    // then /dup twice (two ~- declarations — lists repeat), then /member
    expect(items.slice(1).map((v) => v.$yamloverLink.path)).toEqual([":dup", ":dup", ":member"]);
  });

  it("a !!set container dedups forward+reverse authoring to one membership", async () => {
    const h = createHandlers(tree(), { gitignore: false });
    await h.ready;
    const { json } = call(h, "/api/json", { path: ":unique", depth: "2" });
    const items = json.value as any[];
    expect(items).toHaveLength(1);
    expect(items[0].$yamloverLink.path).toBe(":member");
  });

  it("reverse declarations do not change the member's own type", async () => {
    const h = createHandlers(tree(), { gitignore: false });
    await h.ready;
    const { json } = call(h, "/api/json", { path: ":member", depth: "2" });
    expect(json.type).toBe("object");
    expect(json.value.name).toBe("m");
  });
});

describe("render depth: .inf default + references as references", () => {
  // a directory document with a nested subtree and a forward `*` reference
  const tree = () =>
    tmpTree({
      ".yamlover/body.yamlover":
        "eve:\n  name: Eve\n" +
        "adam:\n  mother: *:eve\n  deep:\n    nested:\n      leaf: 1\n",
    });

  it("defaults to UNLIMITED depth inside a document: the whole subtree inlines (no truncation marker)", async () => {
    const h = createHandlers(tree(), { gitignore: false });
    await h.ready;
    const { json } = call(h, "/api/json", { path: ":adam" }); // no ?depth= → server default (.inf)
    expect(json.value.deep.nested.leaf).toBe(1); // inlined all the way down
  });

  it("renders a reference AS a reference (its pointer text) at the default .inf depth", async () => {
    const h = createHandlers(tree(), { gitignore: false });
    await h.ready;
    const { json } = call(h, "/api/json", { path: ":adam" });
    // the ref renders as a VALID yamlover deref token (`*` + canonical spaced colon path)
    expect(json.value.mother.$yamloverRef).toEqual({ text: "*: eve", path: ":eve" });
    expect(json.value.mother.$yamloverLink).toBeUndefined(); // not a { object … } marker
  });

  it("?depth=.inf is unlimited (whole subtree, references as references)", async () => {
    const h = createHandlers(tree(), { gitignore: false });
    await h.ready;
    const { json } = call(h, "/api/json", { path: ":adam", depth: ".inf" });
    expect(json.value.deep.nested.leaf).toBe(1);
    expect(json.value.mother.$yamloverRef.text).toBe("*: eve");
  });

  it("at an explicit FINITE depth a reference resolves to a navigable link marker; deep containment truncates", async () => {
    const h = createHandlers(tree(), { gitignore: false });
    await h.ready;
    const { json } = call(h, "/api/json", { path: ":adam", depth: "1" });
    expect(json.value.mother.$yamloverLink.path).toBe(":eve"); // resolved → a link, not a $yamloverRef
    expect(json.value.mother.$yamloverRef).toBeUndefined();
    expect(json.value.deep.$yamloverLink).toBeTruthy(); // past the depth-1 budget → truncation marker
  });

  it("a DIRECTORY defaults to ONE level (children are link markers, not inlined whole)", async () => {
    const h = createHandlers(tree(), { gitignore: false });
    await h.ready;
    const { json } = call(h, "/api/json", { path: ":" }); // the served root = a .yamlover directory
    expect(json.value.adam.$yamloverLink).toBeTruthy();
  });
});
