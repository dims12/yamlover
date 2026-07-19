// The projectional editor's in-memory tree — the MPS-style "cell model" behind the unlocked
// yamlover data view. Built ONCE per unlock from the `/api/json` unlimited-depth projection plus
// its `comments` sidecar (raw scalar tokens, pointer text, `!!<…>` tag text), then mutated in
// place by the editor; every structural mutation returns the surgical `/api/edit` ops that make
// the server catch up (ops.ts queues and flushes them). The model is MUTABLE — the editor bumps a
// version counter to re-render — because a projectional cell tree mutates along arbitrary spines,
// where immutable path-copying buys nothing but ceremony.
//
// INDEX DISCIPLINE (the load-bearing invariant): a node's `entries` array holds every entry —
// keyed and ordinal — in source order; the scalar self-value is NOT in the array (it consumes no
// index, mirroring the server's one-address-space rule). An op's numeric segment is the entry's
// SERVER index: its array position counting only `committed` entries — uncommitted holes exist
// only client-side, so they must not shift the addresses of anything real. Ops are emitted at
// mutation time against that committed picture and applied by the server strictly in order, so
// the picture is always the one the server will have when the op's turn comes.

import type { CommentBucket, CommentMap, Edit, NodeJson } from "../../api";
import { asLink, asMixed, asRef, type Link } from "../../render";
import { scalarToSource } from "../value-editors";
import { escapeYamloverScalar } from "../chapter-model";
import { unquoteSource } from "./keys";
import { parseYamlover } from "../../../../../parser/ts/src/yamlover.ts";

let idSeq = 0;
const nid = () => `yed${idSeq++}`;

export type MKind = "scalar" | "container" | "pointer" | "link" | "hole";

export interface MScalar {
  src: string; // the yamlover SOURCE token as edited/committed (verbatim on the wire)
  value: unknown; // the decoded value (drives the token colour class)
  quote?: '"' | "'"; // quoted-mode cell: `src` is derived by wrapping the edited inner text
  block?: boolean; // multiline prose: the cell edits TEXT; `src` is escapeYamloverScalar(text)
  closed?: boolean; // the machine's `quoted_token_closed`: caret after the closing quote, nothing
                    // committed yet — the next key decides key vs value (cleared on commit)
}

export interface MNode {
  id: string;
  kind: MKind;
  rev: number; // bumped when the MODEL rewrites this node's editable text (DOM reset gate)
  dirty?: boolean; // materialized from a hole but NOT yet persisted — the first commit must fire
                   // even when the cell text still equals its initial (preset) value
  scalar?: MScalar;
  pointer?: { raw: string; refPath: string | null }; // raw WITHOUT the leading `*`
  link?: Link; // an opaque $yamloverLink (binary leaf) — read-only
  entries: MEntry[]; // every entry, keyed and ordinal, in source order
  flow?: "map" | "seq"; // a container born from `{` / `[` — rendered and serialized in FLOW form
  omniPending?: boolean; // this container's self line lives on the SERVER as a plain scalar entry
                         // (the level-rule descend converted it client-side) — a scalar entry
                         // cannot be descended into, so the FIRST child commit re-emplaces the
                         // whole omni at the entry's own path instead of inserting into it
  selfValue?: MScalar | null; // the omni scalar self-value (consumes NO index)
  selfAt: number; // its display position among the entries
  metaTag: string | null; // `!!<…>` CONTENT (no delimiters); null = untagged
  metaOnServer?: boolean; // a tag exists server-side — clearing one that never did emits nothing
  prefill?: string; // a hole's restored text (an undone `key:` decision puts the key back to edit)
  setTag: boolean; // `!!set` (read-only display)
  bucket?: CommentBucket; // captured at build — comments/anchors travel with the node
}

