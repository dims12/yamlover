import { ReactNode } from "react";
import { parseLinkTarget } from "../../../parser/ts/src/marklower-links";
import type { Pointer } from "../../../parser/ts/src/ir";
import { Seg, segsToStr, strToSegs } from "./paths";

/**
 * The shared **link** concept: one place that decides what a link *target* means
 * and how a link is made clickable. Every renderer that emits links routes through
 * here, so link behaviour is defined once.
 *
 * THE TARGET LAW (docs/documents/marklower/link-targets): the parenthesized target is a
 * yamlover expression, classified by the ONE seam `parseLinkTarget` (parser/marklower-links)
 * the engine's move planner shares — a spelling that navigates here is exactly a spelling
 * a move keeps alive there:
 *
 *   - **`*<pointer>`** — the canonical in-tree link: a real yamlover pointer expression.
 *     `*:: a: b` project scope, `*: child` document scope, `*..: sib` parent scope,
 *     `*name` current scope. Relative scopes resolve against `holderPath` (the mapping
 *     the prose belongs to); `*: …` against `documentPath`.
 *   - **`::a:b` / `:a`** — the bare colon alias, read forever (same pointer, no sigil).
 *   - **`&…`** — a bookmark target, RESERVED: parsed but not resolved (renders as plain
 *     text). TODO(annotations refactor): give bookmark links behavior.
 *   - **`scheme://…` / `mailto:…`** — an ordinary external link.
 *   - **`/a/b` / `//a/b`** — legacy slash spellings, navigable but frozen.
 */

/** A link's resolved destination. Exactly one of `path` (an in-app JSON-space path
 *  for SPA navigation) or `href` (an external URL) is set. Both null: `dead` says
 *  whether the AUTHOR meant an in-tree link (a pointer/anchor expression that failed
 *  to resolve — rendered visibly broken, never silently as plain text) or the target
 *  was never a link at all (plain text). */
export interface ResolvedLink {
  path: string | null;
  href: string | null;
  dead?: boolean;
}

const UNRESOLVED: ResolvedLink = { path: null, href: null };
const DEAD: ResolvedLink = { path: null, href: null, dead: true };

/** The container mapping a piece of prose belongs to — the frame the relative pointer
 *  scopes (`*name`, `*..: x`) resolve against: a leaf scalar's PARENT. Null for the root.
 *  Presentational wrappers (bullets, tables) are TRANSPARENT: their renderers pass their
 *  own frame down instead of letting items re-derive it from their paths — the same law
 *  the engine's scanTextLinks applies, so navigation and moves can never disagree. */
export function holderOf(path: string | null | undefined): string | null {
  if (!path) return null;
  const segs = strToSegs(path);
  if (segs.length === 0) return null;
  return segsToStr(segs.slice(0, -1));
}

/** Tokenize a slash-spelled link target (`/a/b/0`, legacy `/a/b[0]`) into segments — the
 *  bare-token typing rule (bare digits = position, `~` = the null key, quotes = string key),
 *  with the retired `[n]` read forever as an alias. */
function slashSegs(str: string): Seg[] {
  const out: Seg[] = [];
  for (const tok of str.match(/\[\d+\]|[^/\[\]]+/g) || []) {
    if (/^\[\d+\]$/.test(tok)) { out.push(Number(tok.slice(1, -1))); continue; }
    if (tok === "~") { out.push(null); continue; }
    if (/^\d+$/.test(tok)) { out.push(Number(tok)); continue; }
    if (tok.length >= 2 && tok[0] === "'" && tok[tok.length - 1] === "'") { out.push(tok.slice(1, -1).replace(/''/g, "'")); continue; }
    out.push(tok);
  }
  return out;
}

/** The path a pointer expression addresses, given the two frames a link render carries:
 *  `documentPath` (the `/` scope) and `holderPath` (the mapping the prose belongs to — the
 *  `current`/`parent` frame). Null when a needed frame is missing or a step cannot be
 *  walked nominally (relative indexes, append). */
function pointerPath(ptr: Pointer, documentPath: string, holderPath: string | null): string | null {
  let segs: Seg[];
  switch (ptr.base.scope) {
    case "link":
      if (ptr.base.world) return null; // `::: uri` — an external world, not locally navigable
      segs = [ptr.base.authority];
      break;
    case "document":
      segs = strToSegs(documentPath);
      break;
    case "current":
      if (holderPath == null) return null;
      segs = strToSegs(holderPath);
      break;
    case "parent":
      if (holderPath == null) return null;
      segs = strToSegs(holderPath);
      if (segs.length === 0) return null;
      segs.pop();
      break;
  }
  for (const st of ptr.steps) {
    if (st.sel === "parent") { if (segs.length === 0) return null; segs.pop(); }
    else if (st.sel === "key") segs.push(st.name);
    else if (st.sel === "index") segs.push(st.n);
    else if (st.sel === "nullkey") segs.push(null);
    else return null; // `[.±k]` / `-` have no nominal path here
  }
  return segsToStr(segs);
}

/** Interpret a link `target` against its frames: `documentPath` (the document the link
 *  appears in) and `holderPath` (the mapping its prose belongs to — needed only for the
 *  relative pointer scopes; omitting it leaves those unresolved). */
export function resolveLink(target: string, documentPath = ":", holderPath: string | null = null): ResolvedLink {
  const t = parseLinkTarget(target);
  switch (t.kind) {
    case "pointer": {
      const path = pointerPath(t.ptr, documentPath, holderPath);
      // an in-tree intent that cannot resolve is DEAD, not plain text — the author wrote
      // a pointer; silence would hide the breakage (the dangling-prose-links report)
      return path === null ? DEAD : { path, href: null };
    }
    case "external":
      return { path: null, href: t.href };
    case "legacy-slash": {
      const raw = t.raw;
      if (raw.startsWith("//")) return { path: segsToStr(slashSegs(raw)), href: null }; // legacy project root
      return { path: segsToStr([...strToSegs(documentPath), ...slashSegs(raw)]), href: null }; // legacy doc-relative
    }
    case "anchor":
      return DEAD; // RESERVED — TODO(annotations refactor): bookmark-link behavior; visibly inert meanwhile
    case "unresolved":
      return UNRESOLVED; // never a link — plain prose stays plain
  }
}

/** Render a link as the right kind of anchor: an in-app `.descend` link that calls
 *  `onNavigate` for an internal target, an ordinary external `.extlink` for a URL,
 *  or plain children when the target doesn't resolve. The single place a link
 *  becomes clickable — shared by every renderer that emits links. */
export function NavLink({
  target,
  documentPath,
  holderPath,
  onNavigate,
  children,
}: {
  target: string;
  documentPath?: string;
  holderPath?: string | null;
  onNavigate: (path: string) => void;
  children: ReactNode;
}) {
  const { path, href, dead } = resolveLink(target, documentPath, holderPath ?? null);
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
  if (dead) {
    // the author wrote an in-tree link that resolves to nothing — say so where it stands
    return (
      <span className="deadlink" title={`link target does not resolve: ${target}`}>
        {children}
      </span>
    );
  }
  return <>{children}</>;
}
