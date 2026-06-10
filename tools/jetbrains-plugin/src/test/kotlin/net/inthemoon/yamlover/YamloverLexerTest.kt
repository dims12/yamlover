package net.inthemoon.yamlover

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Drives the heuristic lexer directly. A pointer = the SIGIL (`* & ~`) + a tokenized
 *  PATH: name segments are REF, `/ [ ]` are PUNCT (sign), index digits are NUMBER. A `~`
 *  back-edge's key NAME colors as a KEY. */
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
    fun `pointer path is tokenized into sigil, separators, name and index`() {
        val src = "feline: */pets[1]\n"
        assertTrue("'*' sigil", ofType(src, "YAMLOVER_POINTER").contains("*"))
        assertTrue("name segment REF: ${ofType(src, "YAMLOVER_REF")}", ofType(src, "YAMLOVER_REF").contains("pets"))
        val punct = ofType(src, "YAMLOVER_PUNCT")
        assertTrue("'/' separator: $punct", punct.contains("/"))
        assertTrue("'[' bracket: $punct", punct.contains("["))
        assertTrue("']' bracket: $punct", punct.contains("]"))
        assertTrue("index number: ${ofType(src, "YAMLOVER_NUMBER")}", ofType(src, "YAMLOVER_NUMBER").contains("1"))
        assertTrue("key", tokens(src).any { it.first == "YAMLOVER_KEY" && it.second == "feline" })
    }

    @Test
    fun `anchor sigil plus REF name, back-edge sigil plus KEY name`() {
        val src = "boss: &chief\n  name: Rex\nx:\n  ~mother: */eve\n"
        assertTrue("& sigil", ofType(src, "YAMLOVER_POINTER").contains("&"))
        assertTrue("anchor name REF", ofType(src, "YAMLOVER_REF").contains("chief"))
        assertTrue("~ sigil", ofType(src, "YAMLOVER_POINTER").contains("~"))
        assertTrue("back-edge key name is a KEY", ofType(src, "YAMLOVER_KEY").contains("mother"))
        assertTrue("* sigil", ofType(src, "YAMLOVER_POINTER").contains("*"))
        assertTrue("path name REF", ofType(src, "YAMLOVER_REF").contains("eve"))
    }

    @Test
    fun `schema tag is one TAG token`() {
        val src = "doc: !!<*yamlover/\$defs/chapter>\n  title: T\n"
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
        val src = "- !!<format: text/x-plantuml> |\n"
        val tags = ofType(src, "YAMLOVER_TAG")
        assertTrue("expected full tag incl spaces: $tags", tags.any { it == "!!<format: text/x-plantuml>" })
    }

    @Test
    fun `comment ends the line, sigil and path precede it`() {
        val src = "x: *a/b  # note\n"
        val toks = tokens(src)
        assertEquals("YAMLOVER_COMMENT", toks.last { it.second.isNotBlank() }.first)
        assertTrue(ofType(src, "YAMLOVER_POINTER").contains("*"))
        assertTrue(ofType(src, "YAMLOVER_REF").contains("a"))
        assertTrue(ofType(src, "YAMLOVER_REF").contains("b"))
        assertTrue(ofType(src, "YAMLOVER_PUNCT").contains("/"))
    }

    @Test
    fun `a block pointer path with spaces and commas stays REF to end of line`() {
        val src = "slug: */1105-2_abstract_Is the sequence, with spaces removed.pdf\nnext: 1\n"
        val refs = ofType(src, "YAMLOVER_REF")
        assertTrue("first word: $refs", refs.contains("1105-2_abstract_Is"))
        assertTrue("interior word kept in path: $refs", refs.contains("sequence,"))
        assertTrue("last word: $refs", refs.contains("removed.pdf"))
        // nothing of the path leaks into SCALAR, and the next line is still a key
        assertTrue(ofType(src, "YAMLOVER_SCALAR").isEmpty())
        assertTrue(tokens(src).any { it.first == "YAMLOVER_KEY" && it.second == "next" })
    }

    @Test
    fun `comments and flow still bound a pointer path and anchors keep ending at a space`() {
        val src = "a: */x y # note\nb: {c: *one two}\nboss: &chief {nm: 1}\n"
        assertTrue(ofType(src, "YAMLOVER_COMMENT").contains("# note"))
        val refs = ofType(src, "YAMLOVER_REF")
        assertTrue("flow path ends at space: $refs", refs.contains("one") && !refs.contains("two"))
        assertTrue("anchor name ends at space", refs.contains("chief") && !refs.contains("{nm"))
        assertTrue("flow value after anchor lexes as key", tokens(src).any { it.first == "YAMLOVER_KEY" && it.second == "nm" })
    }
}
