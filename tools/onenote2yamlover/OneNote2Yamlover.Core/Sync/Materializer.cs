using OneNote2Yamlover.Core.Convert;
using OneNote2Yamlover.Core.Model;
using OneNote2Yamlover.Core.Serialize;
using OneNote2Yamlover.Core.Text;

namespace OneNote2Yamlover.Core.Sync;

/// <summary>Writes one section's pages into a directory tree. Ported from <c>Materialize-Page</c>/<c>-Section</c>.</summary>
/// <param name="renderInk">ISF → SVG. Supplied by the host, since decoding ink needs WPF.</param>
public sealed class Materializer(Func<string, string> getPageXml,
                                 Func<byte[], string?>? renderInk = null,
                                 Action<string>? warn = null)
{
    /// <summary>
    /// Writes <paramref name="section"/> into <paramref name="sectionDir"/>. The directory name is
    /// decided by <see cref="NamePlan"/>, not here, so the ancestor reconciler agrees with what
    /// actually lands on disk.
    /// </summary>
    public void MaterializeSection(OneNoteNode section, string sectionDir, IReadOnlyList<PageNode> pages,
                                   Action<string>? onPage = null, CancellationToken ct = default)
    {
        Fs.CreateDirectory(Path.Combine(sectionDir, ".yamlover"));

        var used = Names.NewUsedSet();
        var childNames = new List<string>();
        foreach (var p in pages)
        {
            ct.ThrowIfCancellationRequested();
            childNames.Add(MaterializePage(p, sectionDir, used, onPage, ct));
        }

        Fs.WriteText(Path.Combine(sectionDir, @".yamlover\body.yamlover"),
                     ChapterSerializer.Chapter(section.Name, null, childNames));
    }

    private string MaterializePage(PageNode page, string parentDir, HashSet<string> usedInParent,
                                   Action<string>? onPage, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        onPage?.Invoke(page.Name);

        var conv = PageConverter.Convert(getPageXml(page.Id), renderInk: renderInk, warn: warn);
        bool needsDir = conv.Assets.Count > 0 || page.Sub.Count > 0;
        string baseName = Names.Sanitize(page.Name);

        if (!needsDir)
        {
            string fileName = Names.Unique(usedInParent, baseName, ".yamlover");
            Fs.WriteText(Path.Combine(parentDir, fileName),
                         ChapterSerializer.Chapter(page.Name, conv.Chunks, null));
            return fileName;
        }

        string dirName = Names.Unique(usedInParent, baseName, "");
        string dir = Path.Combine(parentDir, dirName);
        Fs.CreateDirectory(Path.Combine(dir, ".yamlover"));

        foreach (var a in conv.Assets) Fs.WriteBytes(Path.Combine(dir, a.Name), a.Bytes);
        if (ChapterSerializer.Meta(conv.Assets) is { } meta)
            Fs.WriteText(Path.Combine(dir, @".yamlover\meta.yamlover"), meta);

        var used = Names.NewUsedSet();
        var childNames = new List<string>();
        foreach (var sp in page.Sub) childNames.Add(MaterializePage(sp, dir, used, onPage, ct));

        Fs.WriteText(Path.Combine(dir, @".yamlover\body.yamlover"),
                     ChapterSerializer.Chapter(page.Name, conv.Chunks, childNames));
        return dirName;
    }
}
