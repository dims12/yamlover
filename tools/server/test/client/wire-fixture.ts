// TEST FIXTURE ADAPTER — the retired yed-load, kept ONLY as a fixture bridge: suites that
// hand-build legacy NodeJson wire shapes convert them to the Content the mounts now load
// (contentFromNodeJson). Production loads irFromContent (yed-content-load.ts) instead.
// THE (RETIRED) YED LOADER — NodeJson (the /api/json projection, depth `.inf`) → parser IR. This is what
// makes the yed mount CONCRETE-AGNOSTIC: the projection exists for EVERY node the engine serves
// (flat files, dir-backed documents, bare directories, .yaml bodies, deep positional nodes), so
// the editor never asks how a node is stored — the backend's concrete-inheritance rules answer
// that on WRITE (concrete-rules.ts), per op.
//
// The wire carries the full graph: `$yamloverMixed` (omni/mix + `selfAt`), `$yamloverRef`
// (+ the sidecar's canonical `pointer` text), and the COMMENT SIDECAR carries all
// representation — authored scalar spellings (`raw`, sparse: absent means the default),
// one-line flow (`repr: "yaml/flow"`), the K&R switch (`concrete: "json5p"`, at the switch
// only), tags (`meta.schema`), `!!yo`/`!!set`, and the node's `&` anchors — ALL carried into
// the IR (the identity-meta round), so the serializer re-emits them and a whole-subtree
// payload never strips them; ops that omit `meta` still preserve the tag server-side.
//
// COMMENTS and blank lines are carried too (this round): `leading`/`trailing` land on the
// entry's meta, `tail`/`valueTrailing` on the node's meta, `$head` on `Document.head` — in the
// parser-IR shapes, so the cells can DISPLAY them and they move with their nodes through every
// edit. They are display-only carriage: the diff layer never reads them (canon is comment-
// blind) and payloads strip them before serializing, so no op is ever emitted for a comment.

import type { NodeJson, CommentBucket, CommentMap } from "../../src/client/api";
import type { Comment } from "../../../parser/ts/src/ir.ts";
import type { Document, Entry, Node, Value } from "../../../yed/src/state";
import { makeAnchor, parsePointer } from "../../../parser/ts/src/pointer.ts";
import { segToken } from "../../../parser/ts/src/pathseg.ts";
import { parseSchemaRef } from "../../../parser/ts/src/yamlover.ts";
import type { Pointer } from "../../../parser/ts/src/ir.ts";
import { formatFromMetaTag, proseFormatOfTag } from "../../../yed/src/chapter/format";

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

/** A wire comment text as a parser-IR Comment. The span is FABRICATED (the wire carries none;
 *  nothing on the yed path reads spans) — text and placement are the faithful parts. */
const wireComment = (text: string, placement: "leading" | "trailing"): Comment =>
  ({ text, span: { uri: "<wire>", start: 0, end: 0 }, placement, style: "line" });

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
 *  `!!set` and the `&` path anchors ride the IR too (the identity-meta round): the serializer
 *  re-emits them, so a whole-subtree payload no longer silently strips them, and the editor
 *  shows them as chrome. */
