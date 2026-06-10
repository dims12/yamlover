package net.inthemoon.yamlover

/**
 * v1 heuristic pointer navigation (Ctrl+B / Ctrl+click) — pure text logic, no PSI grammar
 * and no engine (that is PLAN.md J3 proper). Mirrors the heuristic-lexer spirit: parse the
 * pointer under the caret, resolve it against a lightweight path index of the SAME file.
 *
 * Supported: current-mapping scope (`*name`), `..` parents, `/` document scope, `/x` string
 * keys, `[n]` integer keys (positions — keyed entries occupy positions too), `&anchor`
 * precedence (a declared anchor wins over a sibling key), backslash escapes.
 * Out of scope: `//` / scheme links (cross-tree — waits for the engine protocol).
 */

sealed class Step {
    data class Key(val name: String) : Step()
    data class Index(val n: Int) : Step()
    object Parent : Step()
}

data class PointerExpr(val document: Boolean, val steps: List<Step>) {
    /** A bare single name in current scope — the case where a declared anchor wins. */
    val bareName: String?
        get() = if (!document && steps.size == 1 && steps[0] is Step.Key) (steps[0] as Step.Key).name else null
}

object Pointers {
    /** Parse the pointer PATH text (after the `*` sigil, unquoted). Null for links (`//…`,
     *  `scheme://…`) and empty paths. */
    fun parse(raw: String): PointerExpr? {
        var s = raw.trim()
        if (s.isEmpty()) return null
        if (s.startsWith("//") || Regex("^[A-Za-z][A-Za-z0-9+.-]*://").containsMatchIn(s)) return null // a link
        val document = s.startsWith("/")
        if (document) s = s.substring(1)
        val steps = ArrayList<Step>()
        var i = 0
        while (i < s.length) {
            when {
                s[i] == '/' -> i++ // segment separator
                s[i] == '[' -> {
                    val close = s.indexOf(']', i)
                    if (close < 0) return null
                    steps.add(Step.Index(s.substring(i + 1, close).toIntOrNull() ?: return null))
                    i = close + 1
                }
                else -> {
                    val sb = StringBuilder()
                    while (i < s.length && s[i] != '/' && s[i] != '[') {
                        if (s[i] == '\\' && i + 1 < s.length) { sb.append(s[i + 1]); i += 2 } else { sb.append(s[i]); i++ }
                    }
                    val name = sb.toString()
                    if (name == "..") steps.add(Step.Parent) else if (name.isNotEmpty()) steps.add(Step.Key(name))
                }
            }
        }
        return if (steps.isEmpty() && !document) null else PointerExpr(document, steps)
    }

    private fun isYRunBoundary(c: Char) =
        c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == ',' || c == '{' || c == '}' || c == '#'

