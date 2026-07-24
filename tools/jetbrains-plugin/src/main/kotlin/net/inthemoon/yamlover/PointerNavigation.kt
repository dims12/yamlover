package net.inthemoon.yamlover

/**
 * v1 heuristic pointer navigation (Ctrl+B / Ctrl+click) — pure text logic, no PSI grammar
 * and no engine (that is PLAN.md J3 proper). Mirrors the heuristic-lexer spirit: parse the
 * pointer under the caret, resolve it against a lightweight path index of the SAME file.
 *
 * Grammar: COLON (SEPARATOR.md — the ONLY form; the legacy `/` separator is DEAD, window
 * closed 2026-07-24). Portions separated by `:`, canonical `: ` styling. Scope ladder:
 * bare = current mapping, `:` = document root, `..` = parent, `::`/`:::` = project/world
 * (cross-tree — needs the engine, resolves to null here). `/` is an ORDINARY key character.
 * A key with a space must be quoted. Index groups: `[n]` absolute, `[.]`/`[.±k]` relative
 * (relative positions need the host frame — parsed, but resolve returns null). There is NO
 * anchor namespace and no precedence: `*name` is pure path lookup (resolve.ts §no-precedence).
 * Out of scope: `::`/`:::` cross-tree links (waits for the engine protocol).
 */

sealed class Step {
    data class Key(val name: String) : Step()
    data class Index(val n: Int) : Step()
    data class RelIndex(val k: Int) : Step() // [.] / [.±k] — the host's own position ± k
    object Parent : Step()
}

sealed class Scope {
    object Current : Scope()                                      // bare — current mapping
    object Document : Scope()                                     // `:` — this document's root
    object Parent : Scope()                                       // leading `..` — parent node
    data class Link(val authority: String, val world: Boolean) : Scope() // `::` / `:::`
}

data class PointerExpr(val scope: Scope, val steps: List<Step>)

object Pointers {
    /** Parse the pointer PATH text (after the `*` sigil, string already unquoted). Null on an
     *  empty path or a malformed portion (a space in an unquoted key, a bad index group). */
    fun parse(raw: String): PointerExpr? {
        val s = raw.trim()
        if (s.isEmpty()) return null
        return try { parseColon(s) } catch (e: Exception) { null }
    }

    // ---- colon form (SEPARATOR.md), ported from parser/ts/src/pointer.ts ------------------

    private fun parseColon(raw: String): PointerExpr {
        if (raw.startsWith(":::")) {
            val portions = splitColon(raw.substring(3)).toMutableList()
            if (portions.isEmpty()) throw IllegalArgumentException("\":::\" needs an authority")
            val auth = portions.removeAt(0)
            return PointerExpr(Scope.Link(portionName(auth), true), portionsToSteps(portions))
        }
        if (raw.startsWith("::")) {
            val portions = splitColon(raw.substring(2)).toMutableList()
            if (portions.isEmpty()) throw IllegalArgumentException("\"::\" needs a first portion")
            val auth = portions.removeAt(0)
            return PointerExpr(Scope.Link(portionName(auth), false), portionsToSteps(portions))
        }
        if (raw.startsWith(":")) {
            return PointerExpr(Scope.Document, portionsToSteps(splitColon(raw.substring(1))))
        }
        val portions = splitColon(raw).toMutableList()
        var scope: Scope = Scope.Current
        if (portions.isNotEmpty() && portions[0] == "..") { scope = Scope.Parent; portions.removeAt(0) }
        return PointerExpr(scope, portionsToSteps(portions))
    }

    /** Split on unescaped, unquoted `:`; trim each portion (the `: ` styling). Quotes and
     *  backslash pairs ride through intact; empty portions are dropped. */
    private fun splitColon(s: String): List<String> {
        val out = ArrayList<String>()
        val cur = StringBuilder()
        var q: Char? = null
        var i = 0
        while (i < s.length) {
            val c = s[i]
            when {
                q != null -> { cur.append(c); if (c == q) q = null }
                c == '\\' && i + 1 < s.length -> { cur.append(c); cur.append(s[i + 1]); i++ }
                c == '\'' || c == '"' -> { q = c; cur.append(c) }
                c == ':' -> { out.add(cur.toString().trim()); cur.setLength(0) }
                else -> cur.append(c)
            }
            i++
        }
        out.add(cur.toString().trim())
        return out.filter { it.isNotEmpty() }
    }

