package net.inthemoon.yamlover

private val YAMLOVER_TOKENS = HlLexerBase.Tokens(
    comment = YamloverTokenTypes.COMMENT,
    key = YamloverTokenTypes.KEY,
    string = YamloverTokenTypes.STRING,
    number = YamloverTokenTypes.NUMBER,
    keyword = YamloverTokenTypes.KEYWORD,
    nullKind = YamloverTokenTypes.NULL,
    punct = YamloverTokenTypes.PUNCT,
    dash = YamloverTokenTypes.DASH,
    pointer = YamloverTokenTypes.POINTER,
    ref = YamloverTokenTypes.REF,
    index = YamloverTokenTypes.INDEX,
    tag = YamloverTokenTypes.TAG,
    scalar = YamloverTokenTypes.SCALAR,
)

/**
 * Heuristic highlighting lexer for **yamlover** — `tokenize(text, 'yamlover')` of the shared
 * engine ({@link HlLexerBase}, the Kotlin port of tools/parser/ts/src/highlight.ts): the full
 * COLON grammar, where a `*`/`&` sigil starts a pointer path that runs to end of line in
 * block context, `#` opens comments only after whitespace/BOL, and `|`/`>` block-scalar
 * bodies are opaque.
 */
class YamloverLexer : HlLexerBase(colonRun = true, hashComments = true, YAMLOVER_TOKENS)
