package net.inthemoon.yamlover

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The heuristic Ctrl+click resolution: pointer-at-caret extraction, path parsing, and the
 *  per-language path indexes — pure logic, driven without the IDE. COLON grammar (SEPARATOR.md;
 *  the legacy `/` separator is DEAD — `/` is an ordinary key character now). */
class PointerNavigationTest {

    // ---- pointer parsing ----------------------------------------------------

    @Test
    fun `parse current-scope steps, document scope and escapes`() {
        assertEquals(PointerExpr(Scope.Current, listOf(Step.Key("pets"), Step.Index(1))), Pointers.parse("pets[1]"))
        assertEquals(PointerExpr(Scope.Document, listOf(Step.Key("a"), Step.Key("b"))), Pointers.parse(": a: b"))
        assertEquals(PointerExpr(Scope.Parent, listOf(Step.Key("x"))), Pointers.parse("..: x"))
        // `/` is an ORDINARY key character (MIME types, dates) — it never separates
        assertEquals(PointerExpr(Scope.Current, listOf(Step.Key("text/html"))), Pointers.parse("text/html"))
        assertEquals(PointerExpr(Scope.Document, listOf(Step.Key("cat/dog"), Step.Key("n"))), Pointers.parse(": cat/dog: n"))
    }

    @Test
    fun `parse the scope ladder — colon, project and world`() {
        assertEquals(PointerExpr(Scope.Link("proj", false), listOf(Step.Key("x"))), Pointers.parse(":: proj: x"))
        assertEquals(
            PointerExpr(Scope.Link("yamlover.inthemoon.net", true), listOf(Step.Key("defs"))),
            Pointers.parse(":::yamlover.inthemoon.net: defs"),
        )
    }

    @Test
    fun `parse quoting and relative indexes`() {
        // a key containing a space must be quoted; unquoted, it is a malformed portion
        assertNull("an unquoted space is invalid", Pointers.parse("a b"))
        assertEquals(PointerExpr(Scope.Current, listOf(Step.Key("a b"))), Pointers.parse("'a b'"))
        // relative index groups `[.]` / `[.±k]` (the table rowspan idiom) parse onto the uplink
        assertEquals(
            PointerExpr(Scope.Current, listOf(Step.Parent, Step.RelIndex(-1), Step.RelIndex(0))),
            Pointers.parse("..[.-1][.]"),
        )
    }

    @Test
    fun `pointer text under the caret (yamlover, unquoted)`() {
        val src = "feline: *: pets[1]\n"
        val inside = src.indexOf("pets") + 2
        assertEquals(": pets[1]", Pointers.yamloverPointerAt(src, inside))
        assertNull("a key is not a pointer", Pointers.yamloverPointerAt(src, 2))
    }

    @Test
    fun `pointer text under the caret (json5p, quoted incl back member)`() {
        val src = "{ fan: { name: 'Bob', ~*': crew' }, x: *'pets[1]' }"
        assertEquals(": crew", Pointers.json5pPointerAt(src, src.indexOf(": crew") + 2))
        assertEquals("pets[1]", Pointers.json5pPointerAt(src, src.indexOf("pets[1]") + 3))
        assertNull("a plain string is not a pointer", Pointers.json5pPointerAt(src, src.indexOf("Bob")))
    }

    // ---- yamlover index -----------------------------------------------------

    private val Y = """
        pets:
          - name: Rex
            species: dog
          - name: Whiskers
        humans:
          - name: Alice
            manager: *: pets[1]
        boss: &chief
          name: Rex
        markup:
        - a
        - b
        other: 9
        fan:
          name: Bob
          ~- *: markup
    """.trimIndent() + "\n"

    private fun yOffsetOfLine(s: String) = Y.indexOf(s).also { check(it >= 0) }.let { Y.lastIndexOf('\n', it) + 1 }

