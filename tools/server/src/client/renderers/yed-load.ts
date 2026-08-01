// THE YED LOADER — NodeJson (the /api/json projection, depth `.inf`) → parser IR. This is what
// makes the yed mount CONCRETE-AGNOSTIC: the projection exists for EVERY node the engine serves
// (flat files, dir-backed documents, bare directories, .yaml bodies, deep positional nodes), so
// the editor never asks how a node is stored — the backend's concrete-inheritance rules answer
// that on WRITE (concrete-rules.ts), per op.
//
// The wire carries the full graph: `$yamloverMixed` (omni/mix + `selfAt`), `$yamloverRef`
// (+ the sidecar's canonical `pointer` text), and the COMMENT SIDECAR carries all
// representation — authored scalar spellings (`raw`, sparse: absent means the default),
// one-line flow (`repr: "yaml/flow"`), the K&R switch (`concrete: "json5p"`, at the switch
// only), tags/anchors/set (READ-ONLY here: yed does not edit them; ops that omit `meta`
// preserve the tag server-side), and the comments themselves (carried into meta for fidelity;
// the diff layer never rewrites untouched regions, so they survive on disk).

import type { NodeJson, CommentBucket, CommentMap } from "../api";
import type { Document, Entry, Node, Value } from "../../../../yed/src/state";
import { parsePointer } from "../../../../parser/ts/src/pointer.ts";
import { segToken } from "../../../../parser/ts/src/pathseg.ts";
import { parseSchemaRef } from "../../../../parser/ts/src/yamlover.ts";
import type { Pointer } from "../../../../parser/ts/src/ir.ts";
import { formatFromMetaTag, proseFormatOfTag } from "../../../../yed/src/chapter/format";

const MIXED_KEY = "$yamloverMixed";
const REF_KEY = "$yamloverRef";
const NUM_KEY = "$yamloverNum";
const LINK_KEY = "$yamloverLink";
const BINARY_KEY = "$yamloverBinary";

interface WireMixed {
  kind: "omni" | "mix" | "array";
  value?: unknown;
  selfAt?: number;
  format?: string | null;
  entries: { key: string | null; value: unknown; anchor?: boolean }[];
}

function asSingle<T>(v: unknown, key: string): T | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const keys = Object.keys(v as object);
    if (keys.length === 1 && keys[0] === key) return (v as Record<string, unknown>)[key] as T;
  }
  return null;
}

function bucketAt(comments: CommentMap | undefined, frag: string): CommentBucket {
  const b = comments?.[frag];
  return b && !Array.isArray(b) ? b : {};
}

/** The spelling of a scalar VALUE when the sidecar carries no authored raw — the serializer's
 *  default is fine, so raw is simply omitted (the parser IR tolerates it; serializers spell
 *  the canonical token). */
function scalarNode(value: unknown, bucket: CommentBucket): Node {
  const num = asSingle<string>(value, NUM_KEY);
  const v = num !== null ? (num === "NaN" ? NaN : num === "-Infinity" ? -Infinity : Infinity) : value;
  // NUMBERS always carry a raw (the serializer's number path reads it unguarded); everything
  // else omits an absent raw and the serializer spells the default. The display reads
  // `raw ?? value`, so a raw must never be a placeholder.
  const raw = bucket.raw ?? (num !== null ? (num === "NaN" ? ".nan" : num === "-Infinity" ? "-.inf" : ".inf")
    : typeof v === "number" ? String(v) : undefined);
  return { kind: "scalar", value: v, ...(raw !== undefined ? { raw } : {}) } as unknown as Node;
}

/** The inner text of a sidecar `!!<…>` tag (`bucket.tag` carries the full token, with an
 *  optional trailing `!!set`), or null when there is no schema tag. */
function tagInner(tag: string | undefined): string | null {
  const m = tag ? /^!!<([\s\S]*)>\s*(?:!!yo)?\s*(?:!!set)?$/.exec(tag) : null;
  return m ? m[1] : null;
}

