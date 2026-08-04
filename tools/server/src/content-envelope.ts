// THE CONTENT ENVELOPE — the yamlover wire (`GET /api/content/{slash-path}?depth=N`).
//
// One representation: the response is a YAMLOVER document (built as a programmatic IR and
// emitted by the serializer — never by string concatenation) whose facets are:
//   - the header keys (`path`, `documentPath`, `type`, facets, `concrete`, `title`, …) — the
//     store-derived envelope every consumer needs without touching storage;
//   - `source` — the requested subtree of the MERGED parser IR (dir members inlined by the
//     walk), serialized WITH comments, depth-pruned;
//   - `side` — the fragment-keyed sidecar carrying what authored text cannot: member
//     provenance (`anchorKey` / `member`), engine-derived formats, resolved reference
//     targets, and the link stubs of cut members (the `linkMarker` payload, verbatim);
//   - `relations` — the upstream relations panel (store knowledge).
//
// THE DEPTH LAW: depth counts DOCUMENT boundaries only. Inline content always serializes
// whole; a member document beyond the budget is respelled as its authored pointer — a
// body-positioned member as `- *: name`, a keyed-remainder member as `name: *: name` — and
// its stub rides the sidecar. BLOBS always cut (bytes never ride the text; `LossyError`
// stays unreachable). The client dereferences a cut by fetching `/api/content` again.
//
// The MERGED IR represents a body-positioned member as a KEYED entry (its key = the member
// name) at the body's position, with the name recorded in the parent's `meta.anchored`
// (walk.ts applyBody). The wire must not spell that keyed form — on disk the member is
// keyless at its position — so within-depth anchored members serialize KEYLESS with
// `anchorKey` in the sidecar (the same shape the editors already model).

import { isPointer, type Document, type Entry, type Node, type Pointer, type Value } from "../../parser/ts/src/ir.ts";
import { parsePointer } from "../../parser/ts/src/pointer.ts";
import { serializeYamlover } from "../../parser/ts/src/serialize-yamlover.ts";
import { segToken } from "../../parser/ts/src/pathseg.ts";
import { nodeDeco, scalarRawToken, type CommentBucket } from "./projection-comments.js";

export type Seg = string | number | null;

/** Store-derived capabilities, injected by engine-api (the store and its helpers live there —
 *  injecting avoids a module cycle and keeps this builder pure over the IR). */
export interface EnvelopeDeps {
  /** A real file/directory stands behind this path (the member test — rekey's fs rule). */
  memberExists(segs: Seg[]): boolean;
  /** The STORE's format for a node — explicit `!!<format: …>` tags and schema-resolved
   *  `$defs` refs alike (the IR's `derivedFormat` covers only the schema-application half). */
  formatAt(segs: Seg[]): string | null;
  /** The `linkMarker(...)` payload for a node — THE stub shape every renderer already reads. */
  stub(segs: Seg[]): Record<string, unknown> | null;
  /** The resolved target of the reference ENTRY at `pos` under the holder (store edges);
   *  null = unrealized/dangling. `text` is the scope-correct canonical pointer spelling
   *  (refPointerText, framed at the holder's document) — what the projection shows at
   *  unlimited depth. */
  refTargetAt(holderSegs: Seg[], pos: number): { path: string; text: string; stub: Record<string, unknown> | null } | null;
  /** The incoming `~` back-edges the projection APPENDS at this node (downstreamEntries'
   *  pseudo-entries, deduped and in their lexicographic order) — they exist nowhere in the
   *  authored text, so the wire carries them here. */
  backEdgesAt(segs: Seg[]): { label: string | null; path: string; text: string; stub: Record<string, unknown> | null }[];
}

export interface EnvelopeInput {
  segs: Seg[];               // the requested node (canonical)
  subtree: Node;             // irNodeAt(cachedDoc, segs) — the merged-IR subtree
  docDepth: number;          // document-boundary budget (Infinity = unlimited)
  header: Record<string, unknown>;    // path/documentPath/type/facets/format/concrete/title/description
  relations: Record<string, { text: string; path?: string }>;
}

/** One sidecar bucket — everything the text cannot say about the node/entry at a fragment. */
interface SideBucket {
  anchorKey?: string;            // a body-positioned member (serialized keyless here)
  member?: true;                 // a keyed-remainder member (its key IS its storage name)
  format?: string;               // engine-derived format (extension folds, resolved tags)
  fileText?: true;               // a whole-file text scalar: raw IS the value (the decoder restores it)
  refPath?: string;              // a realized reference's resolved target
  refText?: string;              // …its scope-correct canonical spelling (the projection's text)
  target?: Record<string, unknown>; // …and the target's link stub
  stub?: Record<string, unknown>;   // a member's link stub (linkMarker verbatim)
  /** A CUT member's node DECORATIONS (anchors / tags / raw / tail) — the comment-map bucket
   *  its inlined form would have carried, pruned away with the content. */
  deco?: CommentBucket;
  backEdges?: { label: string | null; path: string; text: string; stub: Record<string, unknown> | null }[];
}

