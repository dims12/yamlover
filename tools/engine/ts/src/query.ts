// The QUERY evaluator (PLAN.md 3g) — colon-grammar match templates over the Store
// (SEPARATOR.md; the acceptance corpus lives in ../test/query.cases.ts).
//
// A query is a bare colon path whose portions may be MATCHERS:
//   keys/indices        team, [1], 'quoted key', cat\:dog   (the pointer fragment — ≤1 each)
//   wildcards           ?  (any key)   [?]  (any position, incl. anchor-created entries)
//   descent             ...            (contain-only, descendant-or-self, pre-order)
//   uplinks             ..  (spine)    ?..  (all parents)   key..   []..   (M2)
//   value tests         31  true  null  >10  >=10  <10  <=10  !=x  =text  ='spacey text'
//   metadata tests      !!<type: integer>  !!<format: x-yamlover-tag>  !!<*…$defs:tag>
//   combo               `TEST key` — value-test the current node, then step
//
// Results are COMPACT COLON store paths, in WALK ORDER, deduplicated keep-first (the
// O1/O2 rulings). Evaluation never errors on a missing target — it yields ∅.
//
// Resolution rides the Store's edge table: ref edges are stored already resolved
// (transitive deref baked in at index time), anchor-created entries are the `back`
// edges (member → container), so wildcards/uplinks are single indexed lookups.

import type { Store, NodeRow } from './store.ts';
import { parsePointer } from '../../../parser/ts/src/pointer.ts';
import { parseYamlover } from '../../../parser/ts/src/yamlover.ts';
import { isPointer } from '../../../parser/ts/src/ir.ts';

export type Portion =
  | { kind: 'key'; name: string }
  | { kind: 'index'; n: number }
  | { kind: 'anykey' }
  | { kind: 'anypos' }
  | { kind: 'descend' }
  | { kind: 'spine' }
  | { kind: 'up'; sel: 'any' | 'keyless' | string }
  | { kind: 'valtest'; op: '=' | '!=' | '>' | '>=' | '<' | '<='; value: string | number | boolean | null }
  | { kind: 'meta'; type?: string; format?: string; schema?: string }
  | { kind: 'combo'; test: Portion & { kind: 'valtest' }; then: Portion[] };

export interface Query {
  base: { scope: 'current' } | { scope: 'document' } | { scope: 'parent' } | { scope: 'link'; authority: string; world?: boolean };
  portions: Portion[];
}

export function parseQuery(text: string): Query {
  let rest = text.trim();
  let base: Query['base'] = { scope: 'current' };
  let world = false;
  if (rest.startsWith(':::')) { rest = rest.slice(3); base = { scope: 'link', authority: '' }; world = true; }
  else if (rest.startsWith('::')) { rest = rest.slice(2); base = { scope: 'link', authority: '' }; }
  else if (rest.startsWith(':')) { rest = rest.slice(1); base = { scope: 'document' }; }
  const raws = splitPortions(rest);
  if (base.scope === 'link') {
    const auth = raws.shift();
    if (auth === undefined || auth === '') throw new SyntaxError(`query: "::" needs an authority in "${text}"`);
    base = { scope: 'link', authority: keyName(auth), world };
  } else if (base.scope === 'current' && raws[0] === '..') {
    // a LEADING `..` is the parent scope opener; later `..` portions are spine steps
    base = { scope: 'parent' };
    raws.shift();
  }
  const portions: Portion[] = [];
  for (const r of raws) portions.push(...parsePortion(r));
  return { base, portions };
}

/** Split on unescaped/unquoted `:`, with `!!<…>` portions atomic; trim the `: ` styling. */
function splitPortions(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q !== null) { cur += c; if (c === q) q = null; continue; }
    if (c === '\\' && i + 1 < s.length) { cur += c + s[i + 1]; i++; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === '!' && s.startsWith('!!<', i)) {
      const close = s.indexOf('>', i);
      if (close < 0) throw new SyntaxError(`query: unterminated "!!<…>" in "${s}"`);
      cur += s.slice(i, close + 1);
      i = close;
      continue;
    }
    if (c === ':') { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out.filter((p) => p !== '');
}

const CMP = /^(>=|<=|!=|=|>|<)/;

