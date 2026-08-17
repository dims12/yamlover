package net.inthemoon.yamlover

import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/** Ctrl+click across files — the directory concretes (docs/language/concretes): an overlay
 *  (`index.yo` / `.yo/body.yo`) is the same node as its directory, document scope descends
 *  the directory's children, and `::` project scope walks up to the nearest resolving root. */
class FsNavigationTest : BasePlatformTestCase() {

    private fun targetPath(t: PsiElement?): String? =
        (t?.containingFile ?: t as? PsiFile)?.virtualFile?.path

    fun testIndexYoOverlayReachesTheSiblingChapterDir() {
        // the docs/ shape: `docs/index.yo` orders the chapters with `- *: language` rows
        myFixture.addFileToProject("docs/language/index.yo", "the language chapter\ndescription: the spec\n")
        val f = myFixture.addFileToProject("docs/index.yo", "yamlover\n- *: language\n")
        val t = pointerTargetAt(f, f.text.indexOf("language") + 2)
        assertNotNull("`- *: language` must reach docs/language/", t)
        assertTrue(targetPath(t)!!.endsWith("docs/language/index.yo"))
    }

    fun testMultiSegmentDescentThroughSubdirectories() {
        myFixture.addFileToProject("docs/language/vs-yaml/index.yo", "vs yaml\n")
        val f = myFixture.addFileToProject("docs/index.yo", "- *: language: vs-yaml\n")
        val t = pointerTargetAt(f, f.text.indexOf("vs-yaml") + 2)
        assertTrue(targetPath(t)!!.endsWith("docs/language/vs-yaml/index.yo"))
    }

    fun testASegmentMatchesAChildFileByYoExtension() {
        // the legacy `.yo/body.yo` overlay keeps working, and a portion matches `name.yo`
        val f = myFixture.addFileToProject("d/.yo/body.yo", "- *: child\n")
        myFixture.addFileToProject("d/child.yo", "the child\n")
        val t = pointerTargetAt(f, f.text.indexOf("child") + 2)
        assertTrue(targetPath(t)!!.endsWith("d/child.yo"))
    }

    fun testTrailingStepsResolveInsideTheTargetFile() {
        myFixture.addFileToProject("docs/language/index.yo", "the language chapter\ndescription: the spec\n")
        val f = myFixture.addFileToProject("docs/index.yo", "x: *: language: description\n")
        val t = pointerTargetAt(f, f.text.indexOf("description") + 2)
        assertTrue(targetPath(t)!!.endsWith("docs/language/index.yo"))
        val at = t!!.containingFile.text.indexOf("description: the spec")
        assertEquals("must land on the `description` entry", at, t.textRange.startOffset)
    }

    fun testProjectScopeWalksUpToTheNearestResolvingRoot() {
        myFixture.addFileToProject("docs/index.yo", "yamlover\n")
        myFixture.addFileToProject("docs/language/index.yo", "the language chapter\n")
        myFixture.addFileToProject("docs/language/vs-yaml/index.yo", "vs yaml\n")
        val f = myFixture.addFileToProject(
            "docs/language/pointers/index.yo",
            "- >\n  See the [full differences](*::language:vs-yaml) here.\n",
        )
        val t = pointerTargetAt(f, f.text.indexOf("vs-yaml") + 2)
        assertNotNull("a `::` project pointer must climb out of the chapter", t)
        assertTrue(targetPath(t)!!.endsWith("docs/language/vs-yaml/index.yo"))
    }

    fun testInFileResolutionStillWinsOverTheFilesystem() {
        myFixture.addFileToProject("docs/language/index.yo", "the language chapter\n")
        val f = myFixture.addFileToProject("docs/index.yo", "language: in-file\nx: *: language\n")
        val t = pointerTargetAt(f, f.text.indexOf("language", f.text.indexOf("x:")) + 2)
        assertEquals("the in-file `language:` entry shadows the directory", 0, t!!.textRange.startOffset)
    }
}
