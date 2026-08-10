// `mv` — the engine-MEDIATED move (ENGINE.md tier 1): relocate a file or directory
// inside the served root and rewrite every inbound `*`/`~` pointer in the source files
// (an IDE-style rename refactor — surgical span edits, never a re-render). Refs the
// engine cannot rewrite are REPORTED, never silently dropped. The caller reindexes
// afterwards (engine-api: broadcast(doReindex())).
//
// `mv` itself moves FS-level nodes only (files/directories — path is identity, ENGINE.md).
// An INTRA-DOCUMENT key rename moves nothing on disk, so it goes through `relinkRenamed`
// instead: same planner, same span surgery, keyed by store path rather than FS path.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WalkOptions } from './walk.ts';
import { walkTree, ownerNodePath } from './walk.ts';
import { resolveDocument, scanTextLinks } from './resolve.ts';
import type { RewrittenRef, UnrewrittenRef } from './rewrite.ts';
import { planRewrites, applyEdits, nominalPath, under } from './rewrite.ts';

export interface MvReport {
  from: string;                 // root-relative POSIX path actually moved
  to: string;
  rewritten: RewrittenRef[];
  unrewritten: UnrewrittenRef[];
  editedFiles: string[];        // root-relative files whose text was rewritten
}

export function mv(absRoot: string, fromRel: string, toRel: string, opts: WalkOptions = {}): MvReport {
  const root = path.resolve(absRoot);
  const absFrom = path.resolve(root, fromRel);
  const absTo = path.resolve(root, toRel);
  const relFrom = relInside(root, absFrom, 'source');
  const relTo = relInside(root, absTo, 'target');
  for (const rel of [relFrom, relTo]) {
    for (const seg of rel.split('/')) {
      if (seg.startsWith('.')) throw new Error(`mv: hidden/overlay segments are not movable ("${seg}" in "${rel}")`);
    }
  }
  if (!fs.existsSync(absFrom)) throw new Error(`mv: source does not exist: ${relFrom}`);
  // NOTE: on a case-insensitive FS this also rejects a case-only rename (existsSync sees
  // the source) — an escape hatch is future work.
  if (fs.existsSync(absTo)) throw new Error(`mv: target already exists: ${relTo}`);
  if (absTo === absFrom || absTo.startsWith(absFrom + path.sep)) {
    throw new Error(`mv: cannot move "${relFrom}" into itself`);
  }

  // plan against the CURRENT tree (fresh walk — spans are exact, never stale)
  const { doc } = walkTree(root, opts);
  const edges = resolveDocument(doc);
  const plan = planRewrites(doc, edges, storeOf(relFrom), storeOf(relTo), { root, textLinks: scanTextLinks(doc) });

  // apply text edits BEFORE the rename — spans point at the old file locations
  const editedFiles: string[] = [];
  for (const [uri, edits] of plan.edits) {
    fs.writeFileSync(uri, applyEdits(fs.readFileSync(uri, 'utf8'), edits));
    editedFiles.push(path.relative(root, uri).split(path.sep).join('/'));
  }
  fs.mkdirSync(path.dirname(absTo), { recursive: true });
  fs.renameSync(absFrom, absTo);
  return { from: relFrom, to: relTo, rewritten: plan.rewritten, unrewritten: plan.unrewritten, editedFiles };
}

/** Relink after UNMEDIATED moves (watched/offline tiers): the FS already changed and the
 *  stale pointers no longer resolve — match them by their NOMINAL path (what they meant)
 *  under a moved prefix, and rewrite to the new location. Returns the edit report; the
 *  caller reindexes. `from`/`to` are root-relative FS paths.
 *
 *  The diff arrives FILE-level (walk.ts IndexDiff), so a moved directory shows up as its N
 *  moved content/overlay files, never as itself — and a ref points at the directory NODE
 *  (`:privacy`), not at `:privacy:.yo:body.yo`. Normalize first: collapse each overlay file
 *  to the directory that consumes it, then coalesce fully-vacated directories into single
 *  directory-level moves, so the planner sees the move the way tier-1 `mv()` would. */
export function relinkMoved(
  absRoot: string,
  moved: { from: string; to: string }[],
  opts: WalkOptions = {},
): Pick<MvReport, 'rewritten' | 'unrewritten' | 'editedFiles'> {
  const root = path.resolve(absRoot);
  const pairs = coalesceMoved(root, collapseOwners(root, moved));
  return relinkRenamed(absRoot, pairs.map((m) => ({ from: storeOf(m.from), to: storeOf(m.to) })), opts);
}

type MovedPair = { from: string; to: string };

/** A moved OVERLAY file stands for its directory: `X/.yo/body.yo → Y/.yo/body.yo` means the
 *  node `X` moved to `Y`. Judged on the `to` side only (the `from` no longer exists, and
 *  ownerNodePath needs the filesystem to tell a real `index.yo` overlay from a shadowed
 *  member). A pair whose overlay filename itself changed is left alone — no guessing. */
