// @vitest-environment jsdom
//
// FAITHFUL-RENDER round-trip: the yamlover view must read back as the SAME graph it shows.
// We index a body, project it (/api/json at full depth), render it with <Render>, scrape the
// faithful text (drop the fold-gutter chevrons; everything else is the code), reparse it as
// yamlover, and assert the reparsed IR equals the source IR (graph, not typography — comments
// and layout are re-rendered, like serialize.test.ts). This guards #2–#8: a ref shown as a
// bare `:path`, a missing `*`/anchor/tag, or a swallowed null would all break the reparse.

import { describe, it, expect } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { createHandlers } from "../src/server/engine-api";
import { Render } from "../src/client/render";
import { parseYamlover } from "../../parser/ts/src/yamlover.ts";
import type { Document, Node, Pointer, Value } from "../../parser/ts/src/ir.ts";
import { isPointer } from "../../parser/ts/src/ir.ts";
import { tmpTree } from "./helpers";
import { call } from "./http";

// ---- IR equality (graph, not typography) — a trimmed copy of serialize.test.ts's canon ----
function canonNode(n: Node): unknown {
  const ents = (n.entries ?? []).filter((e) => e.key !== "yamlover"); // drop the built-in taxonomy graft
  const anchors = (n.meta?.anchors ?? [])
    .map((a) => ({ base: a.path.base, steps: a.path.steps, ordinal: a.ordinal === true }))
    .sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1));
  return {
    kind: n.kind,
    value: n.kind === "scalar" ? n.value : undefined,
    array: n.array === true,
    set: n.meta?.set === true,
    anchors,
    entries: ents.map((e) => ({ key: e.key, edge: e.edge, value: canonValue(e.value) })),
  };
}
function canonValue(v: Value): unknown {
  return isPointer(v) ? { ptr: { base: (v as Pointer).base, steps: (v as Pointer).steps } } : canonNode(v as Node);
}
const canon = (d: Document) => canonNode(d.root);

/** Render `value`+`comments` as yamlover and return the faithful source text (chevrons dropped). */
function renderedText(value: unknown, comments: unknown, documentPath: string, nodePath: string): string {
  const { container } = render(
    <Render value={value} comments={comments as any} syntax="yaml" onNavigate={() => {}} documentPath={documentPath} nodePath={nodePath} />,
  );
  // the only non-source glyph the view injects is the fold-gutter chevron (`›`); drop it
  const text = (container.textContent ?? "").replace(/›/g, "");
  cleanup();
  return text;
}

/** Index `body`, project + render it, reparse the render, and assert the graph survived. */
async function roundTrip(body: string): Promise<string> {
  const h = createHandlers(tmpTree({ ".yamlover/body.yamlover": body }), { gitignore: false });
  await h.ready;
  const { json } = call(h, "/api/json", { path: ":", depth: ".inf" });
  if (json.value && typeof json.value === "object") delete (json.value as Record<string, unknown>).yamlover; // graft
  const text = renderedText(json.value, json.comments, json.documentPath ?? ":", json.path ?? ":");
  const re = parseYamlover(text, "<rendered>");
  expect(canon(re), `rendered text did not reparse to the same IR:\n${text}`).toEqual(canon(parseYamlover(body, "<body>")));
  return text;
}

/** Render a node from a served tree (any file), returning the faithful yamlover text. */
async function renderNode(files: Record<string, string>, path: string): Promise<string> {
  const h = createHandlers(tmpTree(files), { gitignore: false });
  await h.ready;
  const { json } = call(h, "/api/json", { path, depth: ".inf" });
  return renderedText(json.value, json.comments, json.documentPath ?? path, json.path ?? path);
}

describe("YAML concrete: anchors are document-level, rendered as valid yamlover", () => {
  // A .yaml file is parsed with YAML link semantics: `&whiskers`/`*whiskers` are document-wide,
  // so the alias resolves and the anchor makes a real root key — all shown in yamlover syntax.
  const yaml = "pets:\n  - name: Rex\n  - &whiskers\n    name: Whiskers\nhumans:\n  - name: Alice\n    manager: *whiskers\n";

  it("renders the alias as a document-scope pointer (`*: whiskers`), never absent", async () => {
    const text = await renderNode({ "tour.yaml": yaml }, ":tour.yaml");
    expect(text).toContain("manager: *: whiskers"); // the YAML alias, resolved + valid yamlover
  });

  it("never renders a bare `:path` (every ref is a `*…` token)", async () => {
    const text = await renderNode({ "tour.yaml": yaml }, ":tour.yaml");
    // a realized anchor edge must be a pointer token, not a bare path like `:pets[1]`
    expect(text).not.toMatch(/(^|\s):pets/m);
    expect(text).toMatch(/\*: ?pets/); // the realized `whiskers` root key points back with `*…`
  });
});

