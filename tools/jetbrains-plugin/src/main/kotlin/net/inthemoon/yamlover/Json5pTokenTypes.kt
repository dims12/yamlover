package net.inthemoon.yamlover

import com.intellij.psi.tree.IElementType

class Json5pTokenType(debugName: String) : IElementType(debugName, Json5pLanguage)

object Json5pTokenTypes {
    @JvmField val COMMENT = Json5pTokenType("JSON5P_COMMENT")   // // … and /* … */
    @JvmField val POINTER = Json5pTokenType("JSON5P_POINTER")   // the sigil char * & ~
    @JvmField val REF     = Json5pTokenType("JSON5P_REF")       // a pointer's (quoted) path after * &
    @JvmField val TAG     = Json5pTokenType("JSON5P_TAG")       // a schema tag !!<…> / !!word
    @JvmField val KEY     = Json5pTokenType("JSON5P_KEY")
    @JvmField val STRING  = Json5pTokenType("JSON5P_STRING")
    @JvmField val NUMBER  = Json5pTokenType("JSON5P_NUMBER")    // incl. hex and Infinity
    @JvmField val KEYWORD = Json5pTokenType("JSON5P_KEYWORD")   // true/false
    @JvmField val NULL    = Json5pTokenType("JSON5P_NULL")      // null/~ — its own kind
    @JvmField val INDEX   = Json5pTokenType("JSON5P_INDEX")     // [n]
    @JvmField val PUNCT   = Json5pTokenType("JSON5P_PUNCT")
    @JvmField val DASH    = Json5pTokenType("JSON5P_DASH")      // the sequence marker `- `
    @JvmField val SCALAR  = Json5pTokenType("JSON5P_SCALAR")
}