export interface MEntry {
  id: string;
  key: string | null; // null ⇒ ordinal (`- `)
  quotedKey?: boolean; // the key was AUTHORED quoted (`"value":`) — kept quoted on screen and disk
  decided: boolean; // false ⇒ a fresh entry hole that has not chosen `- ` vs `key:` yet
  node: MNode;
  committed: boolean; // false ⇒ exists only client-side, no server entry behind it
  bucket?: CommentBucket;
}

/** A key's SOURCE token: quoted when authored quoted (or when bare would not survive). */
export function keyToken(entry: Pick<MEntry, "key" | "quotedKey">): string {
  return entry.quotedKey ? JSON.stringify(entry.key) : String(entry.key);
}

// --------------------------------------------------------------------------- //
// Construction from the /api/json projection + comments sidecar
// --------------------------------------------------------------------------- //

const asNumMarker = (v: unknown): string | null => {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const keys = Object.keys(v as object);
    if (keys.length === 1 && keys[0] === "$yamloverNum") return (v as Record<string, string>).$yamloverNum;
  }
  return null;
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Split a bucket's `tag` — `!!<content>` and/or `!!set` — into the tag content and the set flag. */
export function parseTag(tag: string | undefined): { metaTag: string | null; setTag: boolean } {
  if (!tag) return { metaTag: null, setTag: false };
  const setTag = /(^|\s)!!set$/.test(tag);
  const m = /^!!<([\s\S]*)>\s*(?:!!set)?$/.exec(tag);
  return { metaTag: m ? m[1] : null, setTag };
}

function mkScalar(value: unknown, bucket: CommentBucket | undefined): MScalar {
  // THE REPRESENTATION RULE: a block scalar's AUTHORED token (header + content lines) rides the
  // sidecar's `raw` — reproduce it; the cell edits the authored lines, not the chomped value
  const braw = bucket?.raw;
  if (typeof braw === "string" && /^[|>]/.test(braw) && braw.includes("\n")) {
    const src = blockHeader(braw) + "\n" + indentBlockLines(braw.slice(braw.indexOf("\n") + 1));
    return { src, value: blockBody(src), block: true };
  }
  if (typeof value === "string" && value.includes("\n")) {
    const src = escapeYamloverScalar(value); // no authored token — derive `|`/`|-` (or quoted)
    if (src.includes("\n")) return { src, value: blockBody(src), block: true };
    return { src, value, quote: '"' };
  }
  const num = asNumMarker(value);
  if (num !== null) {
    const token = num === "NaN" ? ".nan" : num === "-Infinity" ? "-.inf" : ".inf";
    return { src: token, value: num };
  }
  if (typeof value === "string") {
    // THE REPRESENTATION RULE: an authored-QUOTED string arrives via the sidecar `raw`; a
    // bare-authored one carries none — so prefer the BARE spelling whenever it re-reads as the
    // same string (a plain `species>` in the file must not re-derive into `"species>"`), and
    // project a genuinely quoted token as a QUOTE-MODE cell (paired quotes, the inner edits)
    const src = bucket?.raw ?? (bareStringRoundTrips(value) ? value : scalarToSource(value as never, "yaml"));
    const q = unquoteSource(src);
    if (q && q.inner === value) return { src, value, quote: q.quote };
    return { src, value };
  }
  return { src: bucket?.raw ?? scalarToSource(value as never, "yaml"), value };
}

/** True when `text` re-reads as the SAME string from a bare (unquoted) yamlover line — the
 *  client-side mirror of the server's preferPlainScalar. */
function bareStringRoundTrips(text: string): boolean {
  if (text === "" || text !== text.trim() || text.includes("\n")) return false;
  try {
    const r = parseYamlover(text, "<cell>").root as { kind?: string; value?: unknown; entries?: unknown[] };
    return r.kind === "scalar" && r.value === text && !r.entries?.length;
  } catch {
    return false;
  }
}

function bucketAt(comments: CommentMap | undefined, frag: string): CommentBucket | undefined {
  const b = comments?.[frag];
  return b && !Array.isArray(b) ? b : undefined;
}