/** Build the envelope TEXT (`text/yamlover`). */
export function buildEnvelope(input: EnvelopeInput, deps: EnvelopeDeps): string {
  const side: Record<string, SideBucket> = {};
  // a BLOB request has no text form at all (bytes live behind /api/blob) — the source is
  // empty and the header's type/size/format say everything
  const pruned = (input.subtree as Node).kind === "blob"
    ? ({ kind: "scalar", value: null } as unknown as Node)
    : pruneClone(input.subtree, input.segs, "", input.docDepth, side, deps);
  // the requested node's own head banner (a document root's meta.head) rides as Document.head
  const head = (pruned.meta as { head?: string[] } | undefined)?.head;
  // THE EMPTINESS LAW: an EMPTY document's source is the empty text — never a minted token.
  // An empty body file parses to a null scalar with raw "" (spelling `null` would invent an
  // authored word), and a BODYLESS dir root is a minted empty container (spelling `{}` would
  // invent a flow token the editor then walks INTO). Authored emptiness keeps its spelling:
  // `{}`/`[]` carry `style: flow`, `null`/`~` carry their raw — both excluded here.
  const source = emptyDocRoot(pruned) && !head?.length
    ? ""
    : serializeYamlover(
        { root: pruned, ...(head ? { head } : {}), source: { concrete: "yamlover", uri: "<content>" } } as unknown as Document,
        { comments: true },
      );

  const envelope: Node = mappingOf([
    ...Object.entries(input.header)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => keyed(k, jsToIr(v))),
    keyed("depth", jsToIr(input.docDepth === Infinity ? ".inf" : input.docDepth)),
    keyed("source", { kind: "scalar", value: source } as unknown as Node),
    keyed("side", jsToIr(side)),
    keyed("relations", jsToIr(input.relations)),
  ]);
  return serializeYamlover({ root: envelope, source: { concrete: "yamlover", uri: "<envelope>" } } as unknown as Document);
}

/** An EMPTY document root — no entries, no authored spelling (`style: flow` or a raw token),
 *  no identity to keep (tags/anchors) and no comments to host. The blob placeholder root
 *  (`{kind:"scalar", value:null}`, raw-less) counts too: a blob's source IS empty. */
function emptyDocRoot(n: Node): boolean {
  if ((n.entries ?? []).length > 0) return false;
  const m = (n.meta ?? {}) as { style?: string; schema?: unknown; yo?: boolean; set?: boolean; anchors?: unknown[]; comments?: unknown[] };
  if (m.style === "flow" || m.schema !== undefined || m.yo === true || m.set === true) return false;
  if ((m.anchors?.length ?? 0) > 0 || (m.comments?.length ?? 0) > 0) return false;
  if (n.kind === "scalar") {
    const s = n as Node & { value?: unknown; raw?: string };
    return s.value === null && (s.raw ?? "") === "";
  }
  return true;
}

// --------------------------------------------------------------------------- //
// The pruning clone
// --------------------------------------------------------------------------- //

const anchoredOf = (n: Node): string[] => ((n.meta ?? {}) as { anchored?: string[] }).anchored ?? [];
const hiddenNode = (v: Value): boolean => !isPointer(v) && ((v as Node).meta as { hidden?: boolean } | undefined)?.hidden === true;
const isBlob = (v: Value): boolean => !isPointer(v) && (v as Node).kind === "blob";
const containsBlob = (v: Value): boolean => {
  if (isPointer(v)) return false;
  if ((v as Node).kind === "blob") return true;
  return ((v as Node).entries ?? []).some((e) => containsBlob(e.value));
};

/** The fragment token of a CLONED entry at its rendered index — the continuation the CLIENT
 *  will compute from the parsed source, so sidecar keys and client keys can never disagree. */
const fragOf = (parent: string, e: Entry, idx: number): string => {
  const tok = e.key !== null ? segToken(e.key) : (e as { nullKey?: boolean }).nullKey === true ? "~" : String(idx);
  return `${parent}/${encodeURIComponent(tok)}`;
};

/** The member-pointer IR for a cut: `*: name` — the exact spelling a body grants positions
 *  with, so a cut member reads as the storage already writes it. */
function memberPtr(name: string): Pointer {
  const raw = `: ${segToken(name)}`;
  try {
    return { ...parsePointer(raw), raw } as Pointer;
  } catch {
    return { kind: "pointer", base: { scope: "document" }, steps: [{ sel: "key", name }], raw } as unknown as Pointer;
  }
}

