package net.inthemoon.yamlover

import com.intellij.psi.tree.IElementType

class Json5pTokenType(debugName: String) : IElementType(debugName, Json5pLanguage)

object Json5pTokenTypes {
    @JvmField val COMMENT = Json5pTokenType("JSON5P_COMMENT")   // // … and /* … */
    @JvmField val POINTER = Json5pTokenType("JSON5P_POINTER")   // * & ~
    @JvmField val KEY     = Json5pTokenType("JSON5P_KEY")
    @JvmField val STRING  = Json5pTokenType("JSON5P_STRING")
    @JvmField val NUMBER  = Json5pTokenType("JSON5P_NUMBER")
    @JvmField val KEYWORD = Json5pTokenType("JSON5P_KEYWORD")   // true/false/null/Infinity/NaN
    @JvmField val PUNCT   = Json5pTokenType("JSON5P_PUNCT")
    @JvmField val SCALAR  = Json5pTokenType("JSON5P_SCALAR")
}
