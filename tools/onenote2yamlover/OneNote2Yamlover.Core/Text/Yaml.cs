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
    [GeneratedRegex(@"[\s,\[\]:#'""{}]")] private static partial Regex FlowCellNeedsQuote();

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
    /// A table cell in a FLOW row (TABLE.md; the caller keeps multi-line cells out — those force
    /// the block row form). Plain only when the flow lexer takes the token whole: non-empty, no
    /// whitespace or <c>, [ ] : # ' " { }</c>, and not opening with a yamlover sigil. Everything
    /// else is single-quoted with <c>''</c> doubling — the one escape the parser reads (a
    /// double-quoted backslash escape does NOT parse in flow).
    /// </summary>
    public static string FlowCell(string s)
    {
        s = s.Replace("\r", "");
        bool plain = s.Length > 0 && s == s.Trim()
            && !FlowCellNeedsQuote().IsMatch(s) && !"*&-|>!".Contains(s[0]);
        return plain ? s : "'" + s.Replace("'", "''") + "'";
    }
}