/** Representation meta from a bucket: one-line flow, the K&R switch (NOT propagated — the IR
 *  carries it at the switch only, matching the walk), plus the two FORMAT facts:
 *  - the authored `!!<…>` tag (`bucket.tag`) parsed into the parser IR's own `meta.schema`,
 *    so `sourceOf` re-emits it and a whole-token emplace no longer drops inner tags;
 *  - `meta.derivedFormat` — the engine-derived format when the wire carries one
 *    (`$yamloverMixed.format`, the mount root's `NodeJson.format`), else folded from the tag
 *    the way walk.ts folds it (`$defs: X` → `x-yamlover-X`, inline `format:` verbatim).
 *    This is the key `cellFor` dispatches `byFormat` on.
 *  A trailing `!!set` stays sidecar-only for now (yed reads sets, it does not edit them). */
function metaFrom(bucket: CommentBucket, extra?: Record<string, unknown>, wireFormat?: string | null): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = { ...(extra ?? {}) };
  if (bucket.repr === "yaml/flow") meta.style = "flow";
  if (bucket.concrete !== undefined && bucket.concrete !== null && bucket.concrete !== "yamlover") meta.concrete = bucket.concrete;
  // the `!!yo` plain-yamlover mark (sidecar `tag`): carried into the IR so chunkModeOf routes
  // the node to an inline SOURCE cell — a data island, never a folded subchapter
  if (bucket.tag && /(^|\s)!!yo(\s|$)/.test(bucket.tag)) meta.yo = true;
  const inner = tagInner(bucket.tag);
  if (inner !== null) {
    try { meta.schema = parseSchemaRef(inner); } catch { /* a malformed authored tag stays sidecar-only, as before */ }
  }
  const fmt = wireFormat ?? formatFromMetaTag(inner) ?? proseFormatOfTag(inner);
  if (fmt != null) meta.derivedFormat = fmt;
  return Object.keys(meta).length > 0 ? meta : undefined;
}

/** One wire value → an IR Value, threading the comment sidecar by FRAGMENT (the same fragment
 *  grammar the server's collectComments walks: `/key` for keyed entries — anchored positional
 *  members included — and `[i]` with the ABSOLUTE entry index for keyless ones). */
