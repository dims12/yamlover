import { NodeJson } from "../api";
import { scalarValue } from "../render";
import { Chunk } from "./registry";

/**
 * The renderer for a `string`/`text/csv` (or `text/tab-separated-values`) node:
 * delimited text shown as a table. Like the markdown/asciidoc renderers it works
 * from the node's string value, so it serves both a whole `.csv`/`.tsv` file
 * (`render`) and a single inline chunk (`renderChunk`).
 *
 * The **main parsing parameters live in the URL**, alongside `?format=csv`, so a
 * particular reading of a file is a shareable link:
 *
 *   - `sep`    — the field separator. `,` `;` `|`, the word `tab` (or `space`), or
 *                empty/absent for **auto-detect** (the most frequent candidate on
 *                the first line; `\t` for a `.tsv`).
 *   - `header` — whether the first row is a header (default true; `false`/`0` off).
 *
 * The full-page view exposes these in the node bar beside the renderer's tab (the
 * {@link CsvControls} `config` control, like the markdown/asciidoc width input),
 * writing the same query params (via `history.replaceState`, preserving the path +
 * `format`), so the URL stays the single source of truth — editing it by hand and
 * reloading is equivalent to using the controls.
 */

/** Parse delimited text into rows of fields, RFC-4180-ish: fields may be wrapped in
 *  `quote`, a doubled quote is a literal one, and separators/newlines inside quotes
 *  are data. Handles `\n` and `\r\n`; a trailing newline does not yield an empty
 *  row. */
export function parseDelimited(text: string, sep: string, quote = '"'): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === quote) {
        if (text[i + 1] === quote) {
          field += quote;
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += c;
        i++;
      }
      continue;
    }
    if (c === quote) {
      inQuotes = true;
      i++;
    } else if (c === sep) {
      pushField();
      i++;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      pushRow();
      i++;
    } else {
      field += c;
      i++;
    }
  }
  // flush the final field/row unless the text ended exactly on a row break
  if (field !== "" || row.length) pushRow();
  return rows;
}

/** Decode a `sep` URL value to the actual separator character, or null for
 *  auto-detect (empty/absent). `tab`/`space` are spelled out for URL-friendliness. */
function decodeSep(v: string | null): string | null {
  if (!v) return null;
  if (v === "tab" || v === "\\t") return "\t";
  if (v === "space") return " ";
  return v[0];
}

/** Auto-detect a separator from the first line: a `.tsv` is tab; otherwise the most
 *  frequent of `, ; \t |` (comma when none appears). */
function autoSep(text: string, format: string | null): string {
  if (format === "text/tab-separated-values") return "\t";
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  let best = ",";
  let bestN = 0;
  for (const c of [",", ";", "\t", "|"]) {
    const n = firstLine.split(c).length - 1;
    if (n > bestN) {
      bestN = n;
      best = c;
    }
  }
  return best;
}

const SEP_OPTIONS: { label: string; value: string }[] = [
  { label: "auto", value: "" },
  { label: "comma  ,", value: "," },
  { label: "semicolon  ;", value: ";" },
  { label: "tab", value: "tab" },
  { label: "pipe  |", value: "|" },
];

const params = () => new URLSearchParams(window.location.search);

/** Read the (header) flag from the URL — default true, off for `false`/`0`. */
function headerOn(p: URLSearchParams): boolean {
  const h = p.get("header");
  return !(h === "false" || h === "0");
}

/** Pad a row to `cols` cells so every `<tr>` is rectangular. */
function pad(row: string[], cols: number): string[] {
  return row.length >= cols ? row : [...row, ...Array(cols - row.length).fill("")];
}

/** The table itself — shared by the full page and the inline chunk. */
function Table({ rows, header }: { rows: string[][]; header: boolean }) {
  if (!rows.length) return <p className="csv-empty">(empty)</p>;
  const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const head = header ? rows[0] : null;
  const body = header ? rows.slice(1) : rows;
  return (
    <div className="csv-scroll">
      <table className="csv-table">
        {head && (
          <thead>
            <tr>
              {pad(head, cols).map((c, i) => (
                <th key={i}>{c}</th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri}>
              {pad(r, cols).map((c, ci) => (
                <td key={ci}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CsvView({ node }: { node: NodeJson }) {
  // Options are read straight from the URL each render; the node bar's CsvControls
  // (see registry `config`) write them and re-render the node view, so the URL stays
  // the single source of truth — this view holds no parsing state of its own.
  const p = params();
  const header = headerOn(p);
  const text = String(scalarValue(node.value) ?? "");
  const sep = decodeSep(p.get("sep")) ?? autoSep(text, node.format ?? null);
  const rows = parseDelimited(text, sep);

  return (
    <div className="csv">
      {node.title && <h1 className="chapter-title">{node.title}</h1>}
      {node.description && <p className="chapter-subtitle">{node.description}</p>}
      <Table rows={rows} header={header} />
    </div>
  );
}

/**
 * The CSV parsing controls (separator + header row) shown in the node bar beside
 * the renderer's tab — the `config` hook, mirroring the markdown/asciidoc width
 * input. Each writes a query param (preserving the path + other params) and calls
 * `rerender` so {@link CsvView} re-reads the URL and re-parses.
 */
export function CsvControls({ rerender }: { rerender: () => void }) {
  const p = params();
  const sepParam = p.get("sep") ?? "";
  const header = headerOn(p);

  const setParam = (key: string, value: string) => {
    const q = params();
    if (value) q.set(key, value);
    else q.delete(key);
    const qs = q.toString();
    window.history.replaceState({}, "", window.location.pathname + (qs ? "?" + qs : ""));
    rerender();
  };

  return (
    <div className="csv-toolbar">
      <label>
        separator{" "}
        <select value={sepParam} onChange={(e) => setParam("sep", e.target.value)}>
          {SEP_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={header}
          onChange={(e) => setParam("header", e.target.checked ? "" : "false")}
        />{" "}
        header row
      </label>
    </div>
  );
}

/** A CSV chunk embedded inline in a chapter: just the table, auto-detecting the
 *  separator and treating the first row as a header (no per-chunk URL controls). */
export function CsvChunk({ chunk }: { chunk: Chunk }) {
  const text = String(chunk.value ?? "");
  const rows = parseDelimited(text, autoSep(text, chunk.format ?? null));
  return (
    <div className="csv">
      <Table rows={rows} header />
    </div>
  );
}
