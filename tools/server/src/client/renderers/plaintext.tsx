import { useEffect, useMemo, useState } from "react";
import { NodeJson, blobUrl, fetchSource } from "../api";
import { Chunk } from "./registry";
import { isFileConcrete } from "../../concrete";
import { scalarValue } from "../render";
import { highlightLang, highlightSpans } from "../highlight";

/**
 * The renderer for a `binary`/`text/plain` (`.txt`/`.text`/`.log`) node: the file's
 * bytes shown verbatim in a `<pre>` — NO markup interpretation. (A bare `.txt`
 * otherwise falls to the marklower renderer, which both processes `*…*`/`_…_`-style
 * formatting sequences and re-flows the text, both misleading for plain text.)
 *
 * Because the server serves `text/plain` as raw bytes (it is deliberately kept out
 * of the server's TEXT_FORMATS), the **encoding is chosen on the client** — legacy
 * Cyrillic files are commonly CP866 / Windows-1251 / KOI8-R, not UTF-8. The choice
 * rides in the URL as `?enc=`, alongside `?format=`, so a particular reading is a
 * shareable link; the {@link EncodingControl} `config` control in the node bar
 * writes it (like the CSV controls / markdown width input). Bytes are fetched once
 * per path and re-decoded in place when the encoding changes — no refetch.
 */

const params = () => new URLSearchParams(window.location.search);

/** Selectable encodings — label shown in the bar → the `TextDecoder` label. All four
 *  are part of the WHATWG Encoding standard, so `TextDecoder` decodes them natively. */
export const ENCODINGS: { label: string; value: string }[] = [
  { label: "UTF-8", value: "utf-8" },
  { label: "Windows-1251", value: "windows-1251" },
  { label: "CP866", value: "ibm866" },
  { label: "KOI8-R", value: "koi8-r" },
];
const DEFAULT_ENCODING = "utf-8";
const isEncoding = (v: string) => ENCODINGS.some((e) => e.value === v);

/** The encoding from the URL's `?enc=`, or UTF-8 (an unknown value is ignored). */
export function textEncoding(): string {
  const e = params().get("enc") ?? "";
  return isEncoding(e) ? e : DEFAULT_ENCODING;
}

/** Decode bytes under `encoding`, falling back to UTF-8 if the label is unsupported. */
function decode(bytes: Uint8Array, encoding: string): string {
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** Fetch a file's raw bytes once per `path` (decoding happens separately, so changing
 *  the encoding does not refetch). A null `path` (an inline node, no source file) skips the fetch. */
function useBytes(path: string | null): { bytes: Uint8Array | null; error: string | null } {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setBytes(null);
    setError(null);
    if (path == null) return;
    fetch(blobUrl(path))
      .then((r) => r.arrayBuffer())
      .then((buf) => !cancelled && setBytes(new Uint8Array(buf)))
      .catch((e) => !cancelled && setError(String((e as Error).message || e)));
    return () => {
      cancelled = true;
    };
  }, [path]);
  return { bytes, error };
}

export function PlaintextView({ node }: { node: NodeJson }) {
  // A file-backed node loads its raw bytes via /api/blob (with the encoding selector — legacy
  // Cyrillic files). An INLINE textual node (no source file: markdown/asciidoc/string authored in
  // place) has its already-decoded string value, shown verbatim — no fetch, no encoding choice.
  // Everything ELSE that the tab enables (plaintextTab: an overlay-carrying directory, an inline
  // container of a data language) shows its yamlover SOURCE via /api/source — the overlay of a
  // directory chapter, a re-serialized subtree deeper: raw content wherever raw content exists.
  const fileBacked = isFileConcrete(node.concrete);
  const inline = fileBacked ? null : scalarValue(node.value);
  // an OMNI node's scalarValue is just its self-value (a chapter's title!) — the raw content
  // is its SOURCE; only an entries-free string is its own raw content
  const hasEntries = node.hasKeyed === true || node.hasOrdinal === true;
  const inlineText = typeof inline === "string" && !hasEntries ? inline : null;
  const wantsSource = !fileBacked && inlineText == null;
  const { bytes, error } = useBytes(fileBacked ? node.path : null);
  const [source, setSource] = useState<string | null>(null);
  const [srcError, setSrcError] = useState<string | null>(null);
  useEffect(() => {
    if (!wantsSource) return;
    let cancelled = false;
    setSource(null);
    setSrcError(null);
    fetchSource(node.path)
      .then((r) => !cancelled && setSource(r.source))
      .catch((e) => !cancelled && setSrcError(String((e as Error).message || e)));
    return () => {
      cancelled = true;
    };
  }, [wantsSource, node.path]);
  const encoding = textEncoding();
  const text = useMemo(
    () => (inlineText != null ? inlineText : wantsSource ? source : bytes ? decode(bytes, encoding) : null),
    [inlineText, wantsSource, source, bytes, encoding],
  );
  if (error || srcError) return <div className="error">text: {error ?? srcError}</div>;
  if (text == null) return <div className="loading">reading…</div>;
  // a fetched SOURCE is yamlover by definition (that is what /api/source serializes);
  // bytes/inline text highlight by the node's own format (a .yo file, a code string)
  const lang = wantsSource ? highlightLang("yamlover") : highlightLang(node.format);
  return (
    <div className="text">
      {node.title && <h1 className="chapter-title">{node.title}</h1>}
      {node.description && <p className="chapter-subtitle">{node.description}</p>}
      <pre className="plaintext">{lang ? highlightSpans(text, lang) : text}</pre>
    </div>
  );
}

/** A plain-text chunk embedded inline in a chapter: the verbatim text, decoded as UTF-8
 *  (no per-chunk URL controls, like the CSV chunk). An INLINE chunk (a format-tagged block
 *  scalar in the body — the code-chunk shape, DOCSMIGRATION.md) already carries its text as
 *  the value and fetches nothing; only a file-backed pointer chunk reads bytes. A format
 *  naming a yamlover-family language gets SYNTAX HIGHLIGHTING via the shared lexer
 *  (highlight.tsx); `text/plain` maps to no language and stays verbatim. */
export function PlaintextChunk({ chunk }: { chunk: Chunk }) {
  const inline = typeof chunk.value === "string" ? chunk.value : null;
  const { bytes, error } = useBytes(inline == null ? chunk.path : null);
  const text = useMemo(
    () => (inline != null ? inline : bytes ? decode(bytes, DEFAULT_ENCODING) : null),
    [inline, bytes],
  );
  if (error) return <div className="error">text: {error}</div>;
  if (text == null) return <div className="loading">reading…</div>;
  const lang = highlightLang(chunk.format);
  return <pre className="plaintext">{lang ? highlightSpans(text, lang) : text}</pre>;
}

/**
 * The encoding selector shown in the node bar beside the plaintext tab — the
 * `config` hook. Writes `?enc=` (preserving the path + other params) and calls
 * `rerender` so {@link PlaintextView} re-decodes the already-fetched bytes.
 */
export function EncodingControl({ rerender }: { rerender: () => void }) {
  const enc = textEncoding();
  const setEnc = (value: string) => {
    const q = params();
    if (value && value !== DEFAULT_ENCODING) q.set("enc", value);
    else q.delete("enc");
    const qs = q.toString();
    window.history.replaceState({}, "", window.location.pathname + (qs ? "?" + qs : ""));
    rerender();
  };
  return (
    <label className="enc-control">
      encoding{" "}
      <select value={enc} onChange={(e) => setEnc(e.target.value)}>
        {ENCODINGS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
