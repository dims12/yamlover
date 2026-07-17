// The renderer for a TABLE node (format `x-yamlover-table` — MARKLOWER.md §Tables): an omni
// node whose keyless entries are the ROWS (arrays of cells), the row keyed `header` is the
// header, keyed `title` is the caption. The table consumes exactly TWO nesting levels — rows,
// then cells. A cell is marklower prose (the default), a CHAPTER (an untagged container cell
// switches back to chapter rules), a NESTED table or a list (entering only by their explicit
// tag — told apart by the mixed marker's stamped format), or a `*` pointer — a pointer to an
// adjacent previous cell is a MERGE. A header cell may carry a `width` sidecar: a proportional
// column weight (AsciiDoc `cols` style), rendered as weight/sum percent via <colgroup>.
//
// Merged cells: the engine resolves the relative-index pointers (`*[.-1]`, `*..[.-1][.]` —
// URIs.md §Relative indexes) transitively to the ORIGIN cell, so every member of a merged
// region arrives as a `$yamloverRef` marker whose `path` IS the origin cell's path. The grid
// therefore detects merges by TARGET PATH + GEOMETRY: a ref cell targeting another cell of
// this grid joins that origin's region; a region renders merged only when it tiles a filled
// rectangle with the origin top-left, all on one side of the header/body boundary (MARKLOWER.md
// §Merged cells). Anything else — a pointer to a non-adjacent cell, a non-cell target, a
// non-rectangular region — renders as an ordinary deref cell, per the spec.
//
// Editing (the chapter's lock): STRING cells edit in place via MarklowerChunkEditor, each cell
// posting its own debounced single-op `/api/edit` emplace at its absolute path `<table>[r][c]`
// — no chapter-style model/diff. Pointer cells and structure (rows/columns) are read-only.

import { useEffect, useRef, useState } from "react";
import { editChunks, fetchNode, NodeJson } from "../api";
import { asLink, asMixed, asRef, scalarValue } from "../render";
import { childPath, escapeYamloverScalar } from "./chapter-model";
import { ListBody, listKind } from "./list";
import { MarklowerChunk } from "./marklower";
import { MarklowerChunkEditor } from "./chunk-editors";
import { useEditing } from "./editing";
import { Chunk } from "./registry";

const MIXED_KEY = "$yamloverMixed";

// ---------------------------------------------------------------------------- //
// The grid model
// ---------------------------------------------------------------------------- //

interface CellModel {
  value: unknown; // the projected cell value (string / mixed marker / ref marker / link marker)
  path: string; // the cell's absolute node path — <row path>[c]
}

interface RowModel {
  cells: CellModel[];
  path: string; // the row's absolute node path — positional for keyless, `:key` for keyed rows
  header: boolean; // the row keyed `header` renders as <th> wherever it is authored
  overflow: number; // cells beyond the inferred column count — a reported inconsistency
}

interface TableGrid {
  title: string | null;
  rows: RowModel[]; // header + body rows, in authored order
  cols: number; // inferred from the first row (the header when present)
  widths: (number | null)[] | null; // per-column proportional weights from the header's `width` sidecars, or null when none authored
}

/** Read a projected table value (a `$yamloverMixed` omni marker, or a plain array of rows for
 *  a fully keyless table) into the grid model. Rows keep their authored order; keyed rows other
 *  than `title` are rows too — the key just names them (MARKLOWER.md §The model). */
export function buildTableGrid(value: unknown, tablePath: string): TableGrid {
  const entries: { key: string | null; value: unknown }[] = Array.isArray(value)
    ? value.map((v) => ({ key: null, value: v }))
    : ((value as Record<string, unknown> | null | undefined)?.[MIXED_KEY] as
        | { entries?: { key: string | null; value: unknown }[] }
        | undefined)?.entries ?? [];

  let title: string | null = null;
  const rows: RowModel[] = [];
  entries.forEach((e, absIndex) => {
    if (e.key === "title") {
      title = typeof e.value === "string" ? e.value : null;
      return;
    }
    // keyed rows address by their key (their store path), keyless by position — the same
    // space the engine's resolved ref markers use, so merge targets compare equal
    const rowPath = childPath(tablePath, e.key ?? absIndex);
    const cells = Array.isArray(e.value) ? e.value : e.value == null ? [] : [e.value];
    rows.push({
      cells: cells.map((c, ci) => ({ value: c, path: childPath(rowPath, ci) })),
      path: rowPath,
      header: e.key === "header",
      overflow: 0,
    });
  });

  // the column count is inferred from the FIRST row — the header when present, else the first
  // row; shorter rows pad (rendering), longer rows are a reported inconsistency
  const first = rows.find((r) => r.header) ?? rows[0];
  const cols = first?.cells.length ?? 0;
  for (const r of rows) r.overflow = Math.max(0, r.cells.length - cols);

  // header `width` sidecars: an omni header cell (scalar + fields) may carry a keyed `width`
  // — a proportional column weight (MARKLOWER.md §Header widths). The cell keeps rendering
  // its self-value; a pointer/merged or non-numeric width contributes nothing (weight 1).
  const header = rows.find((r) => r.header);
  const widths: (number | null)[] = (header?.cells ?? []).map((c) => {
    const m = asMixed(c.value);
    if (m?.kind !== "omni") return null;
    const w = m.entries.find((e) => e.key === "width")?.value;
    return typeof w === "number" && isFinite(w) && w > 0 ? w : null;
  });
  return { title, rows, cols, widths: widths.some((w) => w != null) ? widths : null };
}

