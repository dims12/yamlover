package net.inthemoon.yamlover

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The heuristic Ctrl+click resolution: pointer-at-caret extraction, path parsing, and the
 *  per-language path indexes — pure logic, driven without the IDE. */
class PointerNavigationTest {

    // ---- pointer parsing ----------------------------------------------------

    @Test
    fun `parse scopes, steps and escapes`() {
        assertEquals(PointerExpr(false, listOf(Step.Key("pets"), Step.Index(1))), Pointers.parse("pets[1]"))
        assertEquals(PointerExpr(true, listOf(Step.Key("a"), Step.Key("b"))), Pointers.parse("/a/b"))
        assertEquals(PointerExpr(false, listOf(Step.Parent, Step.Key("x"))), Pointers.parse("../x"))
        assertEquals(PointerExpr(false, listOf(Step.Key("cat/dog"), Step.Key("n"))), Pointers.parse("cat\\/dog/n"))
        assertNull("a link is out of scope", Pointers.parse("//my.project/config"))
        assertNull("a scheme link is out of scope", Pointers.parse("https://pet.store.com/pets"))
    }

    @Test
    fun `pointer text under the caret (yamlover, unquoted)`() {
        val src = "feline: */pets[1]\n"
        val inside = src.indexOf("pets") + 2
        assertEquals("/pets[1]", Pointers.yamloverPointerAt(src, inside))
        assertNull("a key is not a pointer", Pointers.yamloverPointerAt(src, 2))
    }

    @Test
    fun `pointer text under the caret (json5p, quoted incl back member)`() {
        val src = "{ fan: { name: 'Bob', ~*'/crew' }, x: *'pets[1]' }"
        assertEquals("/crew", Pointers.json5pPointerAt(src, src.indexOf("/crew") + 2))
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
            manager: */pets[1]
        boss: &chief
          name: Rex
        markup:
        - a
        - b
        other: 9
        fan:
          name: Bob
          ~- */markup
    """.trimIndent() + "\n"

    private fun yOffsetOfLine(s: String) = Y.indexOf(s).also { check(it >= 0) }.let { Y.lastIndexOf('\n', it) + 1 }

    @Test
    fun `yamlover document scope, nesting, positions`() {
        val ix = PathIndex.ofYamlover(Y)
        assertEquals(yOffsetOfLine("- name: Whiskers"), ix.resolve(Pointers.parse("/pets[1]")!!, 0))
        assertEquals(yOffsetOfLine("species: dog"), ix.resolve(Pointers.parse("/pets[0]/species")!!, 0))
        assertEquals(yOffsetOfLine("other: 9"), ix.resolve(Pointers.parse("/other")!!, 0))
        // same-indent sequence under its key
        assertEquals(yOffsetOfLine("- b"), ix.resolve(Pointers.parse("/markup[1]")!!, 0))
    }

    @Test
    fun `yamlover current scope and parents resolve from the caret's container`() {
        val ix = PathIndex.ofYamlover(Y)
        val fromManager = Y.indexOf("manager:")
        assertEquals("a sibling key", yOffsetOfLine("- name: Alice"), ix.resolve(Pointers.parse("name")!!, fromManager))
        assertEquals("up and over", yOffsetOfLine("- name: Whiskers"), ix.resolve(Pointers.parse("../../pets[1]")!!, fromManager))
    }

    @Test
    fun `yamlover anchor wins over a sibling key and ~- entries take no position`() {
        val ix = PathIndex.ofYamlover(Y)
        assertEquals("&chief declaration", yOffsetOfLine("boss: &chief"), ix.resolve(Pointers.parse("chief")!!, Y.indexOf("fan:")))
        // fan has one owned entry (name) and a ~- declaration; the back-edge is not indexed
        assertEquals(yOffsetOfLine("name: Bob"), ix.resolve(Pointers.parse("/fan[0]")!!, 0))
        assertNull(ix.resolve(Pointers.parse("/fan[1]")!!, 0))
    }

    // ---- json5p index -------------------------------------------------------

    private val J = """
        {
          pets: [ { name: 'Rex' }, { name: 'Whiskers' } ],
          humans: [ { name: 'Alice', manager: *'/pets[1]' } ],
          boss: &chief { name: 'Rex' },
          fan: { name: 'Bob', ~*'/pets' },
        }
    """.trimIndent()

    @Test
    fun `json5p nesting, positions, anchors, back members`() {
        val ix = PathIndex.ofJson5p(J)
        assertEquals(J.indexOf("{ name: 'Whiskers' }"), ix.resolve(Pointers.parse("/pets[1]")!!, 0))
        assertEquals(J.indexOf("'Alice'") - "name: ".length, ix.resolve(Pointers.parse("/humans[0]/name")!!, 0))
        assertEquals("anchor wins", J.indexOf("chief"), ix.resolve(Pointers.parse("chief")!!, J.indexOf("fan:")))
        // current scope from inside humans[0]
        val fromManager = J.indexOf("manager")
        assertEquals(J.indexOf("'Alice'") - "name: ".length, ix.resolve(Pointers.parse("name")!!, fromManager))
        // the ~* back member takes no position: fan[0] is `name`, fan[1] does not exist
        assertEquals(J.indexOf("'Bob'") - "name: ".length, ix.resolve(Pointers.parse("/fan[0]")!!, 0))
        assertNull(ix.resolve(Pointers.parse("/fan[1]")!!, 0))
    }
}
