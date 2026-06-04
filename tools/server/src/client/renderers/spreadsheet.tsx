import { useEffect, useState } from "react";
import * as XLSX from "xlsx";
import { NodeJson, blobUrl } from "../api";
import { Chunk } from "./registry";

/**
 * Renderer for Excel workbooks — `.xlsx` (Office Open XML) and legacy `.xls`
 * (BIFF). SheetJS reads both from the served bytes; each sheet is shown as a table
 * (reusing the `.csv-table` styling), with a tab row to switch sheets in a
 * multi-sheet workbook. SheetJS is heavy, so the registry loads this module lazily.
 */
function useWorkbook(path: string): { wb: XLSX.WorkBook | null; error: string | null } {
  const [wb, setWb] = useState<XLSX.WorkBook | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setWb(null);
    setError(null);
    fetch(blobUrl(path))
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        if (cancelled) return;
        setWb(XLSX.read(new Uint8Array(buf), { type: "array" }));
      })
      .catch((e) => !cancelled && setError(String((e as Error).message || e)));
    return () => {
      cancelled = true;
    };
  }, [path]);
  return { wb, error };
}

/** One sheet → a 2-D array of cell strings, then a bordered table (first row as a
 *  header, matching the CSV renderer's look). */
function SheetTable({ sheet }: { sheet: XLSX.WorkSheet }) {
  const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, blankrows: false, defval: "" });
  if (!rows.length) return <p className="csv-empty">(empty sheet)</p>;
  const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const pad = (r: string[]) => (r.length >= cols ? r : [...r, ...Array(cols - r.length).fill("")]);
  const [head, ...body] = rows;
  return (
    <div className="csv-scroll">
      <table className="csv-table">
        <thead>
          <tr>
            {pad(head).map((c, k) => (
              <th key={k}>{String(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri}>
              {pad(r).map((c, ci) => (
                <td key={ci}>{String(c)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The workbook body: a sheet-tab row (when there is more than one) and the active
 *  sheet's table. Shared by the full page and the inline chunk. */
function Workbook({ wb }: { wb: XLSX.WorkBook }) {
  const [active, setActive] = useState(0);
  const names = wb.SheetNames;
  const name = names[Math.min(active, names.length - 1)];
  return (
    <div className="spreadsheet">
      {names.length > 1 && (
        <div className="sheet-tabs">
          {names.map((nm, k) => (
            <button key={nm} className={"sheet-tab" + (k === active ? " active" : "")} onClick={() => setActive(k)}>
              {nm}
            </button>
          ))}
        </div>
      )}
      <SheetTable sheet={wb.Sheets[name]} />
    </div>
  );
}

export function SpreadsheetView({ node }: { node: NodeJson }) {
  const { wb, error } = useWorkbook(node.path);
  if (error) return <div className="error">spreadsheet: {error}</div>;
  if (!wb) return <div className="loading">reading workbook…</div>;
  return (
    <div className="text">
      {node.title && <h1 className="chapter-title">{node.title}</h1>}
      {node.description && <p className="chapter-subtitle">{node.description}</p>}
      <Workbook wb={wb} />
    </div>
  );
}

export function SpreadsheetChunk({ chunk }: { chunk: Chunk }) {
  const { wb, error } = useWorkbook(chunk.path);
  if (error) return <div className="error">spreadsheet: {error}</div>;
  if (!wb) return <div className="loading">reading workbook…</div>;
  return <Workbook wb={wb} />;
}
