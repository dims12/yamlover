package net.inthemoon.yamlover

import com.intellij.lexer.LexerBase
import com.intellij.psi.TokenType
import com.intellij.psi.tree.IElementType

/**
 * v1 heuristic lexer for syntax highlighting only — NOT the real grammar.
 *
 * It recognizes comments (`#`, only after whitespace/BOL — the parser's rule, so `a#b` is one
 * scalar), pointer/anchor runs in the COLON grammar (`* & ~ …`; `:` separates portions, `/`
 * is an ordinary key char — SEPARATOR.md), block scalars (`|`/`>` headers whose indented body
 * is opaque, not re-lexed), quoted strings, `[n]`/`[.±k]` indices, keys (a word followed by
 * `:`), keywords, numbers, scalars and punctuation. It does not build PSI. Replace with the
 * shared yamlover lexer once it exists.
 */
class YamloverLexer : LexerBase() {
    private var buffer: CharSequence = ""
    private var endOffset = 0
    private var tokenStart = 0
    private var tokenEnd = 0
    private var tokenType: IElementType? = null
    private var inPath = false    // tokenizing a pointer's path/target after a `*`/`&`/`~` sigil
    private var inIndex = false   // inside `[ … ]` within a path
    private var flowDepth = 0     // inside `{…}` / `[…]` flow — pointer boundaries differ there
    private var pathToEol = false // a `*`/`&` pointer path (runs to EOL in block, spaced `: ` styling)

    override fun start(buffer: CharSequence, startOffset: Int, endOffset: Int, initialState: Int) {
        this.buffer = buffer
        this.endOffset = endOffset
        this.tokenStart = startOffset
        this.tokenEnd = startOffset
        inPath = false
        inIndex = false
        flowDepth = 0
        advance()
    }

    override fun getState(): Int = 0
    override fun getTokenType(): IElementType? = tokenType
    override fun getTokenStart(): Int = tokenStart
    override fun getTokenEnd(): Int = tokenEnd
    override fun getBufferSequence(): CharSequence = buffer
    override fun getBufferEnd(): Int = endOffset

