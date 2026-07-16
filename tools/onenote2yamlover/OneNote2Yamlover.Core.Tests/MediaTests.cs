using OneNote2Yamlover.Core.Convert;
using OneNote2Yamlover.Core.Serialize;
using OneNote2Yamlover.Core.Text;
using Xunit;

namespace OneNote2Yamlover.Core.Tests;

public class ImageFormatSniffTests
{
    // OneNote leaves @format EMPTY on every image in practice (256 of 256 in the real notebook),
    // so the declared value must never be trusted over the bytes.
    [Theory]
    [InlineData(new byte[] { 0x89, 0x50, 0x4E, 0x47 }, ".png")]
    [InlineData(new byte[] { 0xFF, 0xD8, 0xFF, 0xE0 }, ".jpg")]
    [InlineData(new byte[] { 0x47, 0x49, 0x46, 0x38 }, ".gif")]
    [InlineData(new byte[] { 0x42, 0x4D, 0x00, 0x00 }, ".bmp")]
    [InlineData(new byte[] { 0x49, 0x49, 0x2A, 0x00 }, ".tiff")]
    [InlineData(new byte[] { 0x4D, 0x4D, 0x00, 0x2A }, ".tiff")]
    public void MagicBytesWin(byte[] bytes, string expected) =>
        Assert.Equal(expected, Mime.ExtFromBytes(bytes));

    [Fact]
    public void WebpNeedsBothRiffAndWebp() =>
        Assert.Equal(".webp", Mime.ExtFromBytes("RIFF????WEBPxxxx"u8.ToArray()));

    /// <summary>A JPEG with an empty format attribute must not be named .png.</summary>
    [Fact]
    public void EmptyDeclaredFormatDoesNotOverrideBytes() =>
        Assert.Equal(".jpg", Mime.ExtFromBytes([0xFF, 0xD8, 0xFF], declaredFormat: ""));

    [Fact]
    public void UnknownBytesFallBackToDeclaredFormat() =>
        Assert.Equal(".gif", Mime.ExtFromBytes([1, 2, 3, 4], declaredFormat: "image/gif"));

    [Fact]
    public void UnknownBytesAndNoFormatFallBackToPng() =>
        Assert.Equal(".png", Mime.ExtFromBytes([1, 2, 3, 4]));
}

public class EmbedTests
{
    [Theory]
    [InlineData("https://youtu.be/dQw4w9WgXcQ")]
    [InlineData("https://www.youtube.com/watch?v=u_yIGGhubZs")]
    [InlineData("https://vimeo.com/12345")]
    [InlineData("https://cdn.example.com/clip.mp4")]
    [InlineData("https://cdn.example.com/clip.WEBM")]
    public void EmbeddableTargets(string url) => Assert.True(Marklower.IsEmbeddable(url));

    [Theory]
    [InlineData("https://example.com/page")]
    [InlineData("https://example.com/photo.png")]   // an external <img> would be a hotlink
    [InlineData("mailto:a@b.c")]
    [InlineData("javascript:alert(1)")]
    [InlineData("data:text/html,<b>x</b>")]
    [InlineData("onenote:///C:/x.one")]
    [InlineData("not a url")]
    public void NonEmbeddableTargets(string url) => Assert.False(Marklower.IsEmbeddable(url));

    /// <summary>`*[label](t)` inlines the target; a plain `[label](t)` only points at it.</summary>
    [Fact]
    public void YouTubeLinkBecomesAnEmbedToken() => Assert.Equal(
        "*[Lesson 2](https://www.youtube.com/watch?v=u_yIGGhubZs)",
        Marklower.FromHtml("""<a href="https://www.youtube.com/watch?v=u_yIGGhubZs">Lesson 2</a>"""));

    [Fact]
    public void OrdinaryLinkStaysAPlainLink() => Assert.Equal(
        "[docs](https://example.com/docs)",
        Marklower.FromHtml("""<a href="https://example.com/docs">docs</a>"""));

    [Fact]
    public void EmbedKeepsSurroundingWhitespaceHoisting() => Assert.Equal(
        "see *[clip](https://youtu.be/x) now",
        Marklower.FromHtml("""see<a href="https://youtu.be/x"> clip </a>now"""));
}

public class PageMediaTests
{
    private const string Ns = "http://schemas.microsoft.com/office/onenote/2013/onenote";
    private static readonly string Png = System.Convert.ToBase64String([0x89, 0x50, 0x4E, 0x47, 1, 2]);
    private static readonly string Jpg = System.Convert.ToBase64String([0xFF, 0xD8, 0xFF, 9, 9]);

    private static string Page(string body) =>
        $"""<?xml version="1.0"?><one:Page xmlns:one="{Ns}">{body}</one:Page>""";
    private static string Outline(string inner) => $"<one:Outline><one:OEChildren>{inner}</one:OEChildren></one:Outline>";
    private static string Oe(string inner) => $"<one:OE>{inner}</one:OE>";
    private static string T(string s) => $"<one:T><![CDATA[{s}]]></one:T>";
    private static string Img(string b64) => $"<one:Image format=\"\"><one:Data>{b64}</one:Data></one:Image>";

