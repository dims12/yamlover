import { ReactNode } from "react";
// The LABEL/TOKEN grammar and the link-target law live in the shared parser module — the
// engine's move planner reads the same alternation and the same parseLinkTarget seam, so a
// spelling that renders here is exactly a spelling a move keeps alive there.
import { scanMarklower, type FragToken } from "../../../../parser/ts/src/marklower-links.ts";
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
 *   - **text styling**: `**bold**`/`__bold__`, `*italic*`/`_italic_`, and
 *     `~~strikethrough~~`. Emphasis may WRAP an atomic token (`` **`code`** ``,
 *     `*$$x$$*`) — see the emphasis-over-tokens law at {@link SpanBuf} — but a link
 *     is an emphasis boundary; a link's label styles itself (`[**bold**](t)`).
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

/** Apply emphasis to an ALREADY-ESCAPED run. Bold (`**`/`__`) runs before italic
 *  (`*`/`_`) so a double marker isn't mistaken for two single ones; non-greedy so
 *  neighbours don't merge. The markers (`* _ ~`) survive `escapeHtml`, so styling
 *  the escaped text is safe. An INTRA-WORD `_` is a literal character, not a marker
 *  (Markdown's rule, kept for the same reason): technical prose is full of
 *  `snake_case_ids`, and `unquoted_scalar_appending` must not italicize its middle.
 *  `*` keeps intra-word emphasis - identifiers don't use it. */
function emphasize(escaped: string): string {
  return escaped
    .replace(/~~(.+?)~~/g, "<del>$1</del>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<![A-Za-z0-9])__(.+?)__(?![A-Za-z0-9])/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/(?<![A-Za-z0-9])_(.+?)_(?![A-Za-z0-9])/g, "<em>$1</em>");
}

/** Style a plain-text run: escape it, then apply emphasis. */
function styleText(text: string): string {
  return emphasize(escapeHtml(text));
}

/**
 * THE EMPHASIS-OVER-TOKENS LAW: emphasis is applied to the whole run between links, with
 * each atomic token (code, math, a fence) collapsed to an opaque PLACEHOLDER while the
 * emphasis regexes run — so `` **`code`** `` bolds the code span the way Markdown would,
 * while a `*` INSIDE a token's contents can still never open or close emphasis (the
 * contents were swapped out of the text the regexes see). A LINK stays an emphasis
 * boundary on both faces: its label styles itself (`[**bold**](t)`).
 *
 * `text` accumulates escaped plain runs and placeholders; `render` styles the whole and
 * swaps the atoms back in.
 */
class SpanBuf {
  text = "";
  private atoms: string[] = [];
  addAtom(html: string): void {
    this.text += "\uE000" + (this.atoms.push(html) - 1) + "\uE001";
  }
  render(): string {
    return emphasize(this.text).replace(/\uE000(\d+)\uE001/g, (_, i) => this.atoms[Number(i)]);
  }
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
  let buf = new SpanBuf(); // the run since the last link, atoms as placeholders
  let key = 0;
  const flush = () => {
    const html = buf.render();
    buf = new SpanBuf();
    if (!html) return;
    nodes.push(<span key={key++} dangerouslySetInnerHTML={{ __html: html }} />);
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
    return escapeHtml(text.replace(/(?<=[^\n])\n(?=[^\n])/g, " ")); // emphasis waits for the flush
  };
  const joinTrail = () => {
    buf.text = buf.text.replace(/(?<=[^\n])\n[ \t]*$/, " ");
  };
  for (const t of scanMarklower(src)) {
    buf.text += plain(src.slice(last, t.start)); // plain run before this token
    joinLead = true; // every token is inline
    if (t.kind === "fence") {
      // a ``` fence — not marklower syntax, but ATOMIC all the same: passed through verbatim
      // so its odd backtick count can never desync the inline code arm behind it
      buf.addAtom(escapeHtml(t.raw));
      joinLead = false;
    } else if (t.kind === "math") {
      joinTrail();
      buf.addAtom(renderMath(t.body, false)); // $$ inline math $$
    } else if (t.kind === "code") {
      joinTrail();
      buf.addAtom(`<code>${escapeHtml(t.body)}</code>`); // `code` — contents literal
    } else if (t.kind === "frag" && t.link !== null) {
      // a LINKED fragment token — a real anchor so it navigates in JSON instance space; the
      // value keeps its own inline styling.
      joinTrail();
      flush();
      nodes.push(link(t.valueRaw, t.link));
    } else if (t.kind === "frag") {
      // a link-less FRAGMENT token — the value marked in place (docs/documents/marklower/grammar);
      // the token's bookmarks/fields are data, not chrome, so only the value shows
      joinTrail();
      buf.addAtom(`<mark class="yo-inline-fragment">${styleText(t.value)}</mark>`);
    }
    last = t.end;
  }
  buf.text += plain(src.slice(last));
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
  let buf = new SpanBuf(); // emphasis spans atoms here too (the emphasis-over-tokens law) …
  const cut = () => {
    html += buf.render();
    buf = new SpanBuf();
  };
  let last = 0;
  for (const t of scanMarklower(src)) {
    buf.text += escapeHtml(src.slice(last, t.start));
    if (t.kind === "fence") {
      // a ``` fence rides as one atom, its whole text the data-src — never re-tokenized
      buf.addAtom(`<code class="mlw-atom" contenteditable="false" data-src="${escapeAttr(t.raw)}">${escapeHtml(t.raw)}</code>`);
    } else if (t.kind === "math") {
      buf.addAtom(`<span class="mlw-atom" contenteditable="false" data-src="${escapeAttr(t.raw)}">${renderMath(t.body, false)}</span>`);
    } else if (t.kind === "code") {
      buf.addAtom(`<code class="mlw-atom" contenteditable="false" data-src="${escapeAttr(t.raw)}">${escapeHtml(t.body)}</code>`);
    } else if (t.kind === "frag" && t.link !== null) {
      // … but a LINKED fragment token stays an emphasis boundary, exactly as in the read
      // renderer's `parse` (there it must — a link is a real React element — and the two faces
      // must agree). data-src carries the VERBATIM token, so the round-trip is lossless.
      cut();
      html += `<a class="mlw-atom mlw-link" contenteditable="false" data-src="${escapeAttr(t.raw)}">${styleText(t.valueRaw)}</a>`;
    } else if (t.kind === "frag") {
      // a link-less fragment token: the marked value, one atom, verbatim data-src
      buf.addAtom(`<mark class="mlw-atom yo-inline-fragment" contenteditable="false" data-src="${escapeAttr(t.raw)}">${styleText(t.value)}</mark>`);
    }
    last = t.end;
  }
  buf.text += escapeHtml(src.slice(last));
  cut();
  return html;
}
