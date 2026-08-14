// THE DERIVATION — the retired `/api/json` NodeJson shape computed CLIENT-SIDE from the
// yamlover wire (content.ts). This is projectValue's twin over the parsed IR + sidecar: the
// ~20 read renderers keep consuming the exact shape they always did, while the server speaks
// only yamlover. Proven equivalent against the live /api/json over the deep-book fixture
// (every node × every depth) while both wires were live; the recorded responses now pin this
// module as THE derivation goldens (test/wire-goldens.test.ts).
//
// The correspondences:
//   - depth: the OLD units (every nesting level; `!top && depth <= 0` cuts) — reproduced
//     exactly, including the depth-0 ≡ depth-1 oddity;
//   - a cut MEMBER's marker is the sidecar stub VERBATIM (linkMarker, server-computed);
//   - a cut INLINE node's marker is minted locally (kind/type/facets/title/count derive from
//     the parsed IR; `concrete` from the enclosing document's interior language);
//   - realized references: `$yamloverRef(refText, refPath)` at unlimited depth, the target's
//     stub at finite depth; unrealized: the authored raw, unlinked;
//   - authored `~` back-edges are NOT content (ownedEntries' rule): dropped from the value,
//     while the sidecar's `backEdges` re-append the INCOMING ones, deduped against own entries;
//   - comments come from the SHARED collectComments over the parsed source (the same module
//     the server used), `$head` restamped by content.ts.

import { isPointer, type Entry, type Node } from "../../../parser/ts/src/ir.ts";
import { collectComments } from "../projection-comments.js";
import { interiorOf, isDirConcrete, type FileConcrete } from "../concrete.js";
import { segsToStr, strToSegs, type Seg } from "./paths";
import type { Content, SideBucket } from "./content";
import type { NodeJson } from "./api";

const MIX = "$yamloverMixed";
const LINK = "$yamloverLink";
const REF = "$yamloverRef";
const NUM = "$yamloverNum";
const TAG_FORMAT = "x-yamlover-tag";

const wireScalar = (v: unknown): unknown =>
  typeof v === "number" && !Number.isFinite(v) ? { [NUM]: String(v) } : v;

const scalarType = (v: unknown): string =>
  v === null ? "null" : typeof v === "boolean" ? "boolean" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : "string";

/** The inlined language INSIDE a document of concrete `c` (concreteOf's interior rule). */
const innerConcrete = (c: string): string => {
  if (isDirConcrete(c)) return "yamlover";
  if (c.startsWith("file/")) return c === "file/binary" ? "yamlover" : interiorOf(c as FileConcrete);
  return c; // already an inlined language
};

/** One rendered own entry of a node — the shared indexing: `frag` counts every rendered entry
 *  except authored `~` back-edges (collectComments' rule, mirrored by the envelope builder);
 *  `pathSeg` uses the FULL entries index (the store's addressing basis, irNodeAt's rule). */
interface Own {
  e: Entry;
  frag: string;
  pathSeg: Seg;
  bucket: SideBucket;
  back: boolean;
}

function ownEntriesOf(node: Node, frag: string, side: Record<string, SideBucket>): Own[] {
  const out: Own[] = [];
  let rendered = 0;
  (node.entries ?? []).forEach((e: Entry, srcIdx: number) => {
    const back = (e as { edge?: string }).edge === "back";
    const idx = rendered;
    if (!back) rendered++;
    const nullKey = (e as { nullKey?: boolean }).nullKey === true;
    const tok = e.key !== null ? String(e.key) : nullKey ? "~" : String(idx);
    const f = `${frag}/${encodeURIComponent(tok)}`;
    const bucket = side[f] ?? {};
    const pathSeg: Seg = bucket.anchorKey ?? (e.key !== null ? e.key : nullKey ? null : srcIdx);
    out.push({ e, frag: f, pathSeg, bucket, back });
  });
  return out;
}

type Kind = "object" | "array" | "scalar" | "binary" | "omni" | "mix";

/** displayKind's twin over the parsed IR: anchored membership comes from the sidecar. */
function kindOf(node: Node, own: Own[]): Kind {
  const hasSelf = node.kind === "scalar";
  if (hasSelf) return own.length ? "omni" : "scalar";
  if (own.length === 0) return (node as { array?: boolean }).array ? "array" : "object";
  if ((node as { array?: boolean }).array) return "array";
  // the STORE's rule: a NULL-KEYED entry has a null label, so it counts KEYLESS here (it
  // still renders `~: v` and addresses by `~` — kind and addressing are separate axes)
  const anchoredAny = own.some((o) => o.bucket.anchorKey !== undefined);
  const ordinal = (o: Own): boolean => o.e.key === null || o.bucket.anchorKey !== undefined;
  if (anchoredAny) return own.some((o) => !ordinal(o)) ? "mix" : "array";
  return own.some((o) => o.e.key === null) ? "mix" : "object";
}

