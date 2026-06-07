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

/** Minimal ParserDefinition for json5p (see YamloverParserDefinition for the rationale). */
class Json5pParserDefinition : ParserDefinition {
    override fun createLexer(project: Project?): Lexer = Json5pLexer()
    override fun createParser(project: Project?): PsiParser = FlatParser()
    override fun getFileNodeType(): IFileElementType = FILE
    override fun getCommentTokens(): TokenSet = COMMENTS
    override fun getStringLiteralElements(): TokenSet = STRINGS
    override fun createElement(node: ASTNode): PsiElement = ASTWrapperPsiElement(node)
    override fun createFile(viewProvider: FileViewProvider): PsiFile = Json5pPsiFile(viewProvider)

    private class FlatParser : PsiParser {
        override fun parse(root: IElementType, builder: PsiBuilder): ASTNode {
            val mark = builder.mark()
            while (!builder.eof()) builder.advanceLexer()
            mark.done(root)
            return builder.treeBuilt
        }
    }

    companion object {
        val FILE = IFileElementType(Json5pLanguage)
        private val COMMENTS = TokenSet.create(Json5pTokenTypes.COMMENT)
        private val STRINGS = TokenSet.create(Json5pTokenTypes.STRING)
    }
}

class Json5pPsiFile(viewProvider: FileViewProvider) : PsiFileBase(viewProvider, Json5pLanguage) {
    override fun getFileType() = Json5pFileType
}