function buildNode(v: unknown, frag: string, comments: CommentMap | undefined): MNode {
  const bucket = bucketAt(comments, frag);
  const { metaTag, setTag } = parseTag(bucket?.tag);
  const base = { id: nid(), rev: 0, entries: [] as MEntry[], selfAt: 0, metaTag, metaOnServer: metaTag !== null, setTag, bucket };

  const link = asLink(v);
  if (link) return { ...base, kind: "link", link };
  const ref = asRef(v);
  if (ref) return { ...base, kind: "pointer", pointer: { raw: bucket?.pointer ?? ref.text, refPath: ref.path } };

  const mixed = asMixed(v);
  if (mixed) {
    const node: MNode = { ...base, kind: "container" };
    node.entries = mixed.entries.map((e, i) => buildEntry(e.key, e.value, frag + (e.key != null ? `/${e.key}` : `[${i}]`), comments));
    if (mixed.kind === "omni") {
      // a link self-value (blob-backed omni) stays un-modeled — read-only territory
      node.selfValue = asLink(mixed.value) ? null : mkScalar(mixed.value, bucket);
      node.selfAt = Math.min(mixed.selfAt ?? 0, node.entries.length);
    }
    return node;
  }
  if (isObj(v)) {
    const node: MNode = { ...base, kind: "container" };
    node.entries = Object.entries(v).map(([k, cv]) => buildEntry(k, cv, `${frag}/${k}`, comments));
    return node;
  }
  if (Array.isArray(v)) {
    const node: MNode = { ...base, kind: "container" };
    node.entries = v.map((cv, i) => buildEntry(null, cv, `${frag}[${i}]`, comments));
    return node;
  }
  return { ...base, kind: "scalar", scalar: mkScalar(v, bucket) };
}

function buildEntry(key: string | null, v: unknown, frag: string, comments: CommentMap | undefined): MEntry {
  return { id: nid(), key, decided: true, node: buildNode(v, frag, comments), committed: true, bucket: bucketAt(comments, frag) };
}

/** Build the editor model from an unlimited-depth `/api/json` payload. */
export function buildModel(node: NodeJson): MNode {
  const root = buildNode(node.value, "", node.comments);
  // An EMPTY document projects as `value: null` — present it as an empty container so the editor
  // opens on a ROOT HOLE (an empty doc is NOT a null scalar). An authored `~` keeps its raw token
  // and stays a scalar; a rare authored bare `null` document shows as a hole too (accepted cut).
  if (root.kind === "scalar" && root.scalar?.value === null && !root.bucket?.raw) {
    root.kind = "container";
    root.scalar = undefined;
  }
  return root;
}

// --------------------------------------------------------------------------- //
// Locating + addressing
// --------------------------------------------------------------------------- //

export interface Spine {
  entry: MEntry;
  parents: { container: MNode; index: number }[]; // outermost first; last one owns `entry`
}

/** Depth-first search for the entry with `id`; the returned spine names every ancestor container. */
export function findEntry(root: MNode, id: string): Spine | null {
  const walk = (node: MNode, parents: Spine["parents"]): Spine | null => {
    for (let i = 0; i < node.entries.length; i++) {
      const e = node.entries[i];
      const here = [...parents, { container: node, index: i }];
      if (e.id === id) return { entry: e, parents: here };
      const found = walk(e.node, here);
      if (found) return found;
    }
    return null;
  };
  return walk(root, []);
}

/** Find the node with `id` (a value node, not an entry) and its owning entry spine (null spine for
 *  the root node itself). */
export function findNode(root: MNode, id: string): { node: MNode; spine: Spine | null } | null {
  if (root.id === id) return { node: root, spine: null };
  const walk = (node: MNode, parents: Spine["parents"]): { node: MNode; spine: Spine | null } | null => {
    for (let i = 0; i < node.entries.length; i++) {
      const e = node.entries[i];
      const here = [...parents, { container: node, index: i }];
      if (e.node.id === id) return { node: e.node, spine: { entry: e, parents: here } };
      const found = walk(e.node, here);
      if (found) return found;
    }
    return null;
  };
  return walk(root, []);
}