function parsePortion(r: string): Portion[] {
  if (r === '...') return [{ kind: 'descend' }];
  if (r === '..') return [{ kind: 'spine' }];
  if (r === '?..') return [{ kind: 'up', sel: 'any' }];
  if (r === '[]..') return [{ kind: 'up', sel: 'keyless' }];
  if (r.startsWith('!!<') && r.endsWith('>')) return [parseMeta(r.slice(3, -1))];
  {
    // combo first, so `30 ..` reads as value-test + step (not as the up-key "30 ")
    const sp = unquotedSpace(r);
    if (sp > 0) {
      const head = parseValTest(r.slice(0, sp));
      if (head !== null) return [{ kind: 'combo', test: head, then: parsePortion(r.slice(sp + 1).trim()) }];
      throw new SyntaxError(`query: a key containing a space must be quoted ("${r}")`);
    }
  }
  if (r.endsWith('..') && !r.endsWith('\\..') && r.length > 2) {
    return [{ kind: 'up', sel: keyName(r.slice(0, -2)) }];
  }
  if (r === '?') return [{ kind: 'anykey' }];
  if (r === '[?]') return [{ kind: 'anypos' }];
  if (r.endsWith('[?]') && !r.endsWith('\\[?]')) {
    // the position wildcard as a portion SUFFIX: `pets[?]` = key pets, then any position
    return [...parsePortion(r.slice(0, -3)), { kind: 'anypos' }];
  }
  const test = parseValTest(r);
  if (test !== null) return [test];
  // a plain key portion, possibly quoted/escaped with [n] suffixes — the pointer fragment
  const steps = parsePointer(r).steps;
  return steps.map((st) =>
    st.sel === 'key' ? { kind: 'key', name: st.name } as Portion :
    st.sel === 'index' ? { kind: 'index', n: st.n } as Portion :
    { kind: 'spine' } as Portion);
}

function parseValTest(r: string): (Portion & { kind: 'valtest' }) | null {
  const m = CMP.exec(r);
  if (m) {
    const lit = literal(r.slice(m[0].length).trim(), /*bareWordsOk*/ true);
    return { kind: 'valtest', op: m[0] as never, value: lit };
  }
  // bare literals: numbers / true / false / null test the value; bare WORDS are keys
  const t = r.trim();
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return { kind: 'valtest', op: '=', value: Number(t) };
  if (t === 'true') return { kind: 'valtest', op: '=', value: true };
  if (t === 'false') return { kind: 'valtest', op: '=', value: false };
  if (t === 'null') return { kind: 'valtest', op: '=', value: null };
  return null;
}

function literal(t: string, bareWordsOk: boolean): string | number | boolean | null {
  if ((t[0] === "'" || t[0] === '"') && t[t.length - 1] === t[0]) {
    return t.slice(1, -1).replace(t[0] === "'" ? /''/g : /\\"/g, t[0]);
  }
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return Number(t);
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (bareWordsOk) return t;
  throw new SyntaxError(`query: bad literal "${t}"`);
}

function parseMeta(inner: string): Portion {
  const t = inner.trim();
  if (t.startsWith('*')) {
    const p = parsePointer(t.slice(1).trim());
    const last = p.steps[p.steps.length - 1];
    if (!last || last.sel !== 'key') throw new SyntaxError(`query: bad schema matcher "!!<${inner}>"`);
    return { kind: 'meta', schema: last.name };
  }
  const root = parseYamlover(t).root;
  const out: Portion & { kind: 'meta' } = { kind: 'meta' };
  for (const e of root.entries ?? []) {
    if (isPointer(e.value) || e.value.kind !== 'scalar') continue;
    if (e.key === 'type') out.type = String(e.value.value);
    if (e.key === 'format') out.format = String(e.value.value);
  }
  if (out.type === undefined && out.format === undefined) {
    throw new SyntaxError(`query: a "!!<…>" matcher needs type:/format: or a schema pointer ("${inner}")`);
  }
  return out;
}

function unquotedSpace(s: string): number {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q !== null) { if (c === q) q = null; continue; }
    if (c === '\\') { i++; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === '!' && s.startsWith('!!<', i)) {
      const close = s.indexOf('>', i);
      if (close < 0) return -1;
      i = close;
      continue;
    }
    if (c === ' ') return i;
  }
  return -1;
}

function keyName(portion: string): string {
  const steps = parsePointer(portion).steps;
  if (steps.length !== 1 || steps[0].sel !== 'key') throw new SyntaxError(`query: bad name portion "${portion}"`);
  return steps[0].name;
}

// ──────────────────────────── evaluation over the Store ────────────────────────────

/** The yamlover project's world URI (mirrors mounts.ts; local literal avoids an import cycle). */
const YAMLOVER_AUTHORITY = 'yamlover.inthemoon.net';

