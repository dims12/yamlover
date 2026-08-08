package net.inthemoon.yamlover

import com.intellij.application.options.CodeStyle
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/** The indent options the editor actually resolves for a `.yo` / `.json5p` file — this is what
 *  Tab, Shift+Tab and Enter use. Without our langCodeStyleSettingsProvider these fall back to
 *  the catch-all "Other" options (4 columns). */
class IndentOptionsTest : BasePlatformTestCase() {

    fun testYamloverIndentsTwoSpaces() {
        val file = myFixture.configureByText("sample.yo", "pets:\n  - name: Feline\n")
        val options = CodeStyle.getIndentOptions(file)
        assertEquals("yamlover indent size", 2, options.INDENT_SIZE)
        assertEquals("yamlover tab size", 2, options.TAB_SIZE)
        assertFalse("yamlover must indent with spaces", options.USE_TAB_CHARACTER)
    }

    fun testJson5pIndentsTwoSpaces() {
        val file = myFixture.configureByText("sample.json5p", "{\n  a: 1,\n}\n")
        val options = CodeStyle.getIndentOptions(file)
        assertEquals("json5p indent size", 2, options.INDENT_SIZE)
        assertFalse("json5p must indent with spaces", options.USE_TAB_CHARACTER)
    }

    fun testTabInsertsTwoSpaces() {
        myFixture.configureByText("sample.yo", "- aaa\n<caret>")
        myFixture.performEditorAction("EditorTab")
        myFixture.checkResult("- aaa\n  ")
    }
}
