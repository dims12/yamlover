using System.Xml.Linq;

namespace OneNote2Yamlover.Core.Model;

public static class One
{
    public static readonly XNamespace Ns = "http://schemas.microsoft.com/office/onenote/2013/onenote";
}

public enum NodeKind { Notebook, SectionGroup, Section }

/// <summary>A node of the OneNote tree ABOVE the page level: notebook, section group, or section.</summary>
public sealed class OneNoteNode(NodeKind kind, string id, string name, string? displayName = null)
{
    public NodeKind Kind { get; } = kind;
    public string Id { get; } = id;
    /// <summary>The `name` attribute — the on-disk folder name, frozen at creation. Keys all paths.</summary>
    public string Name { get; } = name;
    /// <summary>What OneNote shows: the notebook `nickname` (tracks renames); elsewhere just the name.</summary>
    public string DisplayName { get; } = displayName ?? name;
    public List<OneNoteNode> Children { get; } = [];

    public bool IsSection => Kind == NodeKind.Section;

    public IEnumerable<OneNoteNode> DescendantsAndSelf()
    {
        yield return this;
        foreach (var c in Children)
            foreach (var d in c.DescendantsAndSelf())
                yield return d;
    }
}

/// <summary>A page and its subpages, rebuilt from OneNote's flat <c>pageLevel</c> list.</summary>
public sealed class PageNode(string id, string name)
{
    public string Id { get; } = id;
    public string Name { get; } = name;
    public List<PageNode> Sub { get; } = [];

    public int CountWithSub() => 1 + Sub.Sum(s => s.CountWithSub());
}

public static class HierarchyParser
{
    /// <summary>Parse the XML from <c>GetHierarchy("", hsSections)</c>. Recycle bins are dropped.</summary>
    public static List<OneNoteNode> ParseNotebooks(string xml)
    {
        var doc = XDocument.Parse(xml);
        return doc.Root?.Elements(One.Ns + "Notebook").Select(ParseContainer).OfType<OneNoteNode>().ToList() ?? [];
    }

    private static OneNoteNode? ParseContainer(XElement e)
    {
        // `isRecycleBin` marks the group; `isInRecycleBin` marks anything inside one.
        if ((string?)e.Attribute("isRecycleBin") == "true") return null;
        if ((string?)e.Attribute("isInRecycleBin") == "true") return null;

        var kind = e.Name.LocalName switch
        {
            "Notebook" => NodeKind.Notebook,
            "SectionGroup" => NodeKind.SectionGroup,
            _ => NodeKind.Section,
        };
        // Only notebooks carry `nickname` — the display name that tracks renames, while `name`
        // stays the on-disk folder name (and may hold escaped control chars, e.g. "Linux^J Unix").
        var nickname = kind == NodeKind.Notebook ? (string?)e.Attribute("nickname") : null;
        var node = new OneNoteNode(kind, (string?)e.Attribute("ID") ?? "",
                                   (string?)e.Attribute("name") ?? "Untitled", nickname);

        if (kind != NodeKind.Section)
            foreach (var child in e.Elements().Where(c => c.Name == One.Ns + "SectionGroup" || c.Name == One.Ns + "Section"))
                if (ParseContainer(child) is { } n)
                    node.Children.Add(n);

        return node;
    }

    /// <summary>
    /// Rebuild the subpage tree from the flat page list. Ported from <c>Reconstruct-Pages</c>:
    /// OneNote emits pages in order with a <c>pageLevel</c>, not nested.
    /// </summary>
    public static List<PageNode> ReconstructPages(string sectionPagesXml)
    {
        var doc = XDocument.Parse(sectionPagesXml);
        var roots = new List<PageNode>();
        var stack = new Dictionary<int, PageNode>();

        foreach (var pg in doc.Descendants(One.Ns + "Page"))
        {
            if ((string?)pg.Attribute("isInRecycleBin") == "true") continue;

            int level = int.TryParse((string?)pg.Attribute("pageLevel"), out var l) ? Math.Max(1, l) : 1;
            var node = new PageNode((string?)pg.Attribute("ID") ?? "", (string?)pg.Attribute("name") ?? "Untitled");

            if (level <= 1)
            {
                roots.Add(node);
                stack.Clear();
                stack[1] = node;
            }
            else
            {
                if (stack.TryGetValue(level - 1, out var parent)) parent.Sub.Add(node);
                else roots.Add(node);
                stack[level] = node;
            }
        }
        return roots;
    }
}