export function evalQuery(s: Store, text: string, from = ':'): string[] {
  const q = parseQuery(text);
  let binds: string[];
  switch (q.base.scope) {
    case 'current': binds = [from]; break;
    case 'parent': binds = compact(spineParent(s, from) === null ? [] : [spineParent(s, from)!]); break;
    case 'document': binds = [docRootOf(s, from)]; break;
    case 'link': {
      // The yamlover world URI is the self-import alias (mirrors resolve.ts): `::: yamlover.inthemoon.net:…`
      // ≡ `:: yamlover:…` (IMPORTS.md §4).
      let authority = q.base.authority;
      if (q.base.world === true && authority === YAMLOVER_AUTHORITY) authority = 'yamlover';
      // SELF-IMPORT absorption (mirrors resolve.ts): `:: yamlover: …` ≡ `:: …` when the served root
      // IS the project — the `yamlover` key is de-materialized (walk.ts), so bind to root `:` and let
      // the steps land on the real `:tags:…` / `:$defs:…`. When a `yamlover` node exists (subdir /
      // foreign bundled graft) it is the bind, as before.
      if (authority === 'yamlover' && childByKey(s, ':', 'yamlover') === null) { binds = [':']; break; }
      const hit = childByKey(s, ':', authority);
      binds = hit === null ? [] : [hit];
      break;
    }
  }
  for (const p of q.portions) {
    binds = dedup(step(s, binds, p));
    if (binds.length === 0) break;
  }
  return dedup(binds);
}

function step(s: Store, binds: string[], p: Portion): string[] {
  const out: string[] = [];
  for (const b of binds) {
    switch (p.kind) {
      case 'key': {
        const hit = childByKey(s, b, p.name);
        if (hit !== null) out.push(hit);
        break;
      }
      case 'index': {
        const row = s.db.prepare(
          "SELECT to_path AS t FROM edge WHERE from_path = ? AND kind IN ('contain','ref') AND pos = ? LIMIT 1",
        ).get(b, p.n) as { t: string } | undefined;
        if (row) out.push(row.t);
        break;
      }
      case 'anykey': {
        for (const r of ownEntries(s, b)) if (r.label !== null) out.push(r.to);
        for (const r of anchorEntries(s, b)) if (r.label !== null) out.push(r.member);
        break;
      }
      case 'anypos': {
        for (const r of ownEntries(s, b)) out.push(r.to);
        for (const r of anchorEntries(s, b)) out.push(r.member);
        break;
      }
      case 'descend': out.push(...descend(s, b)); break;
      case 'spine': {
        const up = spineParent(s, b);
        if (up !== null) out.push(up);
        break;
      }
      case 'up': out.push(...uplinks(s, b, p.sel)); break;
      case 'valtest': if (valOk(s.node(b), p)) out.push(b); break;
      case 'meta': if (metaOk(s, b, p)) out.push(b); break;
      case 'combo': {
        if (!valOk(s.node(b), p.test)) break;
        let inner = [b];
        for (const t of p.then) inner = step(s, inner, t);
        out.push(...inner);
        break;
      }
    }
  }
  return out;
}

function ownEntries(s: Store, p: string): { to: string; label: string | null }[] {
  return (s.db.prepare(
    "SELECT to_path AS t, label FROM edge WHERE from_path = ? AND kind IN ('contain','ref') ORDER BY pos",
  ).all(p) as { t: string; label: string | null }[]).map((r) => ({ to: r.t, label: r.label }));
}

/** Anchor-created entries OF container `p`: the back edges landing on it (member → p),
 *  projected after the container's own entries, ordered by member path (URIs.md). */
function anchorEntries(s: Store, p: string): { member: string; label: string | null }[] {
  return (s.db.prepare(
    "SELECT from_path AS f, label FROM edge WHERE to_path = ? AND kind = 'back' ORDER BY from_path",
  ).all(p) as { f: string; label: string | null }[]).map((r) => ({ member: r.f, label: r.label }));
}

function childByKey(s: Store, p: string, name: string): string | null {
  const own = s.db.prepare(
    "SELECT to_path AS t FROM edge WHERE from_path = ? AND kind IN ('contain','ref') AND label = ? LIMIT 1",
  ).get(p, name) as { t: string } | undefined;
  if (own) return own.t;
  const anchored = s.db.prepare(
    "SELECT from_path AS f FROM edge WHERE to_path = ? AND kind = 'back' AND label = ? ORDER BY from_path LIMIT 1",
  ).get(p, name) as { f: string } | undefined;
  return anchored ? anchored.f : null;
}

function spineParent(s: Store, p: string): string | null {
  const row = s.db.prepare(
    "SELECT from_path AS f FROM edge WHERE to_path = ? AND kind = 'contain' LIMIT 1",
  ).get(p) as { f: string } | undefined;
  return row ? row.f : null;
}

