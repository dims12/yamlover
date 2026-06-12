// `mv` — the engine-MEDIATED move (ENGINE.md tier 1): relocate a file or directory
// inside the served root and rewrite every inbound `*`/`~` pointer in the source files
// (an IDE-style rename refactor — surgical span edits, never a re-render). Refs the
// engine cannot rewrite are REPORTED, never silently dropped. The caller reindexes
// afterwards (engine-api: broadcast(doReindex())).
//
// v1 moves FS-level nodes only (files/directories — path is identity, ENGINE.md);
// intra-document key moves are future work.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WalkOptions } from './walk.ts';
import { walkTree } from './walk.ts';
import { resolveDocument } from './resolve.ts';
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
  const plan = planRewrites(doc, edges, storeOf(relFrom), storeOf(relTo), { root });

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
 *  caller reindexes. */
export function relinkMoved(
  absRoot: string,
  moved: { from: string; to: string }[],
  opts: WalkOptions = {},
): Pick<MvReport, 'rewritten' | 'unrewritten' | 'editedFiles'> {
  const root = path.resolve(absRoot);
  const { doc } = walkTree(root, opts);
  const edges = resolveDocument(doc);
  const rewritten: RewrittenRef[] = [];
  const unrewritten: UnrewrittenRef[] = [];
  // plan ALL moves against the one walk, merge per file, apply ONCE — a second write
  // pass would invalidate the first plan's spans
  const merged = new Map<string, { start: number; end: number; text: string }[]>();
  for (const m of moved) {
    const oldStore = storeOf(m.from);
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
    const plan = planRewrites(doc, shimmed, oldStore, storeOf(m.to), { root });
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
