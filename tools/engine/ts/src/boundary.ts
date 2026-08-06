// THE DOCUMENT BOUNDARY — where a `:`-scoped reference bottoms out.
//
// A document-scoped pointer (`*: a: b`, and an anchor's `&: a: b`) resolves from the nearest
// enclosing DOCUMENT (docs/language/pointers/scopes). Until now only STORAGE could open a
// document: a parsed file, a `.yo`-overlaid directory, the served root (`NodeMeta.documentRoot`).
// But a self-contained chunk in the MIDDLE of a file is a document in every sense that matters to
// a reference — a `!!yo` data island is plain yamlover exempt from the enclosing schema, and a
// tagged graph is a whole little world drawn on its own. Writing `*: 6: whiskers` inside one, so a
// reference has to count its way back out through the chapter that happens to hold it, makes the
// content depend on where it sits: paste it elsewhere and every pointer breaks.
//
// So a TAG may open a document too. The set is hardcoded here — the schema layer has no way to
// declare "I am a boundary" yet, and one list in one module beats the predicate drifting apart
// between the resolver, the store query, and the projection.
//
// Consulted by: resolve.ts (the `document` scope), query.ts `docRootOf` (the same walk over the
// index), and the server's reference SPELLING, so a ref reads back the way it was written.

import type { Node } from '../../../parser/ts/src/ir.ts';
import { isPointer } from '../../../parser/ts/src/ir.ts';

/** Formats whose tag opens a document. `x-yamlover-xyflow`: a graph drawn from its own root, whose
 *  nodes name each other (`*: whiskers`) exactly as the standalone document it depicts would. */
const BOUNDARY_FORMATS = new Set(['x-yamlover-xyflow']);

/** A node's format as its own tag gives it — the engine's derived one, else the last `$defs` step
 *  of an authored `!!<*…: $defs: X>` (store.ts `formatFromMeta`'s rule, minus the store row). */
function tagFormat(node: Node): string | null {
  if (node.meta?.derivedFormat) return node.meta.derivedFormat;
  const s = node.meta?.schema;
  if (!s || !isPointer(s)) return null;
  const last = s.steps[s.steps.length - 1];
  return last?.sel === 'key' ? `x-yamlover-${last.name}` : null;
}

/** Does a `:`-scoped reference stop HERE? True for a storage document root (`documentRoot`), for a
 *  `!!yo` data island (plain yamlover, exempt from its surroundings — so its references are its
 *  own too), and for a node whose tag is in {@link BOUNDARY_FORMATS}. */
export function isDocumentBoundary(node: Node): boolean {
  const m = node.meta;
  if (!m) return false;
  if (m.documentRoot === true || m.yo === true) return true;
  const f = tagFormat(node);
  return f !== null && BOUNDARY_FORMATS.has(f);
}

/** The same question over an INDEXED node — the store keeps `meta` as parsed JSON and the derived
 *  format in its own column, so the row answers it without the IR. */
export function isBoundaryRow(row: { format?: string | null; meta?: unknown } | undefined): boolean {
  if (!row) return false;
  const m = (row.meta ?? {}) as { documentRoot?: boolean; yo?: boolean };
  if (m.documentRoot === true || m.yo === true) return true;
  return row.format != null && BOUNDARY_FORMATS.has(row.format);
}
