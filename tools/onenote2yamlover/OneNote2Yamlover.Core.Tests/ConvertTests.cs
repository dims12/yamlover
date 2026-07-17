using OneNote2Yamlover.Core.Convert;
using OneNote2Yamlover.Core.Model;
using OneNote2Yamlover.Core.Serialize;
using OneNote2Yamlover.Core.Sync;
using Xunit;

namespace OneNote2Yamlover.Core.Tests;

public class PageConverterTests
{
    private const string Ns = "http://schemas.microsoft.com/office/onenote/2013/onenote";

    private static string Page(string body) =>
        $"""<?xml version="1.0"?><one:Page xmlns:one="{Ns}"><one:Outline><one:OEChildren>{body}</one:OEChildren></one:Outline></one:Page>""";

    private static string Oe(string inner) => $"<one:OE>{inner}</one:OE>";
    private static string T(string cdata) => $"<one:T><![CDATA[{cdata}]]></one:T>";

    [Fact]
    public void ProseBecomesOneChunkPerTopLevelOe()
    {
        var c = PageConverter.Convert(Page(Oe(T("own car")) + Oe(T("ruling"))));
        Assert.Equal(2, c.Chunks.Count);
        Assert.All(c.Chunks, x => Assert.Equal(ChunkKind.Text, x.Kind));
        Assert.Equal("own car", c.Chunks[0].Text);
    }

    [Fact]
    public void NestedOeChildrenBecomeBulletLinesInTheSameChunk()
    {
        var c = PageConverter.Convert(Page(Oe(T("parent") + $"<one:OEChildren>{Oe(T("kid"))}</one:OEChildren>")));
        Assert.Single(c.Chunks);
        Assert.Equal("parent\n- kid", c.Chunks[0].Text);
    }

    private static string Cell(string inner) => $"<one:Cell><one:OEChildren>{Oe(inner)}</one:OEChildren></one:Cell>";

    [Fact]
    public void TableBecomesATableChunk()
    {
        string table = "<one:Table><one:Row>" +
                       Cell(T("bpm")) + Cell(T("Tax, and more")) +
                       "</one:Row></one:Table>";
        var c = PageConverter.Convert(Page(Oe(table)));
        var chunk = Assert.Single(c.Chunks);
        Assert.Equal(ChunkKind.Table, chunk.Kind);
        var row = Assert.Single(chunk.Table!.Rows);
        Assert.Equal(["bpm", "Tax, and more"], row.Cells.Select(x => x.Text));
    }

    [Fact]
    public void CellFormattingSurvivesAsMarklower()
    {
        string table = "<one:Table><one:Row>" +
                       Cell(T("""<span style='font-weight:bold'>boss</span>""")) +
                       "</one:Row></one:Table>";
        var c = PageConverter.Convert(Page(Oe(table)));
        Assert.Equal("**boss**", Assert.Single(c.Chunks).Table!.Rows[0].Cells[0].Text);
    }

    [Fact]
    public void NestedTableStaysACellOfItsOwn()
    {
        // the old CSV path flattened a nested table's text into the outer cell
        string inner = $"<one:Table><one:Row>{Cell(T("duty"))}{Cell(T("always"))}</one:Row></one:Table>";
        string table = "<one:Table><one:Row>" +
                       Cell(T("Bubbles")) + Cell(inner) +
                       "</one:Row></one:Table>";
        var c = PageConverter.Convert(Page(Oe(table)));
        var cells = Assert.Single(Assert.Single(c.Chunks).Table!.Rows).Cells;
        Assert.Equal("Bubbles", cells[0].Text);
        Assert.Null(cells[0].Nested);
        var nested = Assert.IsType<TableModel>(cells[1].Nested);
        Assert.Equal(["duty", "always"], Assert.Single(nested.Rows).Cells.Select(x => x.Text));
    }

