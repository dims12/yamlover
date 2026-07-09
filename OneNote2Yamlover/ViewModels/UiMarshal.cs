namespace OneNote2Yamlover.ViewModels;

/// <summary>
/// Marshals a callback onto the thread that created it.
/// <para>
/// An <see cref="ObservableCollection{T}"/> bound to an ItemsControl may only be mutated on the UI
/// thread: WPF's ItemContainerGenerator receives CollectionChanged events and reconciles them against
/// its own state, so an off-thread Add throws "An ItemsControl is inconsistent with its items source"
/// on the next layout pass. <see cref="IProgress{T}"/> does this capture for you; a plain
/// <c>Action&lt;string&gt;</c> log callback does not, and the sync runs on a dedicated STA thread.
/// </para>
/// </summary>
public sealed class UiMarshal
{
    private readonly SynchronizationContext? _context;

    /// <summary>Construct on the UI thread.</summary>
    public UiMarshal() => _context = SynchronizationContext.Current;

    internal UiMarshal(SynchronizationContext? context) => _context = context;

    public void Post(Action action)
    {
        if (_context is null || SynchronizationContext.Current == _context) action();
        else _context.Post(_ => action(), null);
    }
}
