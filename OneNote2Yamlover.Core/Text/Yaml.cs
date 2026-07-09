using System.Text.RegularExpressions;

namespace OneNote2Yamlover.Core.Text;

/// <summary>yamlover surface syntax. Ported from <c>Escape-Ptr</c>, <c>Yaml-Scalar</c>, <c>Csv-Field</c>.</summary>
public static partial class Yaml
{
    // A pointer key is bare only when unambiguous. Page names routinely contain spaces, and a bare
    // key holding one is a parse error (parser/ts/src/pointer.ts: "a key containing a space must be
    // quoted"). Quoting also covers [ ] : # * & ~ ? ! ( ) < > = | and both quote characters.
    [GeneratedRegex(@"^[^\s:\\/\[\]*&#~?!()<>=|'""]+$")] private static partial Regex SafeBareKey();
    [GeneratedRegex(@"^\.+$")] private static partial Regex AllDots();
    [GeneratedRegex(@"^[\p{L}\p{N}]")] private static partial Regex StartsAlnum();
    [GeneratedRegex(@"[:#\r\n]")] private static partial Regex ScalarNeedsQuote();
    [GeneratedRegex(@"["",]")] private static partial Regex CsvNeedsQuote();

    /// <summary>
    /// A pointer key: bare when unambiguous, else double-quoted. An all-dots key must be quoted too,
    /// or <c>..</c> reads as the parent selector. Inside double quotes only \ and " need escaping.
    /// </summary>
    public static string EscapePointer(string s)
    {
        if (SafeBareKey().IsMatch(s) && !AllDots().IsMatch(s)) return s;
        return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    /// <summary>A YAML scalar: bare when safe, else double-quoted with \n and quote escaping.</summary>
    public static string Scalar(string? s)
    {
        if (s is null) return "\"\"";
        if (s.Length > 0 && StartsAlnum().IsMatch(s) && !ScalarNeedsQuote().IsMatch(s)
            && s == s.Trim() && !s.StartsWith('*'))
            return s;

        string e = s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "").Replace("\n", "\\n");
        return "\"" + e + "\"";
    }

    /// <summary>
    /// RFC 4180. A cell's newlines collapse to a space: a bare newline inside a block-scalar CSV
    /// chunk would read as a row break, and OneNote cells wrap for layout, not meaning.
    /// </summary>
    public static string CsvField(string s)
    {
        s = s.Replace("\r", "").Replace("\n", " ");
        if (CsvNeedsQuote().IsMatch(s) || s != s.Trim())
            return "\"" + s.Replace("\"", "\"\"") + "\"";
        return s;
    }
}
