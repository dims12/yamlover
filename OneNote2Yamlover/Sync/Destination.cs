using OneNote2Yamlover.Core.Sync;

namespace OneNote2Yamlover.Sync;

public enum Phase { Enumerate, Convert, Package, Upload, Extract, Done }

public readonly record struct SyncProgress(Phase Phase, long Current, long Total, string? Item = null)
{
    /// <summary>Convert dominates; weight the overall bar so 312 pages move it smoothly.</summary>
    public double Overall => Phase switch
    {
        Phase.Enumerate => 0.05 * Frac,
        Phase.Convert => 0.05 + 0.70 * Frac,
        Phase.Package => 0.75 + 0.05 * Frac,
        Phase.Upload => 0.80 + 0.15 * Frac,
        Phase.Extract => 0.95 + 0.05 * Frac,
        _ => 1.0,
    };

    private double Frac => Total > 0 ? Math.Clamp((double)Current / Total, 0, 1) : 0;
}

/// <summary>Where a sync lands. Exactly one is chosen in the UI.</summary>
public interface ISyncDestination : IDisposable
{
    string Describe { get; }

    /// <summary>Used by the ancestor reconciler to see what earlier syncs already put there.</summary>
    IDestinationIndex Index { get; }

    /// <summary>
    /// Mirror the selected subtree: remove each section directory in <paramref name="mirrorRelPaths"/>
    /// at the destination, then write everything under <paramref name="stageRoot"/> over the top.
    /// Containers are never deleted, so unrelated notebooks survive.
    /// </summary>
    void Publish(string stageRoot, IReadOnlyCollection<string> mirrorRelPaths,
                 IProgress<SyncProgress> progress, CancellationToken ct);
}

public sealed class LocalDestination(string root) : ISyncDestination
{
    public string Root { get; } = root;
    public string Describe => Root;
    public IDestinationIndex Index { get; } = new LocalDestinationIndex(root);

    public void Publish(string stageRoot, IReadOnlyCollection<string> mirrorRelPaths,
                        IProgress<SyncProgress> progress, CancellationToken ct)
    {
        foreach (string rel in mirrorRelPaths)
        {
            ct.ThrowIfCancellationRequested();
            Fs.DeleteDirectory(Path.Combine(Root, rel.Replace('/', Path.DirectorySeparatorChar)));
        }

        var files = Directory.EnumerateFiles(Fs.Long(stageRoot), "*", SearchOption.AllDirectories).ToList();
        long done = 0;
        foreach (string src in files)
        {
            ct.ThrowIfCancellationRequested();
            string rel = Path.GetRelativePath(Fs.Long(stageRoot), src);
            string dst = Path.Combine(Root, rel);
            Fs.CreateDirectory(Path.GetDirectoryName(dst)!);
            File.Copy(src, Fs.Long(dst), overwrite: true);
            progress.Report(new SyncProgress(Phase.Upload, ++done, files.Count, rel));
        }
    }

    public void Dispose() { }
}
