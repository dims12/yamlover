// THE CONTENT CLIENT — fetch + decode the yamlover wire (`GET /api/content/{slash-path}`).
// ONE parse produces everything a consumer needs: the envelope facets (header / side /
// relations) and the SOURCE parsed into the shared parser IR — the single representation
// the editors edit and the renderers derive their views from (derive-node.ts).

import { parseYamlover } from "../../../parser/ts/src/yamlover.ts";
import { isPointer, type Document, type Node, type Value } from "../../../parser/ts/src/ir.ts";
import { api } from "./base";
import { strToSegs, segsToStr } from "./paths";

/** One sidecar bucket — what the authored text cannot say (content-envelope.ts's twin). */
export interface SideBucket {
  anchorKey?: string;
  member?: true;
  format?: string;
  fileText?: true;
  refPath?: string;
  refText?: string;
  target?: Record<string, unknown>;
  stub?: Record<string, unknown>;
  /** A CUT member's node decorations — the comment bucket its inlined form would carry. */
  deco?: Record<string, unknown>;
  backEdges?: { label: string | null; path: string; text: string; stub: Record<string, unknown> | null }[];
}

export interface Content {
  header: Record<string, unknown>;
  /** The parsed source — root IS the requested subtree (documents merged server-side). */
  doc: Document;
  side: Record<string, SideBucket>;
  relations: Record<string, unknown>;
}

/** Decode one envelope text. Exported for tests and the stateless preview path. */
export function decodeEnvelope(text: string): Content {
  const env = parseYamlover(text, "<envelope>");
  const top = jsOf(env.root) as Record<string, unknown>;
  const sourceText = String(top.source ?? "");
  const doc = parseYamlover(sourceText, "<content>");
  // the walk carries a document's head banner on its ROOT NODE's meta; the wire ships it as
  // the source's own head block — restamp so collectComments' `$head` reads it the walk's way
  if (doc.head?.length) {
    doc.root.meta = { ...doc.root.meta, head: doc.head };
  }
  const sideMap = ((top.side ?? {}) as Record<string, SideBucket>);
  // THE WHOLE-FILE RULE (walk.ts textScalar): the wire spelled a text file's content as a
  // block scalar — transport, not representation. Restore `raw = value` where marked, so the
  // editors and the derivation both see the walker's contract.
  for (const [frag, bucket] of Object.entries(sideMap)) {
    if (bucket.fileText !== true) continue;
    const n = nodeAtFrag(doc.root, frag);
    if (n && n.kind === "scalar" && typeof (n as { value?: unknown }).value === "string") {
      (n as { raw?: string }).raw = (n as { value?: unknown }).value as string;
    }
  }
  const { source: _s, side, relations, ...header } = top;
  return {
    header,
    doc,
    side: (side ?? {}) as Record<string, SideBucket>,
    relations: (relations ?? {}) as Record<string, unknown>,
  };
}

/** GET the envelope for a colon path at an OLD-STYLE depth (`null` = unlimited, `undefined` =
 *  the server's per-concrete default, a number = that many levels — documents are a subset of
 *  levels, so the same number bounds the document depth). */
export async function fetchContent(path: string, depth?: number | null): Promise<Content> {
  const segs = strToSegs(path);
  // the slash spelling: the colon path's percent-encoded tokens joined by `/` (a `:` inside a
  // token is itself percent-encoded, so the split is unambiguous)
  const slash = segsToStr(segs).slice(1).split(":").join("/");
  const q = depth === null ? "?depth=.inf" : depth !== undefined ? `?depth=${depth}` : "";
  const r = await fetch(api(`/api/content${slash ? "/" + slash : ""}${q}`));
  const text = await r.text();
  if (!r.ok) {
    let msg = text;
    try { msg = String((JSON.parse(text) as { error?: string }).error ?? text); } catch { /* raw */ }
    throw new Error(msg);
  }
  return decodeEnvelope(text);
}

/** Resolve a sidecar FRAGMENT over the parsed source — the shared indexing rule: a keyless
 *  token is the index among rendered entries, skipping authored `~` back-edges. */
function nodeAtFrag(root: Node, frag: string): Node | null {
  if (frag === "") return root;
  let node: Node = root;
  for (const tok of frag.slice(1).split("/")) {
    const t = decodeURIComponent(tok);
    let hit: Value | undefined;
    let rendered = 0;
    for (const e of node.entries ?? []) {
      const back = (e as { edge?: string }).edge === "back";
      const nullKey = (e as { nullKey?: boolean }).nullKey === true;
      const key = e.key !== null ? String(e.key) : nullKey ? "~" : String(rendered);
      if (!back) rendered++;
      if (key === t) { hit = e.value; break; }
    }
    if (!hit || isPointer(hit)) return null;
    node = hit as Node;
  }
  return node;
}

/** A parsed envelope FACET as plain JS (the envelope is data, not content — pointers cannot
 *  appear in it except inside `source`, which stays text here). */
function jsOf(v: Value): unknown {
  if (isPointer(v)) return v.raw;
  const n = v as Node & { value?: unknown };
  if (n.kind === "scalar" && (n.entries ?? []).length === 0) return n.value;
  const entries = n.entries ?? [];
  if (entries.length > 0 && entries.every((e) => e.key === null)) return entries.map((e) => jsOf(e.value));
  const out: Record<string, unknown> = {};
  for (const e of entries) out[String(e.key)] = jsOf(e.value);
  return out;
}
