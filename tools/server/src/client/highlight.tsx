import { tokenize, type HlKind, type HlLang } from "../../../parser/ts/src/highlight.ts";

/**
 * The presentation half of the shared highlighting lexer (tools/parser/ts/src/highlight.ts):
 * maps its language-neutral token kinds onto the client's EXISTING token-class vocabulary —
 * the same `.k .s .n .b .null .punct .c .yaml-dash` spans the structured renderers
 * (render.tsx, the yed cells) emit, so highlighted source and rendered structure share one
 * palette (COLORS.md). A pointer path's name portions get the one NEW class, `.ref` — the
 * reference color without `.descend`'s link affordance (a highlight is not a hyperlink).
 */

/** The `format` values that name a tokenizable language — grows with the lexer. */
const LANG_BY_FORMAT: Record<string, HlLang> = {
  "text/x-yamlover": "yamlover",
  "text/x-json5p": "json5p",
  "text/x-yaml": "yaml",
  yamlover: "yamlover",
  json5p: "json5p",
  yaml: "yaml",
};

export function highlightLang(format: string | null | undefined): HlLang | null {
  return (format && LANG_BY_FORMAT[format]) || null;
}

const CLASS_BY_KIND: Record<HlKind, string | null> = {
  comment: "c",
  key: "k",
  string: "s",
  number: "n",
  keyword: "b",
  null: "null",
  punct: "punct",
  dash: "punct yaml-dash",
  pointer: "punct",
  ref: "ref",
  index: "punct",
  tag: "b",
  space: null, // plain text — no span
  plain: null,
};

/** The token spans for `text` in `lang` — the shared building block: the code chunk wraps
 *  them in its own `<pre>` (plaintext.tsx), the read-only renderer splices them into an
 *  existing one (render.tsx block-scalar bodies). */
export function highlightSpans(text: string, lang: HlLang): React.ReactNode[] {
  return tokenize(text, lang).map((t, i) => {
    const cls = CLASS_BY_KIND[t.kind];
    return cls ? <span key={i} className={cls}>{t.text}</span> : t.text;
  });
}