/** One path segment appended to a canonical colon-form path (mirrors render.tsx childPath). */
function appendSeg(path: string, seg: string | number): string {
  const base = path === ":" ? "" : path;
  return typeof seg === "number" ? `${base}[${seg}]` : `${base}:${encodeURIComponent(seg)}`;
}

/** An entry's SERVER index inside `container`: its position counting committed entries only —
 *  client-side holes occupy no server address. */
export function serverIndexOf(container: MNode, index: number): number {
  let n = 0;
  for (let i = 0; i < index; i++) if (container.entries[i].committed) n++;
  return n;
}

/** The `/api/edit` path of the entry a spine names: root path + one segment per level — the key
 *  when the entry has one (stable under sibling churn), else the server index. */
export function pathOfSpine(rootPath: string, spine: Spine): string {
  let p = rootPath;
  for (const { container, index } of spine.parents) {
    const e = container.entries[index];
    p = appendSeg(p, e.key ?? serverIndexOf(container, index));
  }
  return p;
}

// --------------------------------------------------------------------------- //
// Serialization of a model subtree (insert payloads / structural moves ONLY)
// --------------------------------------------------------------------------- //

/** The yamlover source of a model node at column 0 — self-value line at `selfAt`, then entries,
 *  nested blocks indented 2. Used for the payload of an `insert`/structural move; scalar tokens
 *  are the model's own (authored or as-typed), so fidelity holds for everything the model holds.
 *  Holes serialize as nothing (an undecided entry) or `""` (an empty value slot). */
export function serializeMNode(node: MNode): string {
  return serializeLines(node, 0).join("\n");
}

function valueToken(node: MNode): string | null {
  if (node.kind === "scalar") return node.scalar!.src;
  if (node.kind === "pointer") return "*" + node.pointer!.raw;
  if (node.kind === "hole") return '""';
  if (node.kind === "container" && node.flow) {
    const items = node.entries
      .filter((e) => e.decided || node.flow === "seq")
      .map((e) => (e.key !== null ? `${e.key}: ` : "") + (valueToken(e.node) ?? '""'));
    return node.flow === "seq" ? `[${items.join(", ")}]` : `{${items.join(", ")}}`;
  }
  return null; // block container / link → block lines
}

function serializeLines(node: MNode, indent: number): string[] {
  const pad = " ".repeat(indent);
  const lines: string[] = [];
  const selfLine = (): void => {
    if (node.selfValue) for (const l of node.selfValue.src.split("\n")) lines.push(pad + l);
  };
  if (node.kind !== "container" || node.flow) {
    const tok = valueToken(node);
    return tok !== null ? tok.split("\n").map((l) => pad + l) : [];
  }
  let emittedSelf = false;
  node.entries.forEach((e, i) => {
    if (i === node.selfAt && node.selfValue) { selfLine(); emittedSelf = true; }
    if (!e.decided) return; // an untouched entry hole serializes as nothing
    const tag = e.node.metaTag !== null ? `!!<${e.node.metaTag}> ` : "";
    const marker = e.key !== null ? `${keyToken(e)}: ` : "- ";
    const tok = valueToken(e.node);
    if (tok !== null && !tok.includes("\n")) {
      lines.push(pad + marker + tag + tok);
    } else if (tok !== null && /^[|>]/.test(tok)) {
      // a block scalar rides its marker (`- |` / `key: |`), content one step deeper — the token's
      // lines already carry the 2-space step relative to the header
      const [head, ...body] = tok.split("\n");
      lines.push(pad + marker + tag + head);
      lines.push(...body.map((l) => (l ? pad + l : l)));
    } else {
      const inner = tok !== null ? tok.split("\n").map((l) => " ".repeat(indent + 2) + l) : serializeLines(e.node, indent + 2);
      // the COMPACT dash form (`- name: Rex`): an untagged ordinal whose container value opens
      // with a single-line entry rides the dash line, the rest stays at indent+2 (YAML block style)
      const first = e.node.entries[0];
      const compact =
        e.key === null && !tag && tok === null && !e.node.selfValue &&
        !!first && first.decided && first.node.metaTag === null &&
        valueToken(first.node) !== null && !valueToken(first.node)!.includes("\n");
      if (compact && inner.length > 0) {
        lines.push(pad + marker + inner[0].trimStart());
        lines.push(...inner.slice(1));
      } else {
        lines.push(pad + marker.trimEnd() + (tag ? " " + tag.trimEnd() : ""));
        lines.push(...inner);
      }
    }
  });
  if (!emittedSelf && node.selfValue) selfLine();
  return lines;
}