    [Fact]
    public void MultiParagraphCellStacksLines()
    {
        string table = "<one:Table><one:Row>" +
                       $"<one:Cell><one:OEChildren>{Oe(T("first"))}{Oe(T("second"))}</one:OEChildren></one:Cell>" +
                       "</one:Row></one:Table>";
        var c = PageConverter.Convert(Page(Oe(table)));
        Assert.Equal("first\nsecond", Assert.Single(c.Chunks).Table!.Rows[0].Cells[0].Text);
    }

    /// <summary>Prose AND a table in one cell: nothing is dropped — the cell becomes a CHAPTER
    /// whose body keeps prose and table in document order (MARKLOWER.md §Cells).</summary>
    [Fact]
    public void CellMixingProseAndTableBecomesAChapterCell()
    {
        string inner = $"<one:Table><one:Row>{Cell(T("duty"))}{Cell(T("always"))}</one:Row></one:Table>";
        string table = "<one:Table><one:Row>" +
                       $"<one:Cell><one:OEChildren>{Oe(T("above"))}{Oe(inner)}{Oe(T("below"))}</one:OEChildren></one:Cell>" +
                       "</one:Row></one:Table>";
        var warnings = new List<string>();
        var c = PageConverter.Convert(Page(Oe(table)), warn: warnings.Add);

        var cell = Assert.Single(Assert.Single(Assert.Single(c.Chunks).Table!.Rows).Cells);
        Assert.NotNull(cell.Chapter);
        Assert.Equal([ChunkKind.Text, ChunkKind.Table, ChunkKind.Text], cell.Chapter.Select(x => x.Kind));
        Assert.Equal("above", cell.Chapter[0].Text);
        Assert.Equal(["duty", "always"], cell.Chapter[1].Table!.Rows[0].Cells.Select(x => x.Text));
        Assert.Equal("below", cell.Chapter[2].Text);
        Assert.Empty(warnings);
    }

    /// <summary>TWO nested tables in one cell also fit a chapter cell — the old code kept only the first.</summary>
    [Fact]
    public void CellWithTwoTablesKeepsBoth()
    {
        string t1 = $"<one:Table><one:Row>{Cell(T("one"))}</one:Row></one:Table>";
        string t2 = $"<one:Table><one:Row>{Cell(T("two"))}</one:Row></one:Table>";
        string table = "<one:Table><one:Row>" +
                       $"<one:Cell><one:OEChildren>{Oe(t1)}{Oe(t2)}</one:OEChildren></one:Cell>" +
                       "</one:Row></one:Table>";
        var c = PageConverter.Convert(Page(Oe(table)));

        var cell = Assert.Single(Assert.Single(Assert.Single(c.Chunks).Table!.Rows).Cells);
        Assert.NotNull(cell.Chapter);
        Assert.Equal(["one", "two"], cell.Chapter.Select(x => x.Table!.Rows[0].Cells[0].Text));
    }

    [Fact]
    public void ImageBecomesAnAssetAndAPointer()
    {
        byte[] png = [0x89, 0x50, 0x4E, 0x47];
        string img = $"""<one:Image format="image/png"><one:Data>{System.Convert.ToBase64String(png)}</one:Data></one:Image>""";
        var c = PageConverter.Convert(Page(Oe(img)));

        var asset = Assert.Single(c.Assets);
        Assert.StartsWith("image-", asset.Name);
        Assert.EndsWith(".png", asset.Name);
        Assert.Equal(png, asset.Bytes);

        var ptr = Assert.Single(c.Chunks);
        Assert.Equal(ChunkKind.Pointer, ptr.Kind);
        Assert.Equal(asset.Name, ptr.File);
    }

    [Fact]
    public void CallbackOnlyImageWithoutDataIsSkipped()
    {
        var c = PageConverter.Convert(Page(Oe("""<one:Image format="image/png"/>""")));
        Assert.Empty(c.Assets);
        Assert.Empty(c.Chunks);
    }

