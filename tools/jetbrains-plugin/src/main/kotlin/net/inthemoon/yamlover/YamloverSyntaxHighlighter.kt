package net.inthemoon.yamlover

import com.intellij.lexer.Lexer
import com.intellij.openapi.editor.DefaultLanguageHighlighterColors
import com.intellij.openapi.editor.colors.TextAttributesKey
import com.intellij.openapi.fileTypes.SyntaxHighlighterBase
import com.intellij.psi.tree.IElementType

class YamloverSyntaxHighlighter : SyntaxHighlighterBase() {
    override fun getHighlightingLexer(): Lexer = YamloverLexer()

    override fun getTokenHighlights(tokenType: IElementType): Array<TextAttributesKey> =
        when (tokenType) {
            YamloverTokenTypes.COMMENT -> COMMENT_KEYS
            // sigils `* ~ &` share the SAME "sign" color as the structural punctuation
            // (`: - , { } [ ]`), like YAML's `-`/`:` — not a loud keyword color.
            YamloverTokenTypes.POINTER -> SIGN_KEYS
            YamloverTokenTypes.PUNCT -> SIGN_KEYS
            YamloverTokenTypes.INDEX -> SIGN_KEYS
            // the pointer's path/target — a distinct color from the sigil (cf. YAML alias)
            YamloverTokenTypes.REF -> REF_KEYS
            YamloverTokenTypes.KEY -> KEY_KEYS
            YamloverTokenTypes.STRING -> STRING_KEYS
            YamloverTokenTypes.NUMBER -> NUMBER_KEYS
            YamloverTokenTypes.KEYWORD -> KEYWORD_KEYS
            else -> EMPTY
        }

    companion object {
        private fun keys(name: String, fallback: TextAttributesKey) =
            arrayOf(TextAttributesKey.createTextAttributesKey(name, fallback))

        val COMMENT_KEYS = keys("YAMLOVER_COMMENT", DefaultLanguageHighlighterColors.LINE_COMMENT)
        // shared "sign" color for sigils (* ~ &) AND structural punctuation (: - , { } [ ])
        val SIGN_KEYS = keys("YAMLOVER_SIGN", DefaultLanguageHighlighterColors.OPERATION_SIGN)
        val REF_KEYS = keys("YAMLOVER_REF", DefaultLanguageHighlighterColors.METADATA)
        val KEY_KEYS = keys("YAMLOVER_KEY", DefaultLanguageHighlighterColors.INSTANCE_FIELD)
        val STRING_KEYS = keys("YAMLOVER_STRING", DefaultLanguageHighlighterColors.STRING)
        val NUMBER_KEYS = keys("YAMLOVER_NUMBER", DefaultLanguageHighlighterColors.NUMBER)
        val KEYWORD_KEYS = keys("YAMLOVER_KEYWORD", DefaultLanguageHighlighterColors.KEYWORD)
        val INDEX_KEYS = keys("YAMLOVER_INDEX", DefaultLanguageHighlighterColors.NUMBER)
        val EMPTY = emptyArray<TextAttributesKey>()
    }
}