describe("faithful-render round-trip (render → reparse → same IR)", () => {
  it("scalars and nested containers", async () => {
    await roundTrip("name: Alice\nage: 30\nuser:\n  role: admin\n  pets:\n    - Rex\n    - Whiskers\n");
  });

  it("authored pointers in every scope (the #2/#5/#6 fixes)", async () => {
    await roundTrip("pets:\n  - name: Rex\nfeline: *pets[0]\ntop: *: pets[0]: name\nself: *pets[0]\n");
  });

  it("a literal-key pointer (escaped colon)", async () => {
    await roundTrip("weird:\n  cat\\:dog:\n    n: 1\nref: *weird: cat\\:dog: n\n");
  });

  it("a null value (rendered as `null`, not `~`)", async () => {
    await roundTrip("a: 1\nnothing: null\nb: 2\n");
  });

  it("non-finite numbers survive store + transport + render (.inf / -.inf / .nan, not null)", async () => {
    // Regression: ±Infinity / NaN were silently nulled (JSON.stringify in the store + transport).
    const text = await roundTrip("max: .inf\nmin: -.inf\nmissing: .nan\nfinite: 5\n");
    expect(text).toMatch(/max: \.inf/);
    expect(text).toMatch(/min: -\.inf/);
    expect(text).toMatch(/missing: \.nan/);
    expect(text).not.toMatch(/null/);
  });

  it("a scalar-body directory IS that scalar (54-scalar-file-overlay: `.yamlover/body.yamlover` = 30)", async () => {
    // Regression: the directory rendered EMPTY — the scalar body was dropped, leaving an empty
    // mapping. A directory whose body.yamlover is a bare scalar must render as that scalar. Use a
    // CHILD node (`:sub`), since the served root also carries the built-in `yamlover` taxonomy graft.
    const text = await renderNode({ "sub/.yamlover/body.yamlover": "30\n" }, ":sub");
    expect(text.trim()).toBe("30");
  });

  it("comments and a blank line survive (typography is allowed to differ, graph is not)", async () => {
    await roundTrip("# head\n\nname: Alice # who\nage: 30\n");
  });

  it("an omni self-value trailing comment rides the value line (no spurious blank)", async () => {
    const text = await renderNode({ ".yamlover/body.yamlover": "!!var 5 # the value\n- solid\n- recommended\nscale: 10\n" }, ":");
    expect(text).toMatch(/(^|\n)5 # the value(\n|$)/); // the comment is ON the `5` line …
    expect(text).not.toMatch(/5[^\n]*\n\s*\n/); // … with no blank line wrapped in after it
  });

  it("a type tag (!!set) survives", async () => {
    await roundTrip("crew: !!set\n  - alpha\n  - beta\n");
  });

  it("a chapter's omni chunk and subchapters ride the dash — no bare `-` line", async () => {
    const text = await roundTrip(
      "title: Doc\n" +
        "- the intro chunk\n" +
        "  yamlover-fragments:\n" +
        "    s1:\n" +
        "      exact: intro\n" +
        "- a plain chunk\n" +
        "- title: Why\n" +
        "  - nested a\n" +
        "  - nested b\n",
    );
    expect(text).not.toMatch(/^\s*-\s*$/m); // no dash left dangling on its own line
    expect(text).toMatch(/^- the intro chunk$/m); // the omni self-value rides the dash
    expect(text).toMatch(/^- title: Why$/m); // the subchapter's first key rides the dash
  });

  it("a chunk written as a single-line `- |-` block (what tagging produces) inlines its self-value", async () => {
    // convertChunkToOmni emits `- |-` (strip) for a one-line chunk → value has no newline → inlines
    const text = await roundTrip("- |-\n    the tagged chunk\n  yamlover-fragments:\n    s1:\n      exact: tagged\n");
    expect(text).not.toMatch(/^\s*-\s*$/m);
    expect(text).toMatch(/^- the tagged chunk$/m);
  });

  // KNOWN GAP (it.fails marks it expected-failing; flip to `it` once fixed). The `&: chief`
  // anchor renders correctly ON boss, but the projection ALSO surfaces the derived root key it
  // creates, as a redundant `chief: :boss` entry (a bare path, not a `*…` pointer). Faithful
  // rendering needs the projection to suppress realized-anchor edges (they're already shown on
  // their source node) — a graph-projection decision, not a rendering one.
  it.fails("a path anchor (&: chief) survives [known gap: realized-anchor edge surfaces]", async () => {
    await roundTrip("boss: &: chief\n  name: Rex\nteam:\n  lead: *: chief\n");
  });
});