// --------------------------------------------------------------------------- //
// Mutations — each mutates in place and returns the ops that mirror it server-side
// --------------------------------------------------------------------------- //

/** Recursively mark an entry's whole subtree committed (its serialized payload just went out). */
function markCommitted(entry: MEntry): void {
  entry.committed = true;
  entry.node.dirty = false;
  entry.node.metaOnServer = entry.node.metaTag !== null; // the payload carried the tag
  for (const e of entry.node.entries) if (e.decided) markCommitted(e);
}

/** The topmost UNCOMMITTED entry on the spine (the unit that must be inserted whole), or null when
 *  the spine is fully committed. */
function topUncommitted(spine: Spine): { container: MNode; index: number; entry: MEntry; depth: number } | null {
  for (let d = 0; d < spine.parents.length; d++) {
    const { container, index } = spine.parents[d];
    const e = container.entries[index];
    if (!e.committed) return { container, index, entry: e, depth: d };
  }
  return null;
}

/** Commit whatever the spine's topmost uncommitted ancestor is — the first real content inside a
 *  client-side subtree pushes the WHOLE subtree to the server. Both keyed and ordinal units go
 *  out as a positional `insert` at the unit's server index (a keyed one carries `key`), so the
 *  document keeps the order the entries were TYPED in. Fully committed spine → no ops. */
export function commitSpine(rootPath: string, root: MNode, entryId: string): Edit[] {
  const spine = findEntry(root, entryId);
  if (!spine) return [];
  const top = topUncommitted(spine);
  if (!top) return [];
  const { container, index, entry } = top;
  if (!entry.decided) return []; // nothing to say yet
  if (container.omniPending) {
    // the container's self line is a plain SCALAR entry server-side — re-render the whole omni
    // (self + children) in place; from here on ordinary child inserts descend into it
    const contPath = pathOfSpine(rootPath, { entry, parents: spine.parents.slice(0, top.depth) });
    container.omniPending = false;
    for (const e of container.entries) if (e.decided) markCommitted(e);
    return [{ path: contPath, op: "emplace", yamlover: serializeMNode(container) }];
  }
  // the CONTAINER's path: the spine up to (not including) the uncommitted entry's own level
  const parentPath = pathOfSpine(rootPath, { entry, parents: spine.parents.slice(0, top.depth) });
  const payload = serializeMNode(entry.node) || '""';
  const meta = entry.node.metaTag !== null ? entry.node.metaTag : undefined;
  const at = serverIndexOf(container, index);
  markCommitted(entry);
  return [{
    path: appendSeg(parentPath, at),
    op: "insert",
    yamlover: payload,
    ...(entry.key !== null ? { key: keyToken(entry) } : {}),
    ...(meta !== undefined ? { meta } : {}),
  }];
}

/** Rewrite a scalar/pointer node's token. Committed → one coalescable emplace; uncommitted → the
 *  subtree commit instead. For the ROOT node (no owning entry) the op targets the root path. */
