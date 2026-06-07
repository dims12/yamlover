package net.inthemoon.yamlover

import com.intellij.psi.tree.IElementType

class YamloverTokenType(debugName: String) : IElementType(debugName, YamloverLanguage)

object YamloverTokenTypes {
    @JvmField val COMMENT = YamloverTokenType("YAMLOVER_COMMENT")
    @JvmField val POINTER = YamloverTokenType("YAMLOVER_POINTER")   // the sigil char * & ~
    @JvmField val REF     = YamloverTokenType("YAMLOVER_REF")       // a pointer's path/target after * &
    @JvmField val TAG     = YamloverTokenType("YAMLOVER_TAG")       // a schema tag !!<…>
    @JvmField val KEY     = YamloverTokenType("YAMLOVER_KEY")       // name before ':'
    @JvmField val STRING  = YamloverTokenType("YAMLOVER_STRING")
    @JvmField val NUMBER  = YamloverTokenType("YAMLOVER_NUMBER")
    @JvmField val KEYWORD = YamloverTokenType("YAMLOVER_KEYWORD")   // true/false/null/~
    @JvmField val INDEX   = YamloverTokenType("YAMLOVER_INDEX")     // [n]
    @JvmField val PUNCT   = YamloverTokenType("YAMLOVER_PUNCT")
    @JvmField val SCALAR  = YamloverTokenType("YAMLOVER_SCALAR")
}
