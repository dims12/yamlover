// POINTER PORTIONS - the pure spelling layer of the decomposed reference entry. A pointer is
// `*` + a SCOPE LADDER (`:` ? 0-3) + colon-separated PORTIONS; entering one is the key-value
// gesture repeated: type a portion, `:` commits it and opens the next. While being entered the
// portions live in the CURSOR alone (cursor-level commits - the document holds the OLD pointer
// or nothing until the full reference parses); this module spells raw ? portions both ways.
//
// Moved out of the server client (pointer-spell.ts / query-complete.ts) so the grammar works
// without any server: completion hints are a separate, optional service - hints are never
// validators and never gates on typing.

import { keyPortion, parsePointer } from "../../../parser/ts/src/pointer.ts";

/** The SCOPE LADDER a pointer opens with (docs/language/pointers/scopes - more colons, wider scope):
 *  0 = current (bare), 1 = `:` document, 2 = `::` project, 3 = `:::` world. */
export type Ladder = 0 | 1 | 2 | 3;

/** Spell a key as a pointer/query portion - the parser's canonical key spelling, plus
 *  quoting for the query grammar's own matcher/comparison heads (a bare key must not read
 *  as one when the same cells drive a query surface). */
export function quoteKey(k: string): string {
  const matcherLike = /^(\?|\.\.\.?|\?\.\.)$/.test(k) || k.endsWith("..");
  const comparisonHead = /^[=!<>]/.test(k);
  const literalLike = /^(true|false|null|[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)$/.test(k);
  if (matcherLike || comparisonHead || literalLike) return `'${k.replace(/'/g, "''")}'`;
  return keyPortion(k);
}

/** Split a whole path/query text into its portions - split on unescaped/unquoted top-level
 *  `:`, `!!<...>` atomic - but TOLERANT: an unterminated quote or `!!<...>` becomes the final
 *  portion instead of throwing (the text is mid-edit). Portions are trimmed; empties dropped. */
export function splitPortions(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q !== null) { cur += c; if (c === q) q = null; continue; }
    if (c === "\\" && i + 1 < text.length) { cur += c + text[i + 1]; i++; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === "!" && text.startsWith("!!<", i)) {
      const close = text.indexOf(">", i);
      if (close < 0) { cur += text.slice(i); break; } // unterminated - owns the rest
      cur += text.slice(i, close + 1);
      i = close;
      continue;
    }
    if (c === ":") { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out.filter((p) => p !== "");
}

/** The full raw a portion row spells under a scope ladder (no `*`): the canonical spaced
 *  colon form. Empty cells (a fresh trailing cell mid-edit) are skipped; no cells = the
 *  scope's bare opener ("" for the current scope - names nothing, refuses downstream). */
export function joinPortions(portions: string[], ladder: Ladder): string {
  const parts = portions.filter((p) => p.trim() !== "");
  const opener = ["", ":", "::", ":::"][ladder];
  if (!parts.length) return opener;
  return ladder === 0 ? parts.join(": ") : opener + " " + parts.join(": ");
}

/** An existing pointer raw ? its scope ladder + portions (indices folded onto the preceding
 *  cell, `..` its own cell, `::`'s authority the first cell). TOLERANT: an unparsable
 *  mid-edit raw guesses the opener and splits the rest as plain portions. */
export function portionsOfRaw(raw: string): { ladder: Ladder; portions: string[] } {
  const text = raw.trim();
  if (text === "") return { ladder: 0, portions: [] };
  try {
    const p = parsePointer(text);
    let ladder: Ladder;
    const portions: string[] = [];
    switch (p.base.scope) {
      case "current":
        ladder = 0;
        break;
      case "parent":
        ladder = 0;
        portions.push("..");
        break;
      case "document":
        ladder = 1;
        break;
      case "link":
        ladder = p.base.world === true ? 3 : 2;
        portions.push(quoteKey(p.base.authority));
        break;
    }
    for (const st of p.steps) {
      if (st.sel === "parent") portions.push("..");
      else if (st.sel === "key") portions.push(quoteKey(st.name));
      else if (st.sel === "nullkey") portions.push("~"); // the NULL key - its own bare-tilde portion
      else if (st.sel === "index") {
        // a position is its own bare-digit portion now (`pets: 1`); `[n]` is read-only legacy
        portions.push(String(st.n));
      } else if (st.sel === "append") {
        portions.push("-"); // the keyless segment
      } else {
        // relindex attaches even to `..` (`..[.-1][.]` - the table rowspan idiom)
        const tok = `[.${st.k === 0 ? "" : (st.k > 0 ? "+" : "") + st.k}]`;
        if (portions.length) portions[portions.length - 1] += tok;
        else portions.push(tok);
      }
    }
    return { ladder, portions };
  } catch {
    const m = /^(:{1,3})/.exec(text);
    const ladder = ((m?.[1].length ?? 0) as Ladder);
    return { ladder, portions: splitPortions(m ? text.slice(m[1].length) : text) };
  }
}