    /** The unquoted pointer path around `offset` in yamlover text (the run after a `*`). */
    fun yamloverPointerAt(text: String, offset: Int): String? {
        var start = offset.coerceIn(0, text.length)
        if (start == text.length || isYRunBoundary(text[start])) start-- // caret at run end
        if (start < 0) return null
        while (start > 0 && !isYRunBoundary(text[start - 1])) start--
        var end = start
        while (end < text.length && !isYRunBoundary(text[end])) end++
        val run = text.substring(start, end)
        if (!run.startsWith("*")) return null
        return run.substring(1)
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

/** A path → offset index of one file, plus anchor declarations and the enclosing-container
 *  lookup. Canonical path: "" for the root, then "/key" (with `/` in names escaped) and
 *  "[n]" segments. */
class PathIndex(
    private val byPath: Map<String, Int>,
    private val anchors: Map<String, Int>,
    private val containers: List<Pair<Int, String>>, // (startOffset, containerPath), ordered
) {
    fun containerOf(offset: Int): String {
        var cur = ""
        for ((at, path) in containers) { if (at > offset) break; cur = path }
        return cur
    }

    fun lookup(path: String): Int? = byPath[path]

    fun resolve(expr: PointerExpr, fromOffset: Int): Int? {
        expr.bareName?.let { name -> anchors[name]?.let { return it } } // a declared anchor wins
        var path = if (expr.document) "" else containerOf(fromOffset)
        for (step in expr.steps) {
            path = when (step) {
                is Step.Parent -> when {
                    path.isEmpty() -> return null
                    path.endsWith("]") -> path.substring(0, path.lastIndexOf('['))
                    path.lastIndexOf('/') >= 0 -> path.substring(0, path.lastIndexOf('/'))
                    else -> return null
                }
                is Step.Key -> path + seg(step.name)
                is Step.Index -> "$path[${step.n}]"
            }
        }
        return byPath[path]
    }

    /** `seqOnly`: a block sequence opened at the SAME indent as its key — it is closed by a
     *  keyed line at that indent (a sibling of the key), not by a dedent. */
    private class Frame(val indent: Int, val path: String, var count: Int = 0, val seqOnly: Boolean = false)

    companion object {
        private fun seg(name: String) = "/" + name.replace("/", "\\/")

        /** Index a yamlover file by indentation. Heuristics: nesting = deeper indent; a block
         *  sequence may also sit at the SAME indent as its (empty-valued) key; back-edge
         *  entries (`~key:` / `~-`) are skipped — they are not owned children. */
        fun ofYamlover(text: String): PathIndex {
            val byPath = HashMap<String, Int>()
            val anchors = HashMap<String, Int>()
            val containers = ArrayList<Pair<Int, String>>()
            val stack = ArrayList<Frame>().apply { add(Frame(0, "")) }
            var pendingKey: Frame? = null // a `key:` with empty rest — its block may follow
            var lineStart = 0

            for (rawLine in text.lineSequence()) {
                val offset = lineStart
                lineStart += rawLine.length + 1
                val noComment = stripComment(rawLine)
                val indent = noComment.indexOfFirst { it != ' ' }
                if (indent < 0) continue // blank or comment-only
                val line = noComment.trim()

                // open the pending key's block if this line starts it (deeper, or a same-indent seq)
                val isSeqLine = line == "-" || line.startsWith("- ") || line == "~-" || line.startsWith("~- ")
                pendingKey?.let { pk ->
                    if (indent > pk.indent) stack.add(Frame(indent, pk.path))
                    else if (indent == pk.indent && isSeqLine) stack.add(Frame(indent, pk.path, seqOnly = true))
                    pendingKey = null
                }
                while (stack.size > 1 &&
                    (indent < stack.last().indent || (stack.last().seqOnly && indent == stack.last().indent && !isSeqLine))
                ) stack.removeAt(stack.size - 1)
                val frame = stack.last()
                if (indent > frame.indent) continue // deeper than any entry column (block scalar …)
                containers.add(offset to frame.path)

                if (line == "~-" || line.startsWith("~- ") || line.startsWith("~")) continue // back-edges: not owned

                if (line == "-" || line.startsWith("- ")) {
                    val idx = frame.count++
                    val itemPath = "${frame.path}[$idx]"
                    byPath[itemPath] = offset
                    var rest = stripTags(line.removePrefix("-").trim())
                    if (rest.startsWith("&")) {
                        val name = rest.substring(1).takeWhile { !it.isWhitespace() }
                        anchors[name] = offset
                        rest = rest.substring(1 + name.length).trim()
                    }
                    val key = splitKey(rest)
                    if (key != null) {
                        // compact `- key: …`: the item is a mapping whose keys sit at the
                        // content column; index the first key and open the item's frame
                        val contentCol = indent + 2
                        byPath[itemPath + seg(key)] = offset
                        stack.add(Frame(contentCol, itemPath, 1))
                    } else if (rest.isEmpty()) {
                        stack.add(Frame(indent + 1, itemPath)) // block item: children are deeper
                    }
                    continue
                }

                val key = splitKey(line) ?: continue
                val idx = frame.count++
                val entryPath = frame.path + seg(key)
                byPath[entryPath] = offset
                byPath["${frame.path}[$idx]"] = offset // a keyed entry still occupies its position
                var rest = stripTags(line.substring(line.indexOf(':') + 1).trim())
                if (rest.startsWith("&")) {
                    anchors[rest.substring(1).takeWhile { !it.isWhitespace() }] = offset
                    rest = ""
                }
                if (rest.isEmpty()) pendingKey = Frame(indent, entryPath)
            }
            return PathIndex(byPath, anchors, containers)
        }

        /** Index a json5p file by brace/bracket structure (strings/comments respected). */
        fun ofJson5p(text: String): PathIndex {
            val byPath = HashMap<String, Int>()
            val anchors = HashMap<String, Int>()
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
             *  and position; an anchored name records the anchor; else a primitive value. */
            fun nameLike(word: String, at: Int, after: Int) {
                val f = stack.last()
                when {
                    pendingAnchor -> { anchors[word] = at; pendingAnchor = false }
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
                        while (i < text.length && !text[i].isWhitespace() && text[i] !in ":,{}[]'\"" && text[i] != '/') { sb.append(text[i]); i++ }
                        if (sb.isEmpty()) i++ else nameLike(sb.toString(), at, i)
                        afterTilde = false
                    }
                }
            }
            return PathIndex(byPath, anchors, containers)
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
