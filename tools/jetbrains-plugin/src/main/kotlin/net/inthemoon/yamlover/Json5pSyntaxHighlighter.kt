package net.inthemoon.yamlover

import com.intellij.lexer.Lexer
import com.intellij.openapi.editor.DefaultLanguageHighlighterColors
import com.intellij.openapi.editor.colors.TextAttributesKey
import com.intellij.openapi.fileTypes.SyntaxHighlighterBase
import com.intellij.psi.tree.IElementType

class Json5pSyntaxHighlighter : SyntaxHighlighterBase() {
    override fun getHighlightingLexer(): Lexer = Json5pLexer()

    override fun getTokenHighlights(tokenType: IElementType): Array<TextAttributesKey> =
        when (tokenType) {
            Json5pTokenTypes.COMMENT -> COMMENT_KEYS
            // sigils `* & ~` share the same "sign" color as punctuation (`: , { } [ ]`)
            Json5pTokenTypes.POINTER -> SIGN_KEYS
            Json5pTokenTypes.PUNCT -> SIGN_KEYS
            Json5pTokenTypes.INDEX -> SIGN_KEYS
            Json5pTokenTypes.DASH -> DASH_KEYS
            // the pointer's (quoted) path/target — a distinct color from the sigil
            Json5pTokenTypes.REF -> REF_KEYS
            Json5pTokenTypes.TAG -> TAG_KEYS
            Json5pTokenTypes.KEY -> KEY_KEYS
            Json5pTokenTypes.STRING -> STRING_KEYS
            Json5pTokenTypes.NUMBER -> NUMBER_KEYS
            Json5pTokenTypes.KEYWORD -> KEYWORD_KEYS
            Json5pTokenTypes.NULL -> NULL_KEYS
            else -> EMPTY
        }

    companion object {
        private fun keys(name: String, fallback: TextAttributesKey) =
            arrayOf(TextAttributesKey.createTextAttributesKey(name, fallback))

        val COMMENT_KEYS = keys("JSON5P_COMMENT", DefaultLanguageHighlighterColors.LINE_COMMENT)
        val SIGN_KEYS = keys("JSON5P_SIGN", DefaultLanguageHighlighterColors.OPERATION_SIGN)
        val REF_KEYS = keys("JSON5P_REF", DefaultLanguageHighlighterColors.METADATA)
        val TAG_KEYS = keys("JSON5P_TAG", DefaultLanguageHighlighterColors.MARKUP_TAG)
        val KEY_KEYS = keys("JSON5P_KEY", DefaultLanguageHighlighterColors.INSTANCE_FIELD)
        val STRING_KEYS = keys("JSON5P_STRING", DefaultLanguageHighlighterColors.STRING)
        val NUMBER_KEYS = keys("JSON5P_NUMBER", DefaultLanguageHighlighterColors.NUMBER)
        val KEYWORD_KEYS = keys("JSON5P_KEYWORD", DefaultLanguageHighlighterColors.KEYWORD)
        // null/~ — keyword-colored by default but its own key (the web's dedicated `null` class)
        val NULL_KEYS = keys("JSON5P_NULL", DefaultLanguageHighlighterColors.KEYWORD)
        // the sequence marker `- ` — sign-colored by default but its own key
        val DASH_KEYS = keys("JSON5P_DASH", DefaultLanguageHighlighterColors.OPERATION_SIGN)
        val EMPTY = emptyArray<TextAttributesKey>()
    }
}