    @Test
    fun `yamlover document scope, nesting, positions`() {
        val ix = PathIndex.ofYamlover(Y)
        assertEquals(yOffsetOfLine("- name: Whiskers"), ix.resolve(Pointers.parse(": pets[1]")!!, 0))
        assertEquals(yOffsetOfLine("species: dog"), ix.resolve(Pointers.parse(": pets[0]: species")!!, 0))
        assertEquals(yOffsetOfLine("other: 9"), ix.resolve(Pointers.parse(": other")!!, 0))
        // same-indent sequence under its key
        assertEquals(yOffsetOfLine("- b"), ix.resolve(Pointers.parse(": markup[1]")!!, 0))
    }

    @Test
    fun `yamlover current scope and parents resolve from the caret's container`() {
        val ix = PathIndex.ofYamlover(Y)
        val fromManager = Y.indexOf("manager:")
        assertEquals("a sibling key", yOffsetOfLine("- name: Alice"), ix.resolve(Pointers.parse("name")!!, fromManager))
        assertEquals("up and over", yOffsetOfLine("- name: Whiskers"), ix.resolve(Pointers.parse("..: ..: pets[1]")!!, fromManager))
    }

    @Test
    fun `yamlover has no anchor namespace and ~- entries take no position`() {
        val ix = PathIndex.ofYamlover(Y)
        // `boss: &chief` opens boss as a container (the anchor takes the value slot); the anchor
        // NAME is not a resolvable target — there is no anchor namespace (resolve.ts §no-precedence)
        val bossName = Y.indexOf("name: Rex", Y.indexOf("boss:")) // the boss one, not pets[0]'s
        assertEquals(Y.lastIndexOf('\n', bossName) + 1, ix.resolve(Pointers.parse(": boss: name")!!, 0))
        assertNull("the anchor name does not resolve as a current-scope key", ix.resolve(Pointers.parse("chief")!!, Y.indexOf("fan:")))
        // fan has one owned entry (name) and a ~- declaration; the back-edge is not indexed
        assertEquals(yOffsetOfLine("name: Bob"), ix.resolve(Pointers.parse(": fan[0]")!!, 0))
        assertNull(ix.resolve(Pointers.parse(": fan[1]")!!, 0))
    }

    // ---- keyed omni (`world: World` + a deeper body — the 517a7a4 shape) ----

    private val O = "world: World\n  eurasia: Eurasia\n    europe: Europe\nother: 9\n"

    @Test
    fun `a keyed omni's scalar self-value is positionless and its deeper body is indexed`() {
        val ix = PathIndex.ofYamlover(O)
        val lineOf = { s: String -> O.indexOf(s).let { O.lastIndexOf('\n', it) + 1 } }
        assertEquals(lineOf("world: World"), ix.resolve(Pointers.parse(": world")!!, 0))
        assertEquals(lineOf("eurasia: Eurasia"), ix.resolve(Pointers.parse(": world: eurasia")!!, 0))
        assertEquals(lineOf("europe: Europe"), ix.resolve(Pointers.parse(": world: eurasia: europe")!!, 0))
        // the self-value took no position — children index from [0]
        assertEquals(lineOf("eurasia: Eurasia"), ix.resolve(Pointers.parse(": world[0]")!!, 0))
        assertEquals(lineOf("other: 9"), ix.resolve(Pointers.parse(": other")!!, 0))
    }

    // ---- yamlover chapter shape (omni self-values) --------------------------

    private val C = """
        !!<*yamlover: ${'$'}defs: chapter>
        "The Title: with a colon"
        description: sub
        - first chunk
        - Sub title
          - sub chunk one
          - sub chunk two
        - - untitled head chunk
          - second chunk
        - Task like
          status: open
        - |
          note: not an entry
    """.trimIndent() + "\n"

    private fun cOffsetOfLine(s: String) = C.indexOf(s).also { check(it >= 0) }.let { C.lastIndexOf('\n', it) + 1 }