    override fun advance() {
        tokenStart = tokenEnd
        if (tokenStart >= endOffset) {
            tokenType = null
            return
        }
        if (inPath) {
            val c = buffer[tokenStart]
            when {
                (c == ' ' || c == '\t') && !spacesEndPath(tokenStart) -> {
                    // an interior space of a BLOCK pointer path — the canonical `: ` styling
                    // keeps a space around each colon separator: stay in path mode
                    tokenEnd = tokenStart + 1
                    while (tokenEnd < endOffset && (buffer[tokenEnd] == ' ' || buffer[tokenEnd] == '\t')) tokenEnd++
                    tokenType = TokenType.WHITE_SPACE
                    return
                }
                isPathBoundary(c) -> { inPath = false; inIndex = false }   // path ended → normal dispatch
                c == ':' -> { tokenEnd = tokenStart + 1; tokenType = YamloverTokenTypes.PUNCT; return } // portion separator
                c == '[' -> { tokenEnd = tokenStart + 1; inIndex = true; tokenType = YamloverTokenTypes.PUNCT; return }
                c == ']' -> { tokenEnd = tokenStart + 1; inIndex = false; tokenType = YamloverTokenTypes.PUNCT; return }
                inIndex && (c == '.' || c == '+' || c == '-') -> { // a relative index `[.±k]`
                    tokenEnd = tokenStart + 1; tokenType = YamloverTokenTypes.PUNCT; return
                }
                inIndex && c.isDigit() -> {
                    tokenEnd = tokenStart + 1
                    while (tokenEnd < endOffset && buffer[tokenEnd].isDigit()) tokenEnd++
                    tokenType = YamloverTokenTypes.NUMBER
                    return
                }
                c == '\'' || c == '"' -> { consumeString(c); tokenType = YamloverTokenTypes.STRING; return } // a quoted portion
                else -> {  // a name segment (REF); `/` is an ordinary key char, respect `\` escapes
                    tokenEnd = tokenStart
                    while (tokenEnd < endOffset) {
                        val ch = buffer[tokenEnd]
                        if (ch == '\\' && tokenEnd + 1 < endOffset) { tokenEnd += 2; continue }
                        if (ch == ' ' || ch == '\t' || ch == ':' || ch == '[' || ch == ']' ||
                            ch == '\'' || ch == '"' || isPathBoundary(ch)) break
                        tokenEnd++
                    }
                    tokenType = YamloverTokenTypes.REF
                    return
                }
            }
            // only reached when the path ended on a boundary — fall through to normal dispatch
        }
        when (val c = buffer[tokenStart]) {
            '\n', '\r', ' ', '\t' -> {
                tokenEnd = tokenStart + 1
                while (tokenEnd < endOffset && buffer[tokenEnd].isSpaceOrEol()) tokenEnd++
                tokenType = TokenType.WHITE_SPACE
            }
            '#' -> {
                // the parser's rule: `#` opens a comment only after whitespace / BOL, so `a#b`
                // (no preceding space) is one scalar — but here `#` is reached as a token start,
                // which happens after whitespace, a boundary punct, or BOL. Guard on the space.
                if (tokenStart == 0 || buffer[tokenStart - 1].isSpaceOrEol()) { consumeToEol(); tokenType = YamloverTokenTypes.COMMENT }
                else consumeWord()
            }
            '|', '>' -> {
                // a block scalar header (`|`/`>` + chomping/indent indicators) at value start:
                // its indented body is opaque — swallow header + body as one token so the body
                // is never re-lexed as yamlover
                if (atValueStart(tokenStart) && blockHeaderIndicatorEnd(tokenStart) != null) consumeBlockScalar()
                else consumeWord()
            }
            '!' -> {
                // a schema tag `!!<…>` — contents are yamlover (a pointer OR an inline schema
                // like `format: text/x-plantuml`), so allow spaces; stop at `>` or end of line
                if (peek(1) == '!' && peek(2) == '<') {
                    tokenEnd = tokenStart + 3
                    while (tokenEnd < endOffset && buffer[tokenEnd] != '>' && buffer[tokenEnd] != '\n' && buffer[tokenEnd] != '\r') tokenEnd++
                    if (tokenEnd < endOffset && buffer[tokenEnd] == '>') tokenEnd++
                    tokenType = YamloverTokenTypes.TAG
                } else if (peek(1) == '!') {
                    // a YAML-style type tag: !!mix / !!omni / !!var / !!set — up to a word boundary
                    tokenEnd = tokenStart + 2
                    while (tokenEnd < endOffset && !buffer[tokenEnd].isSpaceOrEol() && buffer[tokenEnd] != ':') tokenEnd++
                    tokenType = YamloverTokenTypes.TAG
                } else {
                    consumeWord()
                }
            }
            '*', '&' -> {
                // emit just the sigil; the path that follows is tokenized in path mode (name
                // segments → REF, `:`/`[`/`]` → sign, index digits → number, quotes → string).
                // Both `*` pointers and colon-form `&` anchors run to EOL in block context.
                tokenEnd = tokenStart + 1
                tokenType = YamloverTokenTypes.POINTER
                inPath = true
                pathToEol = true
            }
            '~' -> {
                // `~name:` is a back-edge KEY: emit just the `~` sigil so the key NAME that
                // follows lexes as a key (not the whole run as a pointer). A bare `~` (e.g.
                // `x: ~`) is the null scalar — let consumeWord classify it as a keyword.
                val next = if (tokenStart + 1 < endOffset) buffer[tokenStart + 1] else ' '
                if (!next.isWordBoundary() && next != '~' && next != '*' && next != '&') {
                    tokenEnd = tokenStart + 1
                    tokenType = YamloverTokenTypes.POINTER
                } else {
                    consumeWord()
                }
            }
            '"' -> { consumeString('"'); tokenType = YamloverTokenTypes.STRING }
            '\'' -> { consumeString('\''); tokenType = YamloverTokenTypes.STRING }
            '[' -> { consumeIndexOrPunct(); if (tokenType == YamloverTokenTypes.PUNCT) flowDepth++ }
            '{' -> { tokenEnd = tokenStart + 1; tokenType = YamloverTokenTypes.PUNCT; flowDepth++ }
            '}', ']' -> {
                tokenEnd = tokenStart + 1
                tokenType = YamloverTokenTypes.PUNCT
                if (flowDepth > 0) flowDepth--
            }
            ':', ',', '-' -> {
                tokenEnd = tokenStart + 1
                tokenType = YamloverTokenTypes.PUNCT
            }
            else -> { @Suppress("UNUSED_EXPRESSION") c; consumeWord() }
        }
    }

    private fun Char.isSpaceOrEol() = this == '\n' || this == '\r' || this == ' ' || this == '\t'
    private fun peek(o: Int): Char = if (tokenStart + o < endOffset) buffer[tokenStart + o] else ' '

    private fun consumeToEol() {
        tokenEnd = tokenStart + 1
        while (tokenEnd < endOffset && buffer[tokenEnd] != '\n' && buffer[tokenEnd] != '\r') tokenEnd++
    }

    /** A pointer path's hard boundaries. In BLOCK context an unquoted pointer runs to end of
     *  line (or a ` #` comment) — the `: ` separator styling keeps interior spaces. Inside FLOW
     *  (`{…}` / `[…]`) the usual delimiters end it. */
    private fun isPathBoundary(c: Char): Boolean =
        if (flowDepth > 0) c.isSpaceOrEol() || c == ',' || c == '{' || c == '}' || c == '#'
        else c.isSpaceOrEol() || c == '#'
        // NB: a space/tab reaches here only when spacesEndPath() said the path is over — it is
        // a boundary then; an interior `: ` space is handled earlier and never reaches this.

    /** Run-of-spaces at `at`: does it END a block pointer path (trailing spaces before EOL /
     *  a comment), or is it interior (around a `: ` colon separator)? Flow paths always end on
     *  a space. */
    private fun spacesEndPath(at: Int): Boolean {
        if (flowDepth > 0 || !pathToEol) return true
        var j = at
        while (j < endOffset && (buffer[j] == ' ' || buffer[j] == '\t')) j++
        if (j >= endOffset) return true
        val c = buffer[j]
        return c == '\n' || c == '\r' || c == '#'
    }

