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
    fun `comment ends the line, sigil and path precede it`() {
        val src = "x: *a/b  # note\n"
        val toks = tokens(src)
        assertEquals("YAMLOVER_COMMENT", toks.last { it.second.isNotBlank() }.first)
        assertTrue(ofType(src, "YAMLOVER_POINTER").contains("*"))
        assertTrue(ofType(src, "YAMLOVER_REF").contains("a"))
        assertTrue(ofType(src, "YAMLOVER_REF").contains("b"))
        assertTrue(ofType(src, "YAMLOVER_PUNCT").contains("/"))
    }
}
