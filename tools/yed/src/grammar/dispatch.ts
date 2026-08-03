// THE DISPATCH TABLE — the editor's whole key grammar in ONE pure function. A keystroke is
// interpreted against the SITE the caret stands in (which kind of cell, inside which kind of
// container, at which edge) and becomes an INTENT from a small closed set; the projection then
// APPLIES the intent (cells.tsx `runIntent`) through the host's actions. What a key MEANS lives
// here and only here — the per-cell handlers hold no grammar of their own, which is what makes
// the same edit behave identically in every context (THE LAW, yed-*.matrix).
//
// YAMLOVER_EDITOR.yo mirrors this table state for state; keep the two in sync (the table
// test iterates the diagram's transitions against `interpret`).

/** WHERE the caret stands. Everything the grammar may branch on — nothing else may. */
export interface Site {
  /** The kind of cell under the caret. `gapClose` is the position past a flow token's closer,
   *  `gapQuote` past a closing quote; `key` is a key cell inside a flow token; `atom` is a
   *  non-text cell the caret stands ON (a pointer) — deletable, walkable, not editable;
   *  `tag` is a node's editable `!!<…>` tag cell (its INNER text). */
  cell: "holeEntry" | "holeValue" | "token" | "quotedInner" | "key" | "gapClose" | "gapQuote" | "atom" | "tag" | "anchors";
  /** The container the caret's entry lives in. */
  container: "block" | "flowMap" | "flowSeq";
  /** For gaps: the kind of the token AROUND this one (undefined ⇒ not nested in a flow token). */
  outer?: "map" | "seq";
  /** The cell's text state / caret edges. */
  textEmpty: boolean;
  caretAtStart: boolean;
  caretAtEnd: boolean;
  /** The entry's lifecycle (Backspace on an empty cell branches on these). */
  entryDecided: boolean;
  entryCommitted: boolean;
  /** gapClose only: the token holds nothing (`[]` / `{}`). */
  tokenEmpty?: boolean;
  /** Multi-line cells: whether the caret stands on the first/last visual line (vertical arrows
   *  cross cells only from an edge line; inside, they stay the browser's). Default true. */
  caretFirstLine?: boolean;
  caretLastLine?: boolean;
  /** Token cells only: the cursor holds a `|`/`>` BLOCK spelling (a newline in the text — an
   *  input can never hold one). Enter is the textarea's newline, not a commit. */
  blockToken?: boolean;
}

export type Dir = -1 | 1;

/** WHAT a keystroke means. The closed set — an implementation exists once per member. */
export type Intent =
  | { kind: "move"; dir: Dir }              // cross to the neighbouring position
  | { kind: "indent" }                      // Tab in a block container
  | { kind: "dedent" }                      // Shift-Tab in a block container
  | { kind: "nextElement"; spread: boolean }// `,` (inline) / Enter-with-text (own row) in a token
  | { kind: "spreadOrClose" }               // Enter on an EMPTY cell in a token: allocate the row;
                                            //   an unspreadable token closes instead (its one exit)
  | { kind: "closeToken"; closer: "]" | "}" } // the closer finishes the token
  | { kind: "tokenKey" }                    // `:` past a closer — the token becomes the entry's KEY
  | { kind: "quotedKey" }                   // `:` past a closing quote — the string becomes the KEY
  | { kind: "refuse" }                      // consumed with the error ring (a visible refusal)
  | { kind: "commit"; submit: boolean }     // Enter / blur lands the cell's content
  | { kind: "keyCommit" }                   // Enter in a flow KEY cell: commit the key, spread
  | { kind: "nestValue" }                   // Enter in an empty block value hole: nested block
  | { kind: "undoMarker" }                  // Backspace, empty, uncommitted decided entry
  | { kind: "removeLevel" }                 // Backspace, empty: one structure level goes
  | { kind: "reopenToken" }                 // Backspace past the closer of an EMPTY token
  | { kind: "reopenQuote" }                 // Backspace/← past a closing quote: back inside
  | { kind: "join" }                        // Backspace at the head of a token's first line
  | { kind: "quoteExitNext" }               // `,` past a closing quote inside a token
  | { kind: "quoteExitClose"; closer: "]" | "}" } // closer past a closing quote inside a token
  | { kind: "siblingAfter" }                // Enter at a gap: a fresh element after this one
  | { kind: "siblingBefore" }               // Enter at the HEAD of a committed row: the row is
                                            //   pushed down, a fresh sibling hole opens BEFORE it
  | { kind: "nop" };                        // consumed, nothing happens (Enter in an empty
                                            //   entry hole must not insert a DOM newline)

export interface Key {
  key: string;
  shift?: boolean;
}

const inFlow = (s: Site): boolean => s.container !== "block";
const closerOf = (s: Site): "]" | "}" => (s.container === "flowSeq" ? "]" : "}");

