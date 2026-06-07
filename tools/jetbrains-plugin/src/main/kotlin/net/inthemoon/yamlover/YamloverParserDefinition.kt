package net.inthemoon.yamlover

import com.intellij.extapi.psi.ASTWrapperPsiElement
import com.intellij.extapi.psi.PsiFileBase
import com.intellij.lang.ASTNode
import com.intellij.lang.ParserDefinition
import com.intellij.lang.PsiBuilder
import com.intellij.lang.PsiParser
import com.intellij.lexer.Lexer
import com.intellij.openapi.project.Project
import com.intellij.psi.FileViewProvider
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.psi.tree.IElementType
import com.intellij.psi.tree.IFileElementType
import com.intellij.psi.tree.TokenSet

/**
 * Minimal ParserDefinition — required for a `.yamlover` file to be recognized as the
 * yamlover *language* (without it the file's PSI language falls back to TEXT and the
 * lexer-based syntax highlighter never engages). The parser is intentionally flat (all
 * tokens under one file node); a real PSI grammar is Phase J2.
 */
class YamloverParserDefinition : ParserDefinition {
    override fun createLexer(project: Project?): Lexer = YamloverLexer()
    override fun createParser(project: Project?): PsiParser = FlatParser()
    override fun getFileNodeType(): IFileElementType = FILE
    override fun getCommentTokens(): TokenSet = COMMENTS
    override fun getStringLiteralElements(): TokenSet = STRINGS
    override fun createElement(node: ASTNode): PsiElement = ASTWrapperPsiElement(node)
    override fun createFile(viewProvider: FileViewProvider): PsiFile = YamloverPsiFile(viewProvider)

    private class FlatParser : PsiParser {
        override fun parse(root: IElementType, builder: PsiBuilder): ASTNode {
            val mark = builder.mark()
            while (!builder.eof()) builder.advanceLexer()
            mark.done(root)
            return builder.treeBuilt
        }
    }

    companion object {
        val FILE = IFileElementType(YamloverLanguage)
        private val COMMENTS = TokenSet.create(YamloverTokenTypes.COMMENT)
        private val STRINGS = TokenSet.create(YamloverTokenTypes.STRING)
    }
}

class YamloverPsiFile(viewProvider: FileViewProvider) : PsiFileBase(viewProvider, YamloverLanguage) {
    override fun getFileType() = YamloverFileType
}
