import { useEffect, useState } from "react";
import mammoth from "mammoth/mammoth.browser";
import { NodeJson, blobUrl } from "../api";
import { Chunk } from "./registry";

/**
 * Renderer for a `.docx` (Office Open XML word document). The file is served as
 * bytes; mammoth converts the document body to clean semantic HTML (headings,
 * lists, bold/italic, tables, …), shown in the shared `.markup` body. mammoth is
 * heavy and browser-only, so the registry loads this module lazily.
 */
function useDocxHtml(path: string): { html: string | null; error: string | null } {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setError(null);
    fetch(blobUrl(path))
      .then((r) => r.arrayBuffer())
      .then((buf) => mammoth.convertToHtml({ arrayBuffer: buf }))
      .then((res) => !cancelled && setHtml(res.value))
      .catch((e) => !cancelled && setError(String((e as Error).message || e)));
    return () => {
      cancelled = true;
    };
  }, [path]);
  return { html, error };
}

export function DocxView({ node }: { node: NodeJson }) {
  const { html, error } = useDocxHtml(node.path);
  if (error) return <div className="error">docx: {error}</div>;
  if (html == null) return <div className="loading">converting document…</div>;
  return (
    <div className="text">
      {node.title && <h1 className="chapter-title">{node.title}</h1>}
      {node.description && <p className="chapter-subtitle">{node.description}</p>}
      <div className="markup" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

export function DocxChunk({ chunk }: { chunk: Chunk }) {
  const { html, error } = useDocxHtml(chunk.path);
  if (error) return <div className="error">docx: {error}</div>;
  if (html == null) return <div className="loading">converting document…</div>;
  return <div className="markup" dangerouslySetInnerHTML={{ __html: html }} />;
}
