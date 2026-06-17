// SQLite-backed store — the persistent property-graph index (ENGINE.md "Data model").
// Maps the IR (parser/ts/src/ir.ts) into two tables, per IR.md "Mapping IR → engine tables":
//
//   node(path, type, format, value, content_hash, size, is_array, meta)   -- path IS identity
//   edge(from_path, to_path, label, kind, pos)   kind ∈ {contain, ref, back, derived}
//
// Two reconcile-era side tables (Phase 3e):
//   file(path, hash, size, mtime_ms)  -- the FILE MANIFEST: every filesystem file the walk read,
//     keyed by root-relative path. It is the hash cache that makes a re-index cheap (unchanged
//     blobs are never re-read) and the diff base for change detection / offline reconcile.
//   dangling(from_path, raw, reason)  -- `*`/`~` pointers that did not resolve at index time;
//     reported, never silently dropped (ENGINE.md).
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

// Bump when the table shapes change: a mismatched on-disk index is dropped and rebuilt from
// the filesystem (the DB is a derived cache, so this is always safe).
const SCHEMA_VERSION = 4; // 4: store paths are COLON-form (':team:alice', root ':') — SEPARATOR.md M4

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
CREATE TABLE IF NOT EXISTS file (
  path     TEXT PRIMARY KEY,             -- filesystem path relative to the indexed root (POSIX)
  hash     TEXT,                         -- xxh64:… of the bytes; NULL until the hasher reaches a large blob
  size     INTEGER NOT NULL,
  mtime_ms REAL NOT NULL                 -- (size, mtime) match ⇒ reuse hash without re-reading
);
CREATE TABLE IF NOT EXISTS dangling (
  from_path TEXT NOT NULL,               -- the entry holding the pointer
  raw       TEXT NOT NULL,               -- the pointer text as authored
  reason    TEXT NOT NULL                -- why it did not resolve
);
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

/** One file the walk saw: root-relative POSIX path + content identity. `hash` is null for a
 *  large blob the walk did not read — (size, mtimeMs) is the identity until the background
 *  hasher fills the hash in. */
export interface FileRecord {
  path: string;
  hash: string | null;
  size: number;
  mtimeMs: number;
}

/** A `*`/`~` pointer that did not resolve at index time. */
export interface DanglingRef {
  from: string;
  raw: string;
  reason: string;
}

