// Completion LOGIC for the breadcrumb's query cells (no UI): the portion model (a whole
// query as a list of cell texts), and the candidate provider that turns one cell's context
// into real-children TreeNode candidates plus the static operator hints.
//
// Key candidates exist for a cell whose prefix could be a key; a value-test / `!!<…>` /
// index tail gets operators only. A hint is never a validator (pointer-hints doctrine):
// any free-typed query still runs as typed.
//
// KNOWN LIMIT: key candidates come from the last segment of each `head: ?` result path.
// A pointer-valued entry dereferences to its TARGET, so such an entry surfaces under its
// target's own name (or not at all when the target is ordinal), not the entry's key.

import { queryTree, TreeNode } from "./api";
import { Seg, strToSegs } from "./paths";

export interface Completion {
  insert: string; // replaces the typed tail on pick
  label?: string; // popup text (default: insert)
  kind: "key" | "operator";
  detail?: string; // dim right-hand note ("any key", "spine parent", …)
}

/** The query grammar's matcher portions, offered alongside the real keys. */
export const OPERATOR_HINTS: Completion[] = [
  { insert: "?", kind: "operator", detail: "any key" },
  { insert: "[?]", kind: "operator", detail: "any position" },
  { insert: "...", kind: "operator", detail: "recursive descent" },
  { insert: "..", kind: "operator", detail: "spine parent" },
  { insert: "?..", kind: "operator", detail: "all parents" },
  { insert: "=", kind: "operator", detail: "value equals" },
  { insert: "!=", kind: "operator", detail: "value differs" },
  { insert: ">", kind: "operator", detail: "value greater" },
  { insert: ">=", kind: "operator", detail: "value at least" },
  { insert: "<", kind: "operator", detail: "value less" },
  { insert: "<=", kind: "operator", detail: "value at most" },
  { insert: "!!<type: >", kind: "operator", detail: "type test" },
  { insert: "!!<format: >", kind: "operator", detail: "format test" },
];

/** Spell a key as a query/pointer portion: quoted when bare spelling would read as a
 *  matcher or break tokenization (spaces, separators, comparison heads, literals). */
