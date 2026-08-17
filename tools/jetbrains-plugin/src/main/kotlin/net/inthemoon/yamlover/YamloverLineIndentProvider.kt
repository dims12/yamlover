package net.inthemoon.yamlover

import com.intellij.application.options.CodeStyle
import com.intellij.lang.Language
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.project.Project
import com.intellij.psi.codeStyle.lineIndent.LineIndentProvider

/**
 * Smart Enter indentation for yamlover — the flat "parser" builds no formatter model, so
 * without this provider Enter lands the caret at column 0 even where the language REQUIRES
 * a deeper line (a block scalar body under `- >` / `key: |`, a mapping under `key:`).
 *
 * The rules are heuristic line logic, the same spirit as the highlighter and the pointer
 * index — see {@link YamloverIndent} for the decision table.
 */
class YamloverLineIndentProvider : LineIndentProvider {

    override fun isSuitableFor(language: Language?): Boolean = language == YamloverLanguage

    override fun getLineIndent(project: Project, editor: Editor, language: Language?, offset: Int): String? {
        if (language != YamloverLanguage) return null
        val indentSize = CodeStyle.getSettings(editor).getIndentOptions(YamloverFileType).INDENT_SIZE
        val columns = YamloverIndent.indentAfterEnter(editor.document.charsSequence, offset, indentSize) ?: return null
        return " ".repeat(columns)
    }
}

/**
 * The pure text logic behind {@link YamloverLineIndentProvider} — IDE-free and unit-tested.
 *
 * Decision table, driven by the previous non-blank line:
 *  - a block-scalar HEADER (`- >`, `key: |2-`, `- !!<format: text/plain> |`): the body must
 *    be deeper — dash-headed bodies sit at the dash's content column (`- >` → column 2, the
 *    docs/ prose convention), key-headed ones one indent step under the key;
 *  - a line INSIDE a block scalar body: keep its indent (the body continues);
 *  - `key:` with an empty value (incl. a flat row's trailing `-:`): one indent step deeper
 *    at the content column — the place its block opens;
 *  - a lone `-` (or `- -`) item marker: the item's content column;
 *  - anything else (a `- scalar` item, `key: value`, a pointer line): keep the indent, so a
 *    sibling entry lines up.
 */
object YamloverIndent {

    /** The indent (in columns) for the line the caret sits on at `offset`, right after Enter
     *  split the line above it. Null = no opinion (first line / all-blank above). */
    fun indentAfterEnter(text: CharSequence, offset: Int, indentSize: Int): Int? {
        val off = offset.coerceIn(0, text.length)
        var ls = off
        while (ls > 0 && text[ls - 1] != '\n') ls--
        if (ls == 0) return null
        var end = ls - 1 // the `\n` closing the line above the caret's
        while (true) {
            var s = end
            while (s > 0 && text[s - 1] != '\n') s--
            val line = text.subSequence(s, end).toString().trimEnd('\r')
            if (line.isNotBlank()) return indentFor(text, s, line, indentSize)
            if (s == 0) return null
            end = s - 1
        }
    }

    private fun indentFor(text: CharSequence, lineStart: Int, line: String, indentSize: Int): Int {
        val indent = line.indexOfFirst { it != ' ' }.coerceAtLeast(0)
        // inside a block scalar body the next line keeps the body's indent
        val owner = blockScalarOwnerIndent(text, lineStart)
        if (owner != null && indent > owner) return indent
        val stripped = stripComment(line).trimEnd()
        if (stripped.isBlank()) return indent
        blockHeaderBodyIndent(stripped, indentSize)?.let { return it }
        val contentCol = contentColumn(stripped, indent)
        if (contentCol >= stripped.length) return contentCol // a lone `-` (or `- -`): the item's block opens under it
        if (stripped.endsWith(":")) {
            // `key:` / a flat row's trailing `-:` open a deeper block — but a pointer run
            // that happens to end in `:` (`feline: *:`) is a complete value, not a key
            val lastToken = stripped.substring(stripped.lastIndexOf(' ') + 1)
            if (lastToken.startsWith("*") || lastToken.startsWith("&")) return indent
            return contentCol + indentSize
        }
        return indent
    }

