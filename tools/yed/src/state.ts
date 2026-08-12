// yed2 — the DEBUG EDITOR's state. THE INVARIANT that distinguishes it from the production
// editor's model: the document is the parser's IR (the same IR the server walks), and it is
// ALWAYS a valid document — incompleteness lives in the CURSOR alone (the text being typed, the
// key not yet named). There is no flag web to desynchronize: what is not committed is not in the
// document, and everything in the document serializes.

import type { Anchor, Document, Node, Entry, Value } from "../../parser/ts/src/ir.ts";
import { isPointer } from "../../parser/ts/src/ir.ts";
import { parseYamlover } from "../../parser/ts/src/yamlover.ts";
import { schemaTagToken, serializeYamlover } from "../../parser/ts/src/serialize-yamlover.ts";
import { anchorBody } from "../../parser/ts/src/serialize-common.ts";
import { DIALECTS, type Dialect, type DialectId } from "./dialect";
import type { Ladder } from "./grammar/portions";

export type { Document, Node, Entry, Value };
export type { Ladder };

/** Where a machine-driven rewrite plants the caret in a text cell: an edge, or a character
 *  offset (a portion merge lands at the junction). */
export type CaretHint = "start" | "end" | number;

/** A REFERENCE being entered, decomposed into PORTIONS - the key-value gesture repeated:
 *  `ladder` is the scope opener (`:` x 0-3), `portions` the cells' committed texts, `active`
 *  the cell being typed (its LIVE text rides the cursor's `text`). Wholly cursor-level:
 *  the document holds the OLD pointer (a retarget) or nothing (a hole) until the joined
 *  reference parses on commit. */
export interface RefEntry {
  ladder: Ladder;
  portions: string[];
  active: number;
}

/** A path into the IR: entry indices from the document root. [] is the root node itself. */
export type Path = number[];

/** THE CURSOR — the only place incompleteness may exist.
 *  - `hole`:  a NEW entry being typed in the container at `path`, at entry position `index`;
 *             `text` is what has been typed, `key` is set once `k: ` named the pair.
 *  - `token`: editing the SCALAR value of the entry at `path` ([] = the root scalar); `text` is
 *             the in-progress source token (committed on leave).
 *  - `key`:   editing the KEY of the entry at `path`.
 *  - `after`: the caret stands in the GAP past the container value at `path` ([] = the root).
 *  - `ptr`:   the caret stands ON the pointer ATOM at `path` — no text; typing into it
 *             refuses, Enter opens the `pick` cursor to retarget it.
 *  - `pick`:  editing the RAW of the pointer at `path` (the spaced display spelling, no `*`).
 *             The pointer STAYS in the document while edited; commit parses-or-refuses, so
 *             the document never holds a half-typed reference.
 *  - `tag`:   editing the `!!<…>` TAG of the node at `path`; `text` is the tag's INNER content
 *             (no wrapper — the same spelling the edit API's `meta` facet carries).
 *  - `anchors`: editing ONE `&` anchor of the node at `path` — `index` names the row (the
 *             node's anchors are a list; `index === length` is the ADD slot), `text` is that
 *             anchor's BODY (no `&`, the sidecar's spelling). */