/** The merge layout: for each grid position, either the spans it renders with (the ORIGIN of a
 *  merged region), `null` (a region member — emit nothing), or undefined (an ordinary cell). */
type Spans = (null | { colSpan: number; rowSpan: number } | undefined)[][];

/** Compute merged regions per MARKLOWER.md §Merged cells: group ref cells by their (origin) target
 *  path; a group merges iff origin + members tile a filled rectangle, origin top-left, all on
 *  one side of the header/body boundary. Invalid groups render unmerged (ordinary deref cells). */
export function computeSpans(grid: TableGrid): Spans {
  const spans: Spans = grid.rows.map((r) => Array(Math.max(r.cells.length, grid.cols)).fill(undefined));
  const at = new Map<string, { r: number; c: number }>(); // cell path → grid position
  grid.rows.forEach((row, r) => row.cells.forEach((cell, c) => at.set(cell.path, { r, c })));

  const groups = new Map<string, { r: number; c: number }[]>(); // origin path → member positions
  grid.rows.forEach((row, r) =>
    row.cells.forEach((cell, c) => {
      const ref = asRef(cell.value);
      if (!ref?.path) return;
      const origin = at.get(ref.path);
      if (!origin) return; // a pointer out of this grid — an ordinary deref cell
      if (asRef(grid.rows[origin.r].cells[origin.c].value)) return; // origin must be content, not a pointer
      const g = groups.get(ref.path) ?? [];
      g.push({ r, c });
      groups.set(ref.path, g);
    }),
  );

  for (const [originPath, members] of groups) {
    const o = at.get(originPath)!;
    const cells = [o, ...members];
    const minR = Math.min(...cells.map((p) => p.r));
    const maxR = Math.max(...cells.map((p) => p.r));
    const minC = Math.min(...cells.map((p) => p.c));
    const maxC = Math.max(...cells.map((p) => p.c));
    const rect = (maxR - minR + 1) * (maxC - minC + 1);
    const filled = new Set(cells.map((p) => p.r + ":" + p.c)).size === rect && cells.length === rect;
    const originTopLeft = o.r === minR && o.c === minC;
    const oneSide = grid.rows.slice(minR, maxR + 1).every((row) => row.header === grid.rows[minR].header);
    if (!filled || !originTopLeft || !oneSide) continue; // reported inconsistency → render unmerged
    spans[o.r][o.c] = { colSpan: maxC - minC + 1, rowSpan: maxR - minR + 1 };
    for (const m of members) spans[m.r][m.c] = null;
  }
  return spans;
}

// ---------------------------------------------------------------------------- //
// Cells
// ---------------------------------------------------------------------------- //

function proseChunk(cell: CellModel, documentPath?: string): Chunk {
  return { value: cell.value, path: cell.path, type: "string", format: "text/marklower", documentPath };
}

/** An editable prose cell: its own local text state and a debounced single-op emplace — the
 *  table needs no model/diff layer; every cell syncs itself at its absolute path. */
function EditableCell({ cell, tablePath, onNavigate }: { cell: CellModel; tablePath: string; onNavigate: (path: string) => void }) {
  void onNavigate;
  const [text, setText] = useState(String(cell.value ?? ""));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(text);
  const dirty = useRef(false);

  const flush = () => {
    if (!dirty.current) return;
    dirty.current = false;
    void editChunks([{ path: cell.path, op: "emplace", yamlover: escapeYamloverScalar(latest.current) }]).catch((e) =>
      alert(`cell edit failed: ${(e as Error).message}`),
    );
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      flush(); // unmount (lock, navigation) saves the pending text
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const onChangeText = (t: string) => {
    setText(t);
    latest.current = t;
    dirty.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 500);
  };
  void text; // rendered by the editor's own DOM; state exists so the latest text survives re-renders

  return (
    <MarklowerChunkEditor
      text={latest.current}
      rev={0}
      chapterPath={tablePath}
      focusAt={null}
      onFocused={() => {}}
      onChangeText={onChangeText}
      onSplit={() => {}} // a cell has no split/join/arrow chunk navigation
      onArrowOut={() => {}}
      onJoinPrev={() => {}}
      onJoinNext={() => {}}
    />
  );
}