export function quoteKey(k: string): string {
  const literalLike = /^(true|false|null|[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)$/.test(k);
  const matcherLike = /^(\?|\.\.\.?|\?\.\.)$/.test(k) || k.endsWith("..");
  const breaksTokens = /[\s:\[\]'"\\=!<>]/.test(k);
  if (!literalLike && !matcherLike && !breaksTokens && k !== "") return k;
  return `'${k.replace(/'/g, "''")}'`;
}

/** Rank candidates against the typed prefix: prefix matches first, then substrings;
 *  non-matches drop (an empty prefix keeps everything). Case-insensitive. */
export function rankKeys(keys: string[], prefix: string, max = 8): string[] {
  const p = prefix.toLowerCase();
  if (p === "") return keys.slice(0, max);
  return keys
    .map((k) => ({ k, r: k.toLowerCase().startsWith(p) ? 0 : k.toLowerCase().includes(p) ? 1 : -1 }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.k.localeCompare(b.k))
    .slice(0, max)
    .map((x) => x.k);
}

// ---------------------------------------------------------------------------
// The BREADCRUMB's portion model: the whole query as a list of cell texts.

/** Split a whole query text into its portions — the client mirror of the evaluator's
 *  splitPortions (engine query.ts): split on unescaped/unquoted top-level `:`, `!!<…>`
 *  atomic — but TOLERANT: an unterminated quote or `!!<…>` becomes the final portion
 *  instead of throwing (the text is mid-edit). Portions are trimmed; empties dropped. */
export function splitQueryPortions(text: string): string[] {
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
      if (close < 0) { cur += text.slice(i); break; } // unterminated — owns the rest
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

/** A canonical client path as breadcrumb cells: one portion per string key, with numeric
 *  segments FOLDED into the preceding portion (`:pets[0]:name` → ["pets[0]", "name"]) —
 *  matching the pointer spelling. A leading ordinal (no preceding key) is its own cell. */
export function portionsFromPath(path: string): string[] {
  const out: string[] = [];
  for (const seg of strToSegs(path)) {
    if (typeof seg === "number" && out.length > 0) out[out.length - 1] += `[${seg}]`;
    else out.push(typeof seg === "number" ? `[${seg}]` : quoteKey(seg));
  }
  return out;
}

/** The SCOPE LADDER a query/pointer opens with (SEPARATOR.md §2 — more colons, wider
 *  scope): 0 = current (bare), 1 = `:` document, 2 = `::` project, 3 = `:::` world. */
export type Ladder = 0 | 1 | 2 | 3;

/** The full query text of a cell row under a scope ladder. Empty cells (the append cell
 *  mid-edit) are skipped; no cells = the scope's own root (`""` for current scope — the
 *  asking node itself). */
export function joinPortionsScoped(portions: string[], ladder: Ladder): string {
  const parts = portions.filter((p) => p.trim() !== "");
  const opener = ["", ":", "::", ":::"][ladder];
  if (!parts.length) return opener;
  return ladder === 0 ? parts.join(": ") : opener + " " + parts.join(": ");
}

/** The breadcrumb's join — always DOCUMENT-scoped (the root cell is the implied `:`). */
export function joinPortions(portions: string[]): string {
  return joinPortionsScoped(portions, 1);
}

/** The children-of-context query for a context spelled by `joinPortionsScoped`: step `?`
 *  from the context node. A bare-current empty context asks `?` at the asking node; a bare
 *  scope opener takes the `?` directly (`":"` → `": ?"`). */
export function childQuery(contextQuery: string): string {
  if (contextQuery === "") return "?";
  if (/^:+$/.test(contextQuery)) return contextQuery + " ?";
  return contextQuery + ": ?";
}

// ---------------------------------------------------------------------------
// The breadcrumb dropdown's candidates: real children as TreeNodes (TOC icons) + operators.

export type Candidate =
  | { kind: "key"; node: TreeNode; insert: string } // insert = the portion spelling of the child's segment
  | { kind: "operator"; insert: string; detail: string };

/** Whether this cell prefix is a position where KEY candidates make sense (mirror of
 *  contextQueryOf's rules): not a value test, not inside `!!<…>`, not index typing. */
function keyContextAllowed(prefix: string): boolean {
  return !/^(!!<|[=!<>])/.test(prefix) && !prefix.includes("[");
}

const MAX_KEY_CANDIDATES = 50; // the dropdown scrolls, like a TOC branch

/** A query-cell candidate provider: `(contextQuery, prefix) → Candidate[]` — the cells
 *  left of the active one joined by `joinPortionsScoped`, and the active cell's live text. */
export type CandidateProvider = (contextQuery: string, prefix: string) => Promise<Candidate[]>;

/** The query-cell candidate provider: the context's REAL children via
 *  `GET /api/query?shape=tree` evaluated AT `at` (whole TreeNodes — the dropdown shows
 *  true TOC rows), ranked prefix-first against the typed cell text, plus prefix-filtered
 *  operator rows. `contextQuery` is the scope-spelled query of the cells left of the
 *  active one (see {@link joinPortionsScoped}). Failures (a context the evaluator rejects
 *  mid-edit) degrade to operators only — hints, never validators. */
export function treeCandidateProvider(at = ":"): CandidateProvider {
  return async (contextQuery: string, prefix: string): Promise<Candidate[]> => {
    let keys: Candidate[] = [];
    if (keyContextAllowed(prefix)) {
      try {
        const nodes = await queryTree(childQuery(contextQuery), at);
        const seen = new Set<string>();
        for (const n of nodes) {
          const segs = strToSegs(n.path);
          const seg: Seg | undefined = segs[segs.length - 1];
          if (seg === undefined) continue;
          const insert = typeof seg === "number" ? `[${seg}]` : quoteKey(seg);
          if (seen.has(insert)) continue;
          seen.add(insert);
          keys.push({ kind: "key", node: n, insert });
        }
        const p = prefix.trim().toLowerCase();
        if (p !== "") {
          const rank = (c: Candidate & { kind: "key" }): number => {
            const hay = [c.node.label.toLowerCase(), c.insert.toLowerCase()];
            if (hay.some((h) => h.startsWith(p))) return 0;
            if (hay.some((h) => h.includes(p))) return 1;
            return -1;
          };
          keys = (keys as (Candidate & { kind: "key" })[])
            .map((c) => ({ c, r: rank(c) }))
            .filter((x) => x.r >= 0)
            .sort((a, b) => a.r - b.r || a.c.node.label.localeCompare(b.c.node.label))
            .map((x) => x.c);
        }
        keys = keys.slice(0, MAX_KEY_CANDIDATES);
      } catch {
        keys = [];
      }
    }
    const ops = OPERATOR_HINTS.filter((o) => o.insert.startsWith(prefix) && o.insert !== prefix)
      .map<Candidate>((o) => ({ kind: "operator", insert: o.insert, detail: o.detail ?? "" }));
    return [...keys, ...ops];
  };
}