export function setNodeToken(rootPath: string, root: MNode, nodeId: string, next: Partial<MScalar> & { pointer?: string }): Edit[] {
  const found = findNode(root, nodeId);
  if (!found) return [];
  const { node, spine } = found;
  if (next.pointer !== undefined) {
    node.kind = "pointer";
    node.pointer = { raw: next.pointer, refPath: node.pointer?.refPath ?? null };
    node.scalar = undefined;
  } else {
    node.kind = "scalar";
    node.scalar = { ...(node.scalar ?? { value: null }), ...next } as MScalar;
    node.pointer = undefined;
  }
  node.dirty = false; // the commit below persists it
  if (spine && !allCommitted(spine)) return commitSpine(rootPath, root, spine.entry.id);
  const path = spine ? pathOfSpine(rootPath, spine) : rootPath;
  const src = node.kind === "pointer" ? "*" + node.pointer!.raw : node.scalar!.src;
  return [{ path, op: "emplace", yamlover: src }];
}

/** A BARE token typed in an UNDECIDED entry hole is the containing node's scalar SELF-VALUE line
 *  (omni; at most one per block — the caller guards). The hole leaves the entries array (a self
 *  line consumes no index) and `selfAt` keeps the display position where it was typed. Emits the
 *  index-neutral scalar emplace at the CONTAINER's path (or nothing inside an uncommitted subtree
 *  — the eventual subtree commit serializes the self line). */
export function commitHoleAsSelf(rootPath: string, root: MNode, entryId: string, scalar: MScalar): Edit[] {
  const spine = findEntry(root, entryId);
  if (!spine) return [];
  const { container, index } = spine.parents[spine.parents.length - 1];
  if (container.selfValue) return [];
  const at = serverIndexOf(container, index); // committed entries BEFORE the typed position
  container.entries.splice(index, 1);
  container.selfValue = scalar;
  container.selfAt = index;
  container.rev++;
  const parentSpine = spine.parents.slice(0, -1);
  if (!parentSpine.every(({ container: c, index: i }) => c.entries[i].committed)) return [];
  const p = parentSpine.length ? pathOfSpine(rootPath, { entry: spine.entry, parents: parentSpine }) : rootPath;
  // the self line is SAVED at the position it was typed (THE REPRESENTATION RULE)
  return [{ path: p, op: "emplace", yamlover: scalar.src, ...(at > 0 ? { at } : {}) }];
}

/** Set/replace/clear a container's omni self-value (index-neutral). `null` (or an empty token)
 *  drops the line via an empty-string emplace. The scalar keeps its CONCRETE — a quoted self stays
 *  quoted on disk and on screen. */
export function setSelfValue(rootPath: string, root: MNode, nodeId: string, scalar: MScalar | null): Edit[] {
  const found = findNode(root, nodeId);
  if (!found) return [];
  const { node, spine } = found;
  const clearing = scalar === null || scalar.src === "" || scalar.src === '""';
  node.selfValue = clearing ? null : scalar;
  if (spine && !allCommitted(spine)) return commitSpine(rootPath, root, spine.entry.id);
  const path = spine ? pathOfSpine(rootPath, spine) : rootPath;
  const at = serverIndexOf(node, node.selfAt); // a fresh line lands at its position; a replace stays put
  return [{ path, op: "emplace", yamlover: clearing ? '""' : scalar!.src, ...(clearing || at === 0 ? {} : { at }) }];
}

function allCommitted(spine: Spine): boolean {
  return spine.parents.every(({ container, index }) => container.entries[index].committed);
}

/** Set (`content`) or clear (`null`) a node's `!!<…>` meta tag — a meta-only emplace. */
export function setMetaTag(rootPath: string, root: MNode, nodeId: string, content: string | null): Edit[] {
  const found = findNode(root, nodeId);
  if (!found) return [];
  const { node, spine } = found;
  node.metaTag = content;
  if (content === null && !node.metaOnServer) return []; // clearing a never-persisted tag — nothing to say
  if (spine && !allCommitted(spine)) return []; // rides the eventual subtree commit
  node.metaOnServer = content !== null;
  const path = spine ? pathOfSpine(rootPath, spine) : rootPath;
  return [{ path, op: "emplace", meta: content }];
}

