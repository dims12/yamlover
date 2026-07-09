import { ReactNode } from "react";
import { NodeJson } from "../api";
import { scalarValue } from "../render";
import { Chunk } from "./registry";
import { renderMath } from "./latex";
import { NavLink } from "../links";
import { embed } from "../embed";
import { EmbedChip, EmbedFigure, GLYPH } from "./embed";

/**
 * The renderer for `text/marklower` — our own lightweight markup language, **marklower**:
 * deliberately a notch below Markdown ("downshifted" from it), spec'd in `MARKLOWER.md`. It is the
 * format a chapter's prose chunks carry (`$defs/chunk`, stamped by schema propagation); a
 * format-less string elsewhere in the tree is data, and routes to the data view rather than here.
 *
 * The language covers inline concerns only — font styling, hyperlinks, media embeds, math, and code
 * spans — but deliberately **no** chapter structure: no headings/subheadings, since a chapter's
 * shape is its positional body (CHAPTER.md), not its markup.
 *
 * The syntax so far is all inline:
 *
 *   - **atomic tokens**, whose contents are *not* re-interpreted as markup:
 *     `$$…$$` math (typeset with KaTeX via the shared {@link renderMath}, the same
 *     path the `text/x-latex` renderer uses) and `` `code` `` spans;
 *   - **links**: `[text](target)`, where `target` is a path in the app's JSON
 *     instance space (the same space the whole app navigates). Resolved and made
 *     clickable through the shared {@link NavLink} — the one link concept that refs
 *     and rels are expected to adopt later;
 *   - **text styling** on the plain runs between those: `**bold**`/`__bold__`,
 *     `*italic*`/`_italic_`, and `~~strikethrough~~`.
 *
 * Anything else is passed through verbatim. `parse` is the single seam every entry
 * point goes through, so there is one place to teach the grammar.
 */

/** Escape a plain-text run so it can be dropped into HTML (`parse` emits HTML now
 *  that some tokens — math, code, emphasis — render to markup). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Style a plain-text run (one of the stretches between the atomic tokens): escape
 *  it, then apply emphasis. Bold (`**`/`__`) runs before italic (`*`/`_`) so a
 *  double marker isn't mistaken for two single ones; non-greedy so neighbours don't
 *  merge. The markers (`* _ ~`) survive `escapeHtml`, so styling the escaped text
 *  is safe. */
