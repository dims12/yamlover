using System.Collections.ObjectModel;
using OneNote2Yamlover.Core.Model;

namespace OneNote2Yamlover.ViewModels;

/// <summary>
/// WPF's TreeView has no multi-select, so the tri-state checkbox IS the multi-select. Setting
/// <see cref="IsChecked"/> cascades DOWN to every descendant, then asks the parent to reconcile UP:
/// all children checked → true, none → false, otherwise null (the dash).
/// </summary>
public sealed class TreeNodeVm : ObservableBase
{
    private readonly OneNoteNode _node;
    private bool _reconciling;
    private bool? _isChecked = false;
    private bool _isExpanded;

    public TreeNodeVm(OneNoteNode node, TreeNodeVm? parent = null)
    {
        _node = node;
        Parent = parent;
        Children = new ObservableCollection<TreeNodeVm>(node.Children.Select(c => new TreeNodeVm(c, this)));
    }

    public TreeNodeVm? Parent { get; }
    public ObservableCollection<TreeNodeVm> Children { get; }

    public string Name => _node.Name;
    public string DisplayName => _node.DisplayName;
    public NodeKind Kind => _node.Kind;
    public bool IsSection => _node.IsSection;
    public string? SectionId => _node.IsSection ? _node.Id : null;

    /// <summary>A section with pages is a leaf; notebooks and groups start collapsed.</summary>
    public bool IsExpanded { get => _isExpanded; set => Set(ref _isExpanded, value); }

    public string Glyph => Kind switch
    {
        NodeKind.Notebook => "📓",
        NodeKind.SectionGroup => "📁",
        _ => "📄",
    };

    public bool? IsChecked
    {
        get => _isChecked;
        set => SetChecked(value, cascadeDown: true, reconcileUp: true);
    }

    private void SetChecked(bool? value, bool cascadeDown, bool reconcileUp)
    {
        if (_isChecked == value && !_reconciling) return;

        _reconciling = true;
        _isChecked = value;
        Raise(nameof(IsChecked));

        if (cascadeDown && value.HasValue)
            foreach (var c in Children)
                c.SetChecked(value, cascadeDown: true, reconcileUp: false);

        if (reconcileUp) Parent?.ReconcileFromChildren();

        _reconciling = false;
    }

    private void ReconcileFromChildren()
    {
        if (Children.Count == 0) return;
        bool all = Children.All(c => c.IsChecked == true);
        bool none = Children.All(c => c.IsChecked == false);
        SetChecked(all ? true : none ? false : null, cascadeDown: false, reconcileUp: true);
    }

    /// <summary>The selection set: every checked leaf that carries a section id.</summary>
    public IEnumerable<string> CheckedSectionIds()
    {
        if (SectionId is not null && IsChecked == true) yield return SectionId;
        foreach (var id in Children.SelectMany(c => c.CheckedSectionIds())) yield return id;
    }

    public int CheckedSectionCount() => CheckedSectionIds().Count();
}
