using System.Text.RegularExpressions;

namespace OneNote2Yamlover.Core.Text;

/// <summary>Filesystem- and yamlover-safe naming. Ported from <c>Sanitize-Name</c> / <c>Get-UniqueName</c>.</summary>
public static partial class Names
{
    /// <summary>A OneNote page title is often a whole sentence; cap it so nested paths stay workable.</summary>
    public const int DefaultMaxLen = 60;

    [GeneratedRegex(@"[\x00-\x1F]")] private static partial Regex ControlChars();
    [GeneratedRegex(@"[<>:""/\\|?*]")] private static partial Regex WindowsIllegal();
    // `[` and `]` are legal on Windows but are the INDEX selector in a yamlover pointer path. A child
    // whose name holds one is unaddressable: the engine resolves it to null and the whole parent
    // chapter fails to render ("Cannot read properties of null"). Verified against the 0.3.21 engine.
    [GeneratedRegex(@"[\[\]]")] private static partial Regex Brackets();
    [GeneratedRegex(@"\s+")] private static partial Regex Whitespace();
    [GeneratedRegex(@"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$")] private static partial Regex ReservedDevice();

    /// <param name="keepExtension">
    /// Only for real filenames (an attachment's <c>preferredName</c>). A page title's trailing
    /// ".2 notes" is not an extension.
    /// </param>
    public static string Sanitize(string? s, int maxLen = DefaultMaxLen, bool keepExtension = false)
    {
        if (string.IsNullOrWhiteSpace(s)) return "Untitled";

        s = ControlChars().Replace(s, " ");
        s = WindowsIllegal().Replace(s, "-");
        s = Brackets().Replace(s, "-");
        s = Whitespace().Replace(s, " ").Trim();
        s = s.TrimEnd('.', ' ');

        if (s.Length > maxLen)
        {
            string ext = "";
            if (keepExtension)
            {
                string e = Path.GetExtension(s);
                if (e.Length >= 2 && e.Length <= 12) ext = e;
            }
            int keep = Math.Max(1, maxLen - ext.Length);
            s = string.Concat(s.AsSpan(0, Math.Min(keep, s.Length)).ToString().TrimEnd('.', ' '), ext);
        }

        if (s.Length == 0) s = "Untitled";
        if (ReservedDevice().IsMatch(s)) s = "_" + s;
        return s;
    }

    /// <summary>Dedupe within a directory by appending " (2)", " (3)"… Case-INSENSITIVE (a Windows path).</summary>
    public static string Unique(HashSet<string> used, string baseName, string ext)
    {
        string name = baseName + ext;
        for (int i = 2; !used.Add(name.ToLowerInvariant()); i++)
            name = $"{baseName} ({i}){ext}";
        return name;
    }

    /// <summary>A set with the comparer <see cref="Unique"/> expects.</summary>
    public static HashSet<string> NewUsedSet() => new(StringComparer.Ordinal);
}
