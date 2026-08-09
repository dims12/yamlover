// The SHARED heuristic lexer for syntax highlighting — the module the JetBrains plugin's
// YamloverLexer.kt anticipates ("replace with the shared yamlover lexer once it exists").
// It is a HIGHLIGHTER, not the grammar: it never builds IR, never fails, and tokenizes any
// text — including half-typed source — into a flat run of classified slices. Consumers map
// {@link HlKind} to their own presentation (the web client maps to the `.k .s .n …` CSS
// vocabulary; a future terminal printer would map to ANSI). Pure: no React, no CSS, no DOM.
//
// The rules mirror YamloverLexer.kt: comments open only after whitespace/BOL (`a#b` is one
// scalar); a `*`/`&` sigil starts a colon-grammar path that runs to end of line in block
// context (the `: ` styling keeps interior spaces) and to the usual delimiters in flow;
// `|`/`>` block-scalar bodies are opaque (never re-lexed); quoted strings, `[n]`/`[.±k]`
// indices, word-before-`:` keys, keywords, numbers.
//
// Languages grow by a {@link HlLang} entry, not by new consumers: `yamlover` is the full
// colon grammar; `yaml` keeps the sigils but its alias/anchor names are single words (no
// colon run); `json5p` is flow end to end, its comments are `//` / `/* */` (never `#`),
// and its pointer paths ride quoted (`*': …'`).

export type HlLang = 'yamlover' | 'json5p' | 'yaml';

export type HlKind =
  | 'comment' // `# …` (yamlover/yaml) or `// …` / `/* … */` (json5p)
  | 'key'     // a word (or quoted string) immediately followed by `:`
  | 'string'  // a quoted scalar
  | 'number'  // numeric scalars, incl. hex and the float specials
  | 'keyword' // true / false (casings)
  | 'null'    // null / ~ (casings)
  | 'punct'   // structural punctuation: `: , { } [ ]` and the sigil-adjacent signs
  | 'dash'    // the sequence marker `- `
  | 'pointer' // a `* & ~` sigil itself
  | 'ref'     // a pointer path's name portions (the target)
  | 'index'   // a standalone `[n]` position
  | 'tag'     // `!!<…>` and the `!!word` type tags
  | 'space'   // whitespace runs (newlines included) — emitted so the slices concatenate back
  | 'plain';  // everything else (plain scalars, block-scalar bodies)

export interface HlToken {
  kind: HlKind;
  text: string;
}

/** Tokenize `text` for highlighting. Total: the concatenation of the returned slices is
 *  exactly `text`, whatever the input — a guarantee the tests pin. */