    private fun portionsToSteps(portions: List<String>): List<Step> {
        val out = ArrayList<Step>()
        for (p in portions) out.addAll(portionToSteps(p))
        return out
    }

    /** One colon portion → steps: `..`, a (possibly quoted) name, optional `[n]`/`[.±k]`
     *  groups. A bare name containing a SPACE must be quoted (SEPARATOR.md §3). */
    private fun portionToSteps(p: String): List<Step> {
        if (p == "..") return listOf(Step.Parent)
        // `..[.-1][.]` — the table rowspan idiom: the uplink, then the indexes. (The literal
        // key ".." arrives escaped, `\.\.`, and takes the name path.)
        if (p.startsWith("..") && p.length > 2 && p[2] == '[') return listOf(Step.Parent) + indexGroups(p.substring(2))
        val name = StringBuilder()
        var i = 0
        if (p.isNotEmpty() && (p[0] == '\'' || p[0] == '"')) {
            val q = p[0]; i = 1
            while (i < p.length) {
                if (p[i] == q) {
                    if (q == '\'' && i + 1 < p.length && p[i + 1] == '\'') { name.append(q); i += 2; continue }
                    i++; break
                }
                if (q == '"' && p[i] == '\\' && i + 1 < p.length) { name.append(p[i + 1]); i += 2; continue }
                name.append(p[i]); i++
            }
        } else {
            while (i < p.length) {
                val c = p[i]
                if (c == '\\' && i + 1 < p.length) { name.append(p[i + 1]); i += 2; continue }
                if (c == '[') break
                if (c == ' ' || c == '\t') throw IllegalArgumentException("a key containing a space must be quoted")
                name.append(c); i++
            }
        }
        val steps = ArrayList<Step>()
        if (name.isNotEmpty()) steps.add(Step.Key(name.toString()))
        if (i < p.length) steps.addAll(indexGroups(p.substring(i)))
        return steps
    }

    /** A run of bracket groups on a portion tail: `[n]` (absolute) or `[.]`/`[.±k]` (relative:
     *  the host's own position ± k). Digits = absolute; a leading `.` = relative; an offset
     *  needs an explicit sign. */
    private fun indexGroups(s: String): List<Step> {
        val steps = ArrayList<Step>()
        var i = 0
        while (i < s.length) {
            if (s[i] != '[') throw IllegalArgumentException("malformed portion")
            var j = i + 1
            if (j < s.length && s[j] == '.') {
                j++
                var k = 0
                if (j < s.length && (s[j] == '+' || s[j] == '-')) {
                    val sign = if (s[j] == '-') -1 else 1; j++
                    val d = StringBuilder()
                    while (j < s.length && s[j].isDigit()) { d.append(s[j]); j++ }
                    if (d.isEmpty()) throw IllegalArgumentException("malformed index")
                    k = sign * d.toString().toInt()
                }
                if (j >= s.length || s[j] != ']') throw IllegalArgumentException("malformed index")
                steps.add(Step.RelIndex(k)); i = j + 1; continue
            }
            val d = StringBuilder()
            while (j < s.length && s[j].isDigit()) { d.append(s[j]); j++ }
            if (d.isEmpty() || j >= s.length || s[j] != ']') throw IllegalArgumentException("malformed index")
            steps.add(Step.Index(d.toString().toInt())); i = j + 1
        }
        return steps
    }

    /** The authority portion of `::` / `:::` — a (possibly quoted) plain name. */
    private fun portionName(p: String): String {
        val steps = portionToSteps(p)
        val first = steps.firstOrNull()
        if (steps.size != 1 || first !is Step.Key) throw IllegalArgumentException("bad authority portion")
        return first.name
    }