/** A fresh, undecided entry hole after `afterEntryId` (or appended to `containerId` when null).
 *  Client-side only — no ops until something commits. Returns the new entry (focus target). */
export function insertHoleAfter(root: MNode, containerId: string, afterEntryId: string | null): MEntry | null {
  const container = containerId === root.id ? root : findNode(root, containerId)?.node;
  if (!container || container.kind !== "container") return null;
  const after = afterEntryId === null ? -1 : container.entries.findIndex((e) => e.id === afterEntryId);
  const at = afterEntryId === null || after < 0 ? container.entries.length : after + 1;
  return insertHoleAt(root, containerId, at);
}

/** A fresh hole at an exact position of a container (the self-value's Enter inserts at `selfAt`). */
export function insertHoleAt(root: MNode, containerId: string, index: number): MEntry | null {
  const container = containerId === root.id ? root : findNode(root, containerId)?.node;
  if (!container || container.kind !== "container") return null;
  const hole = mkHoleEntry();
  container.entries.splice(Math.max(0, Math.min(index, container.entries.length)), 0, hole);
  return hole;
}

/** Multiline TEXT → block-scalar source (`|`/`|-`, or a quoted line when a block won't round-trip). */
export const blockSource = escapeYamloverScalar;

// ---- block-token plumbing (THE REPRESENTATION RULE) --------------------------------------- //
// A block MScalar's `src` is the source-at-column-0 token: the AUTHORED header line (`|`, `|-`,
// `|+`, `>`, …) followed by the content lines indented 2. The cell edits the CONTENT TEXT
// (`blockBody`); commits re-assemble the SAME header over the edited lines (`blockSrcWith`).

/** The header line of a block token (`|`, `|-`, `>`, …). */
export function blockHeader(src: string): string {
  const nl = src.indexOf("\n");
  return nl < 0 ? src : src.slice(0, nl);
}

/** A block token's content TEXT: the lines after the header, de-indented by the 2-space step. */
export function blockBody(src: string): string {
  const nl = src.indexOf("\n");
  if (nl < 0 || !/^[|>]/.test(src)) return "";
  return src.slice(nl + 1).split("\n").map((l) => (l.startsWith("  ") ? l.slice(2) : l)).join("\n");
}

/** Indent a block token's raw (de-indented) content lines by the 2-space step; blanks stay bare. */
function indentBlockLines(body: string): string {
  return body.split("\n").map((l) => (l.trim().length ? "  " + l : "")).join("\n");
}

/** TEXT under an authored `header` → the full block token, or null when block form cannot hold
 *  the text (an empty/space-led first content line would not survive the parser's de-indent). */
export function blockSrcWith(header: string, text: string): string | null {
  const first = text.split("\n").find((l) => l.trim().length > 0);
  if (!first || /^\s/.test(first)) return null;
  return (/^[|>]/.test(header) ? header : "|") + "\n" + indentBlockLines(text);
}

/** A fresh, undecided client-side entry hole. */
export function mkHoleEntry(): MEntry {
  return {
    id: nid(), key: null, decided: false, committed: false,
    node: { id: nid(), rev: 0, kind: "hole", entries: [], selfAt: 0, metaTag: null, setTag: false },
  };
}

/** Remove an entry. Committed → a `remove` op (by key, else server index); a client-side hole
 *  vanishes silently. */
export function removeEntry(rootPath: string, root: MNode, entryId: string): Edit[] {
  const spine = findEntry(root, entryId);
  if (!spine) return [];
  const { container, index } = spine.parents[spine.parents.length - 1];
  const entry = container.entries[index];
  const path = entry.committed && allCommitted(spine) ? pathOfSpine(rootPath, spine) : null;
  container.entries.splice(index, 1);
  return path !== null ? [{ path, op: "remove" }] : [];
}

/** Tab: the entry becomes the LAST CHILD of its previous ordinal sibling. A scalar sibling turns
 *  omni (its token becomes the self-value); a hole sibling becomes a container. Committed content
 *  moves as remove + re-insert of the serialized subtree. No previous sibling, a keyed target, a
 *  pointer/link sibling, or a keyed entry itself → no-op (starter cut). */