    [Fact]
    public void InsertedFileIsReadFromPathCacheAndNamedFromPreferredName()
    {
        byte[] audio = [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70];
        string ins = """<one:InsertedFile pathCache="C:\cache\00001PGI.bin" preferredName="Звукозапись.3gp"/>""";
        var c = PageConverter.Convert(Page(Oe(ins)), readAttachment: _ => audio);

        var asset = Assert.Single(c.Assets);
        Assert.Equal("Звукозапись.3gp", asset.Name);
        Assert.Equal(audio, asset.Bytes);
        Assert.Equal("audio/3gpp", Core.Text.Mime.FromName(asset.Name));
    }

    [Fact]
    public void MissingAttachmentBytesWarnAndAreSkipped()
    {
        string ins = """<one:InsertedFile pathCache="C:\gone.bin" preferredName="x.3gp"/>""";
        var warnings = new List<string>();
        var c = PageConverter.Convert(Page(Oe(ins)), readAttachment: _ => null, warn: warnings.Add);

        Assert.Empty(c.Assets);
        Assert.Empty(c.Chunks);
        Assert.Contains(warnings, w => w.Contains("x.3gp"));
    }

    /// <summary>The PowerShell original returned early on a name match, dropping the second file's bytes.</summary>
    [Fact]
    public void TwoDifferentAttachmentsWithTheSameNameGetDistinctFiles()
    {
        string ins1 = """<one:InsertedFile pathCache="a" preferredName="note.txt"/>""";
        string ins2 = """<one:InsertedFile pathCache="b" preferredName="note.txt"/>""";
        var c = PageConverter.Convert(Page(Oe(ins1) + Oe(ins2)),
            readAttachment: p => p == "a" ? [1] : [2]);

        Assert.Equal(2, c.Assets.Count);
        Assert.Equal("note.txt", c.Assets[0].Name);
        Assert.Equal("note (2).txt", c.Assets[1].Name);
    }

    [Fact]
    public void IdenticalImageTwiceIsStoredOnce()
    {
        string img = """<one:Image format="image/png"><one:Data>AQID</one:Data></one:Image>""";
        var c = PageConverter.Convert(Page(Oe(img) + Oe(img)));
        Assert.Single(c.Assets);
        Assert.Equal(2, c.Chunks.Count);
        Assert.Equal(c.Chunks[0].File, c.Chunks[1].File);
    }

    [Fact]
    public void LinkSpacingSurvivesThePipeline()
    {
        var c = PageConverter.Convert(Page(Oe(T("""a <a href="u">label </a>b"""))));
        Assert.Equal("a [label](u) b", c.Chunks[0].Text);
    }
}

public class HierarchyTests
{
    private const string Ns = "http://schemas.microsoft.com/office/onenote/2013/onenote";

    [Fact]
    public void RecycleBinsAreExcludedAndGroupsRecurse()
    {
        string xml = $"""
            <?xml version="1.0"?>
            <one:Notebooks xmlns:one="{Ns}">
              <one:Notebook name="NB" ID="nb">
                <one:Section name="S1" ID="s1"/>
                <one:SectionGroup name="G" ID="g">
                  <one:Section name="S2" ID="s2"/>
                  <one:SectionGroup name="G2" ID="g2"><one:Section name="S3" ID="s3"/></one:SectionGroup>
                </one:SectionGroup>
                <one:SectionGroup name="OneNote_RecycleBin" ID="rb" isRecycleBin="true">
                  <one:Section name="Deleted" ID="d"/>
                </one:SectionGroup>
              </one:Notebook>
            </one:Notebooks>
            """;
        var nbs = HierarchyParser.ParseNotebooks(xml);
        var nb = Assert.Single(nbs);
        var sections = nb.DescendantsAndSelf().Where(n => n.IsSection).Select(n => n.Name).ToList();

        Assert.Equal(["S1", "S2", "S3"], sections);
        Assert.DoesNotContain("Deleted", sections);
        Assert.DoesNotContain(nb.Children, c => c.Name == "OneNote_RecycleBin");
    }

