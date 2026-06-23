import { Fragment, memo, useEffect, useReducer, useRef, useState } from "react";
import { fetchNode, fetchSchema, NodeJson, pasteFile, pasteRich, pasteText, PasteResult } from "./api";
import { arxivPdf, tweetUrl, fetchTweetText } from "./paste-links";
import { countImages, htmlToRich, resolveImages, RichDraft } from "./paste-html";
import { renderersFor } from "./renderers/registry";
import { AnnotatedMaterial, useAnnotations } from "./renderers/annotate";
import { DepthControl, viewDepth } from "./renderers/depth";
import { useHashScroll } from "./renderers/headings";

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

// The json5p (JSON-family) view is offered only for a node backed by a json-family file — the
// server reports those `concrete`s. (Detecting JSON flow syntax embedded in a yaml/yamlover file
// is a separate, postponed concern.)
export const JSON_CONCRETES = new Set(["json", "json5", "json5p"]);
export const isJsonConcrete = (c?: string | null): boolean => JSON_CONCRETES.has(c ?? "");

const isSchema = (f: Format) => f.endsWith("schema");
// Serialization syntax: json5p renders JSON-family; yamlover (+ its schema) renders YAML-family.
const syntaxOf = (f: Format): "yaml" | "json" => (f === "json5p" ? "json" : "yaml");

/** The standard data-view tabs a node offers: always `yamlover` + `yamlover/schema`, plus
 *  `json5p` only for a json-family file (so a yaml node isn't rendered as JSON). */
function standardFormatsFor(node: NodeJson): Format[] {
  return isJsonConcrete(node.concrete) ? ["yamlover", "json5p", "yamlover/schema"] : ["yamlover", "yamlover/schema"];
}

/** The representation actually shown: the requested `format` if it is one of this node's standard
 *  views or one of its renderer names; otherwise the node's default (its first renderer's view,
 *  else `yaml`). Guards a stale format (a hand-edited URL, or one — e.g. `json5p` — carried onto a
 *  node that doesn't offer it). */