export function indentEntry(rootPath: string, root: MNode, entryId: string): Edit[] {
  const spine = findEntry(root, entryId);
  if (!spine) return [];
  const { container, index } = spine.parents[spine.parents.length - 1];
  const entry = container.entries[index];
  if (container.flow || entry.key !== null || index === 0) return [];
  const prev = container.entries[index - 1];
  if (prev.key !== null || prev.node.kind === "pointer" || prev.node.kind === "link") return [];
  const edits: Edit[] = [];
  const wasCommitted = entry.committed && allCommitted(spine);
  const prevSpine: Spine = { entry: prev, parents: [...spine.parents.slice(0, -1), { container, index: index - 1 }] };
  const prevPath = pathOfSpine(rootPath, prevSpine);
  if (wasCommitted) edits.push({ path: pathOfSpine(rootPath, spine), op: "remove" });
  container.entries.splice(index, 1);
  if (prev.node.kind === "scalar") {
    // scalar → omni: the token becomes the self-value, the moved entry its first child
    prev.node.selfValue = prev.node.scalar!;
    prev.node.selfAt = 0;
    prev.node.scalar = undefined;
    prev.node.kind = "container";
    // moved-entry uncommitted → no ops fire now; the server still holds a plain scalar entry,
    // so the first child commit must re-emplace the whole omni
    if (prev.committed && !wasCommitted) prev.node.omniPending = true;
  } else if (prev.node.kind === "hole") {
    prev.node.kind = "container";
  }
  prev.node.entries.push(entry);
  if (wasCommitted && prev.committed) {
    const payload = serializeMNode(entry.node) || '""';
    const meta = entry.node.metaTag !== null ? entry.node.metaTag : undefined;
    edits.push({ path: prevPath, op: "insert", yamlover: payload, ...(meta !== undefined ? { meta } : {}) });
    // the insert path names the (childless-until-now) sibling → append; if the sibling just turned
    // omni, the emplace below re-renders it whole with self + child in one op instead
    if (prev.node.selfValue && prev.node.entries.length === 1) {
      edits.length = wasCommitted ? 1 : 0; // drop the insert; replace with a single omni emplace
      edits.push({ path: prevPath, op: "emplace", yamlover: serializeMNode(prev.node) });
    }
  }
  return edits;
}

/** Shift-Tab: the entry leaves its parent and lands right AFTER the parent entry in the
 *  grandparent. Root-level entries and keyed entries stay put (starter cut). */
export function dedentEntry(rootPath: string, root: MNode, entryId: string): Edit[] {
  const spine = findEntry(root, entryId);
  if (!spine || spine.parents.length < 2) return [];
  const { container, index } = spine.parents[spine.parents.length - 1];
  const entry = container.entries[index];
  if (container.flow || entry.key !== null) return [];
  const { container: grand, index: parentIndex } = spine.parents[spine.parents.length - 2];
  const parentEntry = grand.entries[parentIndex];
  const edits: Edit[] = [];
  const wasCommitted = entry.committed && allCommitted(spine);
  if (wasCommitted) edits.push({ path: pathOfSpine(rootPath, spine), op: "remove" });
  container.entries.splice(index, 1);
  grand.entries.splice(parentIndex + 1, 0, entry);
  if (wasCommitted) {
    const grandSpine = spine.parents.slice(0, -2);
    const grandPath = grandSpine.length
      ? pathOfSpine(rootPath, { entry: grand.entries[parentIndex], parents: grandSpine } as Spine)
      : rootPath;
    const at = serverIndexOf(grand, parentIndex + 1);
    const payload = serializeMNode(entry.node) || '""';
    if (!parentEntry.committed) return edits; // parent itself is client-side; its commit will carry us
    edits.push({ path: appendSeg(grandPath, at), op: "insert", yamlover: payload });
  }
  return edits;
}
