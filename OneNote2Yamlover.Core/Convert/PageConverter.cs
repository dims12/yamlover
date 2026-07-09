using System.Xml.Linq;
using OneNote2Yamlover.Core.Model;
using OneNote2Yamlover.Core.Serialize;
using OneNote2Yamlover.Core.Text;

namespace OneNote2Yamlover.Core.Convert;

public sealed record PageConversion(List<Chunk> Chunks, List<Asset> Assets);

/// <summary>One page's XML → chunks + assets. Ported from <c>Walk-OE</c> / <c>Convert-Page</c>.</summary>
public static class PageConverter
{
    /// <param name="readAttachment">
    /// Reads an <c>InsertedFile</c>'s bytes from its <c>pathCache</c>. Injected so Core stays
    /// filesystem-free in tests. Return null when the cache blob is gone.
    /// </param>
    /// <param name="renderInk">
    /// Renders a handwriting stroke blob (ISF) to SVG. Injected because decoding ISF needs WPF's
    /// <c>StrokeCollection</c>, and Core is deliberately platform-neutral. Return null if unreadable.
    /// </param>
    public static PageConversion Convert(string pageXml,
                                         Func<string, byte[]?>? readAttachment = null,
                                         Func<byte[], string?>? renderInk = null,
                                         Action<string>? warn = null)
    {
        readAttachment ??= p => File.Exists(p) ? File.ReadAllBytes(p) : null;

        var doc = XDocument.Parse(pageXml);
        var ctx = new Ctx(readAttachment, renderInk, warn, [], []);
        var root = doc.Root ?? throw new InvalidOperationException("page has no root element");

        // Walk the page's own children IN DOCUMENT ORDER. Images and ink drawings sit directly under
        // one:Page — outside any Outline — and an Outline-only walk silently drops them.
        foreach (var el in root.Elements())
        {
            if (el.Name == One.Ns + "Outline")
            {
                foreach (var oe in el.Elements(One.Ns + "OEChildren").Elements(One.Ns + "OE"))
                {
                    var lines = new List<string>();
                    var tail = new List<Chunk>();
                    WalkOe(oe, 0, lines, tail, ctx);

                    if (lines.Count > 0) ctx.Chunks.Add(Chunk.Prose(string.Join("\n", lines)));
                    ctx.Chunks.AddRange(tail);
                }
            }
            else if (el.Name == One.Ns + "Image") AddImage(el, ctx.Chunks, ctx);
            else if (IsInk(el)) AddInk(el, ctx.Chunks, ctx);
        }

        return new PageConversion(ctx.Chunks, ctx.Assets);
    }

    private sealed record Ctx(Func<string, byte[]?> ReadAttachment, Func<byte[], string?>? RenderInk,
                              Action<string>? Warn, List<Chunk> Chunks, List<Asset> Assets);

    private static bool IsInk(XElement e) =>
        e.Name == One.Ns + "InkDrawing" || e.Name == One.Ns + "InkParagraph" || e.Name == One.Ns + "InkWord";

    private static void WalkOe(XElement oe, int depth, List<string> lines, List<Chunk> tail, Ctx ctx)
    {
        if (oe.Element(One.Ns + "Table") is { } tbl)
        {
            tail.Add(Chunk.Table(TableToCsv(tbl)));
            // A table's cells hang off Table/Row/Cell/OEChildren/OE — NOT off this OE's OEChildren —
            // so the recursion below never reaches them, and Table-ToCsv only takes text. Pull the
            // media out explicitly, or every picture in a table is lost (120 of them, here).
            foreach (var media in tbl.Descendants().Where(e => e.Name == One.Ns + "Image"
                                                            || e.Name == One.Ns + "InsertedFile"
                                                            || IsInk(e)))
            {
                if (media.Name == One.Ns + "Image") AddImage(media, tail, ctx);
                else if (media.Name == One.Ns + "InsertedFile") AddAttachment(media, tail, ctx);
                else if (media.Parent?.Name != One.Ns + "InkParagraph") AddInk(media, tail, ctx);
            }
        }

        if (oe.Element(One.Ns + "Image") is { } img) AddImage(img, tail, ctx);
        if (oe.Element(One.Ns + "InsertedFile") is { } ins) AddAttachment(ins, tail, ctx);
        foreach (var ink in oe.Elements().Where(IsInk)) AddInk(ink, tail, ctx);

        string txt = OeText(oe);
        if (txt.Length > 0)
        {
            string prefix = depth <= 0 ? "" : new string(' ', 2 * (depth - 1)) + "- ";
            lines.Add(prefix + txt);
        }

        foreach (var child in oe.Elements(One.Ns + "OEChildren").Elements(One.Ns + "OE"))
            WalkOe(child, depth + 1, lines, tail, ctx);
    }