export type Cursor =
  | { at: "hole"; path: Path; index: number; text: string; key: string | null; ordinal?: boolean;
      /** the VACANT-HEAD face: the caret walked (or clicked) into the cell right of a `key:`
       *  whose value wraps below — the hole DRAWS on the key row (a bare scalar stays there
       *  as the omni self value). Enter drops the bit: the row-allocation gesture — the same
       *  hole re-renders as its own templatized row below, as in a text editor. */
      head?: true;
      /** the QUOTED cell at ENTRY stage (the paired-closer template, KEY interpreter inside):
       *  `text` is the INNER content, the closing quote is projected. Closing returns the
       *  spelled token to the hole's text, where `: ` may then name the pair — the same cell
       *  as a quoted VALUE, only the interpreter inside differs. */
      quote?: '"' | "'";
      /** the AUTHORED key token (`"a"` typed with its quotes) — commits as EntryMeta.keyRaw */
      keyRaw?: string;
      /** the `*` decision - the reference PORTIONS being entered (text = the active portion) */
      ref?: RefEntry;
      /** the `&` decision - `ref` spells the CONTAINER's bookmark BODY, not a value */
      anchor?: true; caret?: CaretHint }
  | { at: "token"; path: Path; text: string; caret?: "start" | "end";
      /** the QUOTED-SCALAR cell (the paired-closer template): `text` is the INNER content,
       *  the closing quote is projected from the style — an unterminated quote cannot exist */
      quote?: '"' | "'" }
  | { at: "key"; path: Path; text: string; caret?: "start" | "end" }
  | { at: "tag"; path: Path; text: string; caret?: "start" | "end" }
  | { at: "anchors"; path: Path; index: number; text: string; caret?: "start" | "end" }
  | { at: "after"; path: Path }
  | { at: "ptr"; path: Path }
  | { at: "pick"; path: Path; text: string; ref?: RefEntry; caret?: CaretHint };

/** One applied edit, for the visible history pane. */
export interface LogEntry {
  key: string;          // the keystroke (or "⌫", "type:x")
  intent: string;       // what it meant (dispatch) or "text"
  before: string;       // serialized doc before (only when the DOC changed)
  after: string;        // serialized doc after
}

export interface EditorState {
  /** The language POLICY the edit layer applies (dialect.ts). Absent ⇒ "yamlover". */
  dialect?: DialectId;
  doc: Document;
  cursor: Cursor;
  /** A refused edit — shown as the ring on the active cell, cleared by the next accepted one. */
  refused: boolean;
  log: LogEntry[];
}

/** The state's dialect, defaulting to yamlover — the id rides the state (serializable, visible
 *  in the panels); the OBJECT is looked up here. */
export const dialectOf = (s: EditorState): Dialect => DIALECTS[s.dialect ?? "yamlover"];

/** An empty document: a mapping with no entries (what an empty file parses to is a null scalar;
 *  the editor's empty document is the empty container the first entry lands in). */
export function emptyDoc(): Document {
  return { root: { kind: "mapping", entries: [] }, source: { concrete: "yamlover", uri: "<yed2>" } } as unknown as Document;
}

export function initialState(dialect?: DialectId): EditorState {
  return {
    ...(dialect !== undefined ? { dialect } : {}),
    doc: emptyDoc(),
    cursor: { at: "hole", path: [], index: 0, text: "", key: null },
    refused: false,
    log: [],
  };
}

/** Serialize for the panes — a document that cannot serialize is a yed2 BUG (the invariant says
 *  the doc is always valid), so surface the error text instead of throwing at render. */
export function sourceOf(doc: Document): string {
  const text = trySourceOf(doc);
  return text !== null ? text : `!! UNSERIALIZABLE (yed2 invariant broken): ${unserializableWhy(doc)}`;
}

/** The serialized source, or NULL when the document has no yamlover text form (a blob-carrying
 *  doc — link atoms have bytes elsewhere). Callers that would otherwise hand a user the
 *  banner (the clipboard) fall back on this. */
export function trySourceOf(doc: Document): string | null {
  try {
    const root = doc.root as Node;
    // the EMPTY DOCUMENT is a block mapping with no entries; an empty FLOW root is content
    // (`{}` / `[]` are values — the bracket-authored law) and serializes as itself. A root
    // carrying ANCHORS is not empty — its `&: …` lines are source (rootAnchors emits them),
    // so the shortcut must not swallow them.
    if (root.kind === "mapping" && (root.entries ?? []).length === 0 && !isFlow(root)
      && ((root.meta as { anchors?: unknown[] } | undefined)?.anchors ?? []).length === 0) return "";
    return serializeYamlover(doc);
  } catch {
    return null;
  }
}

