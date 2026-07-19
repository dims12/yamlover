using OneNote2Yamlover.Core.Serialize;
using Xunit;

namespace OneNote2Yamlover.Core.Tests;

public class ChapterSerializerTests
{
    private const string Tag = "!!<*yamlover: $defs: chapter>";
    private static string Lines(params string[] l) => string.Join("\n", l) + "\n";

    // The title is the chapter root's scalar SELF-VALUE line (fully-omni, CHAPTER.md) — no `title:` key.
    [Fact]
    public void ProseChunks() => Assert.Equal(
        Lines(Tag, "Change license plates", "- |", "  own car", "- |", "  line one", "  line two"),
        ChapterSerializer.Chapter("Change license plates",
            [Chunk.Prose("own car"), Chunk.Prose("line one\nline two")], null));

    [Fact]
    public void ChildrenOnly() => Assert.Equal(
        Lines(Tag, "Avtomobil", "- *: Untitled.yamlover", "- *: Nomer.yamlover"),
        ChapterSerializer.Chapter("Avtomobil", null, ["Untitled.yamlover", "Nomer.yamlover"]));

    private const string TableTag = "!!<*yamlover: $defs: table>";
    private static TableRow Row(params string[] cells) => new([.. cells.Select(c => new TableCell(c))]);

    /// <summary>Prose, a table, an image, an attachment, then a subchapter — one ordered stream.</summary>
    [Fact]
    public void MixedBodyIsOnePositionalStream() => Assert.Equal(
        Lines(Tag, "Parent",
              "- |", "  intro prose",
              "- " + TableTag,
              "  - [a, b]",
              "  - [1, 2]",
              "- *: image-1a2b3c4d.png",
              "- *: Zvukozapis.3gp",
              "- *: Subpage.yamlover"),
        ChapterSerializer.Chapter("Parent",
            [Chunk.Prose("intro prose"), Chunk.Grid(new TableModel([Row("a", "b"), Row("1", "2")])),
             Chunk.Pointer("image-1a2b3c4d.png"), Chunk.Pointer("Zvukozapis.3gp")],
            ["Subpage.yamlover"]));

    /// <summary>Flow-cell quoting (MARKLOWER.md): a space / sigil / quote forces single quotes with
    /// <c>''</c> doubling; a marklower-bold cell opens with <c>*</c> (a yamlover sigil) so it quotes.</summary>
    [Fact]
    public void FlowRowQuoting() => Assert.Contains(
        "  - [plain, 'two words', '**bold**', 'it''s', '']",
        ChapterSerializer.Chapter("T",
            [Chunk.Grid(new TableModel([Row("plain", "two words", "**bold**", "it's", "")]))], null));

    /// <summary>A multi-line cell forces the BLOCK row form: a lone <c>-</c>, each cell its own
    /// item, the multi-line one a <c>|-</c> block scalar.</summary>
    [Fact]
    public void MultiLineCellMakesABlockRow() => Assert.Contains(
        Lines("  -",
              "    - single",
              "    - |-",
              "      two",
              "      lines"),
        ChapterSerializer.Chapter("T",
            [Chunk.Grid(new TableModel([new TableRow([new TableCell("single"), new TableCell("two\nlines")])]))], null));

    /// <summary>A nested-table cell: explicitly tagged (an untagged container cell is a
    /// CHAPTER — MARKLOWER.md §Cells), its rows at its child indent — the
    /// examples/61-table.yamlover shape.</summary>
    [Fact]
    public void NestedTableCellEmitsRecursively() => Assert.Contains(
        Lines("- " + TableTag,
              "  -",
              "    - Bubbles",
              "    - " + TableTag,
              "      - [duty, always]"),
        ChapterSerializer.Chapter("T",
            [Chunk.Grid(new TableModel([new TableRow([
                new TableCell("Bubbles"),
                new TableCell(Nested: new TableModel([Row("duty", "always")])),
            ])]))], null));

    /// <summary>A chapter CELL (a cell mixing prose and a table): the tag is optional now
    /// (an untagged container cell IS a chapter) but kept for clarity, with the ordered body
    /// at its child indent.</summary>
    [Fact]
    public void ChapterCellEmitsTaggedBody() => Assert.Contains(
        Lines("- " + TableTag,
              "  -",
              "    - single",
              "    - " + Tag,
              "      - above",
              "      - " + TableTag,
              "        - [duty, always]",
              "      - |-",
              "        below",
              "        more"),
        ChapterSerializer.Chapter("T",
            [Chunk.Grid(new TableModel([new TableRow([
                new TableCell("single"),
                new TableCell(Chapter:
                [
                    Chunk.Prose("above"),
                    Chunk.Grid(new TableModel([Row("duty", "always")])),
                    Chunk.Prose("below\nmore"),
                ]),
            ])]))], null));

    [Fact]
    public void EmptyBodyIsTagAndTitleOnly() =>
        Assert.Equal(Lines(Tag, "Untitled"), ChapterSerializer.Chapter("Untitled", null, null));

    /// <summary>The retired encoding must never reappear (yamlover commit d91c19a).</summary>
    [Fact]
    public void NeverEmitsRetiredKeys()
    {
        string s = ChapterSerializer.Chapter("X", [Chunk.Prose("p"), Chunk.Pointer("i.png")], ["c.yamlover"]);
        Assert.DoesNotContain("\nchunks:", s);
        Assert.DoesNotContain("\nchildren:", s);
    }

    [Fact]
    public void PointerWithSpaceIsQuoted() =>
        Assert.Contains("- *: \"Change license plates.yamlover\"",
            ChapterSerializer.Chapter("S", null, ["Change license plates.yamlover"]));

    [Fact]
    public void CyrillicTitleStaysBare() =>
        Assert.Contains("\nАвтомобиль\n", ChapterSerializer.Chapter("Автомобиль", null, null));

    [Fact]
    public void MetaDeclaresEachAssetsTypeAndFormat() => Assert.Equal(
        "properties:\n" +
        "  image-1a2b3c4d.png: { type: binary, format: image/png }\n" +
        "  Звукозапись.3gp: { type: binary, format: audio/3gpp }\n",
        ChapterSerializer.Meta([new Asset("image-1a2b3c4d.png", []), new Asset("Звукозапись.3gp", [])]));

    [Fact]
    public void MetaIsNullWhenThereAreNoAssets()
    {
        Assert.Null(ChapterSerializer.Meta(null));
        Assert.Null(ChapterSerializer.Meta([]));
    }
}