function styleText(text: string): string {
  return escapeHtml(text)
    .replace(/~~(.+?)~~/g, "<del>$1</del>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/_(.+?)_/g, "<em>$1</em>");
}

/** A link/embed label: may contain a balanced `[…]` (so a path used as its own label —
 *  `[:children[0]](:children[0])` — works), but a stray `]` is not a label, so a non-link `[a]` in
 *  prose is left alone. Non-greedy so adjacent tokens don't merge. */
const LABEL = String.raw`(?:[^\[\]]|\[[^\]]*\])*?`;

/** The non-text tokens, in one alternation matched in source order:
 *
 *   1. `$$…$$` math (group 1; `[\s\S]` so a formula may span lines);
 *   2. `` `code` `` (group 2);
 *   3. `*[label](target)` — an EMBED (groups 3 = label, 4 = target): the target is *inlined*
 *      rather than pointed at, `*` carrying the same deref sense it has in yamlover proper;
 *   4. `[label](target)` — an ordinary link (groups 5 = label, 6 = target).
 *
 * The embed's `(?!\*)` guard keeps the one collision with emphasis honest: `*[a](b)*` is an
 * *italic link* (the `*`s pair around it), while `*[a](b)` is an embed. Bold (`**[a](b)**`) is
 * likewise unaffected — the second `*` starts an embed that the trailing `*` immediately vetoes,
 * and the alternation falls through to the plain link.
 */
const TOKEN = new RegExp(
  String.raw`\$\$([\s\S]+?)\$\$|` + // 1: math
    "`([^`]+?)`|" + // 2: code
    String.raw`\*\[(${LABEL})\]\(([^)]+?)\)(?!\*)|` + // 3,4: embed
    String.raw`\[(${LABEL})\]\(([^)]+?)\)`, // 5,6: link
  "g",
);

/** True when a token occupies its own line (only blank space around it) — the one thing that
 *  decides whether an embed renders as a block `<figure>` or an inline chip. Position, not kind:
 *  the same YouTube target is a figure on its own line and a chip mid-sentence. */
function standsAlone(src: string, start: number, end: number): boolean {
  return /(^|\n)[ \t]*$/.test(src.slice(0, start)) && /^[ \t]*(\n|$)/.test(src.slice(end));
}

/** What {@link parse} produced: the node list, plus whether any of it is a BLOCK embed — a
 *  `<figure>` may not sit inside the `<p>` a prose chunk normally wraps itself in (the browser
 *  would hoist it out and scramble the DOM), so the caller picks its wrapper accordingly. */
interface Parsed {
  nodes: ReactNode[];
  block: boolean;
}

/** Parse marklower into React nodes. Most syntax renders to an HTML string (math,
 *  code, emphasis), accumulated and flushed into `<span>`s; a link and an embed must be real
 *  elements (an HTML `<a href>` would reload; an embed carries state), so the result
 *  is a node list, not one HTML string. `documentPath` anchors a link's `:…`
 *  (document-relative) target. */
function parse(value: unknown, onNavigate: (path: string) => void, documentPath?: string): Parsed {
  const src = String(value ?? "");
  const nodes: ReactNode[] = [];
  let html = ""; // buffer of HTML-rendered runs between links
  let key = 0;
  let block = false;
  const flush = () => {
    if (!html) return;
    nodes.push(<span key={key++} dangerouslySetInnerHTML={{ __html: html }} />);
    html = "";
  };
  const link = (label: string, target: string) => (
    <NavLink key={key++} target={target} documentPath={documentPath} onNavigate={onNavigate}>
      <span dangerouslySetInnerHTML={{ __html: styleText(label) }} />
    </NavLink>
  );
  let last = 0;
  // A block embed's own line has to disappear with it: the newline that ENDED the preceding run and
  // the one that BEGINS the following run are the figure's line, and `.chapter-prose` preserves
  // whitespace (`pre-wrap`), so leaving them would open a blank line above and below the figure.
  let trimLead = false;
  const plain = (text: string) => styleText(trimLead ? text.replace(/^[ \t]*\n/, "") : text);
  for (const m of src.matchAll(TOKEN)) {
    html += plain(src.slice(last, m.index)); // plain run before this token
    trimLead = false;
    const end = m.index + m[0].length;
    if (m[1] !== undefined) {
      html += renderMath(m[1], false); // $$ inline math $$
    } else if (m[2] !== undefined) {
      html += `<code>${escapeHtml(m[2])}</code>`; // `code` — contents literal
    } else if (m[3] !== undefined) {
      // *[label](target) — inline the target itself. A target nothing claims (an ordinary page, a
      // host off the provider allowlist) degrades to the link it already was.
      const spec = embed(m[4], documentPath);
      if (!spec) {
        flush();
        nodes.push(link(m[3], m[4]));
      } else if (standsAlone(src, m.index, end)) {
        block = true;
        trimLead = true;
        html = html.replace(/\n[ \t]*$/, ""); // the newline that opened the figure's line
        flush();
        nodes.push(<EmbedFigure key={key++} spec={spec} label={m[3]} />);
      } else {
        flush();
        nodes.push(<EmbedChip key={key++} spec={spec} label={m[3]} />);
      }
    } else {
      // [label](target) — a real anchor so it navigates in JSON instance space; the
      // label keeps its own inline styling.
      flush();
      nodes.push(link(m[5], m[6]));
    }
    last = end;
  }
  html += plain(src.slice(last));
  flush();
  return { nodes, block };
}

/** A parsed chunk's wrapper: a paragraph, unless a block embed forces a `<div>` (see {@link Parsed}). */
function Prose({ parsed }: { parsed: Parsed }) {
  const Tag = parsed.block ? "div" : "p";
  return <Tag className="chapter-prose">{parsed.nodes}</Tag>;
}

export function MarklowerView({ node, onNavigate }: { node: NodeJson; onNavigate: (path: string) => void }) {
  return (
    <div className="marklower">
      {node.title && <h1 className="chapter-title">{node.title}</h1>}
      {node.description && <p className="chapter-subtitle">{node.description}</p>}
      <Prose parsed={parse(scalarValue(node.value), onNavigate, node.documentPath)} />
    </div>
  );
}

/** A marklower chunk embedded inline in a chapter (the chapter supplies the
 *  surrounding number + anchor). */
export function MarklowerChunk({ chunk, onNavigate }: { chunk: Chunk; onNavigate: (path: string) => void }) {
  return <Prose parsed={parse(chunk.value, onNavigate, chunk.documentPath)} />;
}

// --------------------------------------------------------------------------- //
// The WYSIWYG editor (unlocked mode). A prose chunk becomes a contentEditable that LOOKS exactly
// like its read-only render; plain runs and emphasis (**/*/~~) are edited live, while ATOMIC tokens
// (math, code, links) render non-editable and carry their marklower source in `data-src`, so the
// round-trip through domToMarklower is lossless.
// --------------------------------------------------------------------------- //

/** Escape a string for an HTML attribute value (for `data-src`). */
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Marklower → the editor's HTML string: emphasis stays editable inline markup; each atomic token
 *  becomes a `contenteditable=false` element tagged with its verbatim marklower source in
 *  `data-src` (so {@link domToMarklower} reproduces it exactly rather than re-serializing the
 *  rendered KaTeX / code / link). */
export function marklowerToEditableHtml(value: unknown): string {
  const src = String(value ?? "");
  let html = "";
  let last = 0;
  for (const m of src.matchAll(TOKEN)) {
    html += styleText(src.slice(last, m.index));
    if (m[1] !== undefined) {
      html += `<span class="mlw-atom" contenteditable="false" data-src="${escapeAttr("$$" + m[1] + "$$")}">${renderMath(m[1], false)}</span>`;
    } else if (m[2] !== undefined) {
      html += `<code class="mlw-atom" contenteditable="false" data-src="${escapeAttr("`" + m[2] + "`")}">${escapeHtml(m[2])}</code>`;
    } else if (m[3] !== undefined) {
      // An embed edits as a static chip, never as its live media: a playing video (or a frame that
      // swallows clicks) inside a contentEditable cannot be selected, moved, or deleted.
      const spec = embed(m[4]);
      html += `<span class="mlw-atom mlw-embed-chip" contenteditable="false" data-src="${escapeAttr("*[" + m[3] + "](" + m[4] + ")")}">${spec ? GLYPH[spec.kind] : "▶"} ${escapeHtml(m[3])}</span>`;
    } else {
      html += `<a class="mlw-atom mlw-link" contenteditable="false" data-src="${escapeAttr("[" + m[5] + "](" + m[6] + ")")}">${styleText(m[5])}</a>`;
    }
    last = m.index + m[0].length;
  }
  html += styleText(src.slice(last));
  return html;
}

