// The clipboard's FILE flavor, shared by the two places that accept a pasted file: NodeView's
// page-level paste listener (a file becomes a chunk / a directory child) and the WYSIWYG chunk
// editor's own listener (an image becomes a file beside the chapter, referenced by an embed token).

const MIME_EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
  "image/svg+xml": "svg", "image/bmp": "bmp", "image/tiff": "tiff", "application/pdf": "pdf",
};

/** The files carried by a clipboard paste (a file-manager copy fills `files`; a copied image
 *  arrives as an `items` entry of kind "file"). */
export function clipboardFiles(e: ClipboardEvent): File[] {
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
export function pastedName(f: File): string {
  if (f.name) return f.name;
  return `pasted.${MIME_EXT[f.type] || "bin"}`;
}

/** Read a File as base64 (the bare payload, no data-URL prefix). */
export function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("could not read file"));
    r.readAsDataURL(f);
  });
}