function CellContent({
  cell,
  tablePath,
  documentPath,
  unlocked,
  onNavigate,
}: {
  cell: CellModel;
  tablePath: string;
  documentPath?: string;
  unlocked: boolean;
  onNavigate: (path: string) => void;
}) {
  const ref = asRef(cell.value);
  if (ref) {
    // a non-merge pointer cell: the shared target as a link (plain deref); dangling → inert text
    return ref.path ? (
      <a
        href="#"
        className="ref"
        onClick={(e) => {
          e.preventDefault();
          onNavigate(ref.path!);
        }}
      >
        {ref.text}
      </a>
    ) : (
      <span className="s">{ref.text}</span>
    );
  }
  const mixed = asMixed(cell.value);
  if (mixed?.format === "x-yamlover-table") {
    // a NESTED table — entering only by its explicit tag; the stamped format on the
    // mixed marker is what tells it apart from an untagged (chapter) container cell
    return <Grid value={cell.value} path={cell.path} documentPath={documentPath} onNavigate={onNavigate} caption />;
  }
  if (mixed?.format === "x-yamlover-bullets" || mixed?.format === "x-yamlover-numbered") {
    // a tagged LIST cell — bullets / numbered (MARKLOWER.md §Lists)
    return <ListBody value={cell.value} path={cell.path} kind={listKind(mixed.format)} documentPath={documentPath} onNavigate={onNavigate} />;
  }
  if ((mixed && mixed.kind !== "omni") || Array.isArray(cell.value)) {
    // an UNTAGGED container cell IS a CHAPTER — the table schema consumes exactly two
    // nesting levels, then switches back to chapter rules (MARKLOWER.md §Cells)
    return <ChapterCell value={cell.value} path={cell.path} tablePath={tablePath} documentPath={documentPath} onNavigate={onNavigate} />;
  }
  if (mixed) {
    // an omni SCALAR cell (an annotated / width-carrying scalar): render its self-value as prose
    return <MarklowerChunk chunk={proseChunk({ value: scalarValue(cell.value), path: cell.path }, documentPath)} onNavigate={onNavigate} />;
  }
  const link = asLink(cell.value);
  if (link) {
    return (
      <a
        href="#"
        className="ref"
        onClick={(e) => {
          e.preventDefault();
          onNavigate(link.path);
        }}
      >
        {link.title ?? link.path}
      </a>
    );
  }
  if (unlocked) return <EditableCell key={cell.path} cell={cell} tablePath={tablePath} onNavigate={onNavigate} />;
  return <MarklowerChunk chunk={proseChunk(cell, documentPath)} onNavigate={onNavigate} />;
}

/** A CHAPTER cell (MARKLOWER.md §Cells): the UNTAGGED container cell — the table schema
 *  consumes two nesting levels, so a container cell switches back to chapter rules (an
 *  explicit `!!<…chapter>` tag stays legal). Keyed `title`/`description` head the block; the
 *  positional body renders in order, each item through the ordinary cell routing (prose →
 *  marklower, a tagged table → an inline grid, a subchapter → recursion, pointers → links).
 *  Read-only, like every non-prose cell. Accepts a mixed marker or a plain array body. */
