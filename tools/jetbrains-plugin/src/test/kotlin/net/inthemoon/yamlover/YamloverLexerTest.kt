package net.inthemoon.yamlover

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Drives the heuristic lexer directly, pinning it to the shared TS ruleset
 *  (tools/parser/ts/src/highlight.ts). A pointer = the SIGIL (`* & ~`) + a tokenized PATH in
 *  the COLON grammar (docs/language/pointers/paths): name segments are REF, `:` separators / `[ ]` are PUNCT
 *  (sign), index digits are NUMBER, `/` is an ordinary key char. A `~` back-edge's key NAME
 *  colors as a KEY. A `|`/`>` block scalar is a PUNCT header + one opaque SCALAR body. */
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
        // docs/language/pointers/paths: `/` left the metachar set — `text/html` is ONE key segment
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
    fun `a block scalar is a PUNCT header and one opaque scalar body`() {
        val src = "desc: |\n  note: not a key\n  *not a pointer\nnext: 1\n"
        val toks = tokens(src)
        assertTrue("no phantom key in the body", toks.none { it.first == "YAMLOVER_KEY" && it.second == "note" })
        assertTrue("no phantom pointer in the body", toks.none { it.first == "YAMLOVER_POINTER" })
        // the `|`+indicators lex as PUNCT, the body as one opaque SCALAR (highlight.ts:209-213)
        assertTrue("the header is a sign: ${ofType(src, "YAMLOVER_PUNCT")}", ofType(src, "YAMLOVER_PUNCT").contains("|"))
        assertTrue("the body is a scalar: ${ofType(src, "YAMLOVER_SCALAR")}", ofType(src, "YAMLOVER_SCALAR").any { it.contains("note: not a key") })
        // indicators ride in the header token
        assertTrue(ofType("x: |2-\n    keep\nnext: 1\n", "YAMLOVER_PUNCT").contains("|2-"))
        // the dedented next line is still a key
        assertTrue(tokens(src).any { it.first == "YAMLOVER_KEY" && it.second == "next" })
    }

    @Test
    fun `inf, nan and hex classify as numbers, null and tilde ride their own NULL kind`() {
        assertTrue(ofType("x: .inf\n", "YAMLOVER_NUMBER").contains(".inf"))
        assertTrue(ofType("x: .nan\n", "YAMLOVER_NUMBER").contains(".nan"))
        assertTrue(ofType("x: 0xFF\n", "YAMLOVER_NUMBER").contains("0xFF"))
        assertTrue(ofType("x: true\n", "YAMLOVER_KEYWORD").contains("true"))
        // null/~ split off the boolean keywords — the web client's dedicated `null` class
        assertTrue(ofType("x: Null\n", "YAMLOVER_NULL").contains("Null"))
        assertTrue(ofType("x: NULL\n", "YAMLOVER_NULL").contains("NULL"))
        assertTrue(ofType("x: ~\n", "YAMLOVER_NULL").contains("~"))
    }

    @Test
    fun `number classification follows JS Number — NaN and java-only forms are plain`() {
        assertTrue(ofType("x: NaN\n", "YAMLOVER_SCALAR").contains("NaN"))
        assertTrue(ofType("x: Infinity\n", "YAMLOVER_NUMBER").contains("Infinity"))
        assertTrue(ofType("x: 0b101\n", "YAMLOVER_NUMBER").contains("0b101"))
        assertTrue(ofType("x: 0o17\n", "YAMLOVER_NUMBER").contains("0o17"))
        assertTrue("Java-only float suffix is no number", ofType("x: 1f\n", "YAMLOVER_SCALAR").contains("1f"))
    }

    @Test
    fun `a quoted string before a colon is a KEY, elsewhere a STRING`() {
        val src = "\"key with spaces\": 1\n'1': x\ny: 'just a value'\n"
        val keys = ofType(src, "YAMLOVER_KEY")
        assertTrue("quoted keys: $keys", keys.contains("\"key with spaces\""))
        assertTrue("a quoted numeric key: $keys", keys.contains("'1'"))
        assertTrue(ofType(src, "YAMLOVER_STRING").contains("'just a value'"))
    }

    @Test
    fun `the sequence dash has its own kind and a signed number is one token`() {
        val src = "- item\n"
        assertTrue(ofType(src, "YAMLOVER_DASH").contains("-"))
        assertTrue(ofType(src, "YAMLOVER_SCALAR").contains("item"))
        // a `-` NOT before a space starts a word: `-1` is ONE number, `-foo:` a key
        assertTrue(ofType("x: -1\n", "YAMLOVER_NUMBER").contains("-1"))
        assertTrue(ofType("-foo: 1\n", "YAMLOVER_KEY").contains("-foo"))
        assertTrue("no dash inside a word", ofType("x: a-b\n", "YAMLOVER_DASH").isEmpty())
    }

    @Test
    fun `a quoted portion inside a pointer path is a REF, not a STRING`() {
        val src = "x: *: 'дорожный знак': name\n"
        assertTrue("quoted portion: ${ofType(src, "YAMLOVER_REF")}", ofType(src, "YAMLOVER_REF").contains("'дорожный знак'"))
        assertTrue(ofType(src, "YAMLOVER_STRING").isEmpty())
    }

    @Test
    fun `a hash without a preceding space is part of the scalar, not a comment`() {
        val src = "tag: c#5\n"
        assertTrue("c#5 is one scalar: ${ofType(src, "YAMLOVER_SCALAR")}", ofType(src, "YAMLOVER_SCALAR").contains("c#5"))
        assertTrue("no comment", ofType(src, "YAMLOVER_COMMENT").isEmpty())
        // but a spaced # still opens a comment
        assertTrue(ofType("tag: c # x\n", "YAMLOVER_COMMENT").contains("# x"))
    }

    @Test
    fun `a FLAT row's path segments each colour as a KEY`() {
        // docs/language/flattening: `a: a: a: 12` is a flat row — each word-before-colon is a key
        val src = "a: a: a: 12\n"
        assertEquals(listOf("a", "a", "a"), ofType(src, "YAMLOVER_KEY"))
        assertTrue(ofType(src, "YAMLOVER_NUMBER").contains("12"))
    }

    @Test
    fun `the keyless flat segment dash-colon is a DASH, never a key`() {
        // highlight.ts's `-:` arm: the hyphen is the dash; the colon is ordinary punct
        val src = "human1: pets: -: 1\n"
        assertEquals(listOf("human1", "pets"), ofType(src, "YAMLOVER_KEY"))
        assertEquals(listOf("-"), ofType(src, "YAMLOVER_DASH"))
        // `-:x` (no trailing space) is NOT the marker — it starts a word, exactly the TS rule
        assertTrue(ofType("-:x\n", "YAMLOVER_DASH").isEmpty())
    }
}
