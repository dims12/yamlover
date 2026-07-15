using OneNote2Yamlover.Core.Model;
using OneNote2Yamlover.Core.Serialize;

namespace OneNote2Yamlover.Core.Sync;

/// <summary>Answers "does this child already exist at the DESTINATION?" — local dir probe or SFTP listing.</summary>
public interface IDestinationIndex
{
    bool ContainerChildExists(string relContainerPath, string childName);
}

public sealed class LocalDestinationIndex(string root) : IDestinationIndex
{
    public bool ContainerChildExists(string relContainerPath, string childName) =>
        Fs.DirectoryExists(Path.Combine(root,
            relContainerPath.Replace('/', Path.DirectorySeparatorChar), childName));
}

/// <summary>Nothing exists yet — used when the destination is known to be empty, and in tests.</summary>
public sealed class EmptyDestinationIndex : IDestinationIndex
{
    public bool ContainerChildExists(string relContainerPath, string childName) => false;
}

public static class AncestorReconciler
{
    /// <summary>
    /// Writes <c>body.yamlover</c> for every container on the path to a synced section, listing the
    /// children PRESENT AT THE DESTINATION, in OneNote's order.
    /// <para>
    /// The union matters: a fresh stage holds only THIS run's sections, so listing the stage would
    /// silently drop siblings synced earlier. Membership therefore comes from the destination, plus
    /// whatever this run is about to write — the synced sections AND every container on the path to
    /// one (a section group written this run is a child too, and must appear in its parent's list).
    /// </para>
    /// <para>
    /// The destination ROOT is deliberately left alone — the user may have pointed at an existing
    /// yamlover project, and clobbering its <c>.yamlover/body.yamlover</c> would be destructive.
    /// </para>
    /// </summary>
    public static void WriteAncestorBodies(string stageRoot, NamePlan plan,
                                           IReadOnlyCollection<OneNoteNode> syncedSections,
                                           IDestinationIndex destination)
    {
        var containers = syncedSections
            .SelectMany(plan.Ancestors)
            .Distinct()
            .ToList();

        var writtenThisRun = syncedSections.Select(plan.RelPath)
            .Concat(containers.Select(plan.RelPath))
            .ToHashSet(StringComparer.Ordinal);

        foreach (var c in containers)
        {
            string rel = plan.RelPath(c);
            var present = c.Children
                .Select(plan.DirName)
                .Where(name => writtenThisRun.Contains(rel + "/" + name)
                            || destination.ContainerChildExists(rel, name))
                .ToList();

            string dir = plan.LocalPath(stageRoot, c);
            Fs.CreateDirectory(Path.Combine(dir, ".yamlover"));
            Fs.WriteText(Path.Combine(dir, @".yamlover\body.yamlover"),
                         ChapterSerializer.Chapter(c.Name, null, present));
        }
    }
}
