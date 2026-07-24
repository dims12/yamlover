package net.inthemoon.yamlover

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Drives the heuristic lexer directly. A pointer = the SIGIL (`* & ~`) + a tokenized PATH in
 *  the COLON grammar (SEPARATOR.md): name segments are REF, `:` separators / `[ ]` are PUNCT
 *  (sign), index digits are NUMBER, `/` is an ordinary key char. A `~` back-edge's key NAME
 *  colors as a KEY. A `|`/`>` block scalar body is one opaque SCALAR. */
class YamloverLexerTest {
    private fun tokens(text: String): List<Pair<String, String>> {
        val lx = YamloverLexer()
        lx.start(text, 0, text.length, 0)
        val out = ArrayList<Pair<String, String>>()
        while (lx.tokenType != null) {
            out.add(lx.tokenType.toString() to text.substring(lx.tokenStart, lx.tokenEnd))
            lx.advance()
        }
        return out
    }

    private fun ofType(text: String, type: String) =
        tokens(text).filter { it.first == type }.map { it.second }

    @Test
    fun `pointer path is tokenized into sigil, colon separators, name and index`() {
        val src = "feline: *: pets[1]\n"
        assertTrue("'*' sigil", ofType(src, "YAMLOVER_POINTER").contains("*"))
        assertTrue("name segment REF: ${ofType(src, "YAMLOVER_REF")}", ofType(src, "YAMLOVER_REF").contains("pets"))
        val punct = ofType(src, "YAMLOVER_PUNCT")
        assertTrue("':' separator: $punct", punct.contains(":"))
        assertTrue("'[' bracket: $punct", punct.contains("["))
        assertTrue("']' bracket: $punct", punct.contains("]"))
        assertTrue("index number: ${ofType(src, "YAMLOVER_NUMBER")}", ofType(src, "YAMLOVER_NUMBER").contains("1"))
        assertTrue("key", tokens(src).any { it.first == "YAMLOVER_KEY" && it.second == "feline" })
    }

    @Test
    fun `a slash is an ordinary key character in a pointer path`() {
        // SEPARATOR.md §3: `/` left the metachar set — `text/html` is ONE key segment
        val src = "type: *: text/html\n"
        assertTrue("REF holds the whole key: ${ofType(src, "YAMLOVER_REF")}", ofType(src, "YAMLOVER_REF").contains("text/html"))
        assertTrue("'/' is not a separator PUNCT", !ofType(src, "YAMLOVER_PUNCT").contains("/"))
    }

    @Test
    fun `anchor sigil plus REF name, back-edge sigil plus KEY name`() {
        val src = "boss: &chief\n  name: Rex\nx:\n  ~mother: *: eve\n"
        assertTrue("& sigil", ofType(src, "YAMLOVER_POINTER").contains("&"))
        assertTrue("anchor name REF", ofType(src, "YAMLOVER_REF").contains("chief"))
        assertTrue("~ sigil", ofType(src, "YAMLOVER_POINTER").contains("~"))
        assertTrue("back-edge key name is a KEY", ofType(src, "YAMLOVER_KEY").contains("mother"))
        assertTrue("* sigil", ofType(src, "YAMLOVER_POINTER").contains("*"))
        assertTrue("path name REF", ofType(src, "YAMLOVER_REF").contains("eve"))
    }

    @Test
    fun `schema tag is one TAG token`() {
        val src = "doc: !!<*yamlover: \$defs: chapter>\n  T\n"
        val tags = ofType(src, "YAMLOVER_TAG")
        assertTrue("expected a TAG token: $tags", tags.any { it.startsWith("!!<") && it.endsWith(">") })
    }

    @Test
    fun `value-position type tag mix is a TAG token`() {
        val src = "playlist: !!mix\n  - a\n"
        assertTrue(ofType(src, "YAMLOVER_TAG").any { it == "!!mix" })
    }

    @Test
    fun `omni tag before a scalar value is a TAG token`() {
        val src = "rating: !!omni 5\n  - solid\n"
        assertTrue(ofType(src, "YAMLOVER_TAG").any { it == "!!omni" })
    }