    /** The unquoted pointer path around `offset` in yamlover text. In BLOCK context an
     *  unquoted `*` pointer runs to end of line (minus a ` #` comment) — the `: ` separator
     *  styling keeps interior spaces, matching the real parser. Inside FLOW (`{…}`/`[…]`),
     *  space/comma/closing delimiters end it. */
    fun yamloverPointerAt(text: String, offset: Int): String? {
        if (offset < 0 || offset > text.length) return null
        val ls = if (offset == 0) 0 else (text.lastIndexOf('\n', offset - 1) + 1)
        var le = text.indexOf('\n', ls)
        if (le < 0) le = text.length
        var line = text.substring(ls, le)
        // strip a ` #comment`
        for (i in line.indices) {
            if (line[i] == '#' && (i == 0 || line[i - 1] == ' ' || line[i - 1] == '\t')) { line = line.substring(0, i); break }
        }
        val col = (offset - ls).coerceAtMost(line.length)
        // the `*` opening the run the caret is in: the last value-position `*` at or before it
        var star = -1
        for (i in line.indices) {
            if (i > col) break
            if (line[i] == '*' && (i == 0 || line[i - 1] == ' ' || line[i - 1] == '\t' ||
                    line[i - 1] == '{' || line[i - 1] == '[' || line[i - 1] == ',')) star = i
        }
        if (star < 0) return null
        var depth = 0 // flow context = unmatched { / [ before the sigil
        for (i in 0 until star) when (line[i]) { '{', '[' -> depth++; '}', ']' -> depth-- }
        var end = line.length
        if (depth > 0) {
            var j = star + 1
            while (j < end && line[j] != ' ' && line[j] != '\t' && line[j] != ',' && line[j] != '}' && line[j] != ']') j++
            end = j
        }
        val path = line.substring(star + 1, end).trimEnd()
        if (path.isEmpty() || col < star || col > star + 1 + path.length) return null
        return path
    }

    /** The pointer path around `offset` in json5p text: `*'…'` / `*"…"` (the usual, quoted
     *  form — incl. a `~*'…'` back member) or an unquoted `*…` run. One forward scan; pick
     *  the pointer occurrence whose span contains the caret. */
    fun json5pPointerAt(text: String, offset: Int): String? {
        var i = 0
        while (i < text.length) {
            val c = text[i]
            when {
                c == '/' && i + 1 < text.length && text[i + 1] == '/' -> { while (i < text.length && text[i] != '\n') i++ }
                c == '/' && i + 1 < text.length && text[i + 1] == '*' -> {
                    i += 2; while (i + 1 < text.length && !(text[i] == '*' && text[i + 1] == '/')) i++; i += 2
                }
                c == '\'' || c == '"' -> { // a string NOT preceded by `*`: skip it whole
                    if (i > 0 && text[i - 1] == '*') { i++ } // pointer string — handled at its `*`
                    else { i++; while (i < text.length && text[i] != c) { if (text[i] == '\\') i++; i++ }; i++ }
                }
                c == '*' -> {
                    val start = i
                    var path: String
                    var end: Int
                    if (i + 1 < text.length && (text[i + 1] == '\'' || text[i + 1] == '"')) {
                        val q = text[i + 1]
                        val sb = StringBuilder()
                        var j = i + 2
                        while (j < text.length && text[j] != q) {
                            if (text[j] == '\\' && j + 1 < text.length) { sb.append(text[j + 1]); j += 2 } else { sb.append(text[j]); j++ }
                        }
                        end = (j + 1).coerceAtMost(text.length)
                        path = sb.toString()
                    } else {
                        var j = i + 1
                        while (j < text.length && !text[j].isWhitespace() && text[j] != ',' && text[j] != '{' && text[j] != '}' && text[j] != ']') j++
                        end = j
                        path = text.substring(i + 1, j)
                    }
                    if (offset in start..end && path.isNotEmpty()) return path
                    i = end
                }
                else -> i++
            }
        }
        return null
    }
}

/** A path → offset index of one file, plus the enclosing-container lookup. Canonical path:
 *  "" for the root, then ":key" (compact colon; `:` and `\` escaped in a name, `/` literal)
 *  and "[n]" segments — the same compact-colon store form the engine uses (SEPARATOR.md §M4). */
