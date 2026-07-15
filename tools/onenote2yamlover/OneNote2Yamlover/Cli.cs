namespace OneNote2Yamlover;

/// <summary>
/// Command-line driving of the real window. This is not a headless mode: the UI is created and bound
/// exactly as a user would see it, which is the only way to exercise WPF-specific faults (an
/// ObservableCollection mutated off the UI thread throws only once an ItemsControl is bound to it).
/// </summary>
public sealed record CliOptions(
    bool Sync,
    string Notebook,
    IReadOnlyList<string> Sections,
    string? LocalDest,
    string? RemoteHost,
    string? RemotePath,
    bool KeepOpen)
{
    public bool IsRemote => RemoteHost is not null;

    public static CliOptions? Parse(string[] args)
    {
        if (args.Length == 0) return null;

        bool sync = false, keepOpen = false;
        string notebook = "Dmitry's Notebook";
        var sections = new List<string>();
        string? local = null, host = null, remotePath = null;

        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--sync": sync = true; break;
                case "--keep-open": keepOpen = true; break;
                case "--notebook": notebook = Next(args, ref i); break;
                case "--section": sections.Add(Next(args, ref i)); break;
                case "--dest": local = Next(args, ref i); break;
                case "--remote":
                    // host:/abs/path
                    string spec = Next(args, ref i);
                    int c = spec.IndexOf(':');
                    if (c <= 0) throw new ArgumentException("--remote expects host:/abs/path");
                    host = spec[..c];
                    remotePath = spec[(c + 1)..];
                    break;
                case "--help" or "-h":
                    throw new ArgumentException(Usage);
                default:
                    throw new ArgumentException($"unknown argument '{args[i]}'\n\n{Usage}");
            }
        }

        if (!sync) return null;
        if (sections.Count == 0) throw new ArgumentException("--sync needs at least one --section");
        if (local is null && host is null) throw new ArgumentException("--sync needs --dest or --remote");
        if (local is not null && host is not null) throw new ArgumentException("--dest and --remote are exclusive");

        return new CliOptions(sync, notebook, sections, local, host, remotePath, keepOpen);
    }

    private static string Next(string[] args, ref int i) =>
        ++i < args.Length ? args[i] : throw new ArgumentException($"'{args[i - 1]}' needs a value");

    public const string Usage = """
        OneNote2Yamlover [--sync --section <name> ... (--dest <dir> | --remote host:/abs/path)]
                         [--notebook <name>] [--keep-open]

          --sync              drive a sync from the command line, then exit
          --section <name>    section to sync (repeatable)
          --dest <dir>        local destination directory
          --remote host:/path ssh destination; host is an alias from ~/.ssh/config
          --notebook <name>   defaults to "Dmitry's Notebook"
          --keep-open         leave the window open after the sync finishes

        With no arguments the app starts normally.
        Exit code is 0 on success, 1 on failure.
        """;
}
