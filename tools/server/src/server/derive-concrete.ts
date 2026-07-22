// Concrete DERIVATION — the policy deciding where a NEW child of a directory-backed parent is
// ENCODED. This module is deliberately tiny and pure (no I/O): it is the part meant to be
// refined over time (per-schema rules, explicit per-node concretes, size heuristics, …) while
// the mechanics (mkdir, body splicing) stay in engine-api.ts.
//
// v1 rule:
//   - a KEYED CONTAINER child (it has entries of its own — an omni counts) → a nested REAL
//     DIRECTORY named by the key; its own children re-derive recursively.
//   - everything else — a keyed scalar, any ordinal (keyless) child, a flow one-liner — →
//     the parent directory's `.yamlover/body.yamlover` overlay (created on demand). A keyless
//     child cannot be a directory: a directory member needs a name.
// An explicit `concrete:` on the edit always overrides this derivation (engine-api's existing
// member-creation branches run first).

export type MemberEncoding = "body" | "dir";

/** Where a NEW child of a directory-backed parent is encoded (v1 rule above). */
export function deriveMemberEncoding(child: { keyed: boolean; container: boolean }): MemberEncoding {
  return child.keyed && child.container ? "dir" : "body";
}

/** The observed state of a DIRECTORY edit target — everything the routing decision needs.
 *  The caller gathers it (engine-api owns the I/O and the index); the decision lives here. */
export interface DirTargetState {
  hasBody: boolean; // `.yamlover/body.yamlover` exists on disk
  indexedAsDocument: boolean; // the index knows the directory as a document root
}

export type DirEditRoute = MemberEncoding | "document";

/** Where an edit against a directory target routes:
 *  - `dir`      — the child derives to a nested real directory ({@link deriveMemberEncoding});
 *  - `document` — the directory is an ESTABLISHED document (its body exists on disk AND the
 *    index knows it): the ordinary document route applies, with the body's own positional
 *    index space;
 *  - `body`     — everything else: the edit lands in the directory's own body overlay,
 *    materialized on demand.
 *  Disk and index must AGREE for `document` — the same rule for every directory, the served
 *  root included (it is always index-flagged a document root, even before any body exists;
 *  a body born earlier in the current batch exists on disk while the index is still stale).
 *  In both half-states `body` is correct: the edit targets the dir's OWN body either way. */
export function deriveDirEditRoute(target: DirTargetState, child?: { keyed: boolean; container: boolean }): DirEditRoute {
  if (child && deriveMemberEncoding(child) === "dir") return "dir";
  return target.hasBody && target.indexedAsDocument ? "document" : "body";
}
