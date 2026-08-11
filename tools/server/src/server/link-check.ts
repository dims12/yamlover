// THE LINK INVARIANT: every in-tree prose link resolves to a node. The engine scans the
// links (resolve.ts scanTextLinks — the same frames the move planner uses, so a link the
// doctor passes is exactly a link a move keeps alive) and the store answers existence.
// A dead link is CONTENT, not corruption — a `warning` diagnostic (validate.ts
// `link/dead-target`), logged at startup and on every reconcile, listed by /api/doctor.
// This retires the class of silent breakage the dogfooding reports kept finding: a link
// can no longer die invisibly, whatever killed it (a move, a migration, a hand edit).

import * as path from 'node:path';
import type { Document } from '../../../parser/ts/src/ir.ts';
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
