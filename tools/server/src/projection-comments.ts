// THE COMMENT/DECORATION SIDECAR — pure over the parser IR, shared by the SERVER (the legacy
// /api/json projection during the one-wire migration) and the CLIENT (deriving the same
// buckets from the parsed /api/content source). Moved verbatim from engine-api.ts; the only
// dependency beyond the parser is repr.ts (also pure). Comments are typography: none of this
// ever changes a value projection, only annotates it.

import { isPointer } from "../../parser/ts/src/ir.ts";
import type { Node as IrNode, Document, Comment as IrComment } from "../../parser/ts/src/ir.ts";
import { segToken } from "../../parser/ts/src/pathseg.ts";
import { isHiddenEntryKey } from "../../parser/ts/src/overlay-keys.ts";
import { renderPointer } from "../../parser/ts/src/pointer.ts";
import { schemaTagToken } from "../../parser/ts/src/serialize-yamlover.ts";
import { anchorBody } from "../../parser/ts/src/serialize-common.ts";
import { classifyScalar, isDefaultRepr, type BlockQualifiers, type Repr, type ScalarStyle } from "./repr.js";

export type Seg = string | number | null;

/** The comments to show with the value at `segs`, keyed by each node's fragment continuation
 *  FROM THE VIEWED NODE — exactly what the client looks up as `frag.slice(base.length)`. So a
 *  child's leading/trailing comments live under `/key` or `[i]` (i = its index among the node's
 *  RENDERED own entries, matching render.tsx). `$head` is the file banner (only at the served
 *  root); `$tail` is the viewed node's own leftover comments (after its last entry). */
export type CommentBucket = {
  leading?: string[];
  trailing?: string[];
  pointer?: string;      // a ref entry's authored pointer text, canonical colon form (no `*`)
  anchors?: string[];    // the value node's `&` path-anchor bodies (no `&`), source order
  tag?: string;          // the value node's yamlover tags: `!!<…>` schema and/or `!!set` (shape tags are default)
  blankBefore?: boolean;  // a blank source line precedes this entry (or its leading comments)
  valueTrailing?: string[]; // a comment trailing the node's own SELF-VALUE line (an omni `5 # …`)
  tail?: string[];        // a container's LEFTOVER comments — own-line remarks after its last
                          // entry (the parser's tail rule), rendered inside the block
  raw?: string;           // a scalar's authored SOURCE token, carried only when it differs from the
                          // plain decoded form — so `"~"` reads as a string not null, `0xff`/`True`
                          // keep their spelling (docs/language/concretes/04-yaml). A BLOCK
                          // scalar's is the whole authored token: the `|`/`|-`/`>`… header line
                          // plus the de-indented content lines — renderers reproduce it verbatim.
  repr?: string;          // the node's REPRESENTATION concrete (repr.ts) — `yaml/flow` for a
                          // container authored in flow form, `yaml/hex`/`yaml/single`/… for a
                          // scalar. Carried only when it is NOT the default for the value.
  block?: BlockQualifiers; // a literal/folded scalar's chomping / indent indicator, when not clip
  concrete?: string;      // an INLINE CONCRETE SWITCH (`NodeMeta.concrete`) — `json5p` for a flow
                          // token written K&R. Carried only where the switch HAPPENS.
  keyConcrete?: string;   // the ENTRY's key representation (ir.ts EntryMeta.keyConcrete) —
                          // `yamlover/key/flat` when this key was a flat-row segment after the
                          // first. The renderer folds the row because this says the author wrote
                          // one (docs/language/flattening). Sparse: absent means a normal key.
};

export type CommentMap = Record<string, CommentBucket | string[]>;

/** The IR node at client `segs` within an assembled document, or undefined when the path
 *  leaves the contained spine (a pointer / missing key). Keyless segments index the FULL
 *  `entries` array — the same basis the store path uses (graph.ts / resolve.ts: `[i]`). */
export function irNodeAt(doc: Document, segs: Seg[]): IrNode | undefined {
  let node: IrNode = doc.root;
  for (const seg of segs) {
    const entries = node.entries ?? [];
    let val;
    if (typeof seg === "number") {
      const e = entries[seg];
      // a position addresses only a KEYLESS entry — the null-keyed one (`nullKey`) is keyed
      if (!e || e.key !== null || e.nullKey === true || e.edge !== "contain") return undefined;
      val = e.value;
    } else if (seg === null) {
      val = entries.find((en) => en.nullKey === true && en.edge === "contain")?.value;
    } else {
      val = entries.find((en) => en.key === seg && en.edge === "contain")?.value;
    }
    if (!val || isPointer(val)) return undefined;
    node = val;
  }
  return node;
}

