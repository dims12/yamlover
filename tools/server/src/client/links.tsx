import { ReactNode } from "react";
import { segsToStr, strToSegs } from "./paths";

/**
 * The shared **link** concept: one place that decides what a link *target* means
 * and how a link is made clickable. Every renderer that emits links routes through
 * here, so link behaviour is defined once.
 *
 * A target is addressed in the app's JSON instance space — the same space the
 * tree, breadcrumbs, and the URL all navigate — with two anchors, mirroring how an
 * `x-yamlover` `rel` pointer is written:
 *
 *   - **`/some/path`** — relative to the *document* the link appears in (the
 *     nearest yamlover entity; "document" meaning the literal file/entity, overlays
 *     and all). Resolved against the `documentPath` the server reports for the node.
 *   - **`//some/path`** — relative to the *project root* (the location given at
 *     yamlover startup), i.e. the served root → browser path `/some/path`.
 *   - **`scheme://…` / `mailto:…`** — an ordinary external link.
 *
 * `resolveLink` is deliberately the single seam for interpretation: it is where
 * refs and rels are expected to plug in later (gaining the full pointer grammar —
 * `..`, `^name`, virtual children), rather than each renderer re-deciding what a
 * target points at. (Refs/rels keep their own server-side interpretation for now;
 * this powers marklower links.)
 */

/** A link's resolved destination. Exactly one of `path` (an in-app JSON-space path
 *  for SPA navigation) or `href` (an external URL) is set; both null means the
 *  target did not resolve and the link renders as plain text. */
export interface ResolvedLink {
  path: string | null;
  href: string | null;
}

const UNRESOLVED: ResolvedLink = { path: null, href: null };

/** True for an external target carrying a URI scheme (`http:`, `https:`, `mailto:`,
 *  …). A `//`-rooted project path is *not* a scheme (no leading `scheme:`). */
const hasScheme = (s: string) => /^[a-z][a-z0-9+.-]*:/i.test(s);

/** Join a document base path with a document-relative path (both JSON-space),
 *  canonicalizing the result. */
function joinDoc(documentPath: string, rel: string): string {
  return segsToStr([...strToSegs(documentPath), ...strToSegs(rel)]);
}

/** Tokenize a LEGACY slash-spelled link target (`/a/b[0]`) into segments. */
function slashSegs(str: string): (string | number)[] {
  const out: (string | number)[] = [];
  for (const tok of str.match(/\[\d+\]|[^/\[\]]+/g) || []) {
    out.push(/^\[\d+\]$/.test(tok) ? Number(tok.slice(1, -1)) : tok);
  }
  return out;
}

/** Interpret a link `target` against the `documentPath` it appears in (the JSON-space
 *  path of its document; defaults to root). Colon spellings (`:a:b`, `::a:b` —
 *  SEPARATOR.md) are canonical; legacy slash spellings (`/a/b`, `//a/b`) still parse. */
export function resolveLink(target: string, documentPath = ":"): ResolvedLink {
  const raw = target.trim();
  if (!raw) return UNRESOLVED;
  if (raw.startsWith("::")) return { path: segsToStr(strToSegs(raw.slice(2))), href: null }; // project root
  if (raw.startsWith(":")) return { path: joinDoc(documentPath, raw), href: null }; // document-relative
  if (raw.startsWith("//")) return { path: segsToStr(slashSegs(raw)), href: null }; // legacy project root
  if (hasScheme(raw)) return { path: null, href: raw }; // external (http(s)/mailto/…)
  if (raw.startsWith("/")) return { path: segsToStr([...strToSegs(documentPath), ...slashSegs(raw)]), href: null }; // legacy doc-relative
  return UNRESOLVED; // anything else is not (yet) a recognized link target
}

/** Render a link as the right kind of anchor: an in-app `.descend` link that calls
 *  `onNavigate` for an internal target, an ordinary external `.extlink` for a URL,
 *  or plain children when the target doesn't resolve. The single place a link
 *  becomes clickable — shared by every renderer that emits links. */
export function NavLink({
  target,
  documentPath,
  onNavigate,
  children,
}: {
  target: string;
  documentPath?: string;
  onNavigate: (path: string) => void;
  children: ReactNode;
}) {
  const { path, href } = resolveLink(target, documentPath);
  if (href) {
    return (
      <a className="extlink" href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }
  if (path) {
    return (
      <a
        className="descend"
        href={path}
        onClick={(e) => {
          e.preventDefault();
          onNavigate(path);
        }}
      >
        {children}
      </a>
    );
  }
  return <>{children}</>;
}
