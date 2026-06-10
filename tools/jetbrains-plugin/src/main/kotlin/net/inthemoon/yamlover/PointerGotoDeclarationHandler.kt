package net.inthemoon.yamlover

import com.intellij.codeInsight.navigation.actions.GotoDeclarationHandler
import com.intellij.openapi.editor.Editor
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiManager

/**
 * Ctrl+B / Ctrl+click on a `*pointer` in a yamlover / json5p file navigates to its target —
 * the v1 heuristic resolution (see PointerNavigation.kt): in-file paths, anchors, `..`,
 * `/` document scope, `[n]` positions. One cross-file case: in a `.yamlover/body.yamlover`
 * overlay, a document-scope segment that is not in the file falls back to the SIBLING
 * FILE/DIR of the overlaid directory (the overlay describes that directory's children).
 */
class PointerGotoDeclarationHandler : GotoDeclarationHandler {
    override fun getGotoDeclarationTargets(sourceElement: PsiElement?, offset: Int, editor: Editor?): Array<PsiElement>? {
        val file = sourceElement?.containingFile ?: return null
        val yam = file.language == YamloverLanguage
        if (!yam && file.language != Json5pLanguage) return null
        val text = file.text
        val raw = (if (yam) Pointers.yamloverPointerAt(text, offset) else Pointers.json5pPointerAt(text, offset)) ?: return null
        val expr = Pointers.parse(raw) ?: return null
        val index = if (yam) PathIndex.ofYamlover(text) else PathIndex.ofJson5p(text)

        index.resolve(expr, offset)?.let { target ->
            return arrayOf(file.findElementAt(target) ?: file)
        }

        // body.yamlover overlay: `/name` may be a child of the OVERLAID directory on disk
        if (yam && expr.document && expr.steps.isNotEmpty()) {
            val first = expr.steps[0] as? Step.Key ?: return null
            val vf = file.virtualFile ?: return null
            if (vf.name == "body.yamlover" && vf.parent?.name == ".yamlover") {
                val sibling = vf.parent?.parent?.findChild(first.name) ?: return null
                val mgr = PsiManager.getInstance(file.project)
                val psi: PsiElement? = if (sibling.isDirectory) mgr.findDirectory(sibling) else mgr.findFile(sibling)
                if (psi != null) return arrayOf(psi)
            }
        }
        return null
    }
}
