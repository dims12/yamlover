// COMPLETION HINTS - the optional, advisory hint service over the reference PORTION cells
// (grammar/portions.ts). A provider answers "what could the active portion be" from whatever
// knowledge it has - the pure editor's IN-MEMORY document (docHintProvider below), a server's
// live tree (the server host's provider) - and the portion cells draw the dropdown.
//
// THE DOCTRINE (pointer-hints): hints ADVISE and never validate or gate typing. The portion
// grammar's states (dispatch.ts "portion") work identically with no provider at all; a picked
// hint only REPLACES the active cell's text - committing stays the grammar's Enter.

import type { Document, Entry, Node, Path, Value } from "./state";
import { isPointer } from "../../parser/ts/src/ir.ts";
import { quoteKey, type Ladder } from "./grammar/portions";

export interface Hint {
  insert: string; // replaces the active portion's text on pick
  label?: string; // dropdown text (default: insert)
  detail?: string; // dim right-hand note (a value preview, "container", ...)
  /** A GRAMMAR row (`..`, `-`), not a real child: offered and pickable, but it never ARMS —
   *  armed acceptance is for names; a grammar token stays one ArrowDown away. */
  op?: true;
}

/** What the active portion cell asks: the scope ladder, the committed portions LEFT of the
 *  active cell, the active cell's live text, and the cursor's container path (where the bare
 *  scope resolves - the hole's own container / the pointer's holder). The DOCUMENT and the
 *  mount's server addresses ride along so a provider can be one stable value (no closures
 *  over render state): the in-memory provider walks `doc`, a server one spells `path`
 *  against `host` into a wire address. */
export interface HintQuery {
  ladder: Ladder;
  portions: string[];
  prefix: string;
  path: Path;
  doc: Document;
  host?: { base: string; doc: string };
}

/** The seam: sync or async - the cells treat both alike (Promise.resolve). A provider that
 *  cannot answer (an unresolvable context, a scope it has no knowledge of) returns []. */
export type HintProvider = (q: HintQuery) => Hint[] | Promise<Hint[]>;

/** Rank hints against the typed prefix: prefix matches first, then substrings; non-matches
 *  and the EXACT match drop (the text already typed needs no hint). Case-insensitive; an
 *  empty prefix keeps everything (capped). */
export function rankHints(hints: Hint[], prefix: string, max = 12): Hint[] {
  const p = prefix.trim().toLowerCase();
  if (p === "") return hints.slice(0, max);
  return hints
    .map((h) => {
      const hay = [h.insert.toLowerCase(), (h.label ?? "").toLowerCase()];
      const r = hay.includes(p) ? -1 : hay.some((s) => s.startsWith(p)) ? 0 : hay.some((s) => s.includes(p)) ? 1 : -1;
      return { h, r };
    })
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.h.insert.localeCompare(b.h.insert))
    .slice(0, max)
    .map((x) => x.h);
}

// ---------------------------------------------------------------------------- //
// The IN-MEMORY document provider - the debug editor's hints, no server anywhere.
// ---------------------------------------------------------------------------- //

/** One dropdown row's dim preview of an entry's value. */
function preview(v: Value): string {
  if (isPointer(v)) return "*" + ((v as { raw?: string }).raw ?? "");
  const n = v as Node;
  if (n.kind === "mapping") return `(${(n.entries ?? []).length} entries)`;
  if (n.kind === "scalar") {
    const s = String((n as { raw?: string; value?: unknown }).raw ?? (n as { value?: unknown }).value ?? "");
    return s.length > 24 ? s.slice(0, 23) + "\u2026" : s;
  }
  return `(${String(n.kind)})`;
}

/** A committed portion's plain KEY text: `'quoted'` unwrapped, `\x` unescaped. */
function unspellKey(portion: string): string {
  const t = portion.trim();
  if (t.length >= 2 && (t[0] === "'" || t[0] === '"') && t[t.length - 1] === t[0]) {
    return t.slice(1, -1).replace(t[0] === "'" ? /''/g : /""/g, t[0]);
  }
  return t.replace(/\\(.)/g, "$1");
}

/** Resolve one committed portion against a node: a bare-digit portion by POSITION, `~` the
 *  null key, anything else by string key. A pointer value cannot be walked in memory (no
 *  dereference) - null. */
function stepInto(node: Node, portion: string): Value | null {
  const entries = node.entries ?? [];
  const t = portion.trim();
  if (/^\d+$/.test(t)) return entries[Number(t)]?.value ?? null;
  if (t === "~") return entries.find((e: Entry) => e.key === null && (e as { nullKey?: true }).nullKey === true)?.value ?? null;
  const key = unspellKey(t);
  return entries.find((e: Entry) => e.key === key)?.value ?? null;
}

/** The IN-MEMORY provider: candidates are the resolved context node's OWN entries - keyed
 *  ones spelled as portions (quoteKey), keyless ones as their bare positions. The bare scope
 *  (ladder 0) resolves at the query's container path; `:` at the document root; `::` / `:::`
 *  reach beyond one document - the in-memory provider has nothing to say there ([]). One
 *  stable value: the document rides in on the query itself. */
export const docHints: HintProvider = (q: HintQuery): Hint[] => {
  if (q.ladder >= 2) return [];
  const root = q.doc.root as Node;
  // the WALK STACK from the root down to the scope's start node - `..` portions pop it
  const stack: Node[] = [root];
  if (q.ladder === 0) {
    let cur: Value = root;
    for (const i of q.path) {
      const next: Value | undefined = (cur as Node).entries?.[i]?.value;
      if (next === undefined || isPointer(next)) return [];
      cur = next;
      stack.push(cur as Node);
    }
  }
  for (const portion of q.portions) {
    if (portion.trim() === "") continue; // a skipped empty cell mid-edit
    if (portion.trim() === "..") {
      if (stack.length < 2) return []; // above the document - no in-memory knowledge
      stack.pop();
      continue;
    }
    const next = stepInto(stack[stack.length - 1], portion);
    if (next === null || isPointer(next)) return []; // unresolvable / a deref - no hints
    stack.push(next as Node);
  }
  const at = stack[stack.length - 1];
  const out: Hint[] = [];
  (at.entries ?? []).forEach((e: Entry, i: number) => {
    if (e.key !== null) out.push({ insert: quoteKey(e.key), detail: preview(e.value) });
    else if ((e as { nullKey?: true }).nullKey === true) out.push({ insert: "~", detail: preview(e.value) });
    else out.push({ insert: String(i), label: `[${i}]`, detail: preview(e.value) });
  });
  return out;
};