function valueFrom(value: unknown, frag: string, comments: CommentMap | undefined): Value {
  const bucket = bucketAt(comments, frag);

  if (asSingle<string>(value, NUM_KEY) !== null) return scalarNode(value, bucket); // ±Infinity / NaN

  const ref = asSingle<{ text: string; path: string | null }>(value, REF_KEY);
  if (ref) {
    const text = bucket.pointer ?? ref.text.replace(/^\*/, "");
    try {
      return { ...parsePointer(text), raw: text } as unknown as Pointer;
    } catch {
      return { kind: "pointer", raw: text } as unknown as Value; // dangling spelling, kept verbatim
    }
  }
  // a `$yamloverLink` marker — still an ATOM (walkable, deletable, never editable as content,
  // never serialized), but it keeps its navigable payload on `meta.link` so a projection can
  // draw a descend link, and its target's derived format rides `meta.derivedFormat` (a
  // chapter-shaped member draws a heading, not a bare pointer)
  const link = asSingle<{ path: string; title?: string; format?: string | null }>(value, LINK_KEY);
  if (link !== null) {
    const meta = metaFrom(bucket, {
      link: {
        path: link.path,
        ...(link.title != null ? { title: link.title } : {}),
        ...(link.format != null ? { format: link.format } : {}),
      },
    }, link.format);
    return { kind: "blob", entries: [], ...(meta ? { meta } : {}) } as unknown as Node;
  }
  // opaque binaries: an explicit binary payload — an ATOM with no payload to carry
  if (asSingle(value, BINARY_KEY) !== null) {
    return { kind: "blob", entries: [] } as unknown as Node;
  }

  const mixed = asSingle<WireMixed>(value, MIXED_KEY);
  if (mixed) {
    const entries = entriesFrom(mixed.entries, frag, comments);
    if (mixed.kind === "omni") {
      const self = scalarNode(mixed.value, bucket);
      const selfAt = Math.min(mixed.selfAt ?? 0, entries.length);
      const meta = metaFrom(bucket, selfAt > 0 ? { selfAt } : undefined, mixed.format);
      return { ...self, entries, ...(meta ? { meta } : {}) } as unknown as Node;
    }
    const array = mixed.entries.length > 0 && mixed.entries.every((e) => e.key === null);
    const meta = metaFrom(bucket, undefined, mixed.format);
    return { kind: "mapping", entries, ...(array ? { array: true } : {}), ...(meta ? { meta } : {}) } as unknown as Node;
  }

  if (Array.isArray(value)) {
    const entries = entriesFrom(value.map((v) => ({ key: null, value: v })), frag, comments);
    const meta = metaFrom(bucket);
    return { kind: "mapping", entries, array: true, ...(meta ? { meta } : {}) } as unknown as Node;
  }
  if (value !== null && typeof value === "object") {
    const entries = entriesFrom(Object.entries(value as Record<string, unknown>).map(([k, v]) => ({ key: k, value: v })), frag, comments);
    const meta = metaFrom(bucket);
    return { kind: "mapping", entries, ...(meta ? { meta } : {}) } as unknown as Node;
  }

  const meta = metaFrom(bucket);
  const s = scalarNode(value, bucket);
  return (meta ? { ...s, meta } : s) as Value;
}

function entriesFrom(
  wire: { key: string | null; value: unknown; anchor?: boolean }[],
  frag: string,
  comments: CommentMap | undefined,
): Entry[] {
  return wire.map((e, i) => {
    // an ANCHORED positional member is drawn keyless but ADDRESSED by its derived key — the
    // wire key rides the entry meta for the diff layer, the projection stays positional
    const keyless = e.key === null || e.anchor === true;
    const childFrag = `${frag}/${segToken(e.key != null ? e.key : i)}`;
    const value = valueFrom(e.value, childFrag, comments);
    return {
      key: keyless ? null : e.key,
      edge: "contain",
      value,
      ...(e.anchor === true && e.key != null ? { meta: { anchorKey: e.key } } : {}),
    } as unknown as Entry;
  });
}

/** The projection → a parser-IR Document the yed editor owns in memory. */
export function irFromNodeJson(node: NodeJson): Document {
  // a top-level blob without `?binary=1` projects as a bare `{size, format}` OBJECT — do not
  // read it as data (the editor refuses to mount a binary; NodeView's gate already does)
  if (node.valueType === "binary") {
    return { root: { kind: "blob", entries: [] }, source: { concrete: node.concrete ?? "yamlover", uri: node.path } } as unknown as Document;
  }
  const root = ((): Value => {
    // the EMPTY document projects as a null value with no authored raw — an empty container,
    // not a null scalar (the same rule the legacy model applies)
    const bucket = bucketAt(node.comments, "");
    if (node.value === null && bucket.raw === undefined) {
      return { kind: "mapping", entries: [] } as unknown as Node;
    }
    return valueFrom(node.value, "", node.comments);
  })();
  // the mount root's ENGINE-derived format (`NodeJson.format`, the top-level twin of
  // `$yamloverMixed.format`) — it already folded the authored tag and the enclosing schema,
  // so where both could speak it wins (the ir.ts `derivedFormat` doctrine)
  if (node.format != null && (root as { kind?: string }).kind !== "pointer") {
    const n = root as Node & { meta?: Record<string, unknown> };
    n.meta = { ...(n.meta ?? {}), derivedFormat: node.format };
  }
  return { root, source: { concrete: node.concrete ?? "yamlover", uri: node.path } } as unknown as Document;
}