function metaFrom(bucket: CommentBucket, extra?: Record<string, unknown>, wireFormat?: string | null): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = { ...(extra ?? {}) };
  if (bucket.repr === "yaml/flow") meta.style = "flow";
  if (bucket.concrete !== undefined && bucket.concrete !== null && bucket.concrete !== "yamlover") meta.concrete = bucket.concrete;
  // the `!!yo` plain-yamlover mark (sidecar `tag`): carried into the IR so chunkModeOf routes
  // the node to an inline SOURCE cell — a data island, never a folded subchapter
  if (bucket.tag && /(^|\s)!!yo(\s|$)/.test(bucket.tag)) meta.yo = true;
  if (bucket.tag && /(^|\s)!!set(\s|$)/.test(bucket.tag)) meta.set = true;
  const inner = tagInner(bucket.tag);
  if (inner !== null) {
    try { meta.schema = parseSchemaRef(inner); } catch { /* a malformed authored tag stays sidecar-only, as before */ }
  }
  // the node's own `&` anchors, parsed back from their sidecar BODIES (renderPointer-canonical,
  // so the round-trip is exact); a body makeAnchor refuses loads as nothing, never a throw
  if (bucket.anchors && bucket.anchors.length > 0) {
    const anchors = [];
    for (const b of bucket.anchors) {
      try { anchors.push(makeAnchor(b, (m: string) => { throw new Error(m); })); } catch { /* unparseable body stays sidecar-only */ }
    }
    if (anchors.length > 0) meta.anchors = anchors;
  }
  const fmt = wireFormat ?? formatFromMetaTag(inner) ?? proseFormatOfTag(inner);
  if (fmt != null) meta.derivedFormat = fmt;
  // the node's OWN comments — the container's tail block (comments after the last entry) and
  // an omni's value-trailing remark — in the parser's shapes, display-only carriage
  const own: Comment[] = [
    ...(bucket.tail ?? []).map((t) => wireComment(t, "leading")),
    ...(bucket.valueTrailing ?? []).map((t) => wireComment(t, "trailing")),
  ];
  if (own.length > 0) meta.comments = own;
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
    // the SERVER-resolved target rides along (a non-IR extension read by the ↗ affordance;
    // canon/serialize ignore it, and a retarget replaces the value wholesale — never stale)
    const nav = ref.path !== null ? { refPath: ref.path } : {};
    try {
      return { ...parsePointer(text), raw: text, ...nav } as unknown as Pointer;
    } catch {
      return { kind: "pointer", raw: text, ...nav } as unknown as Value; // dangling spelling, kept verbatim
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
    // the entry's DECORATIONS from its bucket: leading/trailing comments + the blank line —
    // display-only carriage (the diff layer never reads entry meta)
    const bucket = bucketAt(comments, childFrag);
    const entryComments: Comment[] = [
      ...(bucket.leading ?? []).map((t) => wireComment(t, "leading")),
      ...(bucket.trailing ?? []).map((t) => wireComment(t, "trailing")),
    ];
    const entryMeta = {
      ...(e.anchor === true && e.key != null ? { anchorKey: e.key } : {}),
      ...(entryComments.length > 0 ? { comments: entryComments } : {}),
      ...(bucket.blankBefore === true ? { blankBefore: true } : {}),
    };
    return {
      key: keyless ? null : e.key,
      edge: "contain",
      value,
      ...(Object.keys(entryMeta).length > 0 ? { meta: entryMeta } : {}),
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
  // the FILE BANNER (`$head`) and the unplaced leftovers (`$tail`) — Document.head and the
  // root's own comment meta, mirroring collectComments' inverse
  const doc = { root, source: { concrete: node.concrete ?? "yamlover", uri: node.path } } as unknown as Document;
  const head = node.comments?.$head;
  if (Array.isArray(head) && head.length > 0) (doc as { head?: Comment[] }).head = head.map((t) => wireComment(t, "leading"));
  const tail = node.comments?.$tail;
  if (Array.isArray(tail) && tail.length > 0 && (root as { kind?: string }).kind !== "pointer") {
    const n = root as Node & { meta?: Record<string, unknown> };
    const prior = ((n.meta?.comments as Comment[] | undefined) ?? []);
    n.meta = { ...(n.meta ?? {}), comments: [...prior, ...tail.map((t) => wireComment(t, "leading"))] };
  }
  return doc;
}

import type { Content } from "../../src/client/content";

/** Route a suite's mocked `fetchContent` through its `fetchNode` mock — the ONE-WIRE mounts
 *  load Content, the fixtures stay NodeJson, and whatever `fetchNode` currently resolves is
 *  what the mount sees. Install as `fetchContent.mockImplementation(contentViaNode(fetchNode))`. */
export const contentViaNode = (fetchNode: (path: string, depth: number | null) => Promise<unknown>) =>
  async (path: string, depth: number | null): Promise<Content> =>
    contentFromNodeJson((await fetchNode(path, depth)) as NodeJson);

/** A legacy NodeJson fixture as the Content the mounts consume: the IR is fully stamped
 *  here (anchorKey/link/derivedFormat), so the loader's sidecar pass is a no-op. */
export function contentFromNodeJson(node: NodeJson): Content {
  const doc = irFromNodeJson(node);
  return {
    header: {
      path: node.path, documentPath: node.documentPath ?? node.path, type: node.type,
      format: node.format ?? null, valueType: node.valueType ?? null,
      hasKeyed: node.hasKeyed ?? false, hasOrdinal: node.hasOrdinal ?? false,
      concrete: node.concrete ?? "yamlover", title: node.title, description: node.description,
      ...(node.parseError ? { parseError: node.parseError } : {}),
    },
    doc,
    side: {},
    relations: (node.relations ?? {}) as Content["relations"],
  };
}