    /// <summary>Six images in the real notebook hang directly off one:Page, outside any Outline.</summary>
    [Fact]
    public void PageLevelImageIsCaptured()
    {
        var c = PageConverter.Convert(Page(Outline(Oe(T("prose"))) + Img(Png)));

        Assert.Equal(2, c.Chunks.Count);
        Assert.Equal(ChunkKind.Text, c.Chunks[0].Kind);
        Assert.Equal(ChunkKind.Pointer, c.Chunks[1].Kind);
        Assert.EndsWith(".png", Assert.Single(c.Assets).Name);
    }

    [Fact]
    public void PageLevelImageKeepsDocumentOrder()
    {
        var c = PageConverter.Convert(Page(Img(Png) + Outline(Oe(T("after")))));
        Assert.Equal(ChunkKind.Pointer, c.Chunks[0].Kind);
        Assert.Equal("after", c.Chunks[1].Text);
    }

    /// <summary>120 images live inside table cells, which the OE recursion never reaches.</summary>
    [Fact]
    public void ImageInsideATableCellIsCaptured()
    {
        string table = "<one:Table><one:Row>" +
                       $"<one:Cell><one:OEChildren>{Oe(T("cell text"))}{Oe(Img(Png))}</one:OEChildren></one:Cell>" +
                       "</one:Row></one:Table>";
        var c = PageConverter.Convert(Page(Outline(Oe(table))));

        Assert.Equal(2, c.Chunks.Count);
        Assert.Equal(ChunkKind.Table, c.Chunks[0].Kind);
        Assert.Equal("cell text", c.Chunks[0].Table!.Rows[0].Cells[0].Text);
        Assert.Equal(ChunkKind.Pointer, c.Chunks[1].Kind);
        Assert.Single(c.Assets);
    }

    [Fact]
    public void JpegWithEmptyFormatIsNamedJpg()
    {
        var c = PageConverter.Convert(Page(Outline(Oe(Img(Jpg)))));
        Assert.EndsWith(".jpg", Assert.Single(c.Assets).Name);
    }

    [Fact]
    public void CallbackOnlyImageWithoutDataIsStillSkipped()
    {
        var c = PageConverter.Convert(Page(Outline(Oe("""<one:Image format="image/png"/>"""))));
        Assert.Empty(c.Assets);
        Assert.Empty(c.Chunks);
    }
}

public class InkTests
{
    private const string Ns = "http://schemas.microsoft.com/office/onenote/2013/onenote";
    private static readonly string Isf = System.Convert.ToBase64String([0x00, 0xB5, 0x01, 0x1D]);

    private static string Page(string body) =>
        $"""<?xml version="1.0"?><one:Page xmlns:one="{Ns}">{body}</one:Page>""";

    private const string FakeSvg = """<svg xmlns="http://www.w3.org/2000/svg"/>""";

    /// <summary>All 371 InkDrawings in the real notebook sit directly under one:Page.</summary>
    [Fact]
    public void PageLevelInkBecomesAnSvgAsset()
    {
        var c = PageConverter.Convert(
            Page($"<one:InkDrawing><one:Data>{Isf}</one:Data></one:InkDrawing>"),
            renderInk: _ => FakeSvg);

        var asset = Assert.Single(c.Assets);
        Assert.StartsWith("ink-", asset.Name);
        Assert.EndsWith(".svg", asset.Name);
        Assert.Equal(FakeSvg, System.Text.Encoding.UTF8.GetString(asset.Bytes));
        Assert.Equal("image/svg+xml", Mime.FromName(asset.Name));

        var ptr = Assert.Single(c.Chunks);
        Assert.Equal(ChunkKind.Pointer, ptr.Kind);
        Assert.Equal(asset.Name, ptr.File);
    }

    /// <summary>An InkParagraph carries no Data of its own; its InkWords do.</summary>
    [Fact]
    public void InkParagraphRendersItsWords()
    {
        string body = $"<one:Outline><one:OEChildren><one:OE><one:InkParagraph>" +
                      $"<one:InkWord><one:Data>{Isf}</one:Data></one:InkWord>" +
                      $"</one:InkParagraph></one:OE></one:OEChildren></one:Outline>";
        var c = PageConverter.Convert(Page(body), renderInk: _ => FakeSvg);

        Assert.Single(c.Assets);
        Assert.Single(c.Chunks);
    }

    [Fact]
    public void UndecodableInkIsWarnedAndSkipped()
    {
        var warnings = new List<string>();
        var c = PageConverter.Convert(
            Page($"<one:InkDrawing><one:Data>{Isf}</one:Data></one:InkDrawing>"),
            renderInk: _ => null, warn: warnings.Add);

        Assert.Empty(c.Assets);
        Assert.Empty(c.Chunks);
        Assert.Contains(warnings, w => w.Contains("ink"));
    }

    [Fact]
    public void InkWithoutARendererIsWarnedNotCrashed()
    {
        var warnings = new List<string>();
        var c = PageConverter.Convert(
            Page($"<one:InkDrawing><one:Data>{Isf}</one:Data></one:InkDrawing>"), warn: warnings.Add);

        Assert.Empty(c.Assets);
        Assert.Contains(warnings, w => w.Contains("no renderer"));
    }

    [Fact]
    public void IdenticalInkIsStoredOnce()
    {
        string ink = $"<one:InkDrawing><one:Data>{Isf}</one:Data></one:InkDrawing>";
        var c = PageConverter.Convert(Page(ink + ink), renderInk: _ => FakeSvg);

        Assert.Single(c.Assets);
        Assert.Equal(2, c.Chunks.Count);
        Assert.Equal(c.Chunks[0].File, c.Chunks[1].File);
    }
}
