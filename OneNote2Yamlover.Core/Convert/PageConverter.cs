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
    public static PageConversion Convert(string pageXml, Func<string, byte[]?>? readAttachment = null,
                                         Action<string>? warn = null)
    {
        readAttachment ??= p => File.Exists(p) ? File.ReadAllBytes(p) : null;

        var doc = XDocument.Parse(pageXml);
        var chunks = new List<Chunk>();
        var assets = new List<Asset>();

        foreach (var outline in doc.Descendants(One.Ns + "Outline"))
        {
            foreach (var oe in outline.Elements(One.Ns + "OEChildren").Elements(One.Ns + "OE"))
            {
                var lines = new List<string>();
                var tail = new List<Chunk>();
                WalkOe(oe, 0, lines, tail, assets, readAttachment, warn);

                if (lines.Count > 0) chunks.Add(Chunk.Prose(string.Join("\n", lines)));
                chunks.AddRange(tail);
            }
        }
        return new PageConversion(chunks, assets);
    }

    private static void WalkOe(XElement oe, int depth, List<string> lines, List<Chunk> tail,
                               List<Asset> assets, Func<string, byte[]?> readAttachment, Action<string>? warn)
    {
        if (oe.Element(One.Ns + "Table") is { } tbl)
            tail.Add(Chunk.Table(TableToCsv(tbl)));

        if (oe.Element(One.Ns + "Image") is { } img)
        {
            string? b64 = img.Element(One.Ns + "Data")?.Value;
            if (!string.IsNullOrWhiteSpace(b64))
            {
                byte[] bytes = System.Convert.FromBase64String(b64.Trim());
                string name = AddAsset(assets, $"image-{Mime.ShortHash(bytes)}{Mime.ExtFromFormat((string?)img.Attribute("format"))}", bytes);
                tail.Add(Chunk.Pointer(name));
            }
            // else: a web-content preview / callback-only image — skipped, the adjacent link is already a chunk.
        }

        // An attachment (audio recording, pdf, …). OneNote keeps the bytes in its own cache and the
        // original filename in `preferredName`; the page XML never inlines them.
        if (oe.Element(One.Ns + "InsertedFile") is { } ins)
        {
            string? cache = (string?)ins.Attribute("pathCache");
            byte[]? bytes = cache is null ? null : readAttachment(cache);
            if (bytes is not null)
            {
                string pref = (string?)ins.Attribute("preferredName") is { } p && !string.IsNullOrWhiteSpace(p)
                    ? p
                    : $"file-{Mime.ShortHash(bytes)}.bin";
                string name = AddAsset(assets, Names.Sanitize(pref, keepExtension: true), bytes);
                tail.Add(Chunk.Pointer(name));
            }
            else
            {
                warn?.Invoke($"InsertedFile bytes missing, skipped: '{(string?)ins.Attribute("preferredName")}' (pathCache={cache})");
            }
        }

        string txt = OeText(oe);
        if (txt.Length > 0)
        {
            string prefix = depth <= 0 ? "" : new string(' ', 2 * (depth - 1)) + "- ";
            lines.Add(prefix + txt);
        }

        foreach (var child in oe.Elements(One.Ns + "OEChildren").Elements(One.Ns + "OE"))
            WalkOe(child, depth + 1, lines, tail, assets, readAttachment, warn);
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
