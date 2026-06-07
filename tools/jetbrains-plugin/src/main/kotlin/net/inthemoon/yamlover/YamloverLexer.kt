package net.inthemoon.yamlover

import com.intellij.lexer.LexerBase
import com.intellij.psi.TokenType
import com.intellij.psi.tree.IElementType

/**
 * v1 heuristic lexer for syntax highlighting only — NOT the real grammar.
 *
 * It recognizes comments (`#` is comment-only now that the document-root scope is a
 * leading slash, not a `#`), pointer/anchor runs (`* & ~ …`), quoted strings, `[n]`
 * indices, keys (a word followed by `:`), keywords, numbers, scalars and punctuation.
 * It does not build PSI. Replace with the shared yamlover lexer once it exists.
 */
class YamloverLexer : LexerBase() {
    private var buffer: CharSequence = ""
    private var endOffset = 0
    private var tokenStart = 0
    private var tokenEnd = 0
    private var tokenType: IElementType? = null
    private var inPath = false    // tokenizing a pointer's path/target after a `*`/`&` sigil
    private var inIndex = false   // inside `[ … ]` within a path

    override fun start(buffer: CharSequence, startOffset: Int, endOffset: Int, initialState: Int) {
        this.buffer = buffer
        this.endOffset = endOffset
        this.tokenStart = startOffset
        this.tokenEnd = startOffset
        inPath = false
        inIndex = false
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
                isPathBoundary(c) -> { inPath = false; inIndex = false }   // path ended → normal dispatch
                c == '/' -> { tokenEnd = tokenStart + 1; tokenType = YamloverTokenTypes.PUNCT; return }
                c == '[' -> { tokenEnd = tokenStart + 1; inIndex = true; tokenType = YamloverTokenTypes.PUNCT; return }
                c == ']' -> { tokenEnd = tokenStart + 1; inIndex = false; tokenType = YamloverTokenTypes.PUNCT; return }
                inIndex && c.isDigit() -> {
                    tokenEnd = tokenStart + 1
                    while (tokenEnd < endOffset && buffer[tokenEnd].isDigit()) tokenEnd++
                    tokenType = YamloverTokenTypes.NUMBER
                    return
                }
                else -> {  // a name segment (REF), respecting backslash escapes
                    tokenEnd = tokenStart
                    while (tokenEnd < endOffset) {
                        val ch = buffer[tokenEnd]
                        if (ch == '\\' && tokenEnd + 1 < endOffset) { tokenEnd += 2; continue }
                        if (ch == '/' || ch == '[' || ch == ']' || isPathBoundary(ch)) break
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
            '#' -> { consumeToEol(); tokenType = YamloverTokenTypes.COMMENT }
            '*', '&' -> {
                // emit just the sigil; the path that follows is tokenized in path mode
                // (name segments → REF, `/ [ ]` → sign, index digits → number)
                tokenEnd = tokenStart + 1
                tokenType = YamloverTokenTypes.POINTER
                inPath = true
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
            '[' -> consumeIndexOrPunct()
            ':', ',', '{', '}', ']', '-' -> {
                tokenEnd = tokenStart + 1
                tokenType = YamloverTokenTypes.PUNCT
            }
            else -> { @Suppress("UNUSED_EXPRESSION") c; consumeWord() }
        }
    }

    private fun Char.isSpaceOrEol() = this == '\n' || this == '\r' || this == ' ' || this == '\t'

    private fun consumeToEol() {
        tokenEnd = tokenStart + 1
        while (tokenEnd < endOffset && buffer[tokenEnd] != '\n' && buffer[tokenEnd] != '\r') tokenEnd++
    }

    /** A pointer's path/target runs up to whitespace, a flow delimiter, or a `#` comment. */
    private fun isPathBoundary(c: Char): Boolean =
        c.isSpaceOrEol() || c == ',' || c == '{' || c == '}' || c == '#'

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

    private fun Char.isWordBoundary() =
        isSpaceOrEol() || this == ':' || this == ',' || this == '{' || this == '}' ||
            this == '[' || this == ']' || this == '#'

    private fun consumeWord() {
        tokenEnd = tokenStart + 1
        while (tokenEnd < endOffset && !buffer[tokenEnd].isWordBoundary()) tokenEnd++
        val word = buffer.subSequence(tokenStart, tokenEnd).toString()
        // Lookahead: a word immediately followed (modulo spaces) by ':' is a key.
        var j = tokenEnd
        while (j < endOffset && (buffer[j] == ' ' || buffer[j] == '\t')) j++
        tokenType = when {
            j < endOffset && buffer[j] == ':' -> YamloverTokenTypes.KEY
            word == "true" || word == "false" || word == "null" || word == "~" -> YamloverTokenTypes.KEYWORD
            word.toDoubleOrNull() != null -> YamloverTokenTypes.NUMBER
            else -> YamloverTokenTypes.SCALAR
        }
    }
}