/** The uplink fan-out (M2): containment + ref edges INTO me (their holders), plus the
 *  containers of my own `back` (anchor/membership) declarations. */
function uplinks(s: Store, p: string, sel: 'any' | 'keyless' | string): string[] {
  const out: string[] = [];
  const label = sel === 'any' || sel === 'keyless' ? null : sel;
  const contains = s.db.prepare(
    sel === 'any'
      ? "SELECT from_path AS x FROM edge WHERE to_path = ? AND kind = 'contain'"
      : "SELECT from_path AS x FROM edge WHERE to_path = ? AND kind = 'contain' AND label " + (sel === 'keyless' ? 'IS NULL' : '= ?'),
  );
  const backs = s.db.prepare(
    sel === 'any'
      ? "SELECT to_path AS x FROM edge WHERE from_path = ? AND kind = 'back'"
      : "SELECT to_path AS x FROM edge WHERE from_path = ? AND kind = 'back' AND label " + (sel === 'keyless' ? 'IS NULL' : '= ?'),
  );
  const refs = s.db.prepare(
    sel === 'any'
      ? "SELECT from_path AS x FROM edge WHERE to_path = ? AND kind = 'ref'"
      : "SELECT from_path AS x FROM edge WHERE to_path = ? AND kind = 'ref' AND label " + (sel === 'keyless' ? 'IS NULL' : '= ?'),
  );
  const args = (q: ReturnType<Store['db']['prepare']>): { x: string }[] =>
    (label === null ? q.all(p) : q.all(p, label)) as { x: string }[];
  for (const r of args(contains)) out.push(r.x);
  for (const r of args(backs)) out.push(r.x);
  for (const r of args(refs)) out.push(r.x);
  return out;
}

function descend(s: Store, p: string): string[] {
  const out: string[] = [p];
  const kids = s.db.prepare(
    "SELECT to_path AS t FROM edge WHERE from_path = ? AND kind = 'contain' ORDER BY pos",
  ).all(p) as { t: string }[];
  for (const k of kids) out.push(...descend(s, k.t));
  return out;
}

function docRootOf(s: Store, p: string): string {
  let cur: string | null = p;
  while (cur !== null && cur !== ':') {
    const row = s.node(cur);
    if (row?.meta && (row.meta as { documentRoot?: boolean }).documentRoot === true) return cur;
    cur = spineParent(s, cur);
  }
  return ':';
}

function valOk(row: NodeRow | null, t: Portion & { kind: 'valtest' }): boolean {
  if (!row || row.type !== 'scalar') return false;
  const v = row.value as string | number | boolean | null;
  switch (t.op) {
    case '=': return v === t.value;
    case '!=': return v !== t.value;
    case '>': return typeof v === 'number' && typeof t.value === 'number' && v > t.value;
    case '>=': return typeof v === 'number' && typeof t.value === 'number' && v >= t.value;
    case '<': return typeof v === 'number' && typeof t.value === 'number' && v < t.value;
    case '<=': return typeof v === 'number' && typeof t.value === 'number' && v <= t.value;
  }
}

function metaOk(s: Store, p: string, t: Portion & { kind: 'meta' }): boolean {
  const row = s.node(p);
  if (!row) return false;
  if (t.schema !== undefined) return row.format === `x-yamlover-${t.schema}`;
  if (t.format !== undefined && row.format !== t.format) return false;
  if (t.type !== undefined) {
    switch (t.type) {
      case 'binary': return row.type === 'blob';
      case 'array': return row.is_array;
      case 'object': return row.type === 'mapping' && !row.is_array;
      case 'string': return row.type === 'scalar' && typeof row.value === 'string';
      case 'integer': return row.type === 'scalar' && typeof row.value === 'number' && Number.isInteger(row.value as number);
      case 'number': return row.type === 'scalar' && typeof row.value === 'number';
      case 'boolean': return row.type === 'scalar' && typeof row.value === 'boolean';
      case 'variant': return row.type === 'scalar' && hasOwnChild(s, p);
      default: return false;
    }
  }
  return true;
}

function hasOwnChild(s: Store, p: string): boolean {
  return s.db.prepare("SELECT 1 FROM edge WHERE from_path = ? AND kind IN ('contain','ref') LIMIT 1").get(p) !== undefined;
}

function dedup(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) if (!seen.has(p)) { seen.add(p); out.push(p); }
  return out;
}

function compact(xs: (string | null)[]): string[] {
  return xs.filter((x): x is string => x !== null);
}
