package net.inthemoon.yamlover

import com.intellij.testFramework.fixtures.BasePlatformTestCase
import org.junit.Assert.assertEquals
import org.junit.Test

/** The pure indent logic (YamloverIndent) — what column the line under the caret gets right
 *  after Enter. Driven without the IDE; the wiring is covered by {@link EnterIndentTest}. */
class LineIndentTest {

    /** Enter just typed at the very end of `text` — the caret sits on the fresh last line. */
    private fun indent(text: String, indentSize: Int = 2): Int? =
        YamloverIndent.indentAfterEnter(text, text.length, indentSize)

    @Test
    fun `a dash-headed block scalar opens its body at the dash's content column`() {
        assertEquals(2, indent("- >\n"))
        assertEquals(4, indent("  - >\n"))
        assertEquals(2, indent("- |\n"))
        assertEquals(2, indent("- >-\n"))
        assertEquals(2, indent("- |2+\n"))
        // a decoration tag between the dash and the indicator changes nothing
        assertEquals(2, indent("- !!<format: text/plain> |\n"))
        // compact `- - >`: the body must clear the INNER item
        assertEquals(4, indent("- - >\n"))
    }

    @Test
    fun `a keyed block scalar opens its body one step under the key`() {
        assertEquals(2, indent("key: |\n"))
        assertEquals(4, indent("  note: >\n"))
        assertEquals(4, indent("- key: >\n"))
        assertEquals(2, indent("key: !!yo |\n"))
        // a bare header at the entry column still needs a deeper body
        assertEquals(2, indent(">\n"))
    }

    @Test
    fun `inside a block scalar body the indent is kept`() {
        assertEquals(2, indent("- >\n  prose line.\n"))
        assertEquals(4, indent("key: |\n    deep body\n"))
        // blank body lines are skipped back to real content (or the header)
        assertEquals(2, indent("- >\n  prose\n\n"))
        assertEquals(2, indent("- >\n\n"))
    }

    @Test
    fun `a body line ending with a colon is prose, not a key`() {
        assertEquals(2, indent("- >\n  the following:\n"))
        // and a `- >` INSIDE a body is content too, not a new header
        assertEquals(2, indent("key: |\n  - >\n"))
    }

    @Test
    fun `an empty-valued key opens its block one step deeper`() {
        assertEquals(2, indent("pets:\n"))
        assertEquals(4, indent("  pets:\n"))
        assertEquals(4, indent("- pets:\n"))
        // a flat row's trailing `-:` opens the new element's block one step under the row
        assertEquals(2, indent("a: pets: -:\n"))
    }

    @Test
    fun `a dedent line after a body is structural again`() {
        assertEquals(2, indent("- >\n  prose\nkey:\n"))
        assertEquals(0, indent("- >\n  prose\nkey: value\n"))
    }

    @Test
    fun `plain entries and pointer lines keep their indent`() {
        assertEquals(0, indent("key: value\n"))
        assertEquals(2, indent("  - name: Feline\n"))
        assertEquals(0, indent("- *: language\n"))
        // a pointer run ending in `:` is a complete value, not a key opening a block
        assertEquals(0, indent("feline: *:\n"))
        // a trailing comment does not hide the structure
        assertEquals(2, indent("pets: # the herd\n"))
    }

    @Test
    fun `a lone dash opens the item's block under it`() {
        assertEquals(2, indent("-\n"))
        assertEquals(4, indent("  -\n"))
    }

    @Test
    fun `the first line has no opinion`() {
        assertEquals(null, indent(""))
        assertEquals(null, YamloverIndent.indentAfterEnter("abc", 1, 2))
    }
}

/** End-to-end wiring: the lineIndentProvider is what Enter actually consults. */
class EnterIndentTest : BasePlatformTestCase() {

    private fun enter(before: String, after: String) {
        myFixture.configureByText("sample.yo", before)
        myFixture.performEditorAction("EditorEnter")
        myFixture.checkResult(after)
    }

    fun testEnterAfterFoldedHeaderIndentsTheBody() =
        enter("- ><caret>\n", "- >\n  <caret>\n")

    fun testEnterAfterKeyedLiteralHeaderIndentsTheBody() =
        enter("note: |<caret>\n", "note: |\n  <caret>\n")

    fun testEnterInsideTheBodyKeepsItsIndent() =
        enter("- >\n  prose line.<caret>\n", "- >\n  prose line.\n  <caret>\n")

    fun testEnterAfterAnEmptyValuedKeyIndentsOneStep() =
        enter("pets:<caret>\n", "pets:\n  <caret>\n")

    fun testEnterAfterAPlainEntryKeepsTheIndent() =
        enter("  - name: Feline<caret>\n", "  - name: Feline\n  <caret>\n")
}
