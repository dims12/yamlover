// PATH ⇄ POINTER spelling for the query-cell PICK hosts (the yamlover editor's reference
// cell, the tag picker): a picked TOC node's canonical client path is spelled as a POINTER
// raw in the user's chosen scope (requirement: the typed opener is honored — bare `*`
// spells relative, climbing with `..:` as needed), and an existing pointer raw is read
// back into cells + ladder for editing.
//
// Two spellings deliberately coexist (do not unify): CELLS carry the QUERY spelling
// (quoteKey — what the evaluator's splitPortions reads), while the COMMITTED raw goes
// through the parser's renderPointer/colonSegment (the canonical pointer emission).

import { parsePointer, renderPointer } from "../../../parser/ts/src/pointer.ts";
import type { PointerBase, Step } from "../../../parser/ts/src/ir.ts";
import { Ladder, quoteKey, splitQueryPortions } from "./query-complete";
import { Seg, strToSegs } from "./paths";

/** Client-path segments → pointer steps. `strToSegs` has already percent-DECODED the
 *  keys (the pitfall pointerRaw guards against server-side) — the renderer re-escapes. */
function stepsOf(segs: Seg[]): Step[] {
  return segs.map<Step>((s) => (typeof s === "number" ? { sel: "index", n: s } : { sel: "key", name: s }));
}

/**
 * Spell the canonical client path `target` as a pointer raw (spaced canonical colon form,
 * no `*`) in the given scope:
 *   0 — CURRENT scope, relative to `holder` (the pointer's holding container): a shared
 *       prefix drops, one `..` per remaining holder level, sibling = plain key;
 *   1 — `:` DOCUMENT-rooted: relative to `docRoot` (the document holding the pointer —
 *       `*: x` resolves at the document root, not the served root); a target outside the
 *       document cannot be document-spelled and falls through to the project scope;
 *   2 — `::` project-rooted (first portion = the root child; self-import absorbed);
 *   3 — spelled like 2 (a true `::: uri` spelling needs the project URI, which a picked
 *       path does not carry — the ladder still evaluates `:::` queries typed by hand).
 */
export function spellPointer(target: string, holder: string, ladder: Ladder, docRoot = ":"): string {
  const t = strToSegs(target);
  if (ladder === 1) {
    const d = strToSegs(docRoot);
    if (d.length <= t.length && d.every((s, i) => s === t[i])) {
      return renderPointer({ kind: "pointer", base: { scope: "document" }, steps: stepsOf(t.slice(d.length)), raw: "" });
    }
    ladder = 2; // outside the document — the `:` scope cannot reach it
  }
  if (ladder >= 2) {
    // the root itself (or a root ordinal) has no `::`-portion spelling — document scope
    if (t.length === 0 || typeof t[0] === "number") {
      return renderPointer({ kind: "pointer", base: { scope: "document" }, steps: stepsOf(t), raw: "" });
    }
    return renderPointer({ kind: "pointer", base: { scope: "link", authority: t[0] }, steps: stepsOf(t.slice(1)), raw: "" });
  }
  // ladder 0 — relative to the holder container
  const h = strToSegs(holder);
  let common = 0;
  while (common < h.length && common < t.length && h[common] === t[common]) common++;
  const ups = h.length - common;
  const rest = t.slice(common);
  if (ups === 0 && rest.length === 0) {
    // the holder itself: reach it from its parent; the root has no relative spelling
    if (h.length === 0) return ":";
    return renderPointer({ kind: "pointer", base: { scope: "parent" }, steps: stepsOf(t.slice(-1)), raw: "" });
  }
  const base: PointerBase = ups === 0 ? { scope: "current" } : { scope: "parent" };
  const upSteps: Step[] = Array.from({ length: Math.max(0, ups - 1) }, () => ({ sel: "parent" }) as Step);
  return renderPointer({ kind: "pointer", base, steps: [...upSteps, ...stepsOf(rest)], raw: "" });
}

/** An existing pointer raw → its scope ladder + query-cell portions (indices folded onto
 *  the preceding cell, `..` its own cell, `::`'s authority the first cell). TOLERANT: an
 *  unparsable mid-edit raw guesses the opener and splits the rest as query portions. */
export function pointerCells(raw: string): { ladder: Ladder; portions: string[] } {
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
      else if (st.sel === "index") {
        // an index folds onto the preceding portion (`pets[1]`) — but never onto a `..`
        if (portions.length && !portions[portions.length - 1].endsWith("..")) portions[portions.length - 1] += `[${st.n}]`;
        else portions.push(`[${st.n}]`);
      } else {
        // relindex attaches even to `..` (`..[.-1][.]` — the table rowspan idiom)
        const tok = `[.${st.k === 0 ? "" : (st.k > 0 ? "+" : "") + st.k}]`;
        if (portions.length) portions[portions.length - 1] += tok;
        else portions.push(tok);
      }
    }
    return { ladder, portions };
  } catch {
    const m = /^(:{1,3})/.exec(text);
    const ladder = ((m?.[1].length ?? 0) as Ladder);
    return { ladder, portions: splitQueryPortions(m ? text.slice(m[1].length) : text) };
  }
}

/** A picked path → the machine's `ctx.spell` shape: pointer spelling reduced to cells.
 *  The returned ladder may differ from the asked one where the scope cannot spell the
 *  target (e.g. the root under `::` falls back to the document scope; a pick outside the
 *  document escalates `:` to `::`). */
export function spellCells(target: string, holder: string, ladder: Ladder, docRoot = ":"): { ladder: Ladder; portions: string[] } {
  return pointerCells(spellPointer(target, holder, ladder, docRoot));
}
