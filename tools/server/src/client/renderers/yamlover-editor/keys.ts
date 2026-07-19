// The projectional editor's typing grammar — PURE decisions, no DOM. A hole cell feeds its current
// text here on every input; the returned action tells the editor which cells to materialize (MPS
// style: the structure appears as you type, with paired delimiters projected and the caret placed
// in the fresh inner cell). `entryStage` marks a hole that has not chosen its entry shape yet
// (`- ` / `key:` / `!!<` apply there); a VALUE hole reuses the same grammar minus the meta tag —
// `- ` / `k: ` in value position open a nested container (block children of this entry).

export type HoleAction =
  | { kind: "ordinal" }                       // typed `- ` — the entry (or a nested child) is keyless
  | { kind: "keyed"; key: string; viaEnter: boolean } // `k:` + space (inline value) or + Enter (nested block)
  | { kind: "quote"; quote: '"' | "'"; rest: string } // opening quote — pair it, caret inside
  | { kind: "flowMap" }                       // `{` — container + keyed hole, `}` projected
  | { kind: "flowSeq" }                       // `[` — container + ordinal hole, `]` projected
  | { kind: "pointer"; rest: string }         // `*` — a reference cell
  | { kind: "metaTag" }                       // `!!<` — a meta-tag cell (entry stage only)
  | { kind: "block" }                         // `|` — a block-scalar (multiline) cell
  | { kind: "text" }                          // anything else — keep accumulating as a plain token
  | null;                                     // nothing decisive yet

/** A key token: bare (conservative — letters/digits/_/./- with inner spaces) up to the colon. */
const KEYED = /^([^\s:#"'{}[\],*&!|>-][^:#]*):([ ]|$)/;

/** Classify the full current `text` of a hole. `entryStage` gates `!!<`; `enterPressed` lets a
 *  bare `k:` (no trailing space) resolve as keyed on Enter. Browsers render a contentEditable's
 *  trailing/collapsing spaces as NON-BREAKING — normalized here so a typed space IS a space. */
export function classifyHoleInput(text: string, entryStage: boolean, enterPressed = false): HoleAction {
  text = text.replace(/\u00a0/g, " ");
  if (text === "") return null;
  if (text === "-" ) return null;              // could still become `- ` or a negative number
  if (text.startsWith("- ")) return { kind: "ordinal" };
  if (text[0] === '"' || text[0] === "'") return { kind: "quote", quote: text[0] as '"' | "'", rest: text.slice(1) };
  if (text[0] === "{") return { kind: "flowMap" };
  if (text[0] === "[") return { kind: "flowSeq" };
  if (text[0] === "*") return { kind: "pointer", rest: text.slice(1) };
  if (entryStage && text.startsWith("!!<")) return { kind: "metaTag" };
  if (entryStage && (text === "!" || text === "!!" || text === "!!<")) return null; // building the sigil
  if (text === "|") return { kind: "block" };
  const m = KEYED.exec(text);
  // the trigger mirrors SOURCE typing: `k: ` (space) → the value inline on this row;
  // `k:` + Enter → the value on the NEXT rows (a nested block)
  if (m && m[2] === " ") return { kind: "keyed", key: m[1].trim(), viaEnter: false };
  if (m && enterPressed) return { kind: "keyed", key: m[1].trim(), viaEnter: true };
  if (m && m[2] === "" && !enterPressed) return null; // `k:` typed — wait for space/Enter (or more text)
  return { kind: "text" };
}

/** Typed spaces are spaces: a contentEditable renders them as NON-BREAKING (U+00A0) — normalize
 *  before any grammar or commit reads the text (token cells and holes; quoted/block prose is
 *  left alone, paste fidelity matters there). */
export const normalizeSpaces = (text: string): string => text.replace(/\u00a0/g, " ");

/** A quoted key line: `"key": …` (the quotes are part of the authored key token). */
const QUOTED_KEYED = /^("(?:[^"\\]|\\.)*")\s*:(?:\s+(.*))?$/;

/** A COMMITTED scalar cell whose text was re-edited into `key: value` (or a bare `key:`) — the
 *  restructure trigger of `scalar_committed` (a mistyped token is not a dead end). A QUOTED
 *  `"key": value` restructures too (`quoted` reports it). Returns the key and the remaining
 *  value token ("" when none was typed yet), or null when the text is not a keyed line at all.
 *  Non-breaking spaces (a contentEditable's rendering of typed spaces) are normalized first. */
export function keyedEditParts(raw: string): { key: string; rest: string; quoted?: boolean } | null {
  const text = raw.replace(/\u00a0/g, " ");
  const q = QUOTED_KEYED.exec(text);
  if (q) {
    try {
      return { key: JSON.parse(q[1]) as string, rest: (q[2] ?? "").trim(), quoted: true };
    } catch {
      return null;
    }
  }
  const m = KEYED.exec(text);
  if (!m) return null;
  return { key: m[1].trim(), rest: text.slice(m[0].length).trim() };
}

/** Serialize a quoted cell's INNER text back to a source token in its quote style. */
export function quoteSource(inner: string, quote: '"' | "'"): string {
  return quote === '"' ? JSON.stringify(inner) : `'${inner.replace(/'/g, "''")}'`;
}

/** The inner (display) text of a quoted source token, or null when `src` is not simply quoted. */
export function unquoteSource(src: string): { inner: string; quote: '"' | "'" } | null {
  if (src.length >= 2 && src[0] === '"' && src.endsWith('"')) {
    try { return { inner: JSON.parse(src) as string, quote: '"' }; } catch { return null; }
  }
  if (src.length >= 2 && src[0] === "'" && src.endsWith("'")) {
    return { inner: src.slice(1, -1).replace(/''/g, "'"), quote: "'" };
  }
  return null;
}
