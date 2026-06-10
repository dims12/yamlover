import { Fragment, useEffect, useReducer, useState } from "react";
import { fetchNode, fetchSchema, NodeJson, pasteFile, PasteResult } from "./api";
import { getRenderer } from "./renderers/registry";
import { AnnotatedMaterial } from "./renderers/annotate";

// Renderers whose output is prose — they get the TEXT annotation layer (drag-select → palette →
// highlight). Image and map renderers carry their OWN region annotation layer (drag-rectangle →
// palette), and pdf/djvu render saved region overlays; see annotate.tsx and the UI guide.
const TEXT_MATERIALS = new Set(["chapter", "markdown", "asciidoc", "marklower"]);
import { TagBadges, splitTagRefs } from "./renderers/tag";
import { Render } from "./render";
import { strToSegs } from "./paths";

// The data representations, in order: `yamlover` (the default, YAML-family syntax), `json5p`
// (JSON-family syntax), then `yamlover/schema` (the instance schema, YAML-family). Each is one
// level deep with nested containers as links. A node with a renderer also offers a tab keyed by
// the renderer's *name* (e.g. `chapter`) — the rendered view, and that node's default.
export type Format = "yamlover" | "json5p" | "yamlover/schema" | (string & {});
export const FORMATS: Format[] = ["yamlover", "json5p", "yamlover/schema"];
export const DEFAULT_FORMAT: Format = "yamlover";

const isStandard = (f: Format) => (FORMATS as string[]).includes(f);
const isSchema = (f: Format) => f.endsWith("schema");
// Serialization syntax: json5p renders JSON-family; yamlover (+ its schema) renders YAML-family.
const syntaxOf = (f: Format): "yaml" | "json" => (f === "json5p" ? "json" : "yaml");

/** The representation actually shown: the requested `format` if it is a standard
 *  view or this node's renderer name; otherwise the node's default (its renderer's
 *  view, else `yaml-schema`). Guards a stale renderer-name format (e.g. a
 *  hand-edited URL, or one carried onto a node with no such renderer). */
function effectiveFormat(format: Format, renderer: { name: string } | null): Format {
  if (isStandard(format)) return format;
  if (renderer && format === renderer.name) return format;
  return renderer ? renderer.name : DEFAULT_FORMAT;
}

/** A node's bare name: its last path segment (a decoded key or `[index]`), or ""
 *  for the root. Used as the document title when the node has no schema title. */
function nodeName(path: string): string {
  const segs = strToSegs(path);
  const last = segs[segs.length - 1];
  if (last === undefined) return "";
  return typeof last === "number" ? `[${last}]` : last;
}

interface Props {
  path: string;
  format: Format;
  onFormat: (f: Format) => void;
  onNavigate: (path: string) => void;
  /** Called after a paste/upload changed the tree at `path`, so the TOC branch can refresh. */
  onContentChanged?: (path: string) => void;
  /** Called after a file was uploaded onto a directory MEMBER, to open the new file. */
  onOpenUploaded?: (result: PasteResult) => void;
}

const MIME_EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
  "image/svg+xml": "svg", "image/bmp": "bmp", "image/tiff": "tiff", "application/pdf": "pdf",
};

/** The files carried by a clipboard paste (a file-manager copy fills `files`; a copied image
 *  arrives as an `items` entry of kind "file"). */
function clipboardFiles(e: ClipboardEvent): File[] {
  const dt = e.clipboardData;
  if (!dt) return [];
  if (dt.files && dt.files.length) return Array.from(dt.files);
  const out: File[] = [];
  for (const it of Array.from(dt.items || [])) {
    if (it.kind === "file") { const f = it.getAsFile(); if (f) out.push(f); }
  }
  return out;
}

/** A name for a pasted file — its own, else a synthesized one from its MIME type. */
function pastedName(f: File): string {
  if (f.name) return f.name;
  return `pasted.${MIME_EXT[f.type] || "bin"}`;
}

/** Read a File as base64 (the bare payload, no data-URL prefix). */
function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("could not read file"));
    r.readAsDataURL(f);
  });
}

