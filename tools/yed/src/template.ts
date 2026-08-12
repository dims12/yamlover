// THE TEMPLATE SEAM — the one module that answers "what structure does this decisive gesture
// materialize here". The TEMPLATE-CELLS doctrine (docs/server/editor/yed): a DECIDED entry
// enters the DOCUMENT the moment its marker is typed — always valid, always serializable —
// and the cells drawn are the real node's own faces (the `{`/`[` eager-structure law made
// universal). A wire-illegal shape (a null-valued entry) lands marked `temporary` on the
// entry meta: drawn with the temp frame, WITHHELD by the sync until its first value commit.
//
// OPENNESS (the future-provider seam): every gesture goes through one `Template` shape, and
// the builders take the document and the materialization path — a future meta/JSON-Schema
// aware provider can consult `meta.schema` at that path and enrich the template (offer the
// schema's known keys as cells, pre-type the value cell), the HintProvider precedent applied
// to structure. Likewise the KEYED builder takes a key SPELLING and the nested-spine
// mechanism can chain entries — a future paths-as-keys syntax is a classifier change feeding
// the same chain, never a new materializer.

import type { Cursor, Document, Node, Path } from "./state";
import { quoteSource } from "./grammar/keys";

/** What a decisive gesture materializes: the entry's VALUE node, whether the entry is
 *  wire-illegal until its first commit (`temporary`), and where the caret stands afterward
 *  (a function of the materialized ENTRY's path). */
export interface Template {
  value: Node;
  temporary: boolean;
  cursor: (entryPath: Path) => Cursor;
}

/** The null scalar — the "nothing here yet" value every marker-only entry holds. Serializes
 *  as the bare `key:` / `-` line (minted null spells ''), re-parses to null: document-legal. */
export const nullScalar = (): Node => ({ kind: "scalar", value: null } as unknown as Node);

/** `k: ` / `- ` — the entry materializes with a NULL value, temporary (wire-illegal until a
 *  value lands); the caret stands in the empty PROVISIONAL VALUE CELL (a token cursor the
 *  site layer maps back to the value_hole rows, so the key economics stay untouched). */
export function markerTemplate(): Template {
  return {
    value: nullScalar(),
    temporary: true,
    cursor: (entryPath) => ({ at: "token", path: entryPath, text: "" }),
  };
}

/** `"` / `'` in value position — the EMPTY QUOTED SCALAR: opening quote drawn, caret in the
 *  inner text cell, the closing quote projected from the node's own style. `""` is
 *  wire-legal, so the entry flushes eagerly (no temporary). */
export function quotedTemplate(quote: '"' | "'"): Template {
  return {
    value: { kind: "scalar", value: "", raw: quoteSource("", quote) } as unknown as Node,
    temporary: false,
    cursor: (entryPath) => ({ at: "token", path: entryPath, text: "", quote }),
  };
}

/** `*` in value position — the same materialized-entry law: the entry exists (null value,
 *  temporary — an incomplete pointer has no valid IR, so the PORTIONS stay cursor-held) and
 *  the portion cells render as the value cell's template over the PICK cursor. Commit lands
 *  the parsed pointer and clears temporary; the Backspace floor removes the entry back to
 *  the named hole (the pick removeLevel law, unchanged). */
export function pointerTemplate(): Template {
  return {
    value: nullScalar(),
    temporary: true,
    cursor: (entryPath) => ({ at: "pick", path: entryPath, text: "", ref: { ladder: 0, portions: [""], active: 0 } }),
  };
}

/** Is this node the UNTOUCHED provisional value — the null scalar a marker template minted?
 *  (The site layer maps a token cursor here back to the value_hole rows.) */
export function isProvisionalValue(v: unknown): boolean {
  const n = v as { kind?: string; value?: unknown; raw?: unknown; entries?: unknown };
  return n != null && n.kind === "scalar" && n.value === null && n.raw === undefined && n.entries === undefined;
}

/** The seam's dispatch — today's gestures; a future schema-aware provider wraps or replaces
 *  this, keyed by the same gesture names. `doc`/`path` ride so such a provider can look up
 *  `meta.schema` at the materialization site. */
export function templateFor(
  gesture: "keyed" | "ordinal" | "quote" | "pointer",
  _ctx: { doc: Document; path: Path },
  arg?: '"' | "'",
): Template {
  switch (gesture) {
    case "keyed":
    case "ordinal":
      return markerTemplate();
    case "quote":
      return quotedTemplate(arg ?? '"');
    case "pointer":
      return pointerTemplate();
  }
}
