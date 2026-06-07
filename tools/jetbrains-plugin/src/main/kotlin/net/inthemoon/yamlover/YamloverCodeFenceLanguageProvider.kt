package net.inthemoon.yamlover

import com.intellij.codeInsight.completion.CompletionParameters
import com.intellij.codeInsight.lookup.LookupElement
import com.intellij.codeInsight.lookup.LookupElementBuilder
import com.intellij.lang.Language
import org.intellij.plugins.markdown.injection.CodeFenceLanguageProvider

/**
 * Highlights ` ```yamlover ` and ` ```json5p ` fenced code blocks inside Markdown by
 * mapping the fence info string to our languages.
 *
 * NOTE: the Markdown plugin's API has shifted across IDE versions — this targets the
 * `org.intellij.plugins.markdown.injection.CodeFenceLanguageProvider` interface and
 * the `org.intellij.markdown.fenceLanguageProvider` extension point. If it fails to
 * resolve against your target IDE, adjust the import/EP to match that version.
 * (As a fallback, IntelliJ already injects a language whose ID equals the info string,
 * so `yamlover`/`json5p` fences may highlight even without this provider.)
 */
class YamloverCodeFenceLanguageProvider : CodeFenceLanguageProvider {
    override fun getLanguageByInfoString(infoString: String): Language? =
        when (infoString.trim().lowercase()) {
            "yamlover" -> YamloverLanguage
            "json5p", "json5+" -> Json5pLanguage
            else -> null
        }

    override fun getCompletionVariantsForInfoString(parameters: CompletionParameters): List<LookupElement> =
        listOf(
            LookupElementBuilder.create("yamlover").withIcon(YamloverIcons.FILE),
            LookupElementBuilder.create("json5p").withIcon(YamloverIcons.JSON5P),
        )
}
