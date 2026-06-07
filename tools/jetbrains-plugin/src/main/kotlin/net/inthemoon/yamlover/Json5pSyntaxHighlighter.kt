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
            Json5pTokenTypes.KEY -> KEY_KEYS
            Json5pTokenTypes.STRING -> STRING_KEYS
            Json5pTokenTypes.NUMBER -> NUMBER_KEYS
            Json5pTokenTypes.KEYWORD -> KEYWORD_KEYS
            else -> EMPTY
        }

    companion object {
        private fun keys(name: String, fallback: TextAttributesKey) =
            arrayOf(TextAttributesKey.createTextAttributesKey(name, fallback))

        val COMMENT_KEYS = keys("JSON5P_COMMENT", DefaultLanguageHighlighterColors.LINE_COMMENT)
        val SIGN_KEYS = keys("JSON5P_SIGN", DefaultLanguageHighlighterColors.OPERATION_SIGN)
        val KEY_KEYS = keys("JSON5P_KEY", DefaultLanguageHighlighterColors.INSTANCE_FIELD)
        val STRING_KEYS = keys("JSON5P_STRING", DefaultLanguageHighlighterColors.STRING)
        val NUMBER_KEYS = keys("JSON5P_NUMBER", DefaultLanguageHighlighterColors.NUMBER)
        val KEYWORD_KEYS = keys("JSON5P_KEYWORD", DefaultLanguageHighlighterColors.KEYWORD)
        val EMPTY = emptyArray<TextAttributesKey>()
    }
}
