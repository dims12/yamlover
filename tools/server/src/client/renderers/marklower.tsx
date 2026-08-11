import { ReactNode } from "react";
// The LABEL/TOKEN grammar and the link-target law live in the shared parser module — the
// engine's move planner reads the same alternation and the same parseLinkTarget seam, so a
// spelling that renders here is exactly a spelling a move keeps alive there.
import { TOKEN } from "../../../../parser/ts/src/marklower-links.ts";
import { NodeJson } from "../api";
import { scalarValue } from "../render";
import { Chunk } from "./registry";
import { renderMath } from "./latex";
import { NavLink, holderOf } from "../links";
import { embed } from "../embed";
import { EmbedFigure } from "./embed";

/**
 * The renderer for `text/marklower` — our own lightweight markup language, **marklower**:
 * deliberately a notch below Markdown ("downshifted" from it), spec'd in `docs/documents/marklower`. It is the
 * format a chapter's prose chunks carry (`$defs/chunk`, stamped by schema propagation); a
 * format-less string elsewhere in the tree is data, and routes to the data view rather than here.
 *
 * The language covers inline concerns only — font styling, hyperlinks, math, and code
 * spans — but deliberately **no** structure: no headings/subheadings and NO embed syntax,
 * since a chapter's shape (and everything embedded in it) is its positional body
 * (docs/documents/chapter) — structure is delegated to yamlover. A MEDIA chunk — one whose
 * entire text is a single embeddable target — renders as a figure (see {@link MarklowerChunk});
 * that is a property of the chunk, not a text token.
 *
 * The syntax so far is all inline:
 *
 *   - **atomic tokens**, whose contents are *not* re-interpreted as markup:
 *     `$$…$$` math (typeset with KaTeX via the shared {@link renderMath}, the same
 *     path the `text/x-latex` renderer uses) and `` `code` `` spans;
 *   - **links**: `[text](target)`, where `target` is a yamlover expression — canonically a
 *     sigiled pointer (`*:: a: b`, `*: child`, `*..: sib`, `*name`), with the bare colon
 *     form read forever (docs/documents/marklower/link-targets). Resolved and made
 *     clickable through the shared {@link NavLink};
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
 *  is safe. An INTRA-WORD `_` is a literal character, not a marker (Markdown's rule,
 *  kept for the same reason): technical prose is full of `snake_case_ids`, and
 *  `unquoted_scalar_appending` must not italicize its middle. `*` keeps intra-word
 *  emphasis - identifiers don't use it. */