/** `interpret(key, site) → Intent | null`. Null means the key is NOT the grammar's — it falls
 *  through to the browser (text entry in an editable cell; nothing at all in a gap). */
export function interpret(k: Key, s: Site): Intent | null {
  // ---- the gap past a flow token's closer -------------------------------------------------- //
  if (s.cell === "gapClose") {
    if (k.key === "Backspace") return s.tokenEmpty ? { kind: "reopenToken" } : { kind: "move", dir: -1 };
    if (k.key === "," && s.outer) return { kind: "nextElement", spread: false };
    if ((k.key === "]" || k.key === "}") && s.outer) return { kind: "closeToken", closer: k.key };
    if (k.key === ":") return s.outer === "seq" ? { kind: "refuse" } : { kind: "tokenKey" };
    // Enter at the gap: a fresh SIBLING of the entry that owns this token — in a block container
    // too (`m: {}` + Enter opens the next row), not only inside another token. The applier
    // no-ops for the one token that has no owning entry (the document root).
    if (k.key === "Enter") return { kind: "siblingAfter" };
    return universalNav(k);
  }
  // ---- the gap past a closing quote -------------------------------------------------------- //
  if (s.cell === "gapQuote") {
    if (s.outer && k.key === ",") return { kind: "quoteExitNext" };
    if (s.outer && (k.key === "]" || k.key === "}")) return { kind: "quoteExitClose", closer: k.key };
    if (k.key === ":") return { kind: "quotedKey" };
    if (k.key === "Enter") return { kind: "commit", submit: true };
    if (k.key === "Backspace" || k.key === "ArrowLeft") return { kind: "reopenQuote" };
    return universalNav(k);
  }
  // ---- an ATOM the caret stands ON (a pointer) — deletable, walkable, NOT editable --------- //
  if (s.cell === "atom") {
    if (k.key === "Backspace") return { kind: "removeLevel" };  // the ladder: the value goes, a name survives
    if (k.key === "," && inFlow(s)) return { kind: "nextElement", spread: false };
    if ((k.key === "]" || k.key === "}") && inFlow(s)) {
      return k.key === closerOf(s) ? { kind: "closeToken", closer: k.key } : { kind: "refuse" };
    }
    if (k.key === "Enter") return { kind: "nop" };              // PICK later — claimed-to-swallow, greyed
    if (k.key.length === 1) return { kind: "refuse" };          // typing into an atom RINGS
    return universalNav(k);
  }
  // ---- the node's `!!<…>` TAG cell — its inner text is native; the grammar owns the edges --- //
  if (s.cell === "tag") {
    // Enter: the tag is DONE — commit and step onto the value; on an EMPTIED cell it is the
    // drop (the same landing removeLevel gives, caret on the node's own cell)
    if (k.key === "Enter") return s.textEmpty ? { kind: "removeLevel" } : { kind: "keyCommit" };
    // Backspace on the emptied cell DROPS the tag (one press, one level: the tag line goes,
    // the node stays); at the head of a non-empty one it walks out, like every text cell
    if (k.key === "Backspace" && s.textEmpty) return { kind: "removeLevel" };
    if (k.key === "Backspace" && !s.textEmpty && s.caretAtStart) return { kind: "move", dir: -1 };
    if (k.key === "Tab") return { kind: "move", dir: k.shift ? -1 : 1 };
    if (k.key === "ArrowLeft" && s.caretAtStart) return { kind: "move", dir: -1 };
    if (k.key === "ArrowRight" && s.caretAtEnd) return { kind: "move", dir: 1 };
    if (k.key === "ArrowUp") return { kind: "move", dir: -1 };
    if (k.key === "ArrowDown") return { kind: "move", dir: 1 };
    return null; // printables and everything else: native text editing in the cell
  }
  // ---- a `&` ANCHOR row — one row, one anchor; text is native, the grammar owns the edges -- //
  if (s.cell === "anchors") {
    // Enter commits the row (an emptied one commits as the removal — same landing either way)
    if (k.key === "Enter") return { kind: "commit", submit: true };
    if (k.key === "Backspace" && s.textEmpty) return { kind: "removeLevel" }; // the row goes
    if (k.key === "Backspace" && !s.textEmpty && s.caretAtStart) return { kind: "move", dir: -1 };
    if (k.key === "Tab") return { kind: "move", dir: k.shift ? -1 : 1 };
    if (k.key === "ArrowLeft" && s.caretAtStart) return { kind: "move", dir: -1 };
    if (k.key === "ArrowRight" && s.caretAtEnd) return { kind: "move", dir: 1 };
    if (k.key === "ArrowUp") return { kind: "move", dir: -1 };
    if (k.key === "ArrowDown") return { kind: "move", dir: 1 };
    return null; // printables: native text editing
  }
  // ---- a KEY cell inside a flow token ------------------------------------------------------ //
  if (s.cell === "key") {
    if (k.key === "Enter") return { kind: "keyCommit" }; // commit the key; the pair takes its row
    // an EMPTIED key + Backspace un-names the pair (one press, one level): `{key: 12}` with the
    // key deleted becomes `{12}` — the incomplete pair, drawn and not written — and the ladder
    // continues instead of jamming on a key nothing could remove
    if (k.key === "Backspace" && s.textEmpty) return { kind: "undoMarker" };
    return flowCommon(k, s, /*textual*/ true);
  }
  // ---- the inner text of a quoted cell — `,` and closers are CHARACTERS here --------------- //
  if (s.cell === "quotedInner") {
    return inFlow(s) ? flowCommon(k, s, /*textual*/ true) : null;
  }
  // ---- token cells and holes --------------------------------------------------------------- //
  const flowIntent = inFlow(s) ? flowCommon(k, s, /*textual*/ false) : null;
  if (flowIntent) return flowIntent;
  if (k.key === "Tab") return inFlow(s) ? { kind: "move", dir: k.shift ? -1 : 1 } : k.shift ? { kind: "dedent" } : { kind: "indent" };
  // a BLOCK token's Enter is a newline IN THE BODY — native in the textarea, never a commit or
  // a sibling gesture (leaving the cell commits; that is the block's boundary)
  if (k.key === "Enter" && s.cell === "token" && s.blockToken === true) return null;
  if (k.key === "Enter") {
    // Enter at the HEAD of a committed row (a token cell, caret before the first character):
    // the text-editor gesture — the row is pushed DOWN and a fresh sibling hole opens BEFORE
    // the entry. Only a block TOKEN cell has this edge (flow Enter never reaches here — the
    // flow grammar consumed it above; a hole's typed text is not a row yet).
    if (!s.textEmpty && s.cell === "token" && s.caretAtStart && !s.caretAtEnd) return { kind: "siblingBefore" };
    if (!s.textEmpty) return { kind: "commit", submit: true }; // holes classify first (cells.tsx)
    if (s.cell === "holeValue" && !inFlow(s)) return { kind: "nestValue" };
    return { kind: "nop" }; // consumed: Enter must never type a newline into a hole
  }
  if (k.key === "Backspace" && s.textEmpty) {
    // an uncommitted DECIDED entry undoes its marker (the colon/dash — or, in flow, whatever the
    // entry decided); anything else removes one structure level. ONE PRESS, ONE LEVEL.
    return !s.entryCommitted && s.entryDecided ? { kind: "undoMarker" } : { kind: "removeLevel" };
  }
  if (k.key === "Backspace" && !s.textEmpty && s.caretAtStart) return { kind: "move", dir: -1 };
  // the WALK LAW is universal: at a cell edge the horizontal arrows cross to the neighbour, in
  // block containers exactly as inside flow tokens
  if (k.key === "ArrowLeft" && s.caretAtStart) return { kind: "move", dir: -1 };
  if (k.key === "ArrowRight" && s.caretAtEnd) return { kind: "move", dir: 1 };
  if (k.key === "ArrowUp" && (s.caretFirstLine ?? true)) return { kind: "move", dir: -1 };
  if (k.key === "ArrowDown" && (s.caretLastLine ?? true)) return { kind: "move", dir: 1 };
  return null;
}

