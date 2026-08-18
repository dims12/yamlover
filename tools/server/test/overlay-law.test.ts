// THE OVERLAY LAW (docs/annotations, docs/language/concretes/03-yamlover/01-dir/00-dir_yo):
// entries under the engine-managed `.yo` subtree (either overlay spelling) browsed DIRECTLY
// lose their magic — served with `special: overlay`, rendered dumb, refused by every edit
// route. `:.yo:settings.yo` is the one human-authored carve-out. Legacy spellings (`yo:`,
// `yamlover-thumbnails:`) are read forever, and the doctor nudges (info) toward migration.
import { describe, it, expect } from "vitest";
import { createHandlers, tmpTree } from "./helpers";
import { call, callBody, callText } from "./http";
import { parseYamlover } from "../../parser/ts/src/yamlover.ts";

type Handler = Parameters<typeof callText>[0];

const LEGACY_DOC = "title: L\nyo:\n  fragments:\n    f1:\n      type: text\n      exact: hi\n";
const DOT_DOC = "title: D\n.yo:\n  fragments:\n    f2:\n      type: text\n      exact: ho\n";

async function tree() {
  const h = createHandlers(
    tmpTree({
      "legacy.yo": LEGACY_DOC,
      "dot.yo": DOT_DOC,
      "d/a.yo": "alpha\n",
      "d/.yo/body.yo": 'a.yo: !!<format: text/plain>\n',
      ".yo/settings.yo": "!!<*yamlover:$defs:config>\ntags: *:: ontos\n",
      "pos.yo": ".first: hidden\nsecond: visible\n",
    }),
    { gitignore: false },
  );
  await h.ready;
  return h as unknown as Handler;
}

/** Lift an envelope's header keys into plain JS (the yamlover wire parses as one mapping). */
async function header(h: Handler, slashPath: string): Promise<{ status: number; [k: string]: unknown }> {
  const r = await callText(h, `/api/content/${slashPath}`, {});
  if (r.status !== 200) return { status: r.status };
  const doc = parseYamlover(r.text, "<envelope>");
  const out: Record<string, unknown> = { status: 200 };
  for (const e of doc.root.entries ?? []) {
    const v = e.value as { value?: unknown };
    if (typeof e.key === "string" && "value" in v) out[e.key] = v.value;
  }
  return out as { status: number };
}

describe("the overlay law — direct browse is dumb, edits refuse", () => {
  it("a fragment node serves with `special: overlay`, in BOTH overlay spellings", async () => {
    const h = await tree();
    const legacy = await header(h, "legacy.yo/yo/fragments/f1");
    expect(legacy.status).toBe(200);
    expect(legacy.special).toBe("overlay");
    const dot = await header(h, "dot.yo/.yo/fragments/f2");
    expect(dot.status).toBe(200);
    expect(dot.special).toBe("overlay");
    // the host documents themselves are ordinary
    expect((await header(h, "legacy.yo")).special).toBeUndefined();
  });

  it(".yo/body.yo browses as a DUMB raw-source node (fileText), read-only", async () => {
    const h = await tree();
    const r = await callText(h, "/api/content/d/.yo/body.yo", {});
    expect(r.status).toBe(200);
    expect(r.text).toContain("special: overlay");
    expect(r.text).toContain("fileText: true"); // the whole-file text-scalar law — never a second parse
    const edit = await callBody(h as never, "POST", "/api/edit", { path: ":d:.yo:body.yo", op: "emplace", yamlover: '"clobber"' });
    expect(edit.status).toBe(400);
  });

  it("settings.yo is the carve-out: browsable WITHOUT `special`, and still editable", async () => {
    const h = await tree();
    const s = await header(h, ".yo/settings.yo");
    expect(s.status).toBe(200);
    expect(s.special).toBeUndefined();
  });

  it("/api/edit refuses the `.yo` subtree in both spellings; ordinary hidden dot-keys stay editable", async () => {
    const h = await tree();
    for (const p of [":legacy.yo:yo:fragments:f1", ":legacy.yo:yo", ":dot.yo:.yo:fragments:f2:exact"]) {
      const r = await callBody(h as never, "POST", "/api/edit", { path: p, op: "emplace", yamlover: '"x"' });
      expect(r.status, p).toBe(400);
      expect(String(r.json?.error ?? "")).toContain("engine-managed");
    }
    // a GENERIC dot-key is hidden but not special — the user's own data, editable as ever
    const ok = await callBody(h as never, "POST", "/api/edit", { path: ":pos.yo:.first", op: "emplace", yamlover: '"still mine"' });
    expect(ok.status).toBe(200);
  });

  it("/api/rekey and /api/mv refuse inside the overlay subtree", async () => {
    const h = await tree();
    const rekey = await callBody(h as never, "POST", "/api/rekey", { path: ":legacy.yo:yo:fragments:f1", key: "f9" });
    expect(rekey.status).toBe(400);
    const mv = await callBody(h as never, "POST", "/api/mv", { from: ":d:.yo:body.yo", to: ":d:stolen.yo" });
    expect(mv.status).toBe(400);
  });

  it("a generic dot-key is hidden yet directly browsable; a position never aliases onto it", async () => {
    const h = await tree();
    const direct = await header(h, "pos.yo/.first");
    expect(direct.status).toBe(200); // hidden, not secret
    // the TOC omits it (the hidden flag prunes at the store level)
    const treeJson = call(h as never, "/api/tree", { path: ":pos.yo", depth: "2" }).json;
    expect((treeJson.children ?? []).map((c: { label: string }) => c.label)).not.toContain(".first");
    // canonSegs refuses to alias a POSITION onto a hidden member — `[0]` never lands on `.first`
    const alias = await callText(h, "/api/content/pos.yo[0]", {});
    expect(alias.status).toBe(404);
  });

  it("a POINTER-SHAPED query reaches hidden nodes (the breadcrumb's explicit-entry door); searches keep hiding", async () => {
    const h = await tree();
    // the breadcrumb's Enter runs shape=filter over the typed cells — an explicitly spelled
    // hidden key must match and navigate, in BOTH overlay spellings and for generic dot-keys
    for (const q of [": d: .yo", ": legacy.yo: yo", ": pos.yo: .first", ": d: .yo: body.yo"]) {
      const r = call(h as never, "/api/query", { q, shape: "filter" });
      expect(r.json.matches, q).toHaveLength(1);
    }
    // a SEARCH never surfaces them: the same nodes stay off wildcard results (the shaped
    // branches — the raw results branch has never hidden-filtered, a pre-existing contract)
    const sweep = call(h as never, "/api/query", { q: ": d: ?", shape: "filter" });
    expect(sweep.json.matches).not.toContain(":d:.yo");
    const deep = call(h as never, "/api/query", { q: ": ...: body.yo", shape: "filter" });
    expect(deep.json.matches).toHaveLength(0);
  });

  it("the doctor lists legacy overlay spellings at severity `info`", async () => {
    const h = await tree();
    const { json } = call(h as never, "/api/doctor");
    const legacy = (json.diagnostics as { code: string; severity: string; path?: string }[])
      .filter((d) => d.code === "annotations/legacy-overlay-spelling");
    expect(legacy.length).toBeGreaterThan(0);
    expect(legacy.every((d) => d.severity === "info")).toBe(true);
    expect(legacy.some((d) => d.path === ":legacy.yo:yo")).toBe(true);
    // info never refuses
    expect(json.allowed).toBe(true);
  });
});