/** Open (creating if needed) the store DB at an absolute file path, with the schema applied. */
export class Store {
  readonly db: DatabaseSync;
  /** True while the DB holds no usable index (a new file, or a schema-version mismatch dropped
   *  it) — the caller must run a full re-index before serving from it. Cleared by the first
   *  successful {@link indexDocument}. */
  private _stale: boolean;
  get stale(): boolean { return this._stale; }

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    const ver = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (ver !== SCHEMA_VERSION) {
      // a derived cache from another era: drop whatever shape it had and start clean
      this.db.exec('DROP TABLE IF EXISTS node; DROP TABLE IF EXISTS edge; DROP TABLE IF EXISTS file; DROP TABLE IF EXISTS dangling;');
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    }
    this.db.exec(SCHEMA);
    this._stale = ver !== SCHEMA_VERSION;
  }

  close(): void { this.db.close(); }

  /** Rebuild the whole index from one resolved document: clear, then insert nodes + edges in
   *  a single transaction. (v1 = one document per DB; the directory walker feeds it; ENGINE.md
   *  derived/cache contract — re-runnable from scratch at any time.) `files` is the walk's file
   *  manifest (hash cache + diff base — replaced wholesale); pointers that fail to resolve are
   *  recorded in `dangling` instead of being silently dropped. */
  indexDocument(doc: Document, files?: FileRecord[]): void {
    const insNode = this.db.prepare(
      `INSERT OR REPLACE INTO node (path, type, format, value, content_hash, size, is_array, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insEdge = this.db.prepare(
      `INSERT INTO edge (from_path, to_path, label, kind, pos) VALUES (?, ?, ?, ?, ?)`,
    );
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM node; DELETE FROM edge; DELETE FROM dangling;');
      if (files) this.db.exec('DELETE FROM file;');
      // nodes + containment edges (one walk; the path scheme matches resolve.ts / buildGraph)
      walkNodes(doc.root, ':', (path, node, parent, label, pos) => {
        const meta = node.meta ? JSON.stringify(node.meta) : null;
        // the array hint is judged over OWNED entries only — a `~-` back-edge (reverse
        // membership) is not a member of this node and must not make it look like an array
        const owned = node.entries?.filter((e) => e.edge !== 'back') ?? [];
        const isArray = node.array || (node.kind === 'mapping' && owned.length > 0 && owned.every((e) => e.key === null));
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
      const insDangling = this.db.prepare('INSERT INTO dangling (from_path, raw, reason) VALUES (?, ?, ?)');
      for (const r of resolveDocument(doc)) {
        if (r.target.kind === 'node') insEdge.run(r.holder, r.target.path, r.label, r.edge, r.pos);
        else if (r.target.kind === 'unresolved') insDangling.run(r.from, r.raw, r.target.reason);
        // 'external' targets are legitimate out-of-tree links, not dangling
      }
      if (files) {
        const insFile = this.db.prepare('INSERT OR REPLACE INTO file (path, hash, size, mtime_ms) VALUES (?, ?, ?, ?)');
        for (const f of files) insFile.run(f.path, f.hash, f.size, f.mtimeMs);
      }
      this.db.exec('COMMIT');
      this._stale = false;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Patch the index for a SINGLE changed subtree instead of rebuilding the whole DB. `doc` is the
   *  FULL, freshly-resolved document (the cached tree with the changed file's subtree spliced back
   *  in and schemas re-applied) — correctness comes from resolving against the whole tree in
   *  memory; speed comes from writing only the rows under `prefix` (the store path P of the changed
   *  subtree). Every node/edge/dangling/file row whose owner lies under P is replaced; rows outside
   *  P are left untouched (their resolution did not change). `files` is the re-walked manifest for
   *  the subtree (POSIX paths under `relPrefix`).
   *
   *  Returns false WITHOUT writing when the patch is not provably equal to a full rebuild: if any
   *  external `ref`/`back` edge pointing INTO the subtree changed (a referenced node added/removed/
   *  re-resolved), the caller must fall back to a full reindex. The boundary `contain` edge into P
   *  (from P's parent, outside the subtree) is stable and intentionally left in place. */
  patchSubtree(doc: Document, prefix: string, files: FileRecord[], relPrefix: string): boolean {
    const colon = prefix + ':';
    const brack = prefix + '[';
    const underP = (p: string): boolean => p === prefix || p.startsWith(colon) || p.startsWith(brack);

    // Resolve the whole (cached + spliced) tree once: the in-memory resolution is global, so cross-
    // file and inbound pointers are correct; we only choose which rows to write from the result.
    const edges = resolveDocument(doc);

    // GUARD: external ref/back edges INTO the subtree must be identical, else a full rebuild is owed.
    const edgeKey = (from: string, to: string, label: string | null, kind: string, pos: number | null): string =>
      JSON.stringify([from, to, label, kind, pos]);
    const extInNew = edges
      .filter((r) => r.target.kind === 'node' && underP((r.target as { path: string }).path) && !underP(r.holder))
      .map((r) => edgeKey(r.holder, (r.target as { path: string }).path, r.label, r.edge, r.pos))
      .sort();
    const extInOld = (
      this.db.prepare("SELECT from_path, to_path, label, kind, pos FROM edge WHERE kind IN ('ref','back')").all() as Record<string, unknown>[]
    )
      .filter((r) => underP(r.to_path as string) && !underP(r.from_path as string))
      .map((r) => edgeKey(r.from_path as string, r.to_path as string, (r.label as string) ?? null, r.kind as string, (r.pos as number) ?? null))
      .sort();
    if (extInOld.length !== extInNew.length || extInOld.some((k, i) => k !== extInNew[i])) return false;

    const insNode = this.db.prepare(
      `INSERT INTO node (path, type, format, value, content_hash, size, is_array, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insEdge = this.db.prepare(
      `INSERT INTO edge (from_path, to_path, label, kind, pos) VALUES (?, ?, ?, ?, ?)`,
    );
    const insDangling = this.db.prepare('INSERT INTO dangling (from_path, raw, reason) VALUES (?, ?, ?)');
    const insFile = this.db.prepare('INSERT OR REPLACE INTO file (path, hash, size, mtime_ms) VALUES (?, ?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      // delete every row owned by the subtree (node identity / edge source / dangling source under P)
      const delUnder = (col: string, table: string): void => {
        this.db
          .prepare(`DELETE FROM ${table} WHERE ${col} = ? OR substr(${col},1,?) = ? OR substr(${col},1,?) = ?`)
          .run(prefix, colon.length, colon, brack.length, brack);
      };
      delUnder('path', 'node');
      delUnder('from_path', 'edge'); // outgoing + interior contain edges; the inbound boundary edge survives
      delUnder('from_path', 'dangling');
      if (relPrefix) this.db.prepare('DELETE FROM file WHERE substr(path,1,?) = ?').run(relPrefix.length, relPrefix);

      // reinsert the subtree's nodes + INTERIOR containment edges (skip the boundary edge into P)
      walkNodes(doc.root, ':', (p, node, parent, label, pos) => {
        if (!underP(p)) return;
        const meta = node.meta ? JSON.stringify(node.meta) : null;
        const owned = node.entries?.filter((e) => e.edge !== 'back') ?? [];
        const isArray = node.array || (node.kind === 'mapping' && owned.length > 0 && owned.every((e) => e.key === null));
        const value = node.kind === 'scalar' ? JSON.stringify(node.value) : null;
        const format = node.kind === 'blob' ? node.format : formatFromMeta(node);
        const hash = node.kind === 'blob' ? node.contentHash : null;
        const size = node.kind === 'blob' ? node.size : null;
        insNode.run(p, node.kind, format, value, hash, size, isArray ? 1 : 0, meta);
        if (parent !== null && underP(parent)) insEdge.run(parent, p, label, 'contain', pos);
      });
      // reinsert resolved ref/back edges and dangling whose HOLDER is under P
      for (const r of edges) {
        if (!underP(r.holder)) continue;
        if (r.target.kind === 'node') insEdge.run(r.holder, r.target.path, r.label, r.edge, r.pos);
        else if (r.target.kind === 'unresolved') insDangling.run(r.from, r.raw, r.target.reason);
      }
      for (const f of files) insFile.run(f.path, f.hash, f.size, f.mtimeMs);
      this.db.exec('COMMIT');
      this._stale = false;
      return true;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Incrementally add ONE annotation document at `annStorePath`, with a forward `target` ref edge
   *  to `targetStorePath` and (when given) a keyless `back` edge to `tagStorePath` — the applied
   *  tag's `~-` membership. This avoids a full re-walk/rebuild (which re-reads and re-hashes every
   *  blob in the served tree, blocking the server) on every save. The root is FORCED to the
   *  annotation format so the material's backlink lookup ({@link relationships} `.in`) finds it; the
   *  `target`/`~-` pointers can't resolve in isolation (they are project-scoped `//…`), so their
   *  edges are added directly from the known targets. */
  addAnnotation(annStorePath: string, targetStorePath: string, doc: Document, tagStorePath?: string): void {
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
      if (tagStorePath) {
        const pos = (doc.root.entries ?? []).findIndex((e) => e.edge === 'back' && e.key === null);
        insEdge.run(annStorePath, tagStorePath, null, 'back', pos >= 0 ? pos : 0);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Incrementally remove one annotation: its node subtree and every edge touching it. */
  removeAnnotation(annStorePath: string): void {
    const like = annStorePath + ':%';
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

  /** Incrementally add ONE named tag under a taxonomy node (tag creation's write path — the
   *  {@link addAnnotation} of tags): upsert any missing taxonomy ancestors as plain mappings (a
   *  fresh `/tags` has no rows yet), then the tag's subtree and its containment edge. Approximate
   *  by design — the next reconcile re-walks the edited taxonomy body and trues everything up;
   *  these rows only have to answer queries until then. */
  addTag(taxonomyStorePath: string, name: string, pos: number, node: Node): void {
    const insNode = this.db.prepare(
      `INSERT OR REPLACE INTO node (path, type, format, value, content_hash, size, is_array, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insEdge = this.db.prepare(
      `INSERT INTO edge (from_path, to_path, label, kind, pos) VALUES (?, ?, ?, ?, ?)`,
    );
    const hasNode = this.db.prepare('SELECT 1 FROM node WHERE path = ?');
    this.db.exec('BEGIN');
    try {
      const segs = taxonomyStorePath === ':' ? [] : taxonomyStorePath.slice(1).split(':');
      for (let i = 1; i <= segs.length; i++) {
        const p = ':' + segs.slice(0, i).join(':');
        if (hasNode.get(p)) continue;
        insNode.run(p, 'mapping', null, null, null, null, 0, null);
        insEdge.run(i === 1 ? ':' : ':' + segs.slice(0, i - 1).join(':'), p, segs[i - 1], 'contain', null);
      }
      const tagPath = (taxonomyStorePath === ':' ? '' : taxonomyStorePath) + ':' + name;
      walkNodes(node, tagPath, (p, n, parent, label, ps) => {
        const meta = n.meta ? JSON.stringify(n.meta) : null;
        const isArray = n.array || (n.kind === 'mapping' && (n.entries?.every((e) => e.key === null) ?? false));
        const value = n.kind === 'scalar' ? JSON.stringify(n.value) : null;
        const format = n.kind === 'blob' ? n.format : formatFromMeta(n);
        insNode.run(p, n.kind, format, value, n.kind === 'blob' ? n.contentHash : null, n.kind === 'blob' ? n.size : null, isArray ? 1 : 0, meta);
        if (parent !== null) insEdge.run(parent, p, label, 'contain', ps);
      });
      insEdge.run(taxonomyStorePath, tagPath, name, 'contain', pos);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** The persisted file manifest, keyed by root-relative path — the previous walk's view of the
   *  filesystem. Feeds the walker's hash cache and the change diff. */
  manifest(): Map<string, FileRecord> {
    const out = new Map<string, FileRecord>();
    for (const r of this.db.prepare('SELECT * FROM file').all() as Record<string, unknown>[]) {
      out.set(r.path as string, { path: r.path as string, hash: (r.hash as string) ?? null, size: r.size as number, mtimeMs: r.mtime_ms as number });
    }
    return out;
  }

  /** Manifest entries still lacking a content hash (large blobs the walk never read), smallest
   *  first so the background hasher shows progress early. */
  unhashedFiles(limit = -1): FileRecord[] {
    return (
      this.db.prepare('SELECT * FROM file WHERE hash IS NULL ORDER BY size ASC, path ASC LIMIT ?').all(limit) as Record<string, unknown>[]
    ).map((r) => ({ path: r.path as string, hash: null, size: r.size as number, mtimeMs: r.mtime_ms as number }));
  }

  /** Fill in one file's content hash after the fact (the background hasher): updates the
   *  manifest row and the matching blob node, guarded by (size, mtimeMs) — returns false
   *  (writing nothing) when the file changed since it was queued. */
  setFileHash(relPath: string, hash: string, size: number, mtimeMs: number): boolean {
    this.db.exec('BEGIN');
    try {
      const r = this.db
        .prepare('UPDATE file SET hash = ? WHERE path = ? AND size = ? AND mtime_ms = ?')
        .run(hash, relPath, size, mtimeMs);
      if (Number(r.changes) === 0) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.db.prepare("UPDATE node SET content_hash = ? WHERE path = ? AND type = 'blob'").run(hash, ':' + relPath.split('/').join(':'));
      this.db.exec('COMMIT');
      return true;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** The pointers that failed to resolve at index time (ENGINE.md: reported, never dropped). */
  dangling(): DanglingRef[] {
    return (this.db.prepare('SELECT * FROM dangling').all() as Record<string, unknown>[]).map((r) => ({
      from: r.from_path as string, raw: r.raw as string, reason: r.reason as string,
    }));
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
  toc(path = ':', depth = Infinity): TocNode[] {
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
 *  path scheme matches resolve.ts/buildGraph: root ':', keyed child ':key', keyless '[i]'. */
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
    const childPath = (path === ':' ? '' : path) + (e.key != null ? ':' + e.key : '[' + i + ']');
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