/** The RHS pane: one node shown in the selected representation. Every
 *  representation is one level deep; nested objects/arrays appear as
 *  `{ N keys }` / `[ M elements ]` hyperlinks you click to descend. */
export function NodeView({ path, format, onFormat, onNavigate, onContentChanged, onOpenUploaded }: Props) {
  const [node, setNode] = useState<NodeJson | null>(null); // header + data value
  const [schema, setSchema] = useState<unknown>(null);
  const [bin, setBin] = useState<unknown>(null); // base64 payload for a binary leaf
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0); // bumped to re-fetch the node after a paste
  const [pasteMsg, setPasteMsg] = useState<string | null>(null); // transient upload status
  const [dragging, setDragging] = useState(false); // a file is being dragged over the window
  // Bumped by a renderer's bar `config` control (e.g. the markup width) after it writes a URL
  // param, so the whole node view re-renders and the rendered body picks up the new setting.
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    setError(null);
    setNode(null);
    let cancelled = false;
    // A first (one-level) fetch settles the node's (type, format); a renderer that
    // needs deeper value (e.g. a chapter, depth 2: arrays one level, elements the
    // next) gets a second fetch at that depth before its value is shown.
    fetchNode(path)
      .then((n) => {
        if (cancelled) return;
        const d = getRenderer(n)?.depth ?? 1;
        if (d > 1) fetchNode(path, d).then((dn) => !cancelled && setNode(dn)).catch((e) => !cancelled && setError(e.message));
        else setNode(n);
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [path, reloadKey]);

  // Paste-to-upload: pasting clipboard file(s) uploads them — the server drops the file into this
  // directory (a directory page), appends it as a chapter chunk (a chapter page), or drops it into
  // the nearest enclosing directory (any other page, i.e. a MEMBER of a directory). Skipped while
  // the focus is in a text field (so annotation notes still paste text normally).
  useEffect(() => {
    if (!node) return;
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const files = clipboardFiles(e);
      if (files.length === 0) return; // a plain text paste — leave it alone
      e.preventDefault();
      void uploadFiles(files);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node, path]);

  // Drag-and-drop upload: dropping file(s) anywhere on the page uploads them by the SAME rules as
  // paste (server decides: into this directory, as a chapter chunk, or into the enclosing folder).
  // Listeners are document-wide so a drop is caught everywhere (and the browser's "open the file"
  // default is suppressed); a `depth` counter keeps the overlay steady as the cursor crosses nested
  // elements.
  useEffect(() => {
    if (!node) return;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes("Files");
    let depth = 0;
    const onEnter = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; setDragging(true); };
    const onOver = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; };
    const onLeave = () => { depth = Math.max(0, depth - 1); if (depth === 0) setDragging(false); };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length) void uploadFiles(files);
    };
    document.addEventListener("dragenter", onEnter);
    document.addEventListener("dragover", onOver);
    document.addEventListener("dragleave", onLeave);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragenter", onEnter);
      document.removeEventListener("dragover", onOver);
      document.removeEventListener("dragleave", onLeave);
      document.removeEventListener("drop", onDrop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node, path]);

  const uploadFiles = async (files: File[]) => {
    try {
      setPasteMsg(`uploading ${files.length} file${files.length > 1 ? "s" : ""}…`);
      let last: PasteResult | null = null;
      for (const f of files) {
        const b64 = await fileToBase64(f);
        last = await pasteFile(path, pastedName(f), b64);
      }
      setPasteMsg(files.length > 1 ? `uploaded ${files.length} files` : "uploaded");
      window.setTimeout(() => setPasteMsg(null), 1500);
      if (last?.open) {
        // a member page: the file went to the enclosing directory — open it (App refreshes the TOC
        // branch and navigates to the new file in its renderer view).
        onOpenUploaded?.(last);
      } else {
        // a directory or chapter page: refresh in place so the new file / chunk shows.
        setReloadKey((k) => k + 1);
        onContentChanged?.(path);
      }
    } catch (err) {
      setPasteMsg("paste failed: " + (err as Error).message);
      window.setTimeout(() => setPasteMsg(null), 4000);
    }
  };

  // The browser tab reflects where you are: the node's schema title if it has one,
  // else its bare name (the last path segment), falling back to the app name at the
  // (titleless) root. Re-set whenever the node settles.
  useEffect(() => {
    if (!node) return;
    document.title = node.title?.trim() || nodeName(path) || "yamlover";
  }, [node, path]);

  useEffect(() => {
    setSchema(null);
    setBin(null);
    if (!node) return;
    const r = getRenderer(node);
    const eff = effectiveFormat(format, r);
    if (r && eff === r.name) return; // the rendered view reads node.value (already fetched)
    if (isSchema(eff)) {
      fetchSchema(path).then(setSchema).catch((e) => setError(e.message));
    } else if (node.type === "binary") {
      fetchNode(path, undefined, { binary: true }).then((n) => setBin(n.value)).catch((e) => setError(e.message));
    }
  }, [format, path, node]);

  if (error) return <div className="error">{error}</div>;
  if (!node) return <div className="loading">…</div>;

  const renderer = getRenderer(node);
  // The renderer adds its own tab (its name), which is this node's default; the
  // standard representations follow.
  const tabs: Format[] = renderer ? [renderer.name, ...FORMATS] : FORMATS;
  const effective = effectiveFormat(format, renderer);
  const showRendered = renderer != null && effective === renderer.name;

  let content: unknown;
  let ready: boolean;
  if (showRendered) {
    content = node.value;
    ready = true;
  } else if (isSchema(effective)) {
    content = schema;
    ready = schema != null;
  } else if (node.type === "binary") {
    content = bin;
    ready = bin != null;
  } else {
    content = node.value;
    ready = true;
  }

  // Tag references (rel edges to x-yamlover-tag nodes) show as badges on every
  // representation; the remaining relations stay in the data-view panel.
  const { tags, rest } = splitTagRefs(node.relations);

  return (
    <div className="nodeview">
      {pasteMsg && <div className="paste-toast">{pasteMsg}</div>}
      {dragging && <div className="drop-overlay">Drop file to upload</div>}
      <div className="nodehead">
        <div className="nodemeta">
          <span className="tag">{node.type}</span>
          {node.concrete && <span className="tag dim">{node.concrete}</span>}
          {/* the tags this node is filed under, inline among the chips */}
          <TagBadges tags={tags} onNavigate={onNavigate} />
        </div>
        {/* the representation tabs dock LEFT, after the chips, set off by a separator; a
            renderer's own bar control (e.g. markup width) sits right after its button */}
        <span className="bar-sep" aria-hidden="true">|</span>
        <div className="tabs">
          {tabs.map((f) => (
            <Fragment key={f}>
              <button className={"tab" + (effective === f ? " active" : "")} onClick={() => onFormat(f)}>
                {f}
              </button>
              {showRendered && renderer && f === renderer.name && renderer.config?.(rerender)}
            </Fragment>
          ))}
        </div>
      </div>

      {/* a renderer presents the node's own title/description; the default view
          shows the description here as a subtitle above the value */}
      {!showRendered && node.description && <p className="nodedesc">{node.description}</p>}

      {showRendered ? (
        TEXT_MATERIALS.has(renderer!.name) ? (
          <AnnotatedMaterial path={path}>{renderer!.render(node, onNavigate)}</AnnotatedMaterial>
        ) : (
          renderer!.render(node, onNavigate)
        )
      ) : (
        <pre className="code">
          {/* data views lead with the relations panel (reverse members / `..`),
              an <hr/>, then the value; schema views embed rel inline already */}
          {!isSchema(effective) && Object.keys(rest).length > 0 && (
            <>
              <Render value={rest} syntax={syntaxOf(effective)} onNavigate={onNavigate} />
              <hr className="reldiv" />
            </>
          )}
          {ready ? <Render value={content} syntax={syntaxOf(effective)} onNavigate={onNavigate} /> : "…"}
        </pre>
      )}
    </div>
  );
}