const typeNameOf = (k: Kind, self: unknown): string =>
  k === "scalar" ? scalarType(self) : k === "mix" ? "kseq" : k;

function facetsOf(node: Node, own: Own[]): { valueType: string | null; hasKeyed: boolean; hasOrdinal: boolean } {
  const ordinal = (o: Own): boolean => o.e.key === null || o.bucket.anchorKey !== undefined; // null label = keyless (the store's rule)
  return {
    valueType: node.kind === "scalar" ? scalarType((node as { value?: unknown }).value) : node.kind === "blob" ? "binary" : null,
    hasKeyed: own.some((o) => !ordinal(o)),
    hasOrdinal: own.some(ordinal),
  };
}

/** titleOf's twin: a chapter/task's own self-value, else the keyed `title` scalar child. */
function titleOfLocal(node: Node, format: string | undefined, own: Own[]): string | undefined {
  const self = (node as { value?: unknown }).value;
  if ((format === "x-yamlover-chapter" || format === "x-yamlover-task") && node.kind === "scalar" && self != null) return String(self);
  const t = own.find((o) => o.e.key === "title" && !o.back);
  if (t && !isPointer(t.e.value)) {
    const v = (t.e.value as { value?: unknown }).value;
    const leaf = (t.e.value as Node).kind === "scalar";
    if (leaf && v != null) return String(v);
  }
  return undefined;
}

/** A cut INLINE node's link marker, minted locally (a cut MEMBER splices its server stub). */
function mintLink(node: Node, segs: Seg[], own: Own[], bucket: SideBucket, dc: string): Record<string, unknown> {
  const nonBack = own.filter((o) => !o.back);
  const k = kindOf(node, nonBack);
  const self = (node as { value?: unknown }).value;
  const info: Record<string, unknown> = {
    kind: k,
    type: typeNameOf(k, self),
    ...facetsOf(node, nonBack),
    path: segsToStr(segs),
  };
  const format = bucket.format;
  if (format) info.format = format;
  if ((node.meta as { yo?: boolean } | undefined)?.yo === true) info.yo = true;
  info.concrete = dc;
  const title = titleOfLocal(node, format, nonBack);
  if (title) info.title = title;
  if (k === "scalar") info.value = wireScalar(self);
  else if (k === "omni" || k === "mix") {
    info.count = nonBack.length;
    if (k === "omni") info.value = wireScalar(self);
  } else {
    info.count = nonBack.length;
  }
  if (format === TAG_FORMAT) {
    const c = nonBack.find((o) => o.e.key === "color");
    const cv = c && !isPointer(c.e.value) ? (c.e.value as { value?: unknown }).value : undefined;
    if (typeof cv === "string") info.color = cv;
  }
  return { [LINK]: info };
}

const refMarker = (text: string, path: string | null): Record<string, unknown> => ({ [REF]: { text, path } });

interface Ctx {
  side: Record<string, SideBucket>;
}

