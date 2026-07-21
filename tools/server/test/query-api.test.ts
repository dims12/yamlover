import { describe, it, expect } from "vitest";
import { createHandlers } from "./helpers";
import { tmpTree } from "./helpers";
import { call } from "./http";

// GET /api/query — the 3g evaluator exposed (the engine-API `query` op of ENGINE.md).

describe("/api/query", () => {
  it("evaluates a colon-grammar query and returns client paths", async () => {
    const h = createHandlers(
      tmpTree({ "team.yamlover": "alice:\n  age: 31\nbob:\n  age: 9\n" }),
      { gitignore: false },
    );
    await h.ready;
    const r = call(h, "/api/query", { q: ": team.yamlover: ?: age: >10" });
    expect(r.status).toBe(200);
    expect(r.json.results).toEqual([":team.yamlover:alice:age"]);
  });

  it("a malformed query is a 400, an empty result is a 200 with []", async () => {
    const h = createHandlers(tmpTree({ name: "Alice" }), { gitignore: false });
    await h.ready;
    expect(call(h, "/api/query", { q: ": tags: дорожный знак" }).status).toBe(400); // unquoted spacey key
    expect(call(h, "/api/query", { q: ": nowhere" }).json.results).toEqual([]);
  });

  // shape=tree: the TOC-search form — each result a TreeNode row (metadata only, children
  // lazy), in the evaluator's walk order, labeled like /api/tree.
  it("shape=tree returns TreeNode-shaped results", async () => {
    const h = createHandlers(
      tmpTree({ "team.yamlover": "alice:\n  age: 31\nbob:\n  age: 9\n" }),
      { gitignore: false },
    );
    await h.ready;
    const r = call(h, "/api/query", { q: ": team.yamlover: ?", shape: "tree" });
    expect(r.status).toBe(200);
    expect(r.json.results.map((n: any) => n.path)).toEqual([":team.yamlover:alice", ":team.yamlover:bob"]);
    const alice = r.json.results[0];
    expect(alice.label).toBe("alice");
    expect(alice.type).toBe("object");
    expect(alice.hasChildren).toBe(true); // chevron: real children load lazily
    expect(alice.children).toEqual([]); // depth 0 — metadata only
  });

  it("shape=tree labels the root result with the served dir's name", async () => {
    const h = createHandlers(tmpTree({ name: "Alice" }), { gitignore: false });
    await h.ready;
    const r = call(h, "/api/query", { q: ":", shape: "tree" });
    expect(r.status).toBe(200);
    expect(r.json.results).toHaveLength(1);
    expect(r.json.results[0].path).toBe(":");
    expect(r.json.results[0].label).not.toBe(""); // basename of the temp dir
  });

  it("shape=tree filters the hidden .yamlover overlay and still 400s a malformed query", async () => {
    const h = createHandlers(
      tmpTree({ name: "Alice", ".yamlover/settings.yamlover": "width: 80\n" }),
      { gitignore: false },
    );
    await h.ready;
    // `: ?` fans out over the root's children — the hidden `.yamlover` overlay must not appear.
    const r = call(h, "/api/query", { q: ": ?", shape: "tree" });
    expect(r.status).toBe(200);
    expect(r.json.results.map((n: any) => n.path)).toEqual([":name"]);
    // descend INTO the overlay: results inside the hidden subtree are filtered too (ancestor-aware)
    const inside = call(h, "/api/query", { q: ": '.yamlover': ?", shape: "tree" });
    expect(inside.json.results).toEqual([]);
    expect(call(h, "/api/query", { q: ": tags: дорожный знак", shape: "tree" }).status).toBe(400);
  });

  // shape=filter: the filtered-TOC form — ONE pruned tree of matches + ALL ancestors,
  // match rows flagged, plus the flat match list in walk order.
  it("shape=filter returns the pruned ancestor tree with match flags", async () => {
    const h = createHandlers(
      tmpTree({ "team.yamlover": "alice:\n  age: 31\nbob:\n  age: 9\n", "pets.yamlover": "- Rex\n" }),
      { gitignore: false },
    );
    await h.ready;
    const r = call(h, "/api/query", { q: ": team.yamlover: ?: age: >10", shape: "filter" });
    expect(r.status).toBe(200);
    expect(r.json.matches).toEqual([":team.yamlover:alice:age"]);
    expect(r.json.truncated).toBe(false);
    const root = r.json.root;
    expect(root.path).toBe(":");
    expect(root.match).toBeUndefined(); // an ancestor, not a match
    // the pruned tree holds ONLY the ancestor chain — pets.yamlover and bob are absent
    expect(root.children.map((c: any) => c.path)).toEqual([":team.yamlover"]);
    const team = root.children[0];
    expect(team.children.map((c: any) => c.path)).toEqual([":team.yamlover:alice"]);
    const age = team.children[0].children[0];
    expect(age.path).toBe(":team.yamlover:alice:age");
    expect(age.match).toBe(true);
    expect(age.children).toEqual([]);
  });

  it("shape=filter: a match ships its real children one level deep (what lies below the path)", async () => {
    const h = createHandlers(
      tmpTree({ "team.yamlover": "alice:\n  age: 31\n  city: Kyiv\nbob:\n  age: 9\n", "pets.yamlover": "- Rex\n" }),
      { gitignore: false },
    );
    await h.ready;
    const r = call(h, "/api/query", { q: ": team.yamlover: alice", shape: "filter" });
    expect(r.status).toBe(200);
    expect(r.json.matches).toEqual([":team.yamlover:alice"]);
    const team = r.json.root.children[0];
    // siblings of the match's ancestors stay pruned (bob and pets.yamlover absent)
    expect(r.json.root.children.map((c: any) => c.path)).toEqual([":team.yamlover"]);
    expect(team.children.map((c: any) => c.path)).toEqual([":team.yamlover:alice"]);
    const alice = team.children[0];
    expect(alice.match).toBe(true);
    // the match's OWN children ship shallow — shown below the path without a chevron click
    expect(alice.children.map((c: any) => c.path)).toEqual([":team.yamlover:alice:age", ":team.yamlover:alice:city"]);
    expect(alice.children.every((c: any) => !c.match)).toBe(true);
    expect(alice.children.map((c: any) => c.children)).toEqual([[], []]); // one level only — deeper stays lazy
  });

  it("shape=filter: a match that is an ancestor of another match keeps both flagged", async () => {
    const h = createHandlers(
      tmpTree({ "team.yamlover": "alice:\n  age: 31\n" }),
      { gitignore: false },
    );
    await h.ready;
    // `...` under alice matches alice AND its descendants
    const r = call(h, "/api/query", { q: ": team.yamlover: alice: ...", shape: "filter" });
    expect(r.status).toBe(200);
    const team = r.json.root.children[0];
    const alice = team.children[0];
    expect(alice.match).toBe(true);
    expect(alice.children[0].path).toBe(":team.yamlover:alice:age");
    expect(alice.children[0].match).toBe(true);
    expect(team.match).toBeUndefined();
  });

  it("the scope ladder is honored: `::` (project) searches the grafted taxonomy, `:` (document) does not", async () => {
    const h = createHandlers(
      tmpTree({ name: "Alice", ".yamlover/settings.yamlover": "width: 80\n" }),
      { gitignore: false },
    );
    await h.ready;
    // the popup's find-anywhere query is PROJECT-scoped and reaches inside the graft…
    const r = call(h, "/api/query", { q: ":: ...: colors", shape: "filter" });
    expect(r.status).toBe(200);
    expect(r.json.matches).toContain(":yamlover:tags:colors");
    // …and the pruned tree carries the graft chain down to the match (+ its palette children)
    const y = r.json.root.children.find((c: any) => c.path === ":yamlover");
    expect(y).toBeTruthy();
    const colors = y.children.find((c: any) => c.path === ":yamlover:tags").children[0];
    expect(colors.match).toBe(true);
    expect(colors.children.map((c: any) => c.path)).toContain(":yamlover:tags:colors:yellow");
    // `:: yamlover: ?` suggests the graft's content (the previous dead end)
    const sub = call(h, "/api/query", { q: ":: yamlover: tags: ?", shape: "tree" });
    expect(sub.json.results.map((n: any) => n.path)).toContain(":yamlover:tags:colors");
    // DOCUMENT scope does NOT see project furniture — `:` is the document, `::` the project
    const doc = call(h, "/api/query", { q: ": ...: colors", shape: "filter" });
    expect(doc.json.matches).toEqual([]);
    // the graft ROOT itself stays off project fan-outs — content, not plumbing
    const fan = call(h, "/api/query", { q: ":: ?", shape: "tree" });
    expect(fan.json.results.map((n: any) => n.path)).toEqual([":name"]);
    // and the `.yamlover` OVERLAY stays off search results at EVERY rung
    const overlay = call(h, "/api/query", { q: ":: ...: settings.yamlover", shape: "filter" });
    expect(overlay.json.matches).toEqual([]);
  });

  it("shape=filter: no matches → bare root, empty list; malformed still 400; hidden filtered", async () => {
    const h = createHandlers(
      tmpTree({ name: "Alice", ".yamlover/settings.yamlover": "width: 80\n" }),
      { gitignore: false },
    );
    await h.ready;
    const none = call(h, "/api/query", { q: ": nowhere", shape: "filter" });
    expect(none.status).toBe(200);
    expect(none.json.matches).toEqual([]);
    expect(none.json.root.children).toEqual([]);
    expect(call(h, "/api/query", { q: ": tags: дорожный знак", shape: "filter" }).status).toBe(400);
    // `: ?` fans over the root's children — the hidden overlay must not appear anywhere
    const r = call(h, "/api/query", { q: ": ?", shape: "filter" });
    expect(r.json.matches).toEqual([":name"]);
    expect(r.json.root.children.map((c: any) => c.path)).toEqual([":name"]);
  });
});
