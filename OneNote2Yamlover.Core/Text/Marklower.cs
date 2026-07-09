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

    /// <summary>
    /// `[label](t)` points at a target; `*[label](t)` INLINES it (MARKLOWER.md §Embeds). A YouTube or
    /// Vimeo target becomes a privacy-preserving player facade; a video file becomes a native
    /// &lt;video&gt;. Anything else degrades to the plain link it already was, so only widen this
    /// where the spec promises an embed — a bare `*` on a non-embeddable target buys nothing and
    /// collides with emphasis.
    /// <para>Images are deliberately NOT embedded: an external `<img>` is a hotlink, and OneNote
    /// already gives us the bytes as a separate chunk.</para>
    /// </summary>
    public static bool IsEmbeddable(string target)
    {
        if (!Uri.TryCreate(target, UriKind.Absolute, out var uri)) return false;
        if (uri.Scheme is not ("http" or "https")) return false;

        string host = uri.Host.StartsWith("www.", StringComparison.OrdinalIgnoreCase) ? uri.Host[4..] : uri.Host;
        if (host is "youtube.com" or "youtu.be" or "m.youtube.com" or "youtube-nocookie.com" or "vimeo.com")
            return true;

        string ext = Path.GetExtension(uri.AbsolutePath).ToLowerInvariant();
        return ext is ".mp4" or ".webm" or ".ogv" or ".mov";
    }

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
            string target = Decode(m.Groups[1].Value);
            string deref = IsEmbeddable(target) ? "*" : "";
            return $"{lead}{deref}[{core}]({target}){trail}";
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