function styleText(text: string): string {
  return escapeHtml(text)
    .replace(/~~(.+?)~~/g, "<del>$1</del>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<![A-Za-z0-9])__(.+?)__(?![A-Za-z0-9])/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/(?<![A-Za-z0-9])_(.+?)_(?![A-Za-z0-9])/g, "<em>$1</em>");
}

/** Parse marklower into React nodes. Most syntax renders to an HTML string (math,
 *  code, emphasis), accumulated and flushed into `<span>`s; a link must be a real
 *  element (an HTML `<a href>` would reload), so the result is a node list, not one
 *  HTML string. `documentPath` anchors a link's `*: …` (document-scope) target;
 *  `holderPath` the relative scopes (`*name`, `*..: x`). */
function parse(
  value: unknown,
  onNavigate: (path: string) => void,
  documentPath?: string,
  holderPath?: string | null,
): ReactNode[] {
  const src = String(value ?? "");
  const nodes: ReactNode[] = [];
  let html = ""; // buffer of HTML-rendered runs between links
  let key = 0;
  const flush = () => {
    if (!html) return;
    nodes.push(<span key={key++} dangerouslySetInnerHTML={{ __html: html }} />);
    html = "";
  };
  const link = (label: string, target: string) => (
    <NavLink key={key++} target={target} documentPath={documentPath} holderPath={holderPath} onNavigate={onNavigate}>
      <span dangerouslySetInnerHTML={{ __html: styleText(label) }} />
    </NavLink>
  );
  let last = 0;
  // A SINGLE newline is a soft break — the hard-wrapped source line reflows at the reading width
  // (markupWidthCh), the way Markdown joins a paragraph's lines. A blank line stays: under
  // `pre-wrap` it is the gap the author drew. At a run's edge the newline joins across an inline
  // token (`joinLead`/`joinTrail`: `text\n$$x$$` is one sentence).
  let joinLead = false;
  const plain = (text: string) => {
    if (joinLead) text = text.replace(/^\n(?!\n)/, " ");
    return styleText(text.replace(/(?<=[^\n])\n(?=[^\n])/g, " "));
  };
  const joinTrail = () => {
    html = html.replace(/(?<=[^\n])\n[ \t]*$/, " ");
  };
  for (const m of src.matchAll(TOKEN)) {
    html += plain(src.slice(last, m.index)); // plain run before this token
    joinLead = true; // every token is inline
    if (m[1] !== undefined) {
      // a ``` fence — not marklower syntax, but ATOMIC all the same: passed through verbatim
      // so its odd backtick count can never desync the inline code arm behind it
      html += escapeHtml(m[0]);
      joinLead = false;
    } else if (m[2] !== undefined) {
      joinTrail();
      html += renderMath(m[2], false); // $$ inline math $$
    } else if (m[3] !== undefined) {
      joinTrail();
      html += `<code>${escapeHtml(m[3])}</code>`; // `code` — contents literal
    } else {
      // [label](target) — a real anchor so it navigates in JSON instance space; the
      // label keeps its own inline styling.
      joinTrail();
      flush();
      nodes.push(link(m[4], m[5]));
    }
    last = m.index + m[0].length;
  }
  html += plain(src.slice(last));
  flush();
  return nodes;
}

/** A parsed chunk's wrapper — always a paragraph now that no text token is a block. */
function Prose({ nodes }: { nodes: ReactNode[] }) {
  return <p className="chapter-prose">{nodes}</p>;
}

export function MarklowerView({ node, onNavigate }: { node: NodeJson; onNavigate: (path: string) => void }) {
  return (
    <div className="marklower">
      {node.title && <h1 className="chapter-title">{node.title}</h1>}
      {node.description && <p className="chapter-subtitle">{node.description}</p>}
      <Prose nodes={parse(scalarValue(node.value), onNavigate, node.documentPath, holderOf(node.path))} />
    </div>
  );
}

/** A marklower chunk embedded inline in a chapter (the chapter supplies the surrounding
 *  number + anchor). A MEDIA chunk — the entire text is one embeddable target — renders as
 *  the figure: embedding is a body-level property of the chunk, never a text token
 *  (docs/documents/marklower/embeds). */
export function MarklowerChunk({ chunk, onNavigate }: { chunk: Chunk; onNavigate: (path: string) => void }) {
  const text = String(chunk.value ?? "").trim();
  if (text !== "" && !/\s/.test(text)) {
    const spec = embed(text, chunk.documentPath);
    if (spec) return <EmbedFigure spec={spec} label="" />;
  }
  return <Prose nodes={parse(chunk.value, onNavigate, chunk.documentPath, chunk.holderPath ?? holderOf(chunk.path))} />;
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
      // a ``` fence rides as one atom, its whole text the data-src — never re-tokenized
      html += `<code class="mlw-atom" contenteditable="false" data-src="${escapeAttr(m[0])}">${escapeHtml(m[0])}</code>`;
    } else if (m[2] !== undefined) {
      html += `<span class="mlw-atom" contenteditable="false" data-src="${escapeAttr("$$" + m[2] + "$$")}">${renderMath(m[2], false)}</span>`;
    } else if (m[3] !== undefined) {
      html += `<code class="mlw-atom" contenteditable="false" data-src="${escapeAttr("`" + m[3] + "`")}">${escapeHtml(m[3])}</code>`;
    } else {
      html += `<a class="mlw-atom mlw-link" contenteditable="false" data-src="${escapeAttr("[" + m[4] + "](" + m[5] + ")")}">${styleText(m[4])}</a>`;
    }
    last = m.index + m[0].length;
  }
  html += styleText(src.slice(last));
  return html;
}
