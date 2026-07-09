using OneNote2Yamlover.Core.Model;
using OneNote2Yamlover.Core.Text;

namespace OneNote2Yamlover.Core.Sync;

/// <summary>
/// Deterministic directory names for the whole OneNote tree, computed once. The materializer and the
/// ancestor reconciler MUST agree on names, and <see cref="Names.Unique"/> depends on sibling order,
/// so it is computed here for every container rather than twice from different call sites.
/// </summary>
public sealed class NamePlan
{
    private readonly Dictionary<OneNoteNode, string> _dirName = [];
    private readonly Dictionary<OneNoteNode, string> _relPath = [];
    private readonly Dictionary<OneNoteNode, OneNoteNode?> _parent = [];

    /// <summary>Containers only: notebooks and section groups (things that get a body.yamlover).</summary>
    public List<OneNoteNode> Containers { get; } = [];

    public NamePlan(IReadOnlyList<OneNoteNode> notebooks)
    {
        var rootUsed = Names.NewUsedSet();
        foreach (var nb in notebooks)
        {
            _dirName[nb] = Names.Unique(rootUsed, Names.Sanitize(nb.Name), "");
            _relPath[nb] = _dirName[nb];
            _parent[nb] = null;
            Walk(nb);
        }
    }

    private void Walk(OneNoteNode container)
    {
        if (container.IsSection) return;
        Containers.Add(container);

        var used = Names.NewUsedSet();
        foreach (var child in container.Children)
        {
            _dirName[child] = Names.Unique(used, Names.Sanitize(child.Name), "");
            _relPath[child] = _relPath[container] + "/" + _dirName[child];
            _parent[child] = container;
            Walk(child);
        }
    }

    public string DirName(OneNoteNode n) => _dirName[n];

    /// <summary>Destination-relative path with '/' separators, e.g. <c>Dmitry's Notebook/Автомобиль</c>.</summary>
    public string RelPath(OneNoteNode n) => _relPath[n];

    public OneNoteNode? Parent(OneNoteNode n) => _parent[n];

    /// <summary>The node's ancestors, nearest first.</summary>
    public IEnumerable<OneNoteNode> Ancestors(OneNoteNode n)
    {
        for (var p = Parent(n); p is not null; p = Parent(p)) yield return p;
    }

    /// <summary>A path relative to the destination root, as an OS path under <paramref name="root"/>.</summary>
    public string LocalPath(string root, OneNoteNode n) =>
        Path.Combine(root, RelPath(n).Replace('/', Path.DirectorySeparatorChar));
}
