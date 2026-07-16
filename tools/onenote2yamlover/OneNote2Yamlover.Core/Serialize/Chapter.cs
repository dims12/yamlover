using System.Text;
using OneNote2Yamlover.Core.Text;

namespace OneNote2Yamlover.Core.Serialize;

public enum ChunkKind
{
    /// <summary>Prose. Emitted as a bare block scalar; marklower is the default format.</summary>
    Text,
    /// <summary>A table (TABLE.md). Emitted as a <c>!!&lt;*yamlover: $defs: table&gt;</c> node.</summary>
    Table,
    /// <summary>A pointer to a sibling file (image, attachment) or a subchapter directory.</summary>
    Pointer,
}

/// <summary>A grid (TABLE.md): rows of cells, top to bottom / left to right. OneNote has no
/// header rows and no merged cells, so the model carries neither — every row is a body row.</summary>
public sealed record TableModel(IReadOnlyList<TableRow> Rows);

public sealed record TableRow(IReadOnlyList<TableCell> Cells);

/// <summary>A cell is marklower prose, a nested table, or — when a OneNote cell mixes prose and
/// tables — a CHAPTER whose body keeps both in order (the cell schema is
/// <c>anyOf: [chunk, table, chapter]</c>; the chapter branch enters by its explicit tag).</summary>
public sealed record TableCell(string Text = "", TableModel? Nested = null, IReadOnlyList<Chunk>? Chapter = null);

/// <param name="Text">Body for <see cref="ChunkKind.Text"/>.</param>
/// <param name="File">Target name for <see cref="ChunkKind.Pointer"/>.</param>
/// <param name="Table">The grid for <see cref="ChunkKind.Table"/>.</param>
public readonly record struct Chunk(ChunkKind Kind, string Text = "", string File = "", TableModel? Table = null)
{
    public static Chunk Prose(string text) => new(ChunkKind.Text, Text: text);
    public static Chunk Grid(TableModel table) => new(ChunkKind.Table, Table: table);
    public static Chunk Pointer(string file) => new(ChunkKind.Pointer, File: file);
}

/// <summary>An asset written next to a chapter and declared in its <c>meta.yamlover</c>.</summary>
public sealed record Asset(string Name, byte[] Bytes);

/// <summary>Ported from <c>Serialize-Chapter</c> / <c>Serialize-Meta</c>.</summary>
public static class ChapterSerializer
{
    public const string Tag = "!!<*yamlover: $defs: chapter>";
    public const string TableTag = "!!<*yamlover: $defs: table>";

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
                case ChunkKind.Table:
                    sb.Append("- ").Append(TableTag).Append('\n');
                    AppendTableRows(sb, c.Table!, 2);
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

    /// <summary>
    /// A table's rows at <paramref name="indent"/> (TABLE.md; the worked shape is
    /// examples/74-table.yamlover). A row of single-line prose cells is FLOW
    /// (<c>- [a, 'b c']</c>); a row holding a multi-line cell or a nested table is BLOCK —
    /// a lone <c>-</c> with each cell a <c>- </c> item two columns deeper (yamlover has no
    /// compact <c>- - cell</c> nesting). A nested-table cell is itself a lone <c>-</c> whose
    /// rows follow at its child indent — the recursion bottoms out in prose cells.
    /// </summary>
    private static void AppendTableRows(StringBuilder sb, TableModel table, int indent)
    {
        string pad = new(' ', indent);
        foreach (var row in table.Rows)
        {
            if (row.Cells.All(c => c.Nested is null && c.Chapter is null && !c.Text.Contains('\n')))
            {
                sb.Append(pad).Append("- [")
                  .Append(string.Join(", ", row.Cells.Select(c => Yaml.FlowCell(c.Text))))
                  .Append("]\n");
                continue;
            }
            sb.Append(pad).Append("-\n");
            foreach (var cell in row.Cells)
            {
                if (cell.Chapter is not null)
                {
                    // an untagged container cell reads as a nested table, so the chapter's tag decides
                    sb.Append(pad).Append("  - ").Append(Tag).Append('\n');
                    AppendCellChapter(sb, cell.Chapter, indent + 4);
                }
                else if (cell.Nested is not null)
                {
                    sb.Append(pad).Append("  -\n");
                    AppendTableRows(sb, cell.Nested, indent + 4);
                }
                else if (cell.Text.Contains('\n'))
                {
                    sb.Append(pad).Append("  - |-\n");
                    foreach (var line in cell.Text.Split('\n'))
                        sb.Append(line.Length > 0 ? pad + "    " + line : "").Append('\n');
                }
                else
                {
                    sb.Append(pad).Append("  - ").Append(Yaml.Scalar(cell.Text)).Append('\n');
                }
            }
        }
    }

    /// <summary>A chapter CELL's body (a cell mixing prose and tables): the ordered chunks as the
    /// chapter's positional items at <paramref name="indent"/>. Prose follows the cell conventions
    /// (plain scalar, or <c>|-</c> when multi-line); a table enters by its explicit tag.</summary>
    private static void AppendCellChapter(StringBuilder sb, IReadOnlyList<Chunk> body, int indent)
    {
        string pad = new(' ', indent);
        foreach (var c in body)
        {
            switch (c.Kind)
            {
                case ChunkKind.Table:
                    sb.Append(pad).Append("- ").Append(TableTag).Append('\n');
                    AppendTableRows(sb, c.Table!, indent + 2);
                    break;
                case ChunkKind.Pointer:
                    sb.Append(pad).Append("- *: ").Append(Yaml.EscapePointer(c.File)).Append('\n');
                    break;
                case ChunkKind.Text when c.Text.Contains('\n'):
                    sb.Append(pad).Append("- |-\n");
                    foreach (var line in c.Text.Split('\n'))
                        sb.Append(line.Length > 0 ? pad + "  " + line : "").Append('\n');
                    break;
                default:
                    sb.Append(pad).Append("- ").Append(Yaml.Scalar(c.Text)).Append('\n');
                    break;
            }
        }
    }
}
