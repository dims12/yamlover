package net.inthemoon.yamlover

import com.intellij.codeInsight.navigation.actions.GotoDeclarationHandler
import com.intellij.navigation.DirectNavigationProvider
import com.intellij.openapi.editor.Editor
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.psi.PsiManager
import com.intellij.psi.PsiWhiteSpace

/**
 * Navigation glue over the heuristic resolver (PointerNavigation.kt), wired twice:
 *
 *  - {@link PointerDirectNavigationProvider} — the MODERN pipeline. The IDE asks it while
 *    Ctrl is held, and a non-null target is what paints the link underline under the cursor
 *    (and then handles the click). Legacy GotoDeclarationHandlers are only consulted when
 *    the action actually runs, which is why a handler alone navigates but shows no hint.
 *  - {@link PointerGotoDeclarationHandler} — the legacy action path, kept so keyboard
 *    Ctrl+B keeps working in contexts that bypass the new pipeline.
 *
 * Resolution: in-file paths, anchors, `..`, `/` document scope, `[n]` positions; plus, in a
 * `.yamlover/body.yamlover` overlay, a document-scope segment falls back to the overlaid
 * directory's child file/dir. `//`/scheme links wait for the engine protocol (PLAN.md J3).
 */
internal fun pointerTargetAt(file: PsiFile, offset: Int): PsiElement? {
    val yam = file.language == YamloverLanguage
    if (!yam && file.language != Json5pLanguage) return null
    val text = file.text
    val raw = (if (yam) Pointers.yamloverPointerAt(text, offset) else Pointers.json5pPointerAt(text, offset)) ?: return null
    val expr = Pointers.parse(raw) ?: return null
    val index = if (yam) PathIndex.ofYamlover(text) else PathIndex.ofJson5p(text)

    index.resolve(expr, offset)?.let { target ->
        return file.findElementAt(target) ?: file
    }

    // body.yamlover overlay: `/name` may be a child of the OVERLAID directory on disk
    if (yam && expr.document && expr.steps.isNotEmpty()) {
        val first = expr.steps[0] as? Step.Key ?: return null
        val vf = file.virtualFile ?: return null
        if (vf.name == "body.yamlover" && vf.parent?.name == ".yamlover") {
            val sibling = vf.parent?.parent?.findChild(first.name) ?: return null
            val mgr = PsiManager.getInstance(file.project)
            return if (sibling.isDirectory) mgr.findDirectory(sibling) else mgr.findFile(sibling)
        }
    }
    return null
}

/** Ctrl+hover link underline + navigation (the modern pipeline; see file doc). */
class PointerDirectNavigationProvider : DirectNavigationProvider {
    override fun getNavigationElement(element: PsiElement): PsiElement? {
        if (element is PsiWhiteSpace) return null // never underline whitespace
        val file = element.containingFile ?: return null
        return pointerTargetAt(file, element.textRange.startOffset)
    }
}

/** Ctrl+B / Ctrl+click action path (legacy handler API; see file doc). */
class PointerGotoDeclarationHandler : GotoDeclarationHandler {
    override fun getGotoDeclarationTargets(sourceElement: PsiElement?, offset: Int, editor: Editor?): Array<PsiElement>? {
        val file = sourceElement?.containingFile ?: return null
        return pointerTargetAt(file, offset)?.let { arrayOf(it) }
    }
}