function collapseOwners(root: string, moved: MovedPair[]): MovedPair[] {
  return moved.map((m) => {
    const ownerTo = ownerNodePath(root, m.to);
    if (ownerTo === m.to) return m;
    const tail = m.to.slice(ownerTo.length); // '/.yo/body.yo' or '/index.yo'
    if (!m.from.endsWith(tail)) return m;
    return { from: m.from.slice(0, -tail.length), to: ownerTo };
  });
}

/** Coalesce sibling moves into their parent directory, to a fixed point: a group of entries
 *  `P/a → Q/a, P/b → Q/b, …` becomes the single `P → Q` — but ONLY when the source parent is
 *  GONE from disk (a real `mv P Q` vacates `P`; moving one file out leaves it), and only when
 *  every member kept its own basename (a child renamed during the move stays its own entry).
 *  Nested moved directories converge to the outermost — the map keying dedupes a child's
 *  promoted pair against the parent's own collapsed overlay entry. */
function coalesceMoved(root: string, pairs: MovedPair[]): MovedPair[] {
  const m = new Map(pairs.map((p) => [p.from, p.to]));
  for (let changed = true; changed; ) {
    changed = false;
    const groups = new Map<string, MovedPair[]>();
    for (const [from, to] of m) {
      const pf = parentPath(from);
      const pt = parentPath(to);
      if (pf === null || pt === null) continue;
      const k = pf + '\0' + pt;
      groups.set(k, [...(groups.get(k) ?? []), { from, to }]);
    }
    for (const [k, g] of groups) {
      const [pf, pt] = k.split('\0');
      if (!g.every((e) => baseName(e.from) === baseName(e.to))) continue;
      if (fs.existsSync(path.join(root, pf))) continue; // source dir not fully vacated — partial move
      for (const e of g) m.delete(e.from);
      m.set(pf, pt);
      changed = true;
      break; // the map changed under us — regroup from scratch
    }
  }
  return [...m].map(([from, to]) => ({ from, to }));
}

function parentPath(rel: string): string | null {
  const i = rel.lastIndexOf('/');
  return i < 0 ? null : rel.slice(0, i);
}

function baseName(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1);
}

/** The same repair keyed by STORE PATH rather than FS path — so it also serves the move `mv`
 *  cannot make: an INTRA-DOCUMENT rename (`:human1:pets:pet1` → `:…:pet3`), where nothing on
 *  disk moved but every inbound `*`/`~` pointer still spells the old key. Call it AFTER the
 *  rename is written: the walk is fresh, so the spans are exact, and the stale refs are found
 *  by what they MEANT (nominalPath) rather than by where they now resolve. */
export function relinkRenamed(
  absRoot: string,
  moved: { from: string; to: string }[],
  opts: WalkOptions = {},
): Pick<MvReport, 'rewritten' | 'unrewritten' | 'editedFiles'> {
  const root = path.resolve(absRoot);
  const { doc } = walkTree(root, opts);
  const edges = resolveDocument(doc);
  const textLinks = scanTextLinks(doc); // once — the per-move loop below reuses it
  const rewritten: RewrittenRef[] = [];
  const unrewritten: UnrewrittenRef[] = [];
  // plan ALL moves against the one walk, merge per file, apply ONCE — a second write
  // pass would invalidate the first plan's spans
  const merged = new Map<string, { start: number; end: number; text: string }[]>();
  for (const m of moved) {
    const oldStore = m.from;
    // only refs that still NOMINALLY address the old location (they broke with the move);
    // refs already pointing at the new path (or unrelated) are left alone
    const stale = edges.filter((e) => {
      if (e.target.kind === 'node' && !under(e.target.path, oldStore)) return false; // resolves elsewhere
      const nom = nominalPath(doc, e);
      return nom !== null && under(nom, oldStore);
    });
    // planRewrites matches by RESOLVED target; for stale refs synthesize the match by
    // treating the nominal path as the target frame — reuse the planner with a shim
    const shimmed = stale.map((e) => ({ ...e, target: { kind: 'node' as const, node: doc.root, path: nominalPath(doc, e)! } }));
    const plan = planRewrites(doc, shimmed, oldStore, m.to, { root, textLinks });
    for (const [uri, edits] of plan.edits) merged.set(uri, [...(merged.get(uri) ?? []), ...edits]);
    rewritten.push(...plan.rewritten);
    unrewritten.push(...plan.unrewritten);
  }
  const editedFiles: string[] = [];
  for (const [uri, edits] of merged) {
    fs.writeFileSync(uri, applyEdits(fs.readFileSync(uri, 'utf8'), edits));
    editedFiles.push(path.relative(root, uri).split(path.sep).join('/'));
  }
  return { rewritten, unrewritten, editedFiles };
}

function relInside(root: string, abs: string, what: string): string {
  const rel = path.relative(root, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`mv: ${what} escapes the served root`);
  }
  return rel.split(path.sep).join('/');
}

/** A root-relative FS path as a COLON-form store path (':dir:file.md'). */
function storeOf(rel: string): string {
  return ':' + rel.split('/').join(':');
}
