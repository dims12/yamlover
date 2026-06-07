package net.inthemoon.yamlover

import com.intellij.openapi.fileTypes.LanguageFileType
import javax.swing.Icon

object Json5pFileType : LanguageFileType(Json5pLanguage) {
    override fun getName(): String = "json5p"
    override fun getDescription(): String = "json5p (JSON5 + pointers)"
    override fun getDefaultExtension(): String = "json5p"
    override fun getIcon(): Icon = YamloverIcons.JSON5P
}
