package net.inthemoon.yamlover

import com.intellij.application.options.IndentOptionsEditor
import com.intellij.application.options.SmartIndentOptionsEditor
import com.intellij.lang.Language
import com.intellij.psi.codeStyle.CommonCodeStyleSettings
import com.intellij.psi.codeStyle.LanguageCodeStyleSettingsProvider

/**
 * Indent options for yamlover. Without a per-language provider the IDE resolves a `.yo`
 * file to the catch-all "Other" indent options (4 columns, tab character per the user's
 * global setting), so Tab / Shift+Tab / Enter indent by the wrong step — and a literal tab
 * is not even legal indentation in the YAML layer. Two spaces, spaces only, like YAML.
 */
class YamloverCodeStyleSettingsProvider : LanguageCodeStyleSettingsProvider() {
    override fun getLanguage(): Language = YamloverLanguage

    override fun customizeDefaults(
        commonSettings: CommonCodeStyleSettings,
        indentOptions: CommonCodeStyleSettings.IndentOptions,
    ) {
        indentOptions.INDENT_SIZE = 2
        indentOptions.CONTINUATION_INDENT_SIZE = 2
        indentOptions.TAB_SIZE = 2
        indentOptions.USE_TAB_CHARACTER = false
        indentOptions.SMART_TABS = false
    }

    override fun getIndentOptionsEditor(): IndentOptionsEditor = SmartIndentOptionsEditor(this)

    override fun getCodeSample(settingsType: SettingsType): String = SAMPLE

    private companion object {
        const val SAMPLE = """# yamlover
world: World
pets:
  - name: Feline
    kind: cat
  - name: Rex
    kind: dog
feline: *: pets: 0
"""
    }
}

/** Same story for json5p — JSON-style two-space indentation. */
class Json5pCodeStyleSettingsProvider : LanguageCodeStyleSettingsProvider() {
    override fun getLanguage(): Language = Json5pLanguage

    override fun customizeDefaults(
        commonSettings: CommonCodeStyleSettings,
        indentOptions: CommonCodeStyleSettings.IndentOptions,
    ) {
        indentOptions.INDENT_SIZE = 2
        indentOptions.CONTINUATION_INDENT_SIZE = 2
        indentOptions.TAB_SIZE = 2
        indentOptions.USE_TAB_CHARACTER = false
        indentOptions.SMART_TABS = false
    }

    override fun getIndentOptionsEditor(): IndentOptionsEditor = SmartIndentOptionsEditor(this)

    override fun getCodeSample(settingsType: SettingsType): String = SAMPLE

    private companion object {
        const val SAMPLE = """{
  world: "World",
  pets: [
    { name: "Feline", kind: "cat" },
    { name: "Rex", kind: "dog" },
  ],
  feline: *: pets: 0,
}
"""
    }
}
