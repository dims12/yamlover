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
