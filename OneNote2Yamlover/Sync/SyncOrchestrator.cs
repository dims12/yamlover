using OneNote2Yamlover.Core.Model;
using OneNote2Yamlover.Core.Sync;
using OneNote2Yamlover.OneNote;

namespace OneNote2Yamlover.Sync;

public sealed record SyncResult(int Sections, int Pages, string Destination);

/// <summary>
/// One-way OneNote → yamlover. Runs entirely on a dedicated STA thread (COM affinity); progress is
/// marshalled back to the UI by <see cref="IProgress{T}"/> capturing the caller's context.
/// </summary>
public static class SyncOrchestrator
{
    public static Task<SyncResult> RunAsync(IReadOnlyList<OneNoteNode> notebooks,
                                            IReadOnlyCollection<string> selectedSectionIds,
                                            ISyncDestination destination,
                                            IProgress<SyncProgress> progress,
                                            Action<string>? log = null,
                                            CancellationToken ct = default)
        => StaWorker.RunAsync(token => Run(notebooks, selectedSectionIds, destination, progress, log, token), ct);

    private static SyncResult Run(IReadOnlyList<OneNoteNode> notebooks,
                                  IReadOnlyCollection<string> selectedSectionIds,
                                  ISyncDestination destination,
                                  IProgress<SyncProgress> progress,
                                  Action<string>? log,
                                  CancellationToken ct)
    {
        using var one = new OneNoteClient(log);
        var plan = new NamePlan(notebooks);

        var sections = notebooks.SelectMany(n => n.DescendantsAndSelf())
                                .Where(n => n.IsSection && selectedSectionIds.Contains(n.Id))
                                .ToList();
        if (sections.Count == 0) throw new InvalidOperationException("No sections selected.");

        // Enumerate first so Convert gets a determinate bar.
        var pagesBySection = new Dictionary<OneNoteNode, List<PageNode>>();
        int totalPages = 0, i = 0;
        foreach (var s in sections)
        {
            ct.ThrowIfCancellationRequested();
            progress.Report(new SyncProgress(Phase.Enumerate, ++i, sections.Count, s.Name));
            var pages = HierarchyParser.ReconstructPages(one.GetSectionPagesXml(s.Id));
            pagesBySection[s] = pages;
            totalPages += pages.Sum(p => p.CountWithSub());
        }
        log?.Invoke($"{sections.Count} section(s), {totalPages} page(s)");

        string stage = Path.Combine(Path.GetTempPath(), "o2y-stage-" + Guid.NewGuid().ToString("N")[..8]);
        try
        {
            long donePages = 0;
            var mat = new Materializer(one.GetPageXml, InkRenderer.ToSvg, w => log?.Invoke("WARN " + w));

            foreach (var s in sections)
            {
                ct.ThrowIfCancellationRequested();
                mat.MaterializeSection(s, plan.LocalPath(stage, s), pagesBySection[s],
                    onPage: name => progress.Report(new SyncProgress(Phase.Convert, ++donePages, totalPages, name)),
                    ct: ct);
            }

            // Ancestor bodies must union THIS run with what earlier syncs left at the destination,
            // or a partial selection silently drops previously-synced siblings from the parent chapter.
            AncestorReconciler.WriteAncestorBodies(stage, plan, sections, destination.Index);

            destination.Publish(stage, sections.Select(plan.RelPath).ToList(), progress, ct);
            progress.Report(new SyncProgress(Phase.Done, 1, 1));
            return new SyncResult(sections.Count, totalPages, destination.Describe);
        }
        finally
        {
            try { Fs.DeleteDirectory(stage); } catch (IOException) { /* best effort */ }
        }
    }
}
