package net.inthemoon.yamlover

import com.intellij.lexer.LexerBase
import com.intellij.psi.TokenType
import com.intellij.psi.tree.IElementType

/**
 * The shared heuristic highlighting engine — the Kotlin port of the SHARED lexer at
 * tools/parser/ts/src/highlight.ts, branch for branch. Like the TS original it is a
 * HIGHLIGHTER, not the grammar: it never fails and tokenizes any text, half-typed source
 * included, into classified slices; it does not build PSI.
 *
 * One engine, parameterized exactly as `tokenize(text, lang)` is: `yamlover` is the full
 * colon grammar (`colonRun=true, hashComments=true`); `json5p` is flow end to end, its
 * comments are `//` / `/* */` (never `#`), and its pointer paths ride quoted (`*': …'`).
 * highlight.ts is the source of truth — change that file first, then re-sync here.
 */
abstract class HlLexerBase(
    private val colonRun: Boolean,      // block pointer paths run to EOL with `: ` styling
    private val hashComments: Boolean,  // `#` comments; false = json5p's `//` and `/* */`
    private val t: Tokens,
) : LexerBase() {

    /** The engine's HlKind vocabulary (highlight.ts:21-35); `space` maps to WHITE_SPACE and
     *  `plain` to `scalar`. */
    class Tokens(
        @JvmField val comment: IElementType,
        @JvmField val key: IElementType,      // a word (or quoted string) followed by `:`
        @JvmField val string: IElementType,   // a quoted scalar
        @JvmField val number: IElementType,   // numeric scalars, incl. hex and float specials
        @JvmField val keyword: IElementType,  // true / false (casings)
        @JvmField val nullKind: IElementType, // null / ~ (casings)
        @JvmField val punct: IElementType,    // `: , { } [ ]` and the sigil-adjacent signs
        @JvmField val dash: IElementType,     // the sequence marker `- `
        @JvmField val pointer: IElementType,  // a `* & ~` sigil itself
        @JvmField val ref: IElementType,      // a pointer path's name portions (the target)
        @JvmField val index: IElementType,    // a standalone `[n]` position
        @JvmField val tag: IElementType,      // `!!<…>` and the `!!word` type tags
        @JvmField val scalar: IElementType,   // TS `plain`: plain scalars, block-scalar bodies
    )

    private var buffer: CharSequence = ""
    private var endOffset = 0
    private var tokenStart = 0
    private var tokenEnd = 0
    private var tokenType: IElementType? = null
    private var inPath = false          // tokenizing a pointer's path after a `*`/`&` sigil
    private var inIndex = false         // inside `[ … ]` within a path
    private var flowDepth = 0           // inside `{…}` / `[…]` flow — path boundaries differ
    private var pendingScalarEnd = -1   // a block scalar's body end, queued after its header PUNCT
    private var pendingQuotedRef = false // a json5p sigil's quoted path, queued after the sigil

    override fun start(buffer: CharSequence, startOffset: Int, endOffset: Int, initialState: Int) {
        this.buffer = buffer
        this.endOffset = endOffset
        this.tokenStart = startOffset
        this.tokenEnd = startOffset
        inPath = false
        inIndex = false
        flowDepth = 0
        pendingScalarEnd = -1
        pendingQuotedRef = false
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
        if (pendingScalarEnd >= 0) {
            // the opaque block-scalar body, right after its header-indicator PUNCT token
            // (highlight.ts:209-213 pushes `punct` then `plain`)
            val e = pendingScalarEnd
            pendingScalarEnd = -1
            if (e > tokenStart) { tokenEnd = e; tokenType = t.scalar; return }
        }
        if (tokenStart >= endOffset) {
            tokenType = null
            return
        }
        val c = buffer[tokenStart]
        if (pendingQuotedRef) {
            // a json5p pointer path rides quoted right after the sigil — one `ref` token,
            // and the path is over with it (highlight.ts:231-235)
            pendingQuotedRef = false
            consumeString(c)
            tokenType = t.ref
            return
        }
        if (inPath) {
            when {
                (c == ' ' || c == '\t') && !spacesEndPath(tokenStart) -> {
                    // an interior space of a BLOCK pointer path — the canonical `: ` styling
                    // keeps a space around each colon separator: stay in path mode
                    tokenEnd = tokenStart + 1
                    while (tokenEnd < endOffset && (buffer[tokenEnd] == ' ' || buffer[tokenEnd] == '\t')) tokenEnd++
                    tokenType = TokenType.WHITE_SPACE
                    return
                }
                c == ':' && colonRun -> { tokenEnd = tokenStart + 1; tokenType = t.punct; return } // portion separator
                c == '[' -> { tokenEnd = tokenStart + 1; inIndex = true; tokenType = t.punct; return }
                c == ']' -> { tokenEnd = tokenStart + 1; inIndex = false; tokenType = t.punct; return }
                inIndex && (c == '.' || c == '+' || c == '-') -> { // a relative index `[.±k]`
                    tokenEnd = tokenStart + 1; tokenType = t.punct; return
                }
                inIndex && c.isDigit() -> {
                    tokenEnd = tokenStart + 1
                    while (tokenEnd < endOffset && buffer[tokenEnd].isDigit()) tokenEnd++
                    tokenType = t.number
                    return
                }
                c == '\'' || c == '"' -> { consumeString(c); tokenType = t.ref; return } // a quoted portion (highlight.ts:175)
                !isPathBoundary(c) && !(c == ':' && !colonRun) -> {
                    // a name segment; `/` is an ordinary key char, respect `\` escapes
                    tokenEnd = tokenStart
                    while (tokenEnd < endOffset) {
                        val ch = buffer[tokenEnd]
                        if (ch == '\\' && tokenEnd + 1 < endOffset) { tokenEnd += 2; continue }
                        if (ch == ' ' || ch == '\t' || ch == ':' || ch == '[' || ch == ']' ||
                            ch == '\'' || ch == '"' || isPathBoundary(ch)) break
                        tokenEnd++
                    }
                    tokenType = t.ref
                    return
                }
                else -> { inPath = false; inIndex = false } // path over — the boundary dispatches normally
            }
        }
        when {
            c.isSpaceOrEol() -> {
                tokenEnd = tokenStart + 1
                while (tokenEnd < endOffset && buffer[tokenEnd].isSpaceOrEol()) tokenEnd++
                tokenType = TokenType.WHITE_SPACE
            }
            c == '#' && hashComments -> {
                // the parser's rule: `#` opens a comment only after whitespace / BOL, so `a#b`
                // (no preceding space) is one scalar — but here `#` is reached as a token start,
                // which happens after whitespace, a boundary punct, or BOL. Guard on the space.
                if (tokenStart == 0 || buffer[tokenStart - 1].isSpaceOrEol()) { consumeToEol(); tokenType = t.comment }
                else consumeWord()
            }
            c == '/' && !hashComments && peek(1) == '/' -> { consumeToEol(); tokenType = t.comment }
            c == '/' && !hashComments && peek(1) == '*' -> {
                // an unterminated block comment runs to EOF (highlight.ts:204-207)
                tokenEnd = tokenStart + 2
                while (tokenEnd < endOffset &&
                    !(buffer[tokenEnd] == '*' && tokenEnd + 1 < endOffset && buffer[tokenEnd + 1] == '/')) tokenEnd++
                tokenEnd = minOf(endOffset, tokenEnd + 2)
                tokenType = t.comment
            }
            (c == '|' || c == '>') && hashComments -> {
                // a block scalar header (`|`/`>` + chomping/indent indicators) at value start:
                // the indicators lex as PUNCT, the indented body as one opaque SCALAR — never
                // re-lexed. Gated on hashComments: json5p (the one non-`#` lang) has no block
                // scalars, exactly TS's `lang !== 'json5p'` (highlight.ts:209).
                val headerEnd = if (atValueStart(tokenStart)) blockHeaderIndicatorEnd(tokenStart) else null
                if (headerEnd != null) {
                    pendingScalarEnd = blockScalarEnd(tokenStart)
                    tokenEnd = headerEnd
                    tokenType = t.punct
                } else consumeWord()
            }
            c == '!' && peek(1) == '!' -> {
                // a schema tag `!!<…>` — contents are yamlover (a pointer OR an inline schema
                // like `format: text/x-plantuml`), so allow spaces; stop at `>` or end of line
                if (peek(2) == '<') {
                    tokenEnd = tokenStart + 3
                    while (tokenEnd < endOffset && buffer[tokenEnd] != '>' && buffer[tokenEnd] != '\n' && buffer[tokenEnd] != '\r') tokenEnd++
                    if (tokenEnd < endOffset && buffer[tokenEnd] == '>') tokenEnd++
                } else {
                    // a YAML-style type tag: !!mix / !!omni / !!var / !!set — up to a word boundary
                    tokenEnd = tokenStart + 2
                    while (tokenEnd < endOffset && !buffer[tokenEnd].isSpaceOrEol() && buffer[tokenEnd] != ':') tokenEnd++
                }
                tokenType = t.tag
            }
            c == '*' || c == '&' -> {
                // emit just the sigil; the path that follows is tokenized in path mode (name
                // segments → REF, `:`/`[`/`]` → sign, index digits → number, quotes → REF).
                // Both `*` pointers and colon-form `&` anchors run to EOL in block context.
                tokenEnd = tokenStart + 1
                tokenType = t.pointer
                val next = peek(1)
                if (!colonRun && (next == '\'' || next == '"')) pendingQuotedRef = true
                else inPath = true
            }
            c == '~' -> {
                // `~name:` is a back-edge KEY: emit just the `~` sigil so the key NAME that
                // follows lexes as a key (not the whole run as a pointer). A bare `~` (e.g.
                // `x: ~`) is the null value — let consumeWord classify it as NULL.
                val next = peek(1)
                if (!next.isWordBoundary() && next != '~' && next != '*' && next != '&') {
                    tokenEnd = tokenStart + 1
                    tokenType = t.pointer
                } else {
                    consumeWord()
                }
            }
            c == '"' || c == '\'' -> {
                // a quoted string immediately followed (modulo spaces) by `:` is a KEY
                // (highlight.ts:244-249) — quotes carry string keys like `'my key':`
                consumeString(c)
                var j = tokenEnd
                while (j < endOffset && (buffer[j] == ' ' || buffer[j] == '\t')) j++
                tokenType = if (j < endOffset && buffer[j] == ':') t.key else t.string
            }
            c == '[' -> {
                var i = tokenStart + 1
                while (i < endOffset && buffer[i].isDigit()) i++
                if (i > tokenStart + 1 && i < endOffset && buffer[i] == ']') {
                    tokenEnd = i + 1
                    tokenType = t.index
                } else {
                    flowDepth++
                    tokenEnd = tokenStart + 1
                    tokenType = t.punct
                }
            }
            c == '{' -> { tokenEnd = tokenStart + 1; tokenType = t.punct; flowDepth++ }
            c == '}' || c == ']' -> {
                tokenEnd = tokenStart + 1
                tokenType = t.punct
                if (flowDepth > 0) flowDepth--
            }
            c == '-' && (tokenStart + 1 >= endOffset || buffer[tokenStart + 1].isSpaceOrEol()) -> {
                // the sequence marker `- ` has its own kind; any other `-` starts a word, so
                // `-1` is ONE number token and `-foo:` a key (highlight.ts:268 → consumeWord)
                tokenEnd = tokenStart + 1
                tokenType = t.dash
            }
            c == '-' && peek(1) == ':' && (tokenStart + 2 >= endOffset || buffer[tokenStart + 2].isSpaceOrEol()) -> {
                // `-:` — the keyless flat-path segment (docs/language/flattening; also the legacy
                // conversion sugar). Only the hyphen is the dash token — the colon is ordinary
                // punct (highlight.ts's `-:` dash arm). Consuming both would paint the colon as
                // the sequence marker.
                tokenEnd = tokenStart + 1
                tokenType = t.dash
            }
            c == ':' || c == ',' -> { tokenEnd = tokenStart + 1; tokenType = t.punct }
            else -> consumeWord()
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
     *  a comment), or is it interior (around a `: ` colon separator)? Flow paths — and langs
     *  without the colon run — always end on a space. */
    private fun spacesEndPath(at: Int): Boolean {
        if (flowDepth > 0 || !colonRun) return true
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

    /** A `|`/`>` is a block header only at value start — after `key:`, a `- ` item, BOL, or a
     *  DECORATION TAG (`- !!<format: text/plain> |`, `- !!yo |`): the tag decorates the value, so
     *  the indicator after it still starts one — without this the tagged block's body would be
     *  re-lexed and an unbalanced quote inside could bleed a string across the chunks below
     *  (highlight.ts atValueStart, the source of truth). */
    private fun atValueStart(pos: Int): Boolean {
        var i = pos - 1
        while (i >= 0 && (buffer[i] == ' ' || buffer[i] == '\t')) i--
        if (i < 0) return true
        val c = buffer[i]
        if (c == ':' || c == '-' || c == '\n' || c == '\r') return true
        if (c == '>') {
            // a closed `!!<…>` tag: scan to its `<` on this line, then require the `!!` sigil
            var k = i - 1
            while (k >= 0 && buffer[k] != '\n' && buffer[k] != '\r' && buffer[k] != '<') k--
            return k >= 2 && buffer[k] == '<' && buffer[k - 1] == '!' && buffer[k - 2] == '!'
        }
        // a bare `!!name` tag (`!!yo`, `!!set`, …)
        var k = i
        while (k >= 0 && (buffer[k].isLetterOrDigit() || buffer[k] == '_' || buffer[k] == '-')) k--
        return k in 1 until i && buffer[k] == '!' && buffer[k - 1] == '!'
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

    /** End of a block scalar's opaque body: the header line's tail + every following blank or
     *  deeper-indented line (a `\r\n` pair skips as one EOL — highlight.ts:121-133). */
    private fun blockScalarEnd(from: Int): Int {
        val headerIndent = lineIndentAt(from)
        var e = toEol(from)
        while (e < endOffset) { // `e` sits at an EOL char — peek the next line
            val nextStart = e + 1 + (if (buffer[e] == '\r' && e + 1 < endOffset && buffer[e + 1] == '\n') 1 else 0)
            var k = nextStart
            while (k < endOffset && buffer[k] == ' ') k++
            val blank = k >= endOffset || buffer[k] == '\n' || buffer[k] == '\r'
            if (!(blank || k - nextStart > headerIndent)) break // a sibling/dedent line ends the body
            e = toEol(k)
        }
        return e
    }

    private fun toEol(from: Int): Int {
        var j = from
        while (j < endOffset && buffer[j] != '\n' && buffer[j] != '\r') j++
        return j
    }

    // ---- words ----------------------------------------------------------------------------

    private fun Char.isWordBoundary() =
        isSpaceOrEol() || this == ':' || this == ',' || this == '{' || this == '}' ||
            this == '[' || this == ']'

    private fun consumeWord() {
        tokenEnd = tokenStart + 1
        while (tokenEnd < endOffset && !buffer[tokenEnd].isWordBoundary()) tokenEnd++
        val word = buffer.subSequence(tokenStart, tokenEnd).toString()
        // Lookahead: a word immediately followed (modulo spaces) by ':' is a key.
        var j = tokenEnd
        while (j < endOffset && (buffer[j] == ' ' || buffer[j] == '\t')) j++
        tokenType = when {
            j < endOffset && buffer[j] == ':' -> t.key
            word in NULLS -> t.nullKind
            word in BOOLS -> t.keyword
            numberLike(word) -> t.number
            else -> t.scalar
        }
    }

    private companion object {
        val NULLS = setOf("null", "Null", "NULL", "~")
        val BOOLS = setOf("true", "True", "TRUE", "false", "False", "FALSE")
        val INF_NAN = Regex("[-+]?\\.(inf|Inf|INF|nan|NaN|NAN)")
        val HEX = Regex("0[xX][0-9A-Fa-f]+")
        val BIN = Regex("0[bB][01]+")
        val OCT = Regex("0[oO][0-7]+")
        val DEC = Regex("[+-]?(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?")
        val INFINITY = setOf("Infinity", "+Infinity", "-Infinity")

        /** JS `Number(word)` (highlight.ts:150): decimal/hex/binary/octal literals and the
         *  float specials — so bare `NaN` stays a plain scalar, and Java-only spellings
         *  (`1f`, `1d`, `0x1p3`) do NOT count as numbers. */
        fun numberLike(w: String) =
            INF_NAN.matches(w) || HEX.matches(w) || BIN.matches(w) || OCT.matches(w) ||
                DEC.matches(w) || w in INFINITY
    }
}