/** A scalar's authored source token to render faithfully — but only when it differs from the plain
 *  decoded form (a quoted string, a `~`/word null, a hex/octal int, a `True` casing, `.inf`, …), so
 *  the sidecar stays sparse and a plain `Rex`/`42` carries nothing. A BLOCK scalar's raw (the
 *  authored `|`/`>` header + content lines) is always carried — the representation lives in the
 *  concrete and the renderer must not re-derive it from the chomped value. */
export function scalarRawToken(node: IrNode): string | undefined {
  if (isPointer(node) || node.kind !== "scalar") return undefined;
  const raw = node.raw;
  if (raw == null) return undefined;
  const v = node.value;
  if (raw.includes("\n")) {
    // a block token is carried only for a genuinely MULTILINE value — a one-line `|-` chunk
    // (what tagging produces) normalizes to its inline form instead
    return /^[|>]/.test(raw) && typeof v === "string" && v.includes("\n") ? raw : undefined;
  }
  if (typeof v === "string" && v.includes("\n")) return undefined;
  const plain = v === null ? "null" : String(v); // mirrors the client's default bare rendering
  return raw === plain ? undefined : raw;
}

/** The yamlover type tags a node carries in canonical serialization, or undefined. Mirrors
 *  serialize-yamlover's `decorations`: the `!!<…>` schema tag (a tag APPLICATION — it must not
 *  vanish from the view just because the store routes it as `format`), then `!!yo` (the
 *  plain-yamlover mark) and `!!set` (set semantics). The shape tag `!!mix` is the DEFAULT —
 *  omni-by-default (docs/language/vs-yaml/differences/mixtures) — so it is never shown. */
export function tagOf(n: IrNode): string | undefined {
  const parts: string[] = [];
  if (n.meta?.schema !== undefined) {
    try {
      parts.push(schemaTagToken(n.meta.schema));
    } catch {
      // an inline schema with no one-line form: parsed input always has one, so only a
      // programmatic IR can get here — better an untagged view than a failed page
    }
  }
  if (n.meta?.yo) parts.push("!!yo");
  if (n.meta?.set) parts.push("!!set");
  return parts.length ? parts.join(" ") : undefined;
}

/** An IR node's representation concrete: a scalar classifies from its authored token, a container
 *  from the parser's authored flow bit. The LANGUAGE default (a json-family document is flow end to
 *  end) is deliberately not consulted here — the client already knows the document's concrete. */
export function classifyNodeRepr(node: IrNode): ScalarStyle | { repr: Repr; block?: undefined } | undefined {
  if (node.kind === "scalar") return classifyScalar(node.value, node.raw);
  if (node.kind === "blob") return undefined;
  return node.meta?.style === "flow" ? { repr: "yaml/flow" as const } : undefined;
}

/** Syntax decorations of a value node (anchors, type tag, a self-value trailing comment),
 *  attached to its fragment. */
export function nodeDeco(bucket: CommentBucket, node: IrNode): void {
  const anchors = (node.meta?.anchors ?? []).map(anchorBody);
  if (anchors.length > 0) bucket.anchors = anchors;
  const tag = tagOf(node);
  if (tag) bucket.tag = tag;
  // the REPRESENTATION concrete (repr.ts), one rule for scalars and containers alike: classify,
  // then send only what the default cannot re-derive
  const style = isPointer(node) ? undefined : classifyNodeRepr(node);
  if (style && !isDefaultRepr(style.repr, node.kind === "scalar" ? node.value : undefined)) {
    bucket.repr = style.repr;
    if (style.block) bucket.block = style.block;
  }
  // the inline CONCRETE switch (K&R) — one signal, so it replaces the repr rather than joining it:
  // a json-family concrete already means flow (repr.ts `collectionRepr`)
  const inline = isPointer(node) ? undefined : (node.meta as { concrete?: string } | undefined)?.concrete;
  if (inline) {
    bucket.concrete = inline;
    delete bucket.repr;
  }
  // a comment trailing the node's own SELF-VALUE line (an omni `5 # …`) — placement `trailing`
  // on the node itself (attachComments routes self-value trailers here, not to an entry)
  const vt = (node.meta?.comments ?? []).filter((c) => c.placement === "trailing").map((c) => c.text);
  if (vt.length > 0) bucket.valueTrailing = vt;
}

