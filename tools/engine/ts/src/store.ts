// SQLite-backed store — the persistent property-graph index (ENGINE.md "Data model").
// Maps the IR (parser/ts/src/ir.ts) into two tables, per IR.md "Mapping IR → engine tables":
//
//   node(path, type, format, value, content_hash, size, is_array, meta)   -- path IS identity
//   edge(from_path, to_path, label, kind, pos)   kind ∈ {contain, ref, back, derived}
//
// The DB is a DERIVED cache — always rebuildable from the filesystem (identity is the path,
// no durable ids; ENGINE.md). v1 keeps ONE top-level DB at <root>/.yamlover/index.db; the
// nested-`.yamlover` federation (each DB owns its subtree, stopping at the next) is future.
//
// Uses Node's built-in `node:sqlite` (DatabaseSync) — zero dependency, matching the engine's
// no-npm-install stance (PLAN.md said better-sqlite3; node:sqlite supersedes it on Node ≥22).

import { DatabaseSync } from 'node:sqlite';
import type { Document, Node } from '../../../parser/ts/src/ir.ts';
import { isPointer } from '../../../parser/ts/src/ir.ts';
import { resolveDocument } from './resolve.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS node (
  path         TEXT PRIMARY KEY,
  type         TEXT NOT NULL,            -- mapping | scalar | blob
  format       TEXT,                     -- blob/meta format (e.g. image/png, text/markdown)
  value        TEXT,                     -- scalar self-value, JSON-encoded (scalar/omni only)
  content_hash TEXT,                     -- blob bytes hash (xxh3/BLAKE3 later)
  size         INTEGER,                  -- blob byte size
  is_array     INTEGER NOT NULL DEFAULT 0, -- projection hint: 1 ⇒ all-keyless (pure sequence)
  meta         TEXT                      -- JSON: schema ref, span, …
);
CREATE TABLE IF NOT EXISTS edge (
  from_path TEXT NOT NULL,
  to_path   TEXT NOT NULL,
  label     TEXT,                        -- relation name (entry key); null for keyless
  kind      TEXT NOT NULL,               -- contain | ref | back | derived
  pos       INTEGER                      -- order within parent (contain) for stable TOC order
);
CREATE INDEX IF NOT EXISTS edge_from ON edge (from_path);
CREATE INDEX IF NOT EXISTS edge_to   ON edge (to_path);
`;

export interface NodeRow {
  path: string;
  type: 'mapping' | 'scalar' | 'blob';
  format: string | null;
  value: unknown;            // decoded from the JSON column (scalar self-value)
  content_hash: string | null;
  size: number | null;
  is_array: boolean;
  meta: Record<string, unknown> | null;
}

export interface EdgeRow {
  from: string;
  to: string;
  label: string | null;
  kind: 'contain' | 'ref' | 'back' | 'derived';
  pos: number | null;
}

/** Open (creating if needed) the store DB at an absolute file path, with the schema applied. */
export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  close(): void { this.db.close(); }

  /** Rebuild the whole index from one resolved document: clear, then insert nodes + edges in
   *  a single transaction. (v1 = one document per DB; the directory walker feeds it; ENGINE.md
   *  derived/cache contract — re-runnable from scratch at any time.) */
  indexDocument(doc: Document): void {
    const insNode = this.db.prepare(
      `INSERT OR REPLACE INTO node (path, type, format, value, content_hash, size, is_array, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insEdge = this.db.prepare(
      `INSERT INTO edge (from_path, to_path, label, kind, pos) VALUES (?, ?, ?, ?, ?)`,
    );
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM node; DELETE FROM edge;');
      // nodes + containment edges (one walk; the path scheme matches resolve.ts / buildGraph)
      walkNodes(doc.root, '/', (path, node, parent, label, pos) => {
        const meta = node.meta ? JSON.stringify(node.meta) : null;
        const isArray = node.array || (node.kind === 'mapping' && (node.entries?.every((e) => e.key === null) ?? false));
        const value =
          node.kind === 'scalar' ? JSON.stringify(node.value) : null;
        const format = node.kind === 'blob' ? node.format : formatFromMeta(node);
        const hash = node.kind === 'blob' ? node.contentHash : null;
        const size = node.kind === 'blob' ? node.size : null;
        insNode.run(path, node.kind, format, value, hash, size, isArray ? 1 : 0, meta);
        if (parent !== null) insEdge.run(parent, path, label, 'contain', pos);
      });
      // resolved `*` / `~` reference edges (containment already emitted above). `pos` is the
      // entry's index in its holder, so a positional pointer (`- *file`) keeps its place in an
      // array alongside the inline entries.
      for (const r of resolveDocument(doc)) {
        if (r.target.kind === 'node') insEdge.run(r.holder, r.target.path, r.label, r.edge, r.pos);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Incrementally add ONE annotation document at `annStorePath`, with a forward `target` ref edge
   *  to `targetStorePath`. This avoids a full re-walk/rebuild (which re-reads and re-hashes every
   *  blob in the served tree, blocking the server) on every save. The root is FORCED to the
   *  annotation format so the material's backlink lookup ({@link relationships} `.in`) finds it; the
   *  `target` pointer can't resolve in isolation (it is project-scoped `//…`), so its edge is added
   *  directly from the known target. */
  addAnnotation(annStorePath: string, targetStorePath: string, doc: Document): void {
    const insNode = this.db.prepare(
      `INSERT OR REPLACE INTO node (path, type, format, value, content_hash, size, is_array, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insEdge = this.db.prepare(
      `INSERT INTO edge (from_path, to_path, label, kind, pos) VALUES (?, ?, ?, ?, ?)`,
    );
    this.db.exec('BEGIN');
    try {
      walkNodes(doc.root, annStorePath, (p, node, parent, label, pos) => {
        const meta = node.meta ? JSON.stringify(node.meta) : null;
        const isArray = node.array || (node.kind === 'mapping' && (node.entries?.every((e) => e.key === null) ?? false));
        const value = node.kind === 'scalar' ? JSON.stringify(node.value) : null;
        const format = p === annStorePath ? 'x-yamlover-annotation' : node.kind === 'blob' ? node.format : formatFromMeta(node);
        const hash = node.kind === 'blob' ? node.contentHash : null;
        const size = node.kind === 'blob' ? node.size : null;
        insNode.run(p, node.kind, format, value, hash, size, isArray ? 1 : 0, meta);
        if (parent !== null) insEdge.run(parent, p, label, 'contain', pos);
      });
      insEdge.run(annStorePath, targetStorePath, 'target', 'ref', 0);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Incrementally remove one annotation: its node subtree and every edge touching it. */
  removeAnnotation(annStorePath: string): void {
    const like = annStorePath + '/%';
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM node WHERE path = ? OR path LIKE ?').run(annStorePath, like);
      this.db
        .prepare('DELETE FROM edge WHERE from_path = ? OR from_path LIKE ? OR to_path = ? OR to_path LIKE ?')
        .run(annStorePath, like, annStorePath, like);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** A node's attributes (null if no such path). */
  node(path: string): NodeRow | null {
    const row = this.db.prepare('SELECT * FROM node WHERE path = ?').get(path) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToNode(row) : null;
  }

  /** Direct containment children of a node, in source order (by `pos`). */
  children(path: string): { to: string; label: string | null; pos: number | null }[] {
    return (
      this.db
        .prepare("SELECT to_path, label, pos FROM edge WHERE from_path = ? AND kind = 'contain' ORDER BY pos")
        .all(path) as Record<string, unknown>[]
    ).map((r) => ({ to: r.to_path as string, label: (r.label as string) ?? null, pos: (r.pos as number) ?? null }));
  }

  /** ALL of a node's entries in source order — containment children AND `*`/`~` pointer
   *  entries (ref/back). Unlike {@link children} this keeps positional pointers (`- *file`)
   *  in place, so an array that mixes inline values and pointers (e.g. a chapter's `chunks`)
   *  projects in full. `kind` says whether `to` is an owned child (contain) or a pointer target. */
  entries(path: string): { to: string; label: string | null; pos: number | null; kind: EdgeRow['kind'] }[] {
    return (
      this.db
        .prepare("SELECT to_path, label, pos, kind FROM edge WHERE from_path = ? AND kind IN ('contain','ref','back') ORDER BY pos")
        .all(path) as Record<string, unknown>[]
    ).map((r) => ({ to: r.to_path as string, label: (r.label as string) ?? null, pos: (r.pos as number) ?? null, kind: r.kind as EdgeRow['kind'] }));
  }

  /** Whether a node has any containment children (expandable in the TOC). */
  hasChildren(path: string): boolean {
    const r = this.db.prepare("SELECT 1 FROM edge WHERE from_path = ? AND kind = 'contain' LIMIT 1").get(path);
    return r != null;
  }

  /** The containment subtree rooted at `path`, up to `depth` levels (TOC). A recursive CTE
   *  over `contain` edges — the acyclic spine; ordered by `pos` at each level. */
  toc(path = '/', depth = Infinity): TocNode[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE sub(from_path, to_path, label, pos, lvl) AS (
           SELECT from_path, to_path, label, pos, 1 FROM edge
             WHERE kind = 'contain' AND from_path = ?
           UNION ALL
           SELECT e.from_path, e.to_path, e.label, e.pos, sub.lvl + 1 FROM edge e
             JOIN sub ON e.from_path = sub.to_path
             WHERE e.kind = 'contain' AND sub.lvl < ?
         )
         SELECT s.to_path AS path, s.from_path AS parent, s.label, s.pos, n.type, n.format
           FROM sub s JOIN node n ON n.path = s.to_path
           ORDER BY s.lvl, s.from_path, s.pos`,
      )
      .all(path, depth === Infinity ? Number.MAX_SAFE_INTEGER : depth) as Record<string, unknown>[];
    // assemble a tree
    const byPath = new Map<string, TocNode>();
    const root: TocNode = { path, label: null, type: this.node(path)?.type ?? 'mapping', format: null, children: [] };
    byPath.set(path, root);
    for (const r of rows) {
      const tn: TocNode = {
        path: r.path as string,
        label: (r.label as string) ?? null,
        type: r.type as TocNode['type'],
        format: (r.format as string) ?? null,
        children: [],
      };
      byPath.set(tn.path, tn);
      (byPath.get(r.parent as string) ?? root).children.push(tn);
    }
    return root.children;
  }

  /** Edges in/out of a node, by kind. `derived` inverses are computed here on demand (never
   *  stored) per ENGINE.md — for each ref/back into/out of the node, the reverse direction. */
  relationships(path: string): { out: EdgeRow[]; in: EdgeRow[] } {
    const out = (this.db.prepare("SELECT * FROM edge WHERE from_path = ? AND kind != 'contain'").all(path) as Record<string, unknown>[]).map(rowToEdge);
    const inc = (this.db.prepare("SELECT * FROM edge WHERE to_path = ? AND kind != 'contain'").all(path) as Record<string, unknown>[]).map(rowToEdge);
    // derived inverses: what points AT this node (for the incoming view)
    const derivedIn: EdgeRow[] = inc
      .filter((e) => e.kind === 'ref' || e.kind === 'back')
      .map((e) => ({ from: e.to, to: e.from, label: e.label, kind: 'derived' as const, pos: null }));
    return { out, in: [...inc, ...derivedIn] };
  }
}

export interface TocNode {
  path: string;
  label: string | null;
  type: 'mapping' | 'scalar' | 'blob';
  format: string | null;
  children: TocNode[];
}

/** Walk every Node depth-first, emitting (path, node, parentPath|null, label|null, pos). The
 *  path scheme matches resolve.ts/buildGraph: root '/', keyed child '/key', keyless '[i]'. */
function walkNodes(
  node: Node,
  path: string,
  visit: (path: string, node: Node, parent: string | null, label: string | null, pos: number | null) => void,
  parent: string | null = null,
  label: string | null = null,
  pos: number | null = null,
): void {
  visit(path, node, parent, label, pos);
  if (!node.entries) return;
  node.entries.forEach((e, i) => {
    if (isPointer(e.value)) return; // pointers are edges, not owned child nodes
    const childPath = (path === '/' ? '' : path) + (e.key != null ? '/' + e.key : '[' + i + ']');
    walkNodes(e.value, childPath, visit, path, e.key, i);
  });
}

/** Pull a `format` out of a node's attached schema (the `!!<…>` tag / walker tagging):
 *  - an inline schema Node `{format: …}` → that format (e.g. `text/x-plantuml`);
 *  - a pointer to a hosted schema `*…/$defs/<name>` → `x-yamlover-<name>` (so `$defs/chapter`
 *    routes to the chapter renderer, `$defs/tag` to the tag renderer).
 *  Returns null when there is no schema or it yields no format. */
function formatFromMeta(node: Node): string | null {
  const s = node.meta?.schema;
  if (!s) return null;
  if (isPointer(s)) {
    const last = s.steps[s.steps.length - 1];
    return last?.sel === 'key' ? `x-yamlover-${last.name}` : null;
  }
  if (s.kind !== 'mapping') return null;
  const f = s.entries?.find((e) => e.key === 'format');
  if (f && !isPointer(f.value) && f.value.kind === 'scalar') return String(f.value.value);
  return null;
}

function rowToNode(r: Record<string, unknown>): NodeRow {
  return {
    path: r.path as string,
    type: r.type as NodeRow['type'],
    format: (r.format as string) ?? null,
    value: r.value != null ? JSON.parse(r.value as string) : null,
    content_hash: (r.content_hash as string) ?? null,
    size: (r.size as number) ?? null,
    is_array: !!r.is_array,
    meta: r.meta != null ? JSON.parse(r.meta as string) : null,
  };
}

function rowToEdge(r: Record<string, unknown>): EdgeRow {
  return {
    from: r.from_path as string,
    to: r.to_path as string,
    label: (r.label as string) ?? null,
    kind: r.kind as EdgeRow['kind'],
    pos: (r.pos as number) ?? null,
  };
}