function pruneClone(
  node: Node,
  segs: Seg[],
  frag: string,
  depthLeft: number,
  side: Record<string, SideBucket>,
  deps: EnvelopeDeps,
): Node {
  const put = (f: string, patch: SideBucket): void => {
    side[f] = { ...(side[f] ?? {}), ...patch };
  };
  const df = deps.formatAt(segs);
  if (df !== null) put(frag, { format: df });
  // THE WHOLE-FILE RULE (walk.ts textScalar): a text FILE's raw IS its content, headerless.
  // The wire must spell it as a block scalar (text is text), so mark it — the decoder
  // restores `raw = value` and no representation is minted out of transport.
  const nv = (node as { value?: unknown; raw?: string }).value;
  if (node.kind === "scalar" && typeof nv === "string" && nv.includes("\n") && (node as { raw?: string }).raw === nv) {
    put(frag, { fileText: true });
  }
  const backs = deps.backEdgesAt(segs);
  if (backs.length > 0) put(frag, { backEdges: backs });

  const anchored = anchoredOf(node);
  const out: Entry[] = [];
  // the RENDERED index — what the client computes over the parsed source. It counts every
  // rendered entry EXCEPT authored `~` back-edges, exactly like collectComments' `i`, so the
  // sidecar keys and the client's comment keys can never disagree.
  let renderedIdx = 0;
  (node.entries ?? []).forEach((e, srcIdx) => {
    if (hiddenNode(e.value)) return; // the `.yo` overlay subtree — never content
    const idx = renderedIdx;
    if ((e as { edge?: string }).edge !== "back") renderedIdx++;

    // an authored reference stays a reference; the sidecar resolves it
    if (isPointer(e.value)) {
      const f = fragOf(frag, e, idx);
      const hit = deps.refTargetAt(segs, srcIdx);
      if (hit) put(f, { refPath: hit.path, refText: hit.text, ...(hit.stub ? { target: hit.stub } : {}) });
      out.push(e);
      return;
    }

    const isMemberEntry = typeof e.key === "string" && deps.memberExists([...segs, e.key]);
    if (isMemberEntry) {
      const name = e.key as string;
      const anchoredHere = anchored.includes(name);
      const childSegs = [...segs, name];
      const cut = depthLeft < 1 || containsBlob(e.value);
      const cutEntry: Entry = {
        key: anchoredHere ? null : name,
        edge: "ref",
        value: memberPtr(name) as unknown as Value,
        ...(e.meta !== undefined ? { meta: e.meta } : {}),
      } as unknown as Entry;
      const keptKeyEntry = (value: Value): Entry =>
        ({ ...e, key: anchoredHere ? null : name, value }) as Entry;
      const f = fragOf(frag, cut ? cutEntry : keptKeyEntry(e.value), idx);
      // EVERY member carries its stub (not only cut ones): the client's old-depth derivation
      // needs the member's linkMarker (concrete/type/title/count) wherever ITS cut falls
      put(f, { ...(anchoredHere ? { anchorKey: name } : { member: true }), stub: deps.stub(childSegs) ?? undefined });
      if (cut) {
        // the member's node decorations would have ridden its inlined form — carry the
        // comment-map bucket so the client's derived comments stay whole
        const deco: CommentBucket = {};
        nodeDeco(deco, e.value as Node);
        const rawTok = scalarRawToken(e.value as Node);
        if (rawTok) deco.raw = rawTok;
        const tailC = (((e.value as Node).meta?.comments ?? []) as { placement: string; text: string }[])
          .filter((c) => c.placement === "leading").map((c) => c.text);
        if (tailC.length > 0) deco.tail = tailC;
        if (Object.keys(deco).length > 0) put(f, { deco });
        out.push(cutEntry);
        return;
      }
      const child = pruneClone(e.value as Node, childSegs, f, depthLeft - 1, side, deps);
      out.push(keptKeyEntry(child as unknown as Value));
      return;
    }

    // inline content — recurse at the SAME depth (inline never consumes the budget)
    const f = fragOf(frag, e, idx);
    const childSeg: Seg = e.key !== null ? e.key : (e as { nullKey?: boolean }).nullKey === true ? null : srcIdx;
    const child = pruneClone(e.value as Node, [...segs, childSeg], f, depthLeft, side, deps);
    out.push({ ...e, value: child as unknown as Value } as Entry);
  });

  return { ...node, entries: out } as Node;
}

// --------------------------------------------------------------------------- //
// Plain data → IR (the envelope's own facets)
// --------------------------------------------------------------------------- //

const keyed = (key: string, value: Node): Entry => ({ key, edge: "contain", value } as unknown as Entry);
const mappingOf = (entries: Entry[]): Node => ({ kind: "mapping", entries } as unknown as Node);

function jsToIr(v: unknown): Node {
  if (Array.isArray(v)) {
    return {
      kind: "mapping",
      array: true,
      entries: v.map((x) => ({ key: null, edge: "contain", value: jsToIr(x) })),
    } as unknown as Node;
  }
  if (v !== null && typeof v === "object") {
    return mappingOf(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined)
        .map(([k, x]) => keyed(k, jsToIr(x))),
    );
  }
  return { kind: "scalar", value: v ?? null } as unknown as Node;
}
