package net.inthemoon.yamlover

import org.junit.Assert.assertTrue
import org.junit.Test

/** Drives the json5p lexer — the flow, `//`-comments instantiation of the shared engine
 *  (highlight.ts `tokenize(text, 'json5p')`). A pointer path rides QUOTED right after the
 *  sigil: `*': …'` lexes as sigil + ONE REF token, the colon portions inside parsed by
 *  PointerNavigation, not coloured here. */
class Json5pLexerTest {
    private fun tokens(text: String): List<Pair<String, String>> {
        val lx = Json5pLexer()
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
    fun `comments are line and block, never hash`() {
        val src = "{a: 1} // tail\n/* block\ncomment */ {b: 2}\n"
        val comments = ofType(src, "JSON5P_COMMENT")
        assertTrue("line comment: $comments", comments.contains("// tail"))
        assertTrue("block comment: $comments", comments.any { it.startsWith("/*") && it.endsWith("*/") })
        // an unterminated block comment runs to EOF
        assertTrue(ofType("{x: 1} /* open", "JSON5P_COMMENT").contains("/* open"))
        // `#` never comments — `a#b` is one scalar
        assertTrue(ofType("{x: a#b}", "JSON5P_SCALAR").contains("a#b"))
    }

    @Test
    fun `a quoted pointer is sigil plus one REF token`() {
        val src = "{a: 1, b: *': pets[1]'} // tail\n"
        assertTrue(ofType(src, "JSON5P_POINTER").contains("*"))
        assertTrue("the quoted path is a REF: ${ofType(src, "JSON5P_REF")}", ofType(src, "JSON5P_REF").contains("': pets[1]'"))
        assertTrue("the path does not lex as a STRING", ofType(src, "JSON5P_STRING").isEmpty())
        assertTrue("a value string elsewhere stays a STRING", ofType("{a: 'v'}", "JSON5P_STRING").contains("'v'"))
    }

    @Test
    fun `an unquoted pointer is sigil plus REF path segments`() {
        val src = "{a: *pets}"
        assertTrue(ofType(src, "JSON5P_POINTER").contains("*"))
        assertTrue("path segment: ${ofType(src, "JSON5P_REF")}", ofType(src, "JSON5P_REF").contains("pets"))
    }

    @Test
    fun `a back-edge sigil emits alone and its key name is a KEY`() {
        val src = "{~mother: 1}"
        assertTrue(ofType(src, "JSON5P_POINTER").contains("~"))
        assertTrue("the name after ~ is a KEY: ${ofType(src, "JSON5P_KEY")}", ofType(src, "JSON5P_KEY").contains("mother"))
    }

    @Test
    fun `quoted keys, null kind and boolean keywords`() {
        assertTrue(ofType("{'a': 1}", "JSON5P_KEY").contains("'a'"))
        assertTrue(ofType("{x: null}", "JSON5P_NULL").contains("null"))
        assertTrue("a bare ~ value is the null", ofType("{x: ~}", "JSON5P_NULL").contains("~"))
        assertTrue(ofType("{x: true}", "JSON5P_KEYWORD").contains("true"))
    }

    @Test
    fun `numbers follow JS Number — Infinity yes, NaN no, greedy digit runs no`() {
        assertTrue(ofType("{x: Infinity}", "JSON5P_NUMBER").contains("Infinity"))
        assertTrue(ofType("{x: 0xFF}", "JSON5P_NUMBER").contains("0xFF"))
        assertTrue(ofType("{x: NaN}", "JSON5P_SCALAR").contains("NaN"))
        assertTrue("1abc is one plain word", ofType("{x: 1abc}", "JSON5P_SCALAR").contains("1abc"))
    }

    @Test
    fun `standalone index, type tag and the sequence dash`() {
        assertTrue(ofType("[3]", "JSON5P_INDEX").contains("[3]"))
        assertTrue(ofType("{x: !!mix }", "JSON5P_TAG").contains("!!mix"))
        assertTrue(ofType("[- 1]", "JSON5P_DASH").contains("-"))
    }
}
