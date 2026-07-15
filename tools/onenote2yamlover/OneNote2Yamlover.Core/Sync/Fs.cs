using System.Text;

namespace OneNote2Yamlover.Core.Sync;

/// <summary>
/// Long-path-safe filesystem helpers. Windows MAX_PATH is 260 and a notebook nests
/// notebook/group/section/page/subpage/.yamlover/body.yamlover, so the `\\?\` prefix is required
/// even with capped names. It takes only a NORMALIZED ABSOLUTE path — `..` is not resolved for you,
/// and Path.Combine on a `\\?\` path is fine but Path.GetFullPath on one is not idempotent-safe.
/// </summary>
public static class Fs
{
    private static readonly UTF8Encoding Utf8NoBom = new(encoderShouldEmitUTF8Identifier: false);

    public static string Long(string path)
    {
        if (!OperatingSystem.IsWindows()) return path;
        if (path.StartsWith(@"\\?\", StringComparison.Ordinal)) return path;
        string full = Path.GetFullPath(path);
        if (full.StartsWith(@"\\", StringComparison.Ordinal)) return @"\\?\UNC\" + full[2..];
        return @"\\?\" + full;
    }

    public static void CreateDirectory(string path) => Directory.CreateDirectory(Long(path));
    public static bool DirectoryExists(string path) => Directory.Exists(Long(path));
    public static bool FileExists(string path) => File.Exists(Long(path));
    public static void DeleteDirectory(string path)
    {
        if (DirectoryExists(path)) Directory.Delete(Long(path), recursive: true);
    }

    /// <summary>yamlover files are UTF-8 with NO byte-order mark.</summary>
    public static void WriteText(string path, string text) => File.WriteAllText(Long(path), text, Utf8NoBom);
    public static void WriteBytes(string path, byte[] bytes) => File.WriteAllBytes(Long(path), bytes);

    public static IEnumerable<string> EnumerateEntryNames(string dir) =>
        DirectoryExists(dir)
            ? Directory.EnumerateFileSystemEntries(Long(dir)).Select(Path.GetFileName).OfType<string>()
            : [];
}