    /// <summary>Renaming a notebook changes `nickname` only; `name` stays the on-disk folder name.</summary>
    [Fact]
    public void NotebookNicknameIsTheDisplayName()
    {
        string xml = $"""
            <?xml version="1.0"?>
            <one:Notebooks xmlns:one="{Ns}">
              <one:Notebook name="Freelance" nickname="Freelance и работа" ID="nb1">
                <one:SectionGroup name="G" ID="g"><one:Section name="S" ID="s"/></one:SectionGroup>
              </one:Notebook>
              <one:Notebook name="Same" ID="nb2"/>
            </one:Notebooks>
            """;
        var nbs = HierarchyParser.ParseNotebooks(xml);

        Assert.Equal("Freelance", nbs[0].Name);
        Assert.Equal("Freelance и работа", nbs[0].DisplayName);
        Assert.Equal("Same", nbs[1].DisplayName);
        Assert.Equal("G", nbs[0].Children[0].DisplayName);
    }

    [Fact]
    public void SubpagesAreNestedByPageLevel()
    {
        string xml = $"""
            <?xml version="1.0"?>
            <one:Section xmlns:one="{Ns}">
              <one:Page ID="p1" name="A" pageLevel="1"/>
              <one:Page ID="p2" name="A.1" pageLevel="2"/>
              <one:Page ID="p3" name="A.1.1" pageLevel="3"/>
              <one:Page ID="p4" name="B" pageLevel="1"/>
              <one:Page ID="p5" name="Gone" pageLevel="1" isInRecycleBin="true"/>
            </one:Section>
            """;
        var pages = HierarchyParser.ReconstructPages(xml);

        Assert.Equal(2, pages.Count);
        Assert.Equal("A", pages[0].Name);
        Assert.Equal("A.1", Assert.Single(pages[0].Sub).Name);
        Assert.Equal("A.1.1", Assert.Single(pages[0].Sub[0].Sub).Name);
        Assert.Equal("B", pages[1].Name);
        Assert.Equal(4, pages.Sum(p => p.CountWithSub()));
    }
}

public class NamePlanAndReconcilerTests
{
    private static OneNoteNode Nb(string name, params OneNoteNode[] kids)
    {
        var n = new OneNoteNode(NodeKind.Notebook, name, name);
        n.Children.AddRange(kids);
        return n;
    }
    private static OneNoteNode Grp(string name, params OneNoteNode[] kids)
    {
        var n = new OneNoteNode(NodeKind.SectionGroup, name, name);
        n.Children.AddRange(kids);
        return n;
    }
    private static OneNoteNode Sec(string name) => new(NodeKind.Section, name, name);

    [Fact]
    public void RelPathsUseSanitizedNames()
    {
        var nb = Nb("Dmitry's Notebook", Sec("Автомобиль"), Sec("a[b"));
        var plan = new NamePlan([nb]);

        Assert.Equal("Dmitry's Notebook/Автомобиль", plan.RelPath(nb.Children[0]));
        Assert.Equal("Dmitry's Notebook/a-b", plan.RelPath(nb.Children[1]));
    }

    [Fact]
    public void SiblingsWithTheSameSanitizedNameAreDeduped()
    {
        var nb = Nb("N", Sec("a:b"), Sec("a?b"));
        var plan = new NamePlan([nb]);
        Assert.Equal("a-b", plan.DirName(nb.Children[0]));
        Assert.Equal("a-b (2)", plan.DirName(nb.Children[1]));
    }