    @Test
    fun `chapter tag line and self-values take no position, item bodies are indexed`() {
        val ix = PathIndex.ofYamlover(C)
        // the tag line and the title (the node's self-value) consume no index
        assertEquals(cOffsetOfLine("description: sub"), ix.resolve(Pointers.parse(": [0]")!!, 0))
        assertEquals(cOffsetOfLine("- first chunk"), ix.resolve(Pointers.parse(": [1]")!!, 0))
        // a titled subchapter: a plain-scalar head is its self-value, the deeper block its body
        assertEquals(cOffsetOfLine("- Sub title"), ix.resolve(Pointers.parse(": [2]")!!, 0))
        assertEquals(cOffsetOfLine("- sub chunk one"), ix.resolve(Pointers.parse(": [2][0]")!!, 0))
        assertEquals(cOffsetOfLine("- sub chunk two"), ix.resolve(Pointers.parse(": [2][1]")!!, 0))
        // compact untitled container: the inline head is the item's first child
        assertEquals(cOffsetOfLine("- - untitled head chunk"), ix.resolve(Pointers.parse(": [3][0]")!!, 0))
        assertEquals(cOffsetOfLine("- second chunk"), ix.resolve(Pointers.parse(": [3][1]")!!, 0))
        // keyed children of a titled item resolve, and still occupy positions
        assertEquals(cOffsetOfLine("status: open"), ix.resolve(Pointers.parse(": [4]: status")!!, 0))
        assertEquals(cOffsetOfLine("status: open"), ix.resolve(Pointers.parse(": [4][0]")!!, 0))
        // block-scalar content stays un-indexed (no phantom `note` entry)
        assertNull(ix.resolve(Pointers.parse(": [5][0]")!!, 0))
        assertNull(ix.resolve(Pointers.parse(": [5]: note")!!, 0))
    }

    // ---- json5p index -------------------------------------------------------

    private val J = """
        {
          pets: [ { name: 'Rex' }, { name: 'Whiskers' } ],
          humans: [ { name: 'Alice', manager: *': pets[1]' } ],
          boss: &chief { name: 'Rex' },
          fan: { name: 'Bob', ~*': pets' },
        }
    """.trimIndent()

    @Test
    fun `json5p nesting, positions, no anchor namespace, back members`() {
        val ix = PathIndex.ofJson5p(J)
        assertEquals(J.indexOf("{ name: 'Whiskers' }"), ix.resolve(Pointers.parse(": pets[1]")!!, 0))
        assertEquals(J.indexOf("'Alice'") - "name: ".length, ix.resolve(Pointers.parse(": humans[0]: name")!!, 0))
        // the anchor takes the value slot; `boss` resolves by key, the anchor NAME does not resolve
        assertEquals(J.indexOf("name: 'Rex' }", J.indexOf("boss")), ix.resolve(Pointers.parse(": boss: name")!!, 0))
        assertNull("no anchor namespace", ix.resolve(Pointers.parse("chief")!!, J.indexOf("fan:")))
        // current scope from inside humans[0]
        val fromManager = J.indexOf("manager")
        assertEquals(J.indexOf("'Alice'") - "name: ".length, ix.resolve(Pointers.parse("name")!!, fromManager))
        // the ~* back member takes no position: fan[0] is `name`, fan[1] does not exist
        assertEquals(J.indexOf("'Bob'") - "name: ".length, ix.resolve(Pointers.parse(": fan[0]")!!, 0))
        assertNull(ix.resolve(Pointers.parse(": fan[1]")!!, 0))
    }
}

class SpacedPointerTest {
    @Test
    fun `a block pointer runs to EOL keeping the interior colon spacing`() {
        val src = "manager: *: humans[0]: name\nnext: 1\n"
        val mid = src.indexOf("humans") + 3
        assertEquals(": humans[0]: name", Pointers.yamloverPointerAt(src, mid))
        // and it parses through the spaced `: ` styling to document scope + steps
        val expr = Pointers.parse(": humans[0]: name")!!
        assertEquals(Scope.Document, expr.scope)
        assertEquals(listOf(Step.Key("humans"), Step.Index(0), Step.Key("name")), expr.steps)
    }

    @Test
    fun `a comment ends the path and flow pointers still end at space or comma`() {
        val src = "x: *: a: b # trailing\n"
        assertEquals(": a: b", Pointers.yamloverPointerAt(src, src.indexOf("a:")))
        val flow = "m: {a: *one two, b: 2}\n"
        assertEquals("one", Pointers.yamloverPointerAt(flow, flow.indexOf("one") + 1))
    }
}