function effectiveFormat(format: Format, renderers: { name: string }[], standard: Format[]): Format {
  if ((standard as string[]).includes(format)) return format;
  if (renderers.some((r) => r.name === format)) return format;
  return renderers[0] ? renderers[0].name : DEFAULT_FORMAT;
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
  /** Bumped by App when a server-pushed change touches this node — re-fetch it. */
  refreshSignal?: number;
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
// memo: App re-renders on every SSE task-progress frame (background indexing/hashing — several
// per second); the node pane — incl. a mounted PDF with all its pages — must only re-render
// when its own props change, or scrolling a long document JANKS while a task runs.
export const NodeView = memo(function NodeView({ path, format, refreshSignal = 0, onFormat, onNavigate, onContentChanged, onOpenUploaded }: Props) {
  const [node, setNode] = useState<NodeJson | null>(null); // header + data value
  const [schema, setSchema] = useState<unknown>(null);
  const [bin, setBin] = useState<unknown>(null); // base64 payload for a binary leaf
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0); // bumped to re-fetch the node after a paste
  const [pasteMsg, setPasteMsg] = useState<string | null>(null); // transient upload status
  const [dragging, setDragging] = useState(false); // a file is being dragged over the window
  const prevPath = useRef(path); // last NAVIGATED path — distinguishes a navigation from a live refresh
  // Bumped by a renderer's bar `config` control (e.g. the markup width) after it writes a URL
  // param, so the whole node view re-renders and the rendered body picks up the new setting.
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  // The tags APPLIED to this material via annotations — they join the header badges (the
  // upstream relation is the annotation node, so the hop to its tag comes from /api/annotations).
  // Unconditional: hooks must run on every render, including the loading ones.
  const anns = useAnnotations(path);
  // A `<page>#/cont` deep link (or a local-ref click) scrolls to the stamped node id once the value
  // settles. Unconditional — hooks run every render, including the loading ones.
  useHashScroll(node);

  useEffect(() => {
    setError(null);
    // Clear the node only on a genuine NAVIGATION (the path changed). A live REFRESH (refreshSignal /
    // reloadKey, e.g. an annotation written from a right-click menu) keeps the current node visible
    // and swaps it in when the re-fetch resolves — no loading flash, and the renderer stays mounted
    // (so a floating menu / selection it owns survives the write that triggered the refresh).
    if (prevPath.current !== path) { setNode(null); prevPath.current = path; }
    let cancelled = false;
    // A first fetch at the SERVER DEFAULT settles the node's (type, format) and, for a data view at
    // the default `.inf`, IS the value shown (the server resolves `.inf` per concrete — a whole text
    // document, one level for a directory/binary). A view that needs a DIFFERENT depth (a renderer's
    // own, or an explicit finite `?depth=`) gets a second fetch at that depth.
    fetchNode(path)
      .then((n) => {
        if (cancelled) return;
        // Depth is chosen by the ACTIVE representation, never the max: a DATA view (yamlover /
        // json5p / schema) honours the `?depth=` setting (default `.inf`); a RENDERER view gets
        // exactly its own depth. The explorer (depth 1) MUST get a one-level projection — at a
        // deeper depth its members stop being `$yamloverLink` markers (overlayed/container members
        // inline), which would break navigation, icons and thumbnails. Switching renderer↔data tab
        // refetches (the effect depends on `format`); the node stays visible meanwhile (no-flash).
        const rs = renderersFor(n);
        const eff = effectiveFormat(format, rs, standardFormatsFor(n));
        const active = rs.find((r) => r.name === eff);
        const swap = (dn: NodeJson) => !cancelled && setNode(dn);
        const fail = (e: Error) => !cancelled && setError(e.message);
        if (active) {
          const d = active.depth ?? 1; // a renderer's own fixed depth
          if (d > 1) fetchNode(path, d).then(swap).catch(fail);
          else setNode(n); // depth 1 (e.g. the explorer) → the settle fetch already covers it
        } else {
          const dv = viewDepth(); // a data view: number = explicit finite, null = `.inf`/default
          if (dv === null) setNode(n); // default/.inf → the settle fetch is the server's per-concrete default
          else fetchNode(path, dv).then(swap).catch(fail); // explicit finite (incl. 1) → fetch exactly that
        }
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
    // `format` is a dep: switching renderer↔data tab can change the needed depth, so refetch.
  }, [path, reloadKey, refreshSignal, format]);

  // Paste-to-upload: pasting clipboard file(s) uploads them — the server drops the file into this
  // directory (a directory page), appends it as a chapter chunk (a chapter page), or drops it into
  // the nearest enclosing directory (any other page, i.e. a MEMBER of a directory). Plain TEXT is
  // pasted too: a chapter gains it as a new chunk; anywhere else it becomes a new chapter
  // .yamlover file in the nearest directory. Skipped while the focus is in a text field (so
  // annotation notes still paste text normally).
  useEffect(() => {
    if (!node) return;
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const files = clipboardFiles(e);
      if (files.length > 0) {
        e.preventDefault();
        void uploadFiles(files);
        return;
      }
      // a web-page selection: its text/html flavor keeps the images and headings that the
      // plain-text flavor drops — paste those as image chunks and subchapters
      const html = e.clipboardData?.getData("text/html") ?? "";
      const rich = html ? htmlToRich(html) : null;
      if (rich) {
        e.preventDefault();
        void uploadRich(rich);
        return;
      }
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (!text.trim()) return;
      e.preventDefault();
      const arxiv = arxivPdf(text);
      if (arxiv) {
        void uploadRemotePdf(arxiv);
        return;
      }
      const tweet = tweetUrl(text);
      if (tweet) {
        void uploadTweet(tweet);
        return;
      }
      void uploadText(text);
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

  // A pasted arXiv link: download the paper's PDF in the browser, then hand it to the normal
  // file-paste flow (chapter → pointer chunk, directory → child, member → open).
  const uploadRemotePdf = async ({ url, name }: { url: string; name: string }) => {
    try {
      setPasteMsg(`downloading ${name}…`);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
      const blob = await resp.blob();
      await uploadFiles([new File([blob], name, { type: "application/pdf" })]);
    } catch (err) {
      setPasteMsg("download failed: " + (err as Error).message);
      window.setTimeout(() => setPasteMsg(null), 4000);
    }
  };

  // A rich (HTML) paste: download its images in the browser, then send ONE structured payload —
  // a chapter appends the chunks/subchapters; a directory gains a new chapter (directory-backed
  // when images are present, so they live inside it).
  const uploadRich = async (draft: RichDraft) => {
    try {
      const n = countImages(draft);
      if (n) setPasteMsg(`downloading ${n} image${n > 1 ? "s" : ""}…`);
      const rich = await resolveImages(draft);
      setPasteMsg("pasting…");
      const result = await pasteRich(path, rich);
      setPasteMsg(result.chapter ? "chunks added" : "chapter created");
      window.setTimeout(() => setPasteMsg(null), 1500);
      if (result.open) {
        onOpenUploaded?.(result);
      } else {
        setReloadKey((k) => k + 1);
        onContentChanged?.(path);
      }
    } catch (err) {
      setPasteMsg("paste failed: " + (err as Error).message);
      window.setTimeout(() => setPasteMsg(null), 4000);
    }
  };

  // A pasted tweet link: fetch the FULL message via X's public oEmbed (your Telegram-style
  // preview, but the whole text) and paste it as TEXT — chapter chunk or new chapter file.
  const uploadTweet = async (statusUrl: string) => {
    try {
      setPasteMsg("fetching tweet…");
      await uploadText(await fetchTweetText(statusUrl));
    } catch (err) {
      setPasteMsg("tweet fetch failed: " + (err as Error).message);
      window.setTimeout(() => setPasteMsg(null), 4000);
    }
  };

  // Paste TEXT by the same navigation rules: a chapter page gains a chunk (refresh in place); a
  // member page gets a sibling chapter file the App then opens; a directory page refreshes.
  const uploadText = async (text: string) => {
    try {
      setPasteMsg("pasting text…");
      const result = await pasteText(path, text);
      setPasteMsg(result.chapter ? "chunk added" : "chapter created");
      window.setTimeout(() => setPasteMsg(null), 1500);
      if (result.open) {
        onOpenUploaded?.(result);
      } else {
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
    const rs = renderersFor(node);
    const eff = effectiveFormat(format, rs, standardFormatsFor(node));
    if (rs.some((r) => r.name === eff)) return; // a rendered view reads node.value (already fetched)
    if (isSchema(eff)) {
      // `.inf`/default (viewDepth null) → omit depth so the server applies its per-concrete default
      fetchSchema(path, viewDepth() ?? undefined).then(setSchema).catch((e) => setError(e.message));
    } else if (node.type === "binary") {
      fetchNode(path, undefined, { binary: true }).then((n) => setBin(n.value)).catch((e) => setError(e.message));
    }
  }, [format, path, node]);

  if (error) return <div className="error">{error}</div>;
  if (!node) return <div className="loading">…</div>;

  const renderers = renderersFor(node);
  // Each rendered representation adds its own tab (its name); the first is this node's default, and
  // a directory offers its explorer view tabs (large icons / details / …) alongside any custom one.
  // The node's standard data representations follow (json5p only for a json-family file).
  const standard = standardFormatsFor(node);
  const tabs: Format[] = [...renderers.map((r) => r.name), ...standard];
  const effective = effectiveFormat(format, renderers, standard);
  // A tab's button text: a renderer's `label` (e.g. "large icons"), else the format slug itself.
  const labelOf = (f: Format): string => renderers.find((r) => r.name === f)?.label ?? f;
  const renderer = renderers.find((r) => r.name === effective) ?? null;
  const showRendered = renderer != null;
  // the document this node belongs to — the base its `#`-fragment anchors are measured from
  const docPath = node.documentPath ?? path;

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
  // representation, JOINED by the tags applied via annotations (deduped by path);
  // the remaining relations stay in the data-view panel.
  const { tags: relTags, rest } = splitTagRefs(node.relations);
  const tags = [...relTags];
  for (const a of anns) {
    if (a.tag && !tags.some((t) => t.path === a.tag!.path)) {
      tags.push({ path: a.tag.path, label: a.tag.name, color: a.tag.color });
    }
  }

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
                {labelOf(f)}
              </button>
              {showRendered && renderer && f === renderer.name && renderer.config?.(rerender, node)}
            </Fragment>
          ))}
          {/* the data views (yamlover / json5p / schema) share a render-depth control — how many
              levels of nested containers are inlined (and collapsible) before a continuation link */}
          {!showRendered && <DepthControl onChange={() => setReloadKey((k) => k + 1)} />}
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
              {/* the relations panel: refs may link in-page, but it gets NO fragment ids
                  (anchors=false) so its keys don't collide with the value's node ids */}
              <Render value={rest} syntax={syntaxOf(effective)} onNavigate={onNavigate} documentPath={docPath} nodePath={path} anchors={false} />
              <hr className="reldiv" />
            </>
          )}
          {ready ? <Render value={content} syntax={syntaxOf(effective)} onNavigate={onNavigate} documentPath={docPath} nodePath={path} comments={node.comments} /> : "…"}
        </pre>
      )}
    </div>
  );
});
