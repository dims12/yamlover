using System.Net;
using System.Text.RegularExpressions;

namespace OneNote2Yamlover.Core.Text;

/// <summary>OneNote inline HTML → marklower. Ported from <c>Html-To-Marklower</c>.</summary>
public static partial class Marklower
{
    [GeneratedRegex(@"(?is)<a\s+[^>]*?href\s*=\s*""([^""]*)""[^>]*>(.*?)</a>")] private static partial Regex Anchor();
    [GeneratedRegex(@"(?is)<span[^>]*font-weight\s*:\s*bold[^>]*>(.*?)</span>")] private static partial Regex Bold();
    [GeneratedRegex(@"(?is)<span[^>]*font-style\s*:\s*italic[^>]*>(.*?)</span>")] private static partial Regex Italic();
    [GeneratedRegex(@"(?is)<span[^>]*text-decoration\s*:[^>]*line-through[^>]*>(.*?)</span>")] private static partial Regex Strike();
    [GeneratedRegex(@"(?is)<br\s*/?>")] private static partial Regex Br();
    [GeneratedRegex(@"(?is)<[^>]+>")] private static partial Regex AnyTag();

    public static string StripTags(string s) => AnyTag().Replace(s, "");
    public static string Decode(string? s) => s is null ? "" : WebUtility.HtmlDecode(s);

    public static string FromHtml(string? html)
    {
        if (string.IsNullOrEmpty(html)) return "";

        // Links first. OneNote often puts the separating space INSIDE the <a>; keep it outside the
        // label rather than trimming it away, or "identity </a>plus" collapses to "](url)plus".
        // Note: Trim() also strips U+00A0 (&nbsp;), which hoisting preserves.
        string h = Anchor().Replace(html, m =>
        {
            string inner = Decode(StripTags(m.Groups[2].Value));
            string core = inner.Trim();
            if (core.Length == 0) return inner;   // whitespace-only anchor: no label to emit
            string lead = inner[..(inner.Length - inner.TrimStart().Length)];
            string trail = inner[inner.TrimEnd().Length..];
            return $"{lead}[{core}]({Decode(m.Groups[1].Value)}){trail}";
        });

        h = Bold().Replace(h, m => "**" + StripTags(m.Groups[1].Value) + "**");
        h = Italic().Replace(h, m => "*" + StripTags(m.Groups[1].Value) + "*");
        h = Strike().Replace(h, m => "~~" + StripTags(m.Groups[1].Value) + "~~");
        h = Br().Replace(h, "\n");
        h = StripTags(h);
        h = Decode(h);
        return h.Trim();
    }
}