    private fun consumeString(quote: Char) {
        tokenEnd = tokenStart + 1
        while (tokenEnd < endOffset) {
            val ch = buffer[tokenEnd]
            if (ch == '\\' && quote == '"' && tokenEnd + 1 < endOffset) {
                tokenEnd += 2
                continue
            }
            tokenEnd++
            if (ch == quote) break
        }
    }

    private fun consumeIndexOrPunct() {
        var i = tokenStart + 1
        while (i < endOffset && buffer[i].isDigit()) i++
        if (i > tokenStart + 1 && i < endOffset && buffer[i] == ']') {
            tokenEnd = i + 1
            tokenType = YamloverTokenTypes.INDEX
        } else {
            tokenEnd = tokenStart + 1
            tokenType = YamloverTokenTypes.PUNCT
        }
    }

    // ---- block scalars (`|` / `>`) --------------------------------------------------------

    /** The start-of-line offset of the line containing `pos`. */
    private fun lineStartOf(pos: Int): Int {
        var i = pos
        while (i > 0 && buffer[i - 1] != '\n') i--
        return i
    }

    /** The leading-space indent width of the line containing `pos`. */
    private fun lineIndentAt(pos: Int): Int {
        val ls = lineStartOf(pos)
        var i = ls
        while (i < endOffset && buffer[i] == ' ') i++
        return i - ls
    }

    /** A `|`/`>` is a block header only at value start — after `key:`, a `- ` item, or BOL. */
    private fun atValueStart(pos: Int): Boolean {
        var i = pos - 1
        while (i >= 0 && (buffer[i] == ' ' || buffer[i] == '\t')) i--
        if (i < 0) return true
        val c = buffer[i]
        return c == ':' || c == '-' || c == '\n' || c == '\r'
    }

    /** If `from` (a `|`/`>`) opens a block header — `[+\-0-9]*` indicators then EOL / ` #` — the
     *  index just past the indicators; else null (a `|`/`>` that is ordinary scalar content). */
    private fun blockHeaderIndicatorEnd(from: Int): Int? {
        var i = from + 1
        while (i < endOffset && (buffer[i] == '+' || buffer[i] == '-' || buffer[i].isDigit())) i++
        var j = i
        while (j < endOffset && (buffer[j] == ' ' || buffer[j] == '\t')) j++
        val ok = j >= endOffset || buffer[j] == '\n' || buffer[j] == '\r' || buffer[j] == '#'
        return if (ok) i else null
    }

    /** Swallow a block scalar (header line + every following blank or deeper-indented line) as
     *  one opaque SCALAR token, so its body is never re-lexed as yamlover. */
    private fun consumeBlockScalar() {
        val headerIndent = lineIndentAt(tokenStart)
        var end = tokenStart
        while (end < endOffset && buffer[end] != '\n') end++ // header line's newline (or EOF)
        while (end < endOffset) { // `end` sits at a '\n' — peek the next line
            val nextStart = end + 1
            var k = nextStart
            while (k < endOffset && buffer[k] == ' ') k++
            val blank = k >= endOffset || buffer[k] == '\n' || buffer[k] == '\r'
            val ind = k - nextStart
            if (!(blank || ind > headerIndent)) break // a sibling/dedent line ends the body
            var e = k
            while (e < endOffset && buffer[e] != '\n') e++
            end = e
        }
        tokenEnd = end
        tokenType = YamloverTokenTypes.SCALAR
    }

    private fun Char.isWordBoundary() =
        isSpaceOrEol() || this == ':' || this == ',' || this == '{' || this == '}' ||
            this == '[' || this == ']'

    private val INF_NAN = Regex("[-+]?\\.(inf|Inf|INF|nan|NaN|NAN)")
    private val HEX = Regex("0[xX][0-9A-Fa-f]+")

    private fun consumeWord() {
        tokenEnd = tokenStart + 1
        while (tokenEnd < endOffset && !buffer[tokenEnd].isWordBoundary()) tokenEnd++
        val word = buffer.subSequence(tokenStart, tokenEnd).toString()
        // Lookahead: a word immediately followed (modulo spaces) by ':' is a key.
        var j = tokenEnd
        while (j < endOffset && (buffer[j] == ' ' || buffer[j] == '\t')) j++
        tokenType = when {
            j < endOffset && buffer[j] == ':' -> YamloverTokenTypes.KEY
            word == "true" || word == "false" || word == "null" || word == "~" ||
                word == "True" || word == "TRUE" || word == "False" || word == "FALSE" ||
                word == "Null" || word == "NULL" -> YamloverTokenTypes.KEYWORD
            INF_NAN.matches(word) || HEX.matches(word) -> YamloverTokenTypes.NUMBER
            word.toDoubleOrNull() != null -> YamloverTokenTypes.NUMBER
            else -> YamloverTokenTypes.SCALAR
        }
    }
}