/** The grammar every cell INSIDE a flow token shares. `textual` — the caller's text owns `,`,
 *  the closers and Enter (a quoted string's characters; a key's characters). */
function flowCommon(k: Key, s: Site, textual: boolean): Intent | null {
  if (!textual) {
    if (k.key === ",") return { kind: "nextElement", spread: false };
    if (k.key === "]" || k.key === "}") {
      return (k.key === closerOf(s)) ? { kind: "closeToken", closer: k.key } : { kind: "refuse" };
    }
    if (k.key === "Enter") return s.textEmpty ? { kind: "spreadOrClose" } : { kind: "nextElement", spread: true };
  }
  if (k.key === "Backspace" && !s.textEmpty && s.caretAtStart) return { kind: "join" }; // may not consume
  if (k.key === "Tab") return { kind: "move", dir: k.shift ? -1 : 1 };
  if (k.key === "ArrowLeft" && s.caretAtStart) return { kind: "move", dir: -1 };
  if (k.key === "ArrowRight" && s.caretAtEnd) return { kind: "move", dir: 1 };
  return null;
}

/** A gap's universal navigation: arrows and Tab cross positions; everything else passes through. */
function universalNav(k: Key): Intent | null {
  if (k.key === "ArrowRight" || k.key === "ArrowDown") return { kind: "move", dir: 1 };
  if (k.key === "ArrowLeft" || k.key === "ArrowUp") return { kind: "move", dir: -1 };
  if (k.key === "Tab") return { kind: "move", dir: k.shift ? -1 : 1 };
  return null;
}
