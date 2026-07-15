using System.Text;
using OneNote2Yamlover.Core.Text;

namespace OneNote2Yamlover.Core.Serialize;

public enum ChunkKind
{
    /// <summary>Prose. Emitted as a bare block scalar; marklower is the default format.</summary>
    Text,
    /// <summary>A table. Emitted with an inline <c>!!&lt;format: text/csv&gt;</c> tag.</summary>
    Csv,
    /// <summary>A pointer to a sibling file (image, attachment) or a subchapter directory.</summary>
    Pointer,
}

/// <param name="Text">Body for <see cref="ChunkKind.Text"/> / <see cref="ChunkKind.Csv"/>.</param>
/// <param name="File">Target name for <see cref="ChunkKind.Pointer"/>.</param>
public readonly record struct Chunk(ChunkKind Kind, string Text = "", string File = "")
{
    public static Chunk Prose(string text) => new(ChunkKind.Text, Text: text);
    public static Chunk Table(string csv) => new(ChunkKind.Csv, Text: csv);
    public static Chunk Pointer(string file) => new(ChunkKind.Pointer, File: file);
}

/// <summary>An asset written next to a chapter and declared in its <c>meta.yamlover</c>.</summary>
public sealed record Asset(string Name, byte[] Bytes);

/// <summary>Ported from <c>Serialize-Chapter</c> / <c>Serialize-Meta</c>.</summary>
public static class ChapterSerializer
{
    public const string Tag = "!!<*yamlover: $defs: chapter>";

    /// <summary>
    /// One positional body: chunks, then subchapter pointers. OneNote subpages always follow their
    /// parent page's own content, so appending them preserves the author's order. The
    /// <c>- *: name</c> pointers are what override the engine's alphabetical directory scan.
    /// There is no <c>chunks:</c> key and no <c>children:</c> key (yamlover CHAPTER.md).
    /// </summary>
    public static string Chapter(string title, IReadOnlyList<Chunk>? chunks, IReadOnlyList<string>? childNames)
    {
        var sb = new StringBuilder();
        sb.Append(Tag).Append('\n');
        sb.Append("title: ").Append(Yaml.Scalar(title)).Append('\n');

        foreach (var c in chunks ?? [])
        {
            switch (c.Kind)
            {
                case ChunkKind.Pointer:
                    sb.Append("- *: ").Append(Yaml.EscapePointer(c.File)).Append('\n');
                    break;
                case ChunkKind.Csv:
                    sb.Append("- !!<format: text/csv> |\n");
                    AppendBlockScalar(sb, c.Text);
                    break;
                default:
                    sb.Append("- |\n");
                    AppendBlockScalar(sb, c.Text);
                    break;
            }
        }

        foreach (var n in childNames ?? [])
            sb.Append("- *: ").Append(Yaml.EscapePointer(n)).Append('\n');

        return sb.ToString();
    }

    /// <summary>
    /// <c>.yamlover/meta.yamlover</c> declares each asset's (type, format), so the engine serves it
    /// with the right Content-Type instead of sniffing application/octet-stream (examples/65).
    /// Returns null when there is nothing to declare.
    /// </summary>
    public static string? Meta(IReadOnlyList<Asset>? assets)
    {
        if (assets is null || assets.Count == 0) return null;
        var sb = new StringBuilder("properties:\n");
        foreach (var a in assets)
            sb.Append("  ").Append(Yaml.Scalar(a.Name))
              .Append(": { type: binary, format: ").Append(Mime.FromName(a.Name)).Append(" }\n");
        return sb.ToString();
    }

    private static void AppendBlockScalar(StringBuilder sb, string text)
    {
        foreach (var line in text.Split('\n'))
            sb.Append("  ").Append(line).Append('\n');
    }
}
