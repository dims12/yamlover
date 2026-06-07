package net.inthemoon.yamlover

import com.intellij.openapi.fileTypes.SyntaxHighlighterFactory
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/** End-to-end wiring check: does the IDE actually resolve OUR highlighter for the yamlover
 *  language / file type, and color the POINTER token? (The lexer unit test bypasses this.) */
class YamloverHighlightWiringTest : BasePlatformTestCase() {

    fun testFactoryResolvesForLanguage() {
        val hl = SyntaxHighlighterFactory.getSyntaxHighlighter(YamloverLanguage, project, null)
        assertNotNull("no SyntaxHighlighter registered for YamloverLanguage", hl)
        assertTrue("wrong highlighter: ${hl?.javaClass?.name}", hl is YamloverSyntaxHighlighter)
    }

    fun testFactoryResolvesForFileType() {
        val hl = SyntaxHighlighterFactory.getSyntaxHighlighter(YamloverFileType, project, null)
        assertTrue("no/!our highlighter for YamloverFileType: ${hl?.javaClass?.name}", hl is YamloverSyntaxHighlighter)
    }

    fun testPointerTokenIsColored() {
        val hl = SyntaxHighlighterFactory.getSyntaxHighlighter(YamloverLanguage, project, null)!!
        assertTrue("POINTER has no text-attribute keys", hl.getTokenHighlights(YamloverTokenTypes.POINTER).isNotEmpty())
    }

    fun testFileOpensAsYamlover() {
        val f = myFixture.configureByText("sample.yamlover", "feline: */pets[1]\n")
        assertEquals("file not recognized as yamlover", YamloverLanguage, f.language)
        assertEquals(YamloverFileType, f.fileType)
    }
}