    private static void AddImage(XElement img, List<Chunk> into, Ctx ctx)
    {
        string? b64 = img.Element(One.Ns + "Data")?.Value;
        // No Data means a web-content preview / callback-only image: there are no bytes to save.
        if (string.IsNullOrWhiteSpace(b64)) return;

        byte[] bytes = System.Convert.FromBase64String(b64.Trim());
        string ext = Mime.ExtFromBytes(bytes, (string?)img.Attribute("format"));
        into.Add(Chunk.Pointer(AddAsset(ctx.Assets, $"image-{Mime.ShortHash(bytes)}{ext}", bytes)));
    }

    /// <summary>An attachment (audio recording, pdf, …). OneNote keeps the bytes in its own cache
    /// and the original filename in <c>preferredName</c>; the page XML never inlines them.</summary>
    private static void AddAttachment(XElement ins, List<Chunk> into, Ctx ctx)
    {
        string? cache = (string?)ins.Attribute("pathCache");
        byte[]? bytes = cache is null ? null : ctx.ReadAttachment(cache);
        if (bytes is null)
        {
            ctx.Warn?.Invoke($"InsertedFile bytes missing, skipped: '{(string?)ins.Attribute("preferredName")}' (pathCache={cache})");
            return;
        }

        string pref = (string?)ins.Attribute("preferredName") is { } p && !string.IsNullOrWhiteSpace(p)
            ? p
            : $"file-{Mime.ShortHash(bytes)}.bin";
        into.Add(Chunk.Pointer(AddAsset(ctx.Assets, Names.Sanitize(pref, keepExtension: true), bytes)));
    }

    /// <summary>
    /// Handwriting. OneNote stores strokes as base64 ISF (Ink Serialized Format) in <c>one:Data</c>.
    /// Neither ISF nor InkML renders anywhere, so we rasterise-free convert to SVG — the only
    /// display format of the three, and one the engine already knows as <c>image/svg+xml</c>.
    /// Pressure, tilt and stroke timing are lost.
    /// </summary>
    private static void AddInk(XElement ink, List<Chunk> into, Ctx ctx)
    {
        // An InkParagraph wraps InkWords, each carrying its own strokes.
        var blobs = ink.Element(One.Ns + "Data") is not null
            ? [ink]
            : ink.Descendants().Where(e => IsInk(e) && e.Element(One.Ns + "Data") is not null).ToList();

        foreach (var el in blobs)
        {
            string? b64 = el.Element(One.Ns + "Data")?.Value;
            if (string.IsNullOrWhiteSpace(b64)) continue;

            byte[] isf = System.Convert.FromBase64String(b64.Trim());
            if (ctx.RenderInk is null) { ctx.Warn?.Invoke("ink found but no renderer supplied; skipped"); return; }

            string? svg = ctx.RenderInk(isf);
            if (svg is null)
            {
                ctx.Warn?.Invoke($"could not decode ink strokes ({isf.Length} bytes); skipped");
                continue;
            }

            byte[] bytes = System.Text.Encoding.UTF8.GetBytes(svg);
            into.Add(Chunk.Pointer(AddAsset(ctx.Assets, $"ink-{Mime.ShortHash(isf)}.svg", bytes)));
        }
    }

    /// <summary>Concatenate an OE's <c>one:T</c> runs, then convert the inline HTML to marklower.</summary>
    private static string OeText(XElement oe) =>
        Marklower.FromHtml(string.Concat(oe.Elements(One.Ns + "T").Select(t => t.Value)));

    private static string TableToCsv(XElement tbl)
    {
        var rows = new List<string>();
        foreach (var row in tbl.Elements(One.Ns + "Row"))
        {
            var cells = row.Elements(One.Ns + "Cell").Select(cell =>
            {
                var parts = cell.Descendants(One.Ns + "OE").Select(OeText).Where(t => t.Length > 0);
                return Yaml.CsvField(string.Join(" ", parts));
            });
            rows.Add(string.Join(",", cells));
        }
        return string.Join("\n", rows);
    }

    /// <summary>
    /// Register an asset once per page. Content-identical images share a hashed name, so a repeat is
    /// the same file. Two DIFFERENT files that collide on name get a " (2)" suffix — the PowerShell
    /// original returned early on any name match and silently dropped the second file's bytes.
    /// </summary>
    private static string AddAsset(List<Asset> assets, string name, byte[] bytes)
    {
        var existing = assets.FirstOrDefault(a => string.Equals(a.Name, name, StringComparison.Ordinal));
        if (existing is not null && existing.Bytes.AsSpan().SequenceEqual(bytes)) return name;

        string stem = Path.GetFileNameWithoutExtension(name), ext = Path.GetExtension(name);
        string final = name;
        for (int i = 2; assets.Any(a => string.Equals(a.Name, final, StringComparison.Ordinal)); i++)
            final = $"{stem} ({i}){ext}";

        assets.Add(new Asset(final, bytes));
        return final;
    }
}