/** projectValue's twin. `dc` = the inlined language at this node (for minted markers). */
function deriveValue(node: Node, frag: string, segs: Seg[], depth: number, top: boolean, dc: string, ctx: Ctx): unknown {
  const bucket = ctx.side[frag] ?? {};
  const own = ownEntriesOf(node, frag, ctx.side);
  const nonBack = own.filter((o) => !o.back);
  const k = kindOf(node, nonBack);
  if (!top && depth <= 0) {
    return bucket.stub ?? mintLink(node, segs, own, bucket, dc);
  }

  const project = (o: Own): unknown => {
    if (isPointer(o.e.value)) {
      // a CUT MEMBER document (the envelope's depth boundary): its pointer spelling carries
      // the member's linkMarker stub — and a member this deep is past the OLD depth too
      // (document depth ≤ nesting depth), so the stub is the marker at every old depth
      if ((o.bucket.anchorKey !== undefined || o.bucket.member === true) && o.bucket.stub) return o.bucket.stub;
      const raw = (o.e.value as { raw?: string }).raw ?? "";
      if (o.bucket.refPath === undefined) return refMarker(raw, null); // unrealized — authored text, unlinked
      return depth === Infinity
        ? refMarker(o.bucket.refText ?? raw, o.bucket.refPath)
        : (o.bucket.target ?? refMarker(o.bucket.refText ?? raw, o.bucket.refPath));
    }
    const child = o.e.value as Node;
    const childDc = o.bucket.anchorKey !== undefined || o.bucket.member === true
      ? innerConcrete(String((o.bucket.stub as { $yamloverLink?: { concrete?: string } } | undefined)?.$yamloverLink?.concrete ?? dc))
      : dc;
    return deriveValue(child, o.frag, [...segs, o.pathSeg], depth - 1, false, childDc, ctx);
  };

  // SET semantics: an element appears at most once — dedup own refs by (label, target/raw)
  let entries = nonBack;
  const isSet = (node.meta as { set?: boolean } | undefined)?.set === true;
  const relKey = (label: string | null, to: string): string => `${label ?? ""} ${to}`;
  const ownKey = (o: Own): string =>
    relKey(o.e.key, isPointer(o.e.value) ? (o.bucket.refPath ?? (o.e.value as { raw?: string }).raw ?? "") : segsToStr([...segs, o.pathSeg]));
  if (isSet) {
    const kept = new Set<string>();
    entries = entries.filter((o) => { const key = ownKey(o); if (kept.has(key)) return false; kept.add(key); return true; });
  }

  // the sidecar's INCOMING `~` pseudo-entries, deduped against own (downstreamEntries' rule:
  // labeled backs — and every back under set semantics — dedup by (label, other end))
  const seen = new Set(entries.map(ownKey));
  const appended = (bucket.backEdges ?? []).filter((be) => {
    if (be.label == null && !isSet) return true;
    const key = relKey(be.label, be.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const projectBack = (be: NonNullable<SideBucket["backEdges"]>[number]): unknown =>
    depth === Infinity ? refMarker(be.text, be.path) : (be.stub ?? refMarker(be.text, be.path));

  const anchoredAny = nonBack.some((o) => o.bucket.anchorKey !== undefined);
  const format = bucket.format;

  if (k === "array" && !format && !anchoredAny) {
    return [...entries.map(project), ...appended.map(projectBack)];
  }
  if (k === "omni" || k === "mix" || k === "array") {
    const list = [
      ...entries.map((o) => ({
        key: o.bucket.anchorKey ?? o.e.key,
        value: project(o),
        ...(o.bucket.anchorKey !== undefined ? { anchor: true } : {}),
        ...((o.e as { nullKey?: boolean }).nullKey === true ? { keyNull: true } : {}),
      })),
      ...appended.map((be) => ({ key: be.label, value: projectBack(be) })),
    ];
    const marker: Record<string, unknown> = { kind: k, entries: list };
    if (format) marker.format = format;
    if ((node.meta as { yo?: boolean } | undefined)?.yo === true) marker.yo = true;
    if (k === "omni") {
      marker.value = wireScalar((node as { value?: unknown }).value);
      const selfAt = (node.meta as { selfAt?: number } | undefined)?.selfAt;
      if (typeof selfAt === "number") marker.selfAt = selfAt;
    }
    return { [MIX]: marker };
  }
  if (k === "object") {
    const out: Record<string, unknown> = {};
    for (const o of entries) out[o.e.key ?? String(o.pathSeg)] = project(o);
    for (const be of appended) out[be.label ?? ""] = projectBack(be);
    return out;
  }
  return wireScalar((node as { value?: unknown }).value);
}

/** The old wire, derived: `fetchNode(path, depth)`'s NodeJson from one /api/content fetch. */
export function deriveNodeJson(content: Content, oldDepth?: number | null): NodeJson {
  const h = content.header;
  const concrete = String(h.concrete ?? "yamlover");
  const isBinaryTop = h.type === "binary";
  const depth =
    oldDepth === undefined
      ? (isBinaryTop || isDirConcrete(concrete) ? 1 : Infinity)
      : oldDepth === null
        ? Infinity
        : oldDepth;
  const segs = strToSegs(String(h.path ?? ":"));
  // THE EMPTINESS TWIN: an empty document rides the wire as empty TEXT (the envelope's
  // emptiness law) and parses to a raw-less null scalar; the old wire projected a bodyless
  // OBJECT root (a bare dir) as `{}` — keep the derivation byte-compatible with it
  const r = content.doc.root as { kind?: string; value?: unknown; raw?: string; entries?: unknown[] };
  const emptyRoot = r.kind === "scalar" && r.value === null && (r.raw ?? "") === "" && !(r.entries ?? []).length;
  const value = isBinaryTop
    ? { size: h.size, format: h.format ?? null }
    : emptyRoot && h.type === "object"
      ? {}
      : h.valueType === "binary"
        ? blobOmniValue(content, segs, depth, concrete)
        : deriveValue(content.doc.root, "", segs, depth, true, innerConcrete(concrete), { side: content.side });
  return {
    path: String(h.path ?? ":"),
    type: String(h.type ?? "object"),
    format: (h.format ?? null) as string | null,
    valueType: (h.valueType ?? null) as never,
    hasKeyed: Boolean(h.hasKeyed),
    hasOrdinal: Boolean(h.hasOrdinal),
    concrete,
    documentPath: String(h.documentPath ?? String(h.path ?? ":")),
    title: (h.title ?? null) as string | null,
    description: (h.description ?? null) as string | null,
    ...(h.parseError ? { parseError: h.parseError as NodeJson["parseError"] } : {}),
    value,
    comments: isBinaryTop ? {} : (deriveComments(content, depth) as NodeJson["comments"]),
    relations: content.relations as NodeJson["relations"],
  } as NodeJson;
}

/** The blob-backed OMNI (an image carrying overlay entries — fragments/annotations): the old
 *  wire spelled it as an omni marker whose SELF-VALUE is the navigable binary link
 *  (binaryValueMarker) with the overlay entries alongside. The wire carries only the entries
 *  (bytes have no text form); the self is minted here from the header facets. */
function blobOmniValue(content: Content, segs: Seg[], depth: number, concrete: string): unknown {
  const h = content.header;
  const self: Record<string, unknown> = { kind: "binary", type: "blob", path: segsToStr(segs), size: h.size };
  if (h.format != null) self.format = h.format;
  const derived = deriveValue(content.doc.root, "", segs, depth, true, innerConcrete(concrete), { side: content.side });
  const m = (derived as Record<string, { entries?: unknown[] }> | null)?.[MIX];
  const entries = m?.entries
    ?? (Array.isArray(derived)
      ? derived.map((value) => ({ key: null, value }))
      : derived !== null && typeof derived === "object"
        ? Object.entries(derived as Record<string, unknown>).map(([key, value]) => ({ key, value }))
        : []);
  const marker: Record<string, unknown> = { kind: "omni", entries };
  if (h.format != null) marker.format = h.format;
  marker.value = { [LINK]: self };
  return { [MIX]: marker };
}

/** collectComments over the parsed source — minus the artifacts of the wire's own spelling:
 *  a CUT member serializes as a pointer line, which the collector would record as an authored
 *  `pointer` bucket, but on the old wire (and in the merged IR) that entry is a CONTAIN
 *  member with no pointer token at all. */
function deriveComments(content: Content, depth: number): Record<string, unknown> {
  const out = collectComments(content.doc, [], depth) as Record<string, Record<string, unknown> | string[]>;
  for (const [frag, bucket] of Object.entries(content.side)) {
    if (bucket.anchorKey === undefined && bucket.member !== true) continue;
    const b = out[frag];
    const entryFields = b && !Array.isArray(b) ? { ...b } : {};
    delete (entryFields as { pointer?: string }).pointer; // the wire's cut spelling, not authored
    // …and the member's own node decorations, pruned with its content, ride the sidecar back in
    const merged = { ...entryFields, ...(bucket.deco ?? {}) };
    if (Object.keys(merged).length > 0) out[frag] = merged;
    else delete out[frag];
  }
  // THE KEY REMAP: an anchored member serializes KEYLESS in the source, so the collector keyed
  // its buckets by INDEX — but the old wire (and every fragment consumer) addresses members by
  // their KEY. Rewrite each fragment segment through the sidecar's anchorKey table.
  const remap = (key: string): string => {
    if (!key.startsWith("/")) return key; // $head / $tail / ""
    const toks = key.slice(1).split("/");
    let prefix = "";
    const outToks: string[] = [];
    for (const tok of toks) {
      prefix = `${prefix}/${tok}`;
      const ak = content.side[prefix]?.anchorKey;
      outToks.push(ak !== undefined ? encodeURIComponent(ak) : tok);
    }
    return "/" + outToks.join("/");
  };
  const renamed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(out)) renamed[remap(k)] = v;
  return renamed;
}
