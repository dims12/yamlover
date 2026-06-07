package net.inthemoon.yamlover

import com.intellij.openapi.fileTypes.LanguageFileType
import javax.swing.Icon

object YamloverFileType : LanguageFileType(YamloverLanguage) {
    override fun getName(): String = "yamlover"
    override fun getDescription(): String = "yamlover graph overlay"
    override fun getDefaultExtension(): String = "yamlover"
    override fun getIcon(): Icon = YamloverIcons.FILE
}