class PathIndex(
    private val byPath: Map<String, Int>,
    private val containers: List<Pair<Int, String>>, // (startOffset, containerPath), ordered
) {
    fun containerOf(offset: Int): String {
        var cur = ""
        for ((at, path) in containers) { if (at > offset) break; cur = path }
        return cur
    }

    fun lookup(path: String): Int? = byPath[path]

    fun resolve(expr: PointerExpr, fromOffset: Int): Int? {
        var path = when (expr.scope) {
            is Scope.Current -> containerOf(fromOffset)
            is Scope.Document -> ""
            is Scope.Parent -> parentOf(containerOf(fromOffset)) ?: return null
            is Scope.Link -> return null // cross-tree (::/:::): needs the engine
        }
        for (step in expr.steps) {
            path = when (step) {
                is Step.Parent -> parentOf(path) ?: return null
                is Step.Key -> path + seg(step.name)
                is Step.Index -> "$path[${step.n}]"
                is Step.RelIndex -> return null // a relative position needs the host frame
            }
        }
        return byPath[path]
    }

    /** `seqOnly`: a block sequence opened at the SAME indent as its key — it is closed by a
     *  keyed line at that indent (a sibling of the key), not by a dedent. */
    private class Frame(val indent: Int, val path: String, var count: Int = 0, val seqOnly: Boolean = false)

    /** A container whose block MAY follow — the frame adopts the first deeper line's indent.
     *  `sameIndentSeq`: a `key:` is also opened by a same-indent `- ` line (its child
     *  sequence); a dash item's / keyed omni's self-value is not — there a same-indent line is
     *  a sibling. `count` seeds the frame (0: a self-value took no position → children from [0]). */
    private class Pending(val indent: Int, val path: String, val count: Int = 0, val sameIndentSeq: Boolean = false)

    companion object {
        /** A canonical compact-colon segment: `:` prefix, then the name with `\` and `:`
         *  escaped so `parentOf` can split back. `/` stays literal (SEPARATOR.md §3). */
        private fun seg(name: String) = ":" + name.replace("\\", "\\\\").replace(":", "\\:")

        /** The parent of a compact-colon path: drop a trailing `[n]`, else the last `:key`
         *  segment (an unescaped `:`). Null at the root. */
        private fun parentOf(path: String): String? {
            if (path.isEmpty()) return null
            if (path.endsWith("]")) { val i = path.lastIndexOf('['); return if (i < 0) null else path.substring(0, i) }
            var i = path.length - 1
            while (i >= 0) {
                if (path[i] == ':' && (i == 0 || path[i - 1] != '\\')) return path.substring(0, i)
                i--
            }
            return null
        }

        /** Index a yamlover file by indentation. Heuristics: nesting = deeper indent; a block
         *  sequence may also sit at the SAME indent as its (empty-valued) key; back-edge
         *  entries (`~key:` / `~-`) are skipped — they are not owned children. Omni: a tag
         *  line (`!!…`) and a scalar self-value take NO position — a scalar-headed dash item
         *  OR a keyed line with a non-empty scalar value (`world: World`) whose deeper block
         *  holds its children indexes those children from `[0]`. Anchors (`&…`) take the value
         *  slot and are not indexed (there is no anchor namespace). */
        fun ofYamlover(text: String): PathIndex {
            val byPath = HashMap<String, Int>()
            val containers = ArrayList<Pair<Int, String>>()
            val stack = ArrayList<Frame>().apply { add(Frame(0, "")) }
            var pending: Pending? = null // a container whose block may follow
            var lineStart = 0

            for (rawLine in text.lineSequence()) {
                val offset = lineStart
                lineStart += rawLine.length + 1
                val noComment = stripComment(rawLine)
                val indent = noComment.indexOfFirst { it != ' ' }
                if (indent < 0) continue // blank or comment-only
                val line = noComment.trim()

                // open the pending container's block if this line starts it (deeper, or —
                // for an empty-valued key — a same-indent seq)
                val isSeqLine = line == "-" || line.startsWith("- ") || line == "~-" || line.startsWith("~- ")
                pending?.let { pk ->
                    if (indent > pk.indent) stack.add(Frame(indent, pk.path, pk.count))
                    else if (indent == pk.indent && isSeqLine && pk.sameIndentSeq) stack.add(Frame(indent, pk.path, pk.count, seqOnly = true))
                    pending = null
                }
                while (stack.size > 1 &&
                    (indent < stack.last().indent || (stack.last().seqOnly && indent == stack.last().indent && !isSeqLine))
                ) stack.removeAt(stack.size - 1)
                val frame = stack.last()
                if (indent > frame.indent) continue // deeper than any entry column (block scalar …)
                containers.add(offset to frame.path)

                if (line == "~-" || line.startsWith("~- ") || line.startsWith("~")) continue // back-edges: not owned
                if (line.startsWith("!!")) continue // a document/value tag line: not an entry

                if (line == "-" || line.startsWith("- ")) {
                    val idx = frame.count++
                    val itemPath = "${frame.path}[$idx]"
                    byPath[itemPath] = offset
                    var rest = stripTags(line.removePrefix("-").trim())
                    if (rest.startsWith("&")) rest = "" // an anchor takes the value slot
                    when {
                        rest.isEmpty() -> stack.add(Frame(indent + 1, itemPath)) // block item: children are deeper
                        rest == "-" || rest.startsWith("- ") -> {
                            // compact `- - x`: the inline head is the item's FIRST child
                            byPath["$itemPath[0]"] = offset
                            pending = Pending(indent, itemPath, 1)
                        }
                        rest.matches(BLOCK_SCALAR_HEAD) -> {} // `- |` / `- >`: deeper lines are scalar content, not entries
                        else -> {
                            val key = splitKey(rest)
                            if (key != null) {
                                // compact `- key: …`: the item is a mapping whose keys sit at
                                // the content column; index the first key and open the frame
                                byPath[itemPath + seg(key)] = offset
                                stack.add(Frame(indent + 2, itemPath, 1))
                            } else {
                                // a plain scalar head is the item's SELF-VALUE (omni title) —
                                // it takes no index; a deeper block holds the item's children
                                pending = Pending(indent, itemPath, 0)
                            }
                        }
                    }
                    continue
                }

                val key = splitKey(line) ?: continue
                val idx = frame.count++
                val entryPath = frame.path + seg(key)
                byPath[entryPath] = offset
                byPath["${frame.path}[$idx]"] = offset // a keyed entry still occupies its position
                var rest = stripTags(line.substring(line.indexOf(':') + 1).trim())
                if (rest.startsWith("&")) rest = "" // an anchor takes the value slot
                when {
                    rest.isEmpty() -> pending = Pending(indent, entryPath, sameIndentSeq = true)
                    rest.matches(BLOCK_SCALAR_HEAD) -> {} // `key: |`: deeper lines are scalar content
                    else -> pending = Pending(indent, entryPath, 0) // keyed omni: a scalar self-value + maybe a deeper body
                }
            }
            return PathIndex(byPath, containers)
        }

        /** A YAML block-scalar header: `|` / `>` with optional chomping/indent indicators. */
        private val BLOCK_SCALAR_HEAD = Regex("[|>][0-9+-]*")

        /** Index a json5p file by brace/bracket structure (strings/comments respected). */
        fun ofJson5p(text: String): PathIndex {
            val byPath = HashMap<String, Int>()
            val containers = ArrayList<Pair<Int, String>>()
            val stack = ArrayList<Frame>().apply { add(Frame(0, "")) }
            var pendingKeyPath: String? = null // a key just seen — names the NEXT value
            var pendingAnchor = false
            var afterTilde = false
            var i = 0

            fun isKeyAhead(from: Int): Boolean {
                var j = from
                while (j < text.length && (text[j] == ' ' || text[j] == '\t')) j++
                return j < text.length && text[j] == ':'
            }

            /** A name/string token read at `at`, ending at `after`: a key registers its path
             *  and position; an anchored name is skipped (no anchor namespace); else a value. */
            fun nameLike(word: String, at: Int, after: Int) {
                val f = stack.last()
                when {
                    pendingAnchor -> pendingAnchor = false // an anchor takes the value slot; not indexed
                    isKeyAhead(after) -> {
                        val idx = f.count++
                        byPath[f.path + seg(word)] = at
                        byPath["${f.path}[$idx]"] = at
                        pendingKeyPath = f.path + seg(word)
                    }
                    else -> { // a primitive value: keyed → consumes the pending key; keyless → a position
                        if (pendingKeyPath != null) pendingKeyPath = null
                        else byPath["${stack.last().path}[${stack.last().count++}]"] = at
                    }
                }
            }

            while (i < text.length) {
                val c = text[i]
                when {
                    c == '/' && i + 1 < text.length && text[i + 1] == '/' -> { while (i < text.length && text[i] != '\n') i++ }
                    c == '/' && i + 1 < text.length && text[i + 1] == '*' -> {
                        i += 2; while (i + 1 < text.length && !(text[i] == '*' && text[i + 1] == '/')) i++; i += 2
                    }
                    c == '{' || c == '[' -> {
                        val f = stack.last()
                        // the document-root brace IS the root container; a nested keyless one
                        // is an element taking a position
                        val path = pendingKeyPath
                            ?: if (stack.size == 1) "" else "${f.path}[${f.count++}]".also { byPath[it] = i }
                        pendingKeyPath = null
                        stack.add(Frame(0, path))
                        containers.add(i + 1 to path)
                        i++
                    }
                    c == '}' || c == ']' -> {
                        if (stack.size > 1) stack.removeAt(stack.size - 1)
                        containers.add(i + 1 to stack.last().path)
                        i++
                    }
                    c == '&' -> { pendingAnchor = true; i++ }
                    c == '~' -> { afterTilde = true; i++ }
                    c == '*' -> { // a pointer value; a keyless one (array element) takes a position
                        val at = i
                        i++
                        if (i < text.length && (text[i] == '\'' || text[i] == '"')) {
                            val q = text[i]; i++
                            while (i < text.length && text[i] != q) { if (text[i] == '\\') i++; i++ }
                            i++
                        } else {
                            while (i < text.length && !text[i].isWhitespace() && text[i] != ',' && text[i] != '}' && text[i] != ']') i++
                        }
                        when {
                            afterTilde -> {} // `~*'…'` back member: takes NO position
                            pendingKeyPath != null -> pendingKeyPath = null
                            else -> byPath["${stack.last().path}[${stack.last().count++}]"] = at
                        }
                        afterTilde = false
                    }
                    c == '\'' || c == '"' -> {
                        val at = i
                        val sb = StringBuilder()
                        i++
                        while (i < text.length && text[i] != c) {
                            if (text[i] == '\\' && i + 1 < text.length) { sb.append(text[i + 1]); i += 2 } else { sb.append(text[i]); i++ }
                        }
                        i++
                        nameLike(sb.toString(), at, i)
                        afterTilde = false
                    }
                    c.isWhitespace() || c == ',' || c == ':' -> i++
                    else -> {
                        val at = i
                        val sb = StringBuilder()
                        // `/` is an ordinary key character now (SEPARATOR.md §3): it does not end a word
                        while (i < text.length && !text[i].isWhitespace() && text[i] !in ":,{}[]'\"") { sb.append(text[i]); i++ }
                        if (sb.isEmpty()) i++ else nameLike(sb.toString(), at, i)
                        afterTilde = false
                    }
                }
            }
            return PathIndex(byPath, containers)
        }

        /** Strip a trailing `#` comment (quote-aware, same rule as the parser). */
        private fun stripComment(s: String): String {
            var inS = false; var inD = false
            var i = 0
            while (i < s.length) {
                val c = s[i]
                when {
                    inD && c == '\\' -> i++ // skip the escaped char
                    c == '\'' && !inD -> inS = !inS
                    c == '"' && !inS -> inD = !inD
                    c == '#' && !inS && !inD && (i == 0 || s[i - 1] == ' ' || s[i - 1] == '\t') -> return s.substring(0, i)
                }
                i++
            }
            return s
        }

        /** `key` of a `key: …` line (null if none); strips quotes; ignores `:` inside quotes. */
        private fun splitKey(line: String): String? {
            var inS = false; var inD = false
            for (i in line.indices) {
                val c = line[i]
                when {
                    c == '\'' && !inD -> inS = !inS
                    c == '"' && !inS -> inD = !inD
                    c == ':' && !inS && !inD && (i + 1 == line.length || line[i + 1] == ' ' || line[i + 1] == '\t') -> {
                        var k = line.substring(0, i).trim()
                        if (k.length >= 2 && (k[0] == '\'' || k[0] == '"') && k.last() == k[0]) k = k.substring(1, k.length - 1)
                        return k.replace("\\", "")
                    }
                }
            }
            return null
        }

        /** Drop a leading `!!word` / `!!<…>` tag from a value rest. */
        private fun stripTags(rest: String): String {
            var r = rest
            if (r.startsWith("!!<")) { val close = r.indexOf('>'); r = if (close < 0) "" else r.substring(close + 1).trim() }
            else if (r.startsWith("!!")) r = r.dropWhile { !it.isWhitespace() }.trim()
            return r
        }
    }
}