export function collectComments(
  doc: Document,
  segs: Seg[],
  depth: number,
  // the member test (a real file/dir behind the path) — the HIDDEN-WIRE LAW twin below needs
  // it to drop storage-backed hidden subtrees; callers without storage pass nothing
  memberExists: (segs: Seg[]) => boolean = () => false,
): CommentMap {
  const out: CommentMap = {};
  const root = irNodeAt(doc, segs);
  if (!root) return out;
  { // the viewed node's own anchors / tag / self-value trailing comment / raw token, keyed at ""
    const self: CommentBucket = {};
    nodeDeco(self, root);
    const raw = scalarRawToken(root);
    if (raw) self.raw = raw;
    if (Object.keys(self).length > 0) out[""] = self;
  }
  // $head is the head-of-file banner — shown when the VIEWED node is a document root (the walk
  // carries each document's head onto its root node, so sub-documents surface theirs too).
  const head = (root.meta?.head ?? []).map((c) => c.text);
  if (head.length > 0) out.$head = head;
  // leftover comments after the node's last entry render at the bottom ($tail); a `trailing`
  // one rides the self-value line instead (valueTrailing, via nodeDeco above).
  const tail = (root.meta?.comments ?? []).filter((c) => c.placement === "leading").map((c) => c.text);
  if (tail.length > 0) out.$tail = tail;
  const placed = (cs: IrComment[] | undefined, p: "leading" | "trailing"): string[] =>
    (cs ?? []).filter((c) => c.placement === p).map((c) => c.text);
  const walk = (node: IrNode, rel: string, segsHere: Seg[], d: number, top: boolean): void => {
    if (!top && d <= 0) return; // a non-top node past the depth budget renders as a link marker
    let i = 0; // index over RENDERED own entries (own back-edges and hidden members are filtered)
    let srcIdx = -1; // index over the FULL entries array (the keyless-seg basis, irNodeAt)
    for (const e of node.entries ?? []) {
      srcIdx++;
      if (e.edge === "back") continue;
      // THE HIDDEN-WIRE LAW (content-envelope.ts pruneClone is the twin): only a hidden entry
      // with STORAGE behind it (the `.yo/` dir, the `yamlover` graft) is filtered; a hidden
      // entry inside the document (dot-key, legacy `yo:`/`yamlover-*`) is authored — it rides
      // the wire and therefore counts here.
      if (e.edge === "contain" && !isPointer(e.value) && e.value.meta?.hidden &&
          (typeof e.key !== "string" || !isHiddenEntryKey(e.key) || memberExists([...segsHere, e.key]))) continue;
      // the slash continuation mirrors the client's childFrag/fragmentOf spelling: `/` + the
      // segment's canonical token (`/key`, `/0`, `/~` for the null key)
      const cont = "/" + segToken(e.key != null ? e.key : e.nullKey === true ? null : i);
      i++;
      const bucket: CommentBucket = {};
      const lead = placed(e.meta?.comments, "leading");
      const trail = placed(e.meta?.comments, "trailing");
      if (lead.length > 0) bucket.leading = lead;
      if (trail.length > 0) bucket.trailing = trail;
      // a blank line before the entry, or before its leading-comment block, is worth keeping
      const leadComment = e.meta?.comments?.find((c) => c.placement === "leading");
      if (e.meta?.blankBefore || leadComment?.blankBefore) bucket.blankBefore = true;
      if (e.meta?.keyConcrete === "yamlover/key/flat") bucket.keyConcrete = e.meta.keyConcrete;
      if (isPointer(e.value)) bucket.pointer = renderPointer(e.value); // the authored `*…` token
      else {
        nodeDeco(bucket, e.value); // the value node's anchors + type tag
        const raw = scalarRawToken(e.value); // a scalar's faithful source token (when it differs)
        if (raw) bucket.raw = raw;
        // the container's LEFTOVER comments (the tail rule, comments.ts): own-line remarks
        // after its last entry, kept on the node meta — rendered inside the block
        const tailC = placed(e.value.meta?.comments, "leading");
        if (tailC.length > 0) bucket.tail = tailC;
      }
      if (Object.keys(bucket).length > 0) out[rel + cont] = bucket;
      if (e.edge === "contain" && !isPointer(e.value)) {
        const childSeg: Seg = e.key != null ? e.key : e.nullKey === true ? null : srcIdx;
        walk(e.value, rel + cont, [...segsHere, childSeg], d - 1, false);
      }
    }
  };
  walk(root, "", segs, depth, true);
  return out;
}
