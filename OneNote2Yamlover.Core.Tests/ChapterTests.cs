using OneNote2Yamlover.Core.Serialize;
using Xunit;

namespace OneNote2Yamlover.Core.Tests;

public class ChapterSerializerTests
{
    private const string Tag = "!!<*yamlover: $defs: chapter>";
    private static string Lines(params string[] l) => string.Join("\n", l) + "\n";

    [Fact]
    public void ProseChunks() => Assert.Equal(
        Lines(Tag, "title: Change license plates", "- |", "  own car", "- |", "  line one", "  line two"),
        ChapterSerializer.Chapter("Change license plates",
            [Chunk.Prose("own car"), Chunk.Prose("line one\nline two")], null));

    [Fact]
    public void ChildrenOnly() => Assert.Equal(
        Lines(Tag, "title: Avtomobil", "- *: Untitled.yamlover", "- *: Nomer.yamlover"),
        ChapterSerializer.Chapter("Avtomobil", null, ["Untitled.yamlover", "Nomer.yamlover"]));

    /// <summary>Prose, a CSV table, an image, an attachment, then a subchapter — one ordered stream.</summary>
    [Fact]
    public void MixedBodyIsOnePositionalStream() => Assert.Equal(
        Lines(Tag, "title: Parent",
              "- |", "  intro prose",
              "- !!<format: text/csv> |", "  a,b", "  1,2",
              "- *: image-1a2b3c4d.png",
              "- *: Zvukozapis.3gp",
              "- *: Subpage.yamlover"),
        ChapterSerializer.Chapter("Parent",
            [Chunk.Prose("intro prose"), Chunk.Table("a,b\n1,2"),
             Chunk.Pointer("image-1a2b3c4d.png"), Chunk.Pointer("Zvukozapis.3gp")],
            ["Subpage.yamlover"]));

    [Fact]
    public void EmptyBodyIsTagAndTitleOnly() =>
        Assert.Equal(Lines(Tag, "title: Untitled"), ChapterSerializer.Chapter("Untitled", null, null));

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
        Assert.Contains("title: Автомобиль", ChapterSerializer.Chapter("Автомобиль", null, null));

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