    /// <summary>Sync section B alone; the notebook body must still list A, which is only at the destination.</summary>
    [Fact]
    public void AncestorBodyUnionsDestinationWithThisRun()
    {
        var nb = Nb("N", Sec("A"), Sec("B"));
        var plan = new NamePlan([nb]);
        string stage = Path.Combine(Path.GetTempPath(), "o2y-test-" + Guid.NewGuid().ToString("N")[..8]);

        try
        {
            var destHasA = new FakeIndex(("N", "A"));
            AncestorReconciler.WriteAncestorBodies(stage, plan, [nb.Children[1]], destHasA);

            string body = File.ReadAllText(Path.Combine(stage, "N", ".yamlover", "body.yamlover"));
            Assert.Equal(
                ChapterSerializer.Tag + "\ntitle: N\n- *: A\n- *: B\n",
                body);
        }
        finally { if (Directory.Exists(stage)) Directory.Delete(stage, true); }
    }

    /// <summary>A section-group child written this run must appear in its parent's list, in OneNote order.</summary>
    [Fact]
    public void AncestorBodyListsSectionGroupsAmongSections()
    {
        var nb = Nb("N", Sec("A"), Grp("G", Sec("S")), Sec("B"));
        var plan = new NamePlan([nb]);
        string stage = Path.Combine(Path.GetTempPath(), "o2y-test-" + Guid.NewGuid().ToString("N")[..8]);
        try
        {
            var synced = nb.DescendantsAndSelf().Where(n => n.IsSection).ToList();
            AncestorReconciler.WriteAncestorBodies(stage, plan, synced, new EmptyDestinationIndex());

            string nbBody = File.ReadAllText(Path.Combine(stage, "N", ".yamlover", "body.yamlover"));
            Assert.Equal(ChapterSerializer.Tag + "\ntitle: N\n- *: A\n- *: G\n- *: B\n", nbBody);

            string grpBody = File.ReadAllText(Path.Combine(stage, "N", "G", ".yamlover", "body.yamlover"));
            Assert.Equal(ChapterSerializer.Tag + "\ntitle: G\n- *: S\n", grpBody);
        }
        finally { if (Directory.Exists(stage)) Directory.Delete(stage, true); }
    }

    [Fact]
    public void AncestorBodyOmitsSectionsThatExistNowhere()
    {
        var nb = Nb("N", Sec("A"), Sec("B"));
        var plan = new NamePlan([nb]);
        string stage = Path.Combine(Path.GetTempPath(), "o2y-test-" + Guid.NewGuid().ToString("N")[..8]);
        try
        {
            AncestorReconciler.WriteAncestorBodies(stage, plan, [nb.Children[1]], new EmptyDestinationIndex());
            string body = File.ReadAllText(Path.Combine(stage, "N", ".yamlover", "body.yamlover"));
            Assert.Equal(ChapterSerializer.Tag + "\ntitle: N\n- *: B\n", body);
        }
        finally { if (Directory.Exists(stage)) Directory.Delete(stage, true); }
    }

    /// <summary>A renamed notebook keeps its folder name; only the body's title shows the nickname.</summary>
    [Fact]
    public void RenamedNotebookTitlesTheBodyWithItsNickname()
    {
        var nb = new OneNoteNode(NodeKind.Notebook, "nb", "Бизнес", "Я, Расцвет, Бизнес");
        nb.Children.Add(Sec("A"));
        var plan = new NamePlan([nb]);
        string stage = Path.Combine(Path.GetTempPath(), "o2y-test-" + Guid.NewGuid().ToString("N")[..8]);
        try
        {
            AncestorReconciler.WriteAncestorBodies(stage, plan, [nb.Children[0]], new EmptyDestinationIndex());
            string body = File.ReadAllText(Path.Combine(stage, "Бизнес", ".yamlover", "body.yamlover"));
            Assert.Equal(ChapterSerializer.Tag + "\ntitle: Я, Расцвет, Бизнес\n- *: A\n", body);
        }
        finally { if (Directory.Exists(stage)) Directory.Delete(stage, true); }
    }

    private sealed class FakeIndex(params (string Rel, string Child)[] present) : IDestinationIndex
    {
        public bool ContainerChildExists(string relContainerPath, string childName) =>
            present.Any(p => p.Rel == relContainerPath && p.Child == childName);
    }
}