function ChapterCell({
  value,
  path,
  tablePath,
  documentPath,
  onNavigate,
}: {
  value: unknown;
  path: string;
  tablePath: string;
  documentPath?: string;
  onNavigate: (path: string) => void;
}) {
  const entries: { key: string | null; value: unknown }[] = Array.isArray(value)
    ? value.map((v) => ({ key: null, value: v }))
    : (asMixed(value)?.entries ?? []);
  return (
    <div className="yl-cell-chapter">
      {entries.map((e, i) => {
        const p = childPath(path, e.key ?? i);
        if (e.key === "title")
          return (
            <p key={p} className="yl-cell-chapter-title">
              <strong>{String(e.value ?? "")}</strong>
            </p>
          );
        if (e.key === "description") return <p key={p}>{String(e.value ?? "")}</p>;
        if (e.key !== null) return null; // other keyed fields have no cell rendering
        return (
          <div key={p} className="yl-cell-chapter-item">
            <CellContent cell={{ value: e.value, path: p }} tablePath={tablePath} documentPath={documentPath} unlocked={false} onNavigate={onNavigate} />
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------- //
// The grid + views
// ---------------------------------------------------------------------------- //

/** The editable caption: a plain single-line field emplacing `:title` (JSON-escaped). */
function EditableTitle({ title, tablePath }: { title: string; tablePath: string }) {
  const [text, setText] = useState(title);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const save = (t: string) => void editChunks([{ path: childPath(tablePath, "title"), op: "emplace", yamlover: JSON.stringify(t) }]);
  return (
    <input
      className="yl-table-title-edit"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => save(e.target.value), 500);
      }}
      onBlur={() => save(text)}
    />
  );
}

export function Grid({
  value,
  path,
  documentPath,
  onNavigate,
  caption,
}: {
  value: unknown;
  path: string;
  documentPath?: string;
  onNavigate: (path: string) => void;
  caption?: boolean; // render the title as a <caption> (the inline/nested form)
}) {
  const { unlocked } = useEditing();
  const grid = buildTableGrid(value, path);
  if (!grid.rows.length) return <p className="csv-empty">(empty table)</p>;
  const spans = computeSpans(grid);
  const overflow = grid.rows.reduce((n, r) => n + r.overflow, 0);

  const renderRow = (row: RowModel, r: number) => {
    const Tag = row.header ? "th" : "td";
    const padded = [...row.cells];
    while (padded.length < grid.cols) padded.push({ value: "", path: childPath(row.path, padded.length) });
    return (
      <tr key={row.path}>
        {padded.map((cell, c) => {
          const sp = spans[r]?.[c];
          if (sp === null) return null; // a merged-region member — the origin spans over it
          return (
            <Tag key={cell.path} data-node-path={cell.path} colSpan={sp?.colSpan} rowSpan={sp?.rowSpan}>
              <CellContent cell={cell} tablePath={path} documentPath={documentPath} unlocked={unlocked} onNavigate={onNavigate} />
            </Tag>
          );
        })}
      </tr>
    );
  };

  // `header` renders as the header wherever it is authored: leading header rows form <thead>,
  // any later one still renders as a <th> row inside the body (valid HTML, correct reading)
  let split = 0;
  while (split < grid.rows.length && grid.rows[split].header) split++;

  // proportional column widths (AsciiDoc `cols` style): weight/sum percent, width-less columns
  // default to weight 1 so a partial spec still lays out the whole grid
  const weights = grid.widths ? Array.from({ length: grid.cols }, (_, c) => grid.widths![c] ?? 1) : null;
  const weightSum = weights ? weights.reduce((a, b) => a + b, 0) : 0;

  return (
    <div className="csv-scroll">
      <table className="csv-table yl-table">
        {caption && grid.title != null && (
          <caption>{unlocked ? <EditableTitle title={grid.title} tablePath={path} /> : grid.title}</caption>
        )}
        {weights && weightSum > 0 && (
          <colgroup>
            {weights.map((w, c) => (
              <col key={c} style={{ width: `${(100 * w) / weightSum}%` }} />
            ))}
          </colgroup>
        )}
        {split > 0 && <thead>{grid.rows.slice(0, split).map((row, r) => renderRow(row, r))}</thead>}
        <tbody>{grid.rows.slice(split).map((row, i) => renderRow(row, split + i))}</tbody>
      </table>
      {overflow > 0 && (
        <p className="yl-table-notice">
          ⚠ {overflow} cell{overflow > 1 ? "s" : ""} beyond the column count inferred from the first row (MARKLOWER.md)
        </p>
      )}
    </div>
  );
}

/** The full-page view: title as the page heading (the CsvView precedent). */
export function TableView({ node, onNavigate }: { node: NodeJson; onNavigate: (path: string) => void }) {
  const grid = buildTableGrid(node.value, node.path);
  const { unlocked } = useEditing();
  return (
    <div className="csv">
      {grid.title != null &&
        (unlocked ? <EditableTitle title={grid.title} tablePath={node.path} /> : <h1 className="chapter-title">{grid.title}</h1>)}
      {node.description && <p className="chapter-subtitle">{node.description}</p>}
      <Grid value={node.value} path={node.path} documentPath={node.documentPath} onNavigate={onNavigate} />
    </div>
  );
}

/** The inline (chapter body) form. A chapter fetches at depth 1, so the table arrives as a link
 *  marker — fetch the whole subtree by path (cells, nested tables, resolved merge refs). */
export function TableChunk({ chunk, onNavigate }: { chunk: Chunk; onNavigate: (path: string) => void }) {
  const [node, setNode] = useState<NodeJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inline = asMixed(chunk.value) || Array.isArray(chunk.value); // already deep (a nested fetch)
  useEffect(() => {
    if (inline) return;
    let cancelled = false;
    fetchNode(chunk.path, null)
      .then((n) => !cancelled && setNode(n))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [chunk.path, inline]);

  if (inline) return <Grid value={chunk.value} path={chunk.path} documentPath={chunk.documentPath} onNavigate={onNavigate} caption />;
  if (error) return <p className="csv-empty">table failed to load: {error}</p>;
  if (!node) return <p className="csv-empty">…</p>;
  return <Grid value={node.value} path={node.path} documentPath={node.documentPath ?? chunk.documentPath} onNavigate={onNavigate} caption />;
}