    @Test
    fun `inline schema tag with spaces is one TAG token`() {
        val src = "- !!<format: text/x-plantuml> x\n"
        val tags = ofType(src, "YAMLOVER_TAG")
        assertTrue("expected full tag incl spaces: $tags", tags.any { it == "!!<format: text/x-plantuml>" })
    }

    @Test
    fun `comment ends the line, sigil and colon path precede it`() {
        val src = "x: *a: b  # note\n"
        val toks = tokens(src)
        assertEquals("YAMLOVER_COMMENT", toks.last { it.second.isNotBlank() }.first)
        assertTrue(ofType(src, "YAMLOVER_POINTER").contains("*"))
        assertTrue(ofType(src, "YAMLOVER_REF").contains("a"))
        assertTrue(ofType(src, "YAMLOVER_REF").contains("b"))
        assertTrue(ofType(src, "YAMLOVER_PUNCT").contains(":"))
    }

    @Test
    fun `a block pointer path keeps the interior colon spacing to end of line`() {
        val src = "slug: *: chapter: intro: getting-started\nnext: 1\n"
        val refs = ofType(src, "YAMLOVER_REF")
        assertTrue("first portion: $refs", refs.contains("chapter"))
        assertTrue("interior portion: $refs", refs.contains("intro"))
        assertTrue("last portion: $refs", refs.contains("getting-started"))
        // nothing of the path leaks into SCALAR, and the next line is still a key
        assertTrue(ofType(src, "YAMLOVER_SCALAR").isEmpty())
        assertTrue(tokens(src).any { it.first == "YAMLOVER_KEY" && it.second == "next" })
    }

    @Test
    fun `comments and flow bound a pointer path, an own-line anchor runs to EOL`() {
        val src = "a: *: x # note\nb: {c: *one two}\nboss: &chief\n"
        assertTrue(ofType(src, "YAMLOVER_COMMENT").contains("# note"))
        val refs = ofType(src, "YAMLOVER_REF")
        assertTrue("flow path ends at space: $refs", refs.contains("one") && !refs.contains("two"))
        assertTrue("own-line anchor runs to EOL", refs.contains("chief"))
    }

    @Test
    fun `a block scalar header and its indented body are one opaque scalar`() {
        val src = "desc: |\n  note: not a key\n  *not a pointer\nnext: 1\n"
        val toks = tokens(src)
        assertTrue("no phantom key in the body", toks.none { it.first == "YAMLOVER_KEY" && it.second == "note" })
        assertTrue("no phantom pointer in the body", toks.none { it.first == "YAMLOVER_POINTER" })
        assertTrue("the body is a scalar: ${ofType(src, "YAMLOVER_SCALAR")}", ofType(src, "YAMLOVER_SCALAR").any { it.contains("note: not a key") })
        // the dedented next line is still a key
        assertTrue(tokens(src).any { it.first == "YAMLOVER_KEY" && it.second == "next" })
    }

    @Test
    fun `inf, nan and hex classify as numbers, keywords include capitalized null`() {
        assertTrue(ofType("x: .inf\n", "YAMLOVER_NUMBER").contains(".inf"))
        assertTrue(ofType("x: .nan\n", "YAMLOVER_NUMBER").contains(".nan"))
        assertTrue(ofType("x: 0xFF\n", "YAMLOVER_NUMBER").contains("0xFF"))
        assertTrue(ofType("x: Null\n", "YAMLOVER_KEYWORD").contains("Null"))
        assertTrue(ofType("x: NULL\n", "YAMLOVER_KEYWORD").contains("NULL"))
    }

    @Test
    fun `a hash without a preceding space is part of the scalar, not a comment`() {
        val src = "tag: c#5\n"
        assertTrue("c#5 is one scalar: ${ofType(src, "YAMLOVER_SCALAR")}", ofType(src, "YAMLOVER_SCALAR").contains("c#5"))
        assertTrue("no comment", ofType(src, "YAMLOVER_COMMENT").isEmpty())
        // but a spaced # still opens a comment
        assertTrue(ofType("tag: c # x\n", "YAMLOVER_COMMENT").contains("# x"))
    }
}