function unserializableWhy(doc: Document): string {
  try {
    serializeYamlover(doc);
    return "serializes on the second try (a heisen-state)";
  } catch (e) {
    return (e as Error).message;
  }
}

export function parseSource(src: string): Document {
  return parseYamlover(src, "<yed2>");
}

/** The node's read-only TAG decorations, in the serializer's reading order: the `!!<…>` schema
 *  tag, `!!yo`, `!!set` — the same ordered prefix the serializer's `decorations()` writes.
 *  Exception-safe like the chapter layer's tagContentOf: an untaggable schema renders nothing. */
export function metaDecorations(v: Value): string[] {
  if (isPointer(v)) return [];
  const m = ((v as Node).meta ?? {}) as { schema?: Value; yo?: boolean; set?: boolean };
  const out: string[] = [];
  if (m.schema !== undefined) {
    try { out.push(schemaTagToken(m.schema)); } catch { /* untaggable content stays invisible */ }
  }
  if (m.yo === true) out.push("!!yo");
  if (m.set === true) out.push("!!set");
  return out;
}

/** The node's tag INNER text (`meta.schema` through the serializer's spelling, no `!!<…>`
 *  wrapper) — the tag cell's edit text and the edit API's `meta` facet. Null: no tag, or
 *  untaggable content. */
export function schemaTextOf(v: Value): string | null {
  if (isPointer(v)) return null;
  const sch = ((v as Node).meta ?? {}) as { schema?: Value };
  if (sch.schema === undefined) return null;
  try { return schemaTagToken(sch.schema).slice(3, -1); } catch { return null; }
}

/** The BLOCK SCALAR face of a node's raw: the authored `|` / `|-` / `>` … header and the
 *  de-indented body lines (the parser's normalized raw). Null: not a block scalar. */
export function blockRawOf(v: Value): { header: string; lines: string[] } | null {
  if (isPointer(v)) return null;
  const raw = (v as { raw?: string }).raw;
  if (typeof raw !== "string" || !raw.includes("\n")) return null;
  const [header, ...lines] = raw.split("\n");
  if (!/^[|>][+-]?$/.test(header)) return null;
  return { header, lines };
}

/** The node's `&` anchor tokens for display — the canonical own-line spelling (`&` + body). */
export function anchorDecorations(v: Value): string[] {
  if (isPointer(v)) return [];
  const anchors = (((v as Node).meta ?? {}) as { anchors?: Anchor[] }).anchors ?? [];
  return anchors.map((a) => "&" + anchorBody(a));
}

// ---------------------------------------------------------------------------- //
// IR navigation (read-only helpers over the parser types)
// ---------------------------------------------------------------------------- //

/** The node at `path` (entry indices), or null. Pointers are opaque leaves here. */
export function nodeAt(doc: Document, path: Path): Node | null {
  let cur: Value = doc.root;
  for (const i of path) {
    if (isPointer(cur)) return null;
    const e: Entry | undefined = (cur as Node).entries?.[i];
    if (!e) return null;
    cur = e.value;
  }
  return isPointer(cur) ? null : (cur as Node);
}

export function entryAt(doc: Document, path: Path): Entry | null {
  if (path.length === 0) return null;
  const parent = nodeAt(doc, path.slice(0, -1));
  return parent?.entries?.[path[path.length - 1]] ?? null;
}

/** Is the node a CONTAINER for editing purposes (it holds entries / may hold them)? */
export const isContainer = (n: Node): boolean => n.kind === "mapping";

/** The authored BRACKET of a flow container: `[` when `array`, else `{` (the bracket-authored
 *  law — `array` is the IR's authored bit, never re-derived from the entries). */
export const bracketOf = (n: Node): "[" | "{" => ((n as { array?: boolean }).array ? "[" : "{");

/** Is this container written FLOW (one line) or SPREAD (K&R — the json5p switch)? */
export const isFlow = (n: Node): boolean => n.meta?.style === "flow" || isSpread(n);
export const isSpread = (n: Node): boolean => (n.meta as { concrete?: string } | undefined)?.concrete === "json5p";