    /** The column where the line's content starts, past any leading `- ` item markers. */
    private fun contentColumn(stripped: String, indent: Int): Int {
        var i = indent
        while (i < stripped.length && stripped[i] == '-' && (i + 1 >= stripped.length || stripped[i + 1] == ' ')) {
            i += 2
            while (i < stripped.length && stripped[i] == ' ') i++
        }
        return i
    }

    /** If this structural line opens a block scalar — a `|`/`>` header (with optional
     *  chomping/indent indicators, optionally behind a `!!` tag) at value start — the body's
     *  indent column; else null. */
    fun blockHeaderBodyIndent(stripped: String, indentSize: Int): Int? {
        val indent = stripped.indexOfFirst { it != ' ' }
        if (indent < 0) return null
        val contentCol = contentColumn(stripped, indent)
        if (contentCol >= stripped.length) return null
        val rest = stripped.substring(contentCol.coerceAtMost(stripped.length))
        val afterKey = splitLastValue(rest)
        val value = stripTags((afterKey ?: rest).trim()).trim()
        if (!BLOCK_SCALAR_HEAD.matches(value)) return null
        return when {
            afterKey != null -> contentCol + indentSize // `key: |` — the body one step under the key
            contentCol > indent -> contentCol           // `- >` — the dash's content column
            else -> indent + indentSize                 // a bare `>` at entry column
        }
    }

    /** The header-line indent when a block scalar's body is OPEN just above `lineStart`;
     *  null when the position is structural. (The caller still checks the line's own indent
     *  against it — a shallower line closes the body.) */
    fun blockScalarOwnerIndent(text: CharSequence, lineStart: Int): Int? {
        var owner: Int? = null
        var i = 0
        while (i < lineStart) {
            var e = i
            while (e < text.length && text[e] != '\n') e++
            val raw = text.subSequence(i, e).toString().trimEnd('\r')
            val indent = raw.indexOfFirst { it != ' ' }
            val blank = indent < 0
            if (owner != null && !blank && indent <= owner!!) owner = null // a sibling/dedent closes the body
            if (owner == null && !blank) {
                val stripped = stripComment(raw).trimEnd()
                if (stripped.isNotBlank() && blockHeaderBodyIndent(stripped, 2) != null) owner = indent
            }
            i = e + 1
        }
        return owner
    }

    /** A YAML block-scalar header token: `|` / `>` + chomping/indent indicators. */
    private val BLOCK_SCALAR_HEAD = Regex("[|>][0-9+-]*")

    /** The value after the LAST top-level `: ` separator (quote- and `!!<…>`-tag-aware), or
     *  null when the line has no key portion at all. */
    private fun splitLastValue(rest: String): String? {
        var inS = false
        var inD = false
        var inTag = false
        var cut = -1
        var i = 0
        while (i < rest.length) {
            val c = rest[i]
            when {
                inTag -> if (c == '>') inTag = false
                c == '\'' && !inD -> inS = !inS
                c == '"' && !inS -> inD = !inD
                !inS && !inD && c == '!' && i + 2 < rest.length && rest[i + 1] == '!' && rest[i + 2] == '<' -> { inTag = true; i += 2 }
                c == '\\' && inD -> i++
                c == ':' && !inS && !inD && (i + 1 == rest.length || rest[i + 1] == ' ') -> cut = i
            }
            i++
        }
        return if (cut < 0) null else rest.substring(cut + 1).trim()
    }

    /** Drop a leading `!!word` / `!!<…>` tag from a value rest (the tag decorates the value). */
    private fun stripTags(rest: String): String {
        var r = rest
        if (r.startsWith("!!<")) {
            val close = r.indexOf('>')
            r = if (close < 0) "" else r.substring(close + 1).trim()
        } else if (r.startsWith("!!")) r = r.dropWhile { !it.isWhitespace() }.trim()
        return r
    }

    /** Strip a trailing `#` comment (quote-aware — the parser's rule). */
    private fun stripComment(s: String): String {
        var inS = false
        var inD = false
        var i = 0
        while (i < s.length) {
            val c = s[i]
            when {
                inD && c == '\\' -> i++
                c == '\'' && !inD -> inS = !inS
                c == '"' && !inS -> inD = !inD
                c == '#' && !inS && !inD && (i == 0 || s[i - 1] == ' ' || s[i - 1] == '\t') -> return s.substring(0, i)
            }
            i++
        }
        return s
    }
}
