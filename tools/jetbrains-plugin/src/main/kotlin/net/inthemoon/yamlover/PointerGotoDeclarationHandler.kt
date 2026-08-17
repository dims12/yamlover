package net.inthemoon.yamlover

import com.intellij.codeInsight.navigation.actions.GotoDeclarationHandler
import com.intellij.navigation.DirectNavigationProvider
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
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
 * Resolution: in-file paths, `..` parent, `:` document scope, `[n]` positions (colon grammar,
 * docs/language/pointers/paths); plus the DIRECTORY concretes (docs/language/concretes): an
 * overlay file (`index.yo`, or `.yo/body.yo`) is the SAME node as its directory, so document
 * scope descends the overlaid directory's children — dirs, files, `name.yo` files — and a
 * `::` project pointer walks up to the nearest ancestor where the path resolves. `:::` world
 * links wait for the engine protocol (PLAN.md J3).
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

    // filesystem fallback: the yamlover tree continues past the file, on disk
    if (!yam) return null
    val vf = file.virtualFile ?: return null
    val fs = FsNavigation(file.project)
    return when (val scope = expr.scope) {
        is Scope.Document -> fs.overlaidDir(vf)?.let { fs.descend(it, expr.steps) }
        is Scope.Link ->
            if (scope.world) null // `:::` — a named world mount: engine territory
            else fs.fromProjectRoot(vf, listOf(Step.Key(scope.authority)) + expr.steps)
        else -> null
    }
}

/** Heuristic filesystem resolution for the directory concretes (docs/language/concretes):
 *  a plain dir is a mapping keyed by child names, an overlay file (`index.yo` / `.yo/body.yo`)
 *  is the same node as its directory. */
internal class FsNavigation(project: Project) {
    private val mgr = PsiManager.getInstance(project)

    /** The directory this file speaks for at document scope — the overlay contract makes
     *  `dir/index.yo` and `dir/.yo/body.yo` the same node as `dir/`. Null for other files. */
    fun overlaidDir(vf: VirtualFile): VirtualFile? = when {
        vf.name == "body.yo" && vf.parent?.name == ".yo" -> vf.parent?.parent
        vf.name == "index.yo" -> vf.parent
        else -> null
    }

    /** `::` project scope. The mount table lives in the engine, so heuristically: try every
     *  ancestor directory, nearest first, and take the first where the whole path resolves
     *  (`*::language:vs-yaml` inside docs/ finds docs/ — the nearest root owning `language`). */
    fun fromProjectRoot(vf: VirtualFile, steps: List<Step>): PsiElement? {
        var dir: VirtualFile? = overlaidDir(vf) ?: vf.parent
        while (dir != null) {
            descend(dir, steps)?.let { return it }
            dir = dir.parent
        }
        return null
    }

    /** Walk key steps down the tree: a portion matches a child dir or file named `name`,
     *  `name.yo`, or `name.yamlover`. Steps that leave the filesystem resolve inside the
     *  nearest overlay file's own path index; a final directory answers with its overlay. */
    fun descend(root: VirtualFile, steps: List<Step>): PsiElement? {
        var dir = root
        for ((i, step) in steps.withIndex()) {
            val name = (step as? Step.Key)?.name ?: return resolveInOverlay(dir, steps.drop(i))
            val child = dir.findChild(name) ?: dir.findChild("$name.yo") ?: dir.findChild("$name.yamlover")
            when {
                child == null -> return resolveInOverlay(dir, steps.drop(i))
                child.isDirectory -> dir = child
                else -> {
                    val rest = steps.drop(i + 1)
                    return if (rest.isEmpty()) mgr.findFile(child) else resolveInFile(child, rest)
                }
            }
        }
        return overlayOf(dir)?.let { mgr.findFile(it) } ?: mgr.findDirectory(dir)
    }

    private fun overlayOf(dir: VirtualFile): VirtualFile? =
        dir.findChild("index.yo") ?: dir.findChild(".yo")?.findChild("body.yo")

    private fun resolveInOverlay(dir: VirtualFile, rest: List<Step>): PsiElement? =
        overlayOf(dir)?.let { resolveInFile(it, rest) }

    /** The remaining steps resolve inside the target file's own path index (document scope —
     *  the file is the document the walk landed on). */
    private fun resolveInFile(vf: VirtualFile, rest: List<Step>): PsiElement? {
        val psi = mgr.findFile(vf) ?: return null
        if (psi.language != YamloverLanguage) return null
        val at = PathIndex.ofYamlover(psi.text).resolve(PointerExpr(Scope.Document, rest), 0) ?: return null
        return psi.findElementAt(at) ?: psi
    }
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