export function tokenize(text: string, lang: HlLang = 'yamlover'): HlToken[] {
  const colonRun = lang === 'yamlover'; // block pointer paths run to EOL with `: ` styling
  const hashComments = lang !== 'json5p';
  const end = text.length;
  const out: HlToken[] = [];
  let i = 0;
  let inPath = false;
  let inIndex = false;
  let flowDepth = 0;

  const isSpace = (c: string) => c === ' ' || c === '\t';
  const isEol = (c: string) => c === '\n' || c === '\r';
  const isSpaceOrEol = (c: string) => isSpace(c) || isEol(c);
  const isDigit = (c: string) => c >= '0' && c <= '9';
  const isWordBoundary = (c: string) =>
    isSpaceOrEol(c) || c === ':' || c === ',' || c === '{' || c === '}' || c === '[' || c === ']';
  const push = (kind: HlKind, from: number, to: number) => {
    if (to > from) out.push({ kind, text: text.slice(from, to) });
    i = to;
  };
  const toEol = (from: number): number => {
    let j = from;
    while (j < end && !isEol(text[j])) j++;
    return j;
  };
  const quotedEnd = (from: number, quote: string): number => {
    let j = from + 1;
    while (j < end) {
      const c = text[j];
      if (c === '\\' && quote === '"' && j + 1 < end) { j += 2; continue; }
      j++;
      if (c === quote) break;
    }
    return j;
  };

  /** A pointer path's hard boundaries (flow: the usual delimiters; block: EOL / ` #`). */
  const isPathBoundary = (c: string): boolean =>
    flowDepth > 0 ? isSpaceOrEol(c) || c === ',' || c === '{' || c === '}' || c === '#' : isSpaceOrEol(c) || c === '#';

  /** A run of spaces at `at`: does it END a block path (trailing before EOL / a comment), or
   *  is it interior — the `: ` colon styling? Flow paths (and single-word langs) end on it. */
  const spacesEndPath = (at: number): boolean => {
    if (flowDepth > 0 || !colonRun) return true;
    let j = at;
    while (j < end && isSpace(text[j])) j++;
    if (j >= end) return true;
    return isEol(text[j]) || text[j] === '#';
  };

  const lineIndentAt = (pos: number): number => {
    let ls = pos;
    while (ls > 0 && text[ls - 1] !== '\n') ls--;
    let j = ls;
    while (j < end && text[j] === ' ') j++;
    return j - ls;
  };

  /** A `|`/`>` opens a block header only at value start — after `key:`, a `- ` item, BOL, or a
   *  DECORATION TAG (`- !!<format: text/plain> |`, `- !!yo |`): the tag decorates the value, so
   *  the indicator after it still starts one — without this the tagged block's body would be
   *  re-lexed and an unbalanced quote inside could bleed a string across the chunks below. */
  const atValueStart = (pos: number): boolean => {
    let j = pos - 1;
    while (j >= 0 && isSpace(text[j])) j--;
    if (j < 0) return true;
    const c = text[j];
    if (c === ':' || c === '-' || isEol(c)) return true;
    if (c === '>') {
      // a closed `!!<…>` tag: scan to its `<` on this line, then require the `!!` sigil
      let k = j - 1;
      while (k >= 0 && !isEol(text[k]) && text[k] !== '<') k--;
      return k >= 2 && text[k] === '<' && text[k - 1] === '!' && text[k - 2] === '!';
    }
    // a bare `!!name` tag (`!!yo`, `!!set`, …)
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_-]/.test(text[k])) k--;
    return k >= 1 && k < j && text[k] === '!' && text[k - 1] === '!';
  };

  /** Past-the-indicators index if `from` (a `|`/`>`) opens a block header, else null. */
  const blockHeaderEnd = (from: number): number | null => {
    let j = from + 1;
    while (j < end && (text[j] === '+' || text[j] === '-' || isDigit(text[j]))) j++;
    let k = j;
    while (k < end && isSpace(text[k])) k++;
    return k >= end || isEol(text[k]) || text[k] === '#' ? j : null;
  };

  /** Header line + every blank or deeper-indented line — one opaque body token. */
  const blockScalarEnd = (from: number): number => {
    const headerIndent = lineIndentAt(from);
    let e = toEol(from);
    while (e < end) {
      const nextStart = e + 1 + (text[e] === '\r' && text[e + 1] === '\n' ? 1 : 0);
      let k = nextStart;
      while (k < end && text[k] === ' ') k++;
      const blank = k >= end || isEol(text[k]);
      if (!(blank || k - nextStart > headerIndent)) break;
      e = toEol(k);
    }
    return e;
  };

  const INF_NAN = /^[-+]?\.(inf|Inf|INF|nan|NaN|NAN)$/;
  const HEX = /^0[xX][0-9A-Fa-f]+$/;
  const NULLS = new Set(['null', 'Null', 'NULL', '~']);
  const BOOLS = new Set(['true', 'True', 'TRUE', 'false', 'False', 'FALSE']);

  const consumeWord = () => {
    let j = i + 1;
    while (j < end && !isWordBoundary(text[j])) j++;
    const word = text.slice(i, j);
    let k = j;
    while (k < end && isSpace(text[k])) k++;
    const kind: HlKind =
      k < end && text[k] === ':' ? 'key'
      : NULLS.has(word) ? 'null'
      : BOOLS.has(word) ? 'keyword'
      : INF_NAN.test(word) || HEX.test(word) || (word.trim() !== '' && !Number.isNaN(Number(word))) ? 'number'
      : 'plain';
    push(kind, i, j);
  };

  while (i < end) {
    const c = text[i];

    if (inPath) {
      if (isSpace(c) && !spacesEndPath(i)) {
        let j = i + 1;
        while (j < end && isSpace(text[j])) j++;
        push('space', i, j);
        continue;
      }
      if (c === ':' && colonRun) { push('punct', i, i + 1); continue; }
      if (c === '[') { inIndex = true; push('punct', i, i + 1); continue; }
      if (c === ']') { inIndex = false; push('punct', i, i + 1); continue; }
      if (inIndex && (c === '.' || c === '+' || c === '-')) { push('punct', i, i + 1); continue; }
      if (inIndex && isDigit(c)) {
        let j = i + 1;
        while (j < end && isDigit(text[j])) j++;
        push('number', i, j);
        continue;
      }
      if (c === "'" || c === '"') { push('ref', i, quotedEnd(i, c)); continue; }
      if (!isPathBoundary(c) && !(c === ':' && !colonRun)) {
        let j = i;
        while (j < end) {
          const ch = text[j];
          if (ch === '\\' && j + 1 < end) { j += 2; continue; }
          if (isSpace(ch) || ch === ':' || ch === '[' || ch === ']' || ch === "'" || ch === '"' || isPathBoundary(ch)) break;
          j++;
        }
        push('ref', i, j);
        continue;
      }
      inPath = false;
      inIndex = false;
      // fall through — the boundary character dispatches normally
    }

    if (isSpaceOrEol(c)) {
      let j = i + 1;
      while (j < end && isSpaceOrEol(text[j])) j++;
      push('space', i, j);
      continue;
    }
    if (c === '#' && hashComments) {
      if (i === 0 || isSpaceOrEol(text[i - 1])) push('comment', i, toEol(i));
      else consumeWord();
      continue;
    }
    if (c === '/' && !hashComments && text[i + 1] === '/') { push('comment', i, toEol(i)); continue; }
    if (c === '/' && !hashComments && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      push('comment', i, close < 0 ? end : close + 2);
      continue;
    }
    if ((c === '|' || c === '>') && lang !== 'json5p' && atValueStart(i) && blockHeaderEnd(i) !== null) {
      const bodyEnd = blockScalarEnd(i);
      push('punct', i, blockHeaderEnd(i)!);
      push('plain', i, bodyEnd); // i advanced past the header by the push above
      continue;
    }
    if (c === '!' && text[i + 1] === '!') {
      if (text[i + 2] === '<') {
        let j = i + 3;
        while (j < end && text[j] !== '>' && !isEol(text[j])) j++;
        if (j < end && text[j] === '>') j++;
        push('tag', i, j);
      } else {
        let j = i + 2;
        while (j < end && !isSpaceOrEol(text[j]) && text[j] !== ':') j++;
        push('tag', i, j);
      }
      continue;
    }
    if (c === '*' || c === '&') {
      push('pointer', i, i + 1);
      inPath = true;
      // a json5p pointer path rides quoted right after the sigil — take it as one ref token
      if (!colonRun && (text[i] === "'" || text[i] === '"')) {
        push('ref', i, quotedEnd(i, text[i]));
        inPath = false;
      }
      continue;
    }
    if (c === '~') {
      const next = i + 1 < end ? text[i + 1] : ' ';
      if (!isWordBoundary(next) && next !== '~' && next !== '*' && next !== '&') push('pointer', i, i + 1);
      else consumeWord();
      continue;
    }
    if (c === '"' || c === "'") {
      const j = quotedEnd(i, c);
      let k = j;
      while (k < end && isSpace(text[k])) k++;
      push(k < end && text[k] === ':' ? 'key' : 'string', i, j);
      continue;
    }
    if (c === '[') {
      let j = i + 1;
      while (j < end && isDigit(text[j])) j++;
      if (j > i + 1 && j < end && text[j] === ']') {
        push('index', i, j + 1);
      } else {
        flowDepth++;
        push('punct', i, i + 1);
      }
      continue;
    }
    if (c === '{') { flowDepth++; push('punct', i, i + 1); continue; }
    if (c === '}' || c === ']') {
      if (flowDepth > 0) flowDepth--;
      push('punct', i, i + 1);
      continue;
    }
    if (c === '-' && (i + 1 >= end || isSpaceOrEol(text[i + 1]))) { push('dash', i, i + 1); continue; }
    if (c === ':' || c === ',') { push('punct', i, i + 1); continue; }
    consumeWord();
  }
  return out;
}
