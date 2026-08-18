// THE LINK INVARIANT: every in-tree prose link resolves to a node. The engine scans the
// links (resolve.ts scanTextLinks — the same frames the move planner uses, so a link the
// doctor passes is exactly a link a move keeps alive) and the store answers existence.
// A dead link is CONTENT, not corruption — a `warning` diagnostic (validate.ts
// `link/dead-target`), logged at startup and on every reconcile, listed by /api/doctor.
// This retires the class of silent breakage the dogfooding reports kept finding: a link
// can no longer die invisibly, whatever killed it (a move, a migration, a hand edit).

import * as path from 'node:path';
import type { Document } from '../../../parser/ts/src/ir.ts';
import { isOverlayKey, LEGACY_OVERLAY_KEY, LEGACY_THUMBNAILS_KEY } from '../../../parser/ts/src/overlay-keys.ts';
import { scanTextLinks } from '../../../engine/ts/src/resolve.ts';
import type { Store } from '../../../engine/ts/src/store.ts';
import type { Diagnostic } from '../validate.ts';

/** Every prose link whose nominal target names no node, as doctor warnings. `&…` targets
 *  are RESERVED (annotations rework) — never checked; unwalkable targets (an external
 *  `:::` world, a relative index) are not locally checkable and pass silently. */
export function deadLinkDiagnostics(doc: Document, store: Store, dataRoot: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const l of scanTextLinks(doc)) {
    if (l.anchor) continue; // reserved `&…` — not checked
    if (l.target === null) continue; // no nominal path to check
    if (store.node(l.target) !== null) continue;
    out.push({
      code: 'link/dead-target',
      severity: 'warning',
      message: `prose link ${l.raw} addresses ${l.target}, which names no node`,
      path: l.from,
      ...(l.uri ? { fsPath: path.relative(dataRoot, l.uri).split(path.sep).join('/') } : {}),
    });
  }
  return out;
}

/** STALE DOUBLED FRAGMENTS: a `fragments:` mapping nested DIRECTLY inside `.yo: fragments:`
 *  (either overlay spelling). Nothing writes this shape any more (the embed walk reads the
 *  flat `.yo: fragments:` row now), but pre-fix annotates over a flat-spelled overlay left it
 *  behind — real fragments buried one level too deep, whose member pointers spell the doubled
 *  `…: fragments: fragments: <slug>` and whose locate can never fire. The doctor surfaces
 *  the damage; the repair is moving the buried children up one level. */
export function doubledFragmentDiagnostics(doc: Document): Diagnostic[] {
  const out: Diagnostic[] = [];
  const walk = (node: unknown, segs: string[]): void => {
    const entries = (node as { entries?: { key?: string | null; value?: unknown }[] }).entries ?? [];
    entries.forEach((e, i) => {
      const key = typeof e.key === 'string' ? e.key : null;
      if (
        key === 'fragments' &&
        segs[segs.length - 1] === 'fragments' &&
        isOverlayKey(segs[segs.length - 2])
      ) {
        out.push({
          code: 'annotations/doubled-fragments',
          severity: 'warning',
          message: `a \`fragments:\` mapping nested inside \`${segs[segs.length - 2]}: fragments:\` — left by a pre-fix annotate over the flat spelling`,
          path: ':' + [...segs, key].join(':'),
          hint: 'move its child fragments up one level, into the enclosing fragments mapping',
        });
      }
      if (e.value !== null && typeof e.value === 'object') walk(e.value, [...segs, key ?? String(i)]);
    });
  };
  walk(doc.root, []);
  return out;
}

/** LEGACY OVERLAY SPELLINGS: a document-internal `yo:` or `yamlover-thumbnails:` key. Read
 *  forever — nothing is broken — but the canonical spelling is `.yo:` / `.yo: thumbnails:`,
 *  and the migration script rewrites a whole tree in one pass. Severity `info`: a nudge the
 *  doctor lists, never a refusal. */
export function legacyOverlaySpellingDiagnostics(doc: Document): Diagnostic[] {
  const out: Diagnostic[] = [];
  const walk = (node: unknown, segs: string[]): void => {
    const entries = (node as { entries?: { key?: string | null; value?: unknown }[] }).entries ?? [];
    entries.forEach((e, i) => {
      const key = typeof e.key === 'string' ? e.key : null;
      if (key === LEGACY_OVERLAY_KEY || key === LEGACY_THUMBNAILS_KEY) {
        out.push({
          code: 'annotations/legacy-overlay-spelling',
          severity: 'info',
          message: `the legacy \`${key}:\` spelling — the canonical key is ${key === LEGACY_OVERLAY_KEY ? '`.yo:`' : '`.yo: thumbnails:`'}`,
          path: ':' + [...segs, key].join(':'),
          hint: 'migrate the tree with tools/migrate-dot-yo.mjs (legacy spellings stay readable forever)',
        });
      }
      if (e.value !== null && typeof e.value === 'object') walk(e.value, [...segs, key ?? String(i)]);
    });
  };
  walk(doc.root, []);
  return out;
}

/** The unique dead TARGET store paths — the client's currency (GET /api/dead-links):
 *  NavLink marks a resolved link whose target is in this set as `.deadlink`, closing the
 *  UI half of the invariant (a dead link is visible where it stands, not just logged). */
export function deadLinkTargets(doc: Document, store: Store): string[] {
  const out = new Set<string>();
  for (const l of scanTextLinks(doc)) {
    if (l.anchor || l.target === null) continue;
    if (store.node(l.target) === null) out.add(l.target);
  }
  return [...out];
}

/** The capped log rendering: every dead link once, first `max` spelled out. */
export function logDeadLinks(found: Diagnostic[], log: (line: string) => void, max = 8): void {
  for (const d of found.slice(0, max)) {
    log(`validate ${d.severity}: ${d.code} at ${d.path ?? d.fsPath ?? '?'} — ${d.message}`);
  }
  if (found.length > max) log(`validate warning: link/dead-target — and ${found.length - max} more (GET /api/doctor lists all)`);
}
