using System.Globalization;
using System.Text;
using System.Windows;
using System.Windows.Ink;

namespace OneNote2Yamlover.Sync;

/// <summary>
/// OneNote stores handwriting as base64 <b>ISF</b> (Ink Serialized Format) in <c>one:Data</c>.
/// WPF's <see cref="StrokeCollection"/> reads ISF directly, which is the whole reason this lives in
/// the WPF assembly rather than in Core.
/// <para>
/// We emit SVG rather than preserving ISF or converting to InkML: neither of those is a display
/// format — nothing renders them — whereas SVG is standardised, renders everywhere, and the yamlover
/// engine already maps <c>.svg</c> to <c>image/svg+xml</c>. Pressure, tilt and stroke timing are lost.
/// </para>
/// </summary>
public static class InkRenderer
{
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    /// <summary>ISF bytes → an SVG document, or null when the blob holds no readable strokes.</summary>
    public static string? ToSvg(byte[] isf)
    {
        StrokeCollection strokes;
        try
        {
            using var ms = new MemoryStream(isf);
            strokes = new StrokeCollection(ms);
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or EndOfStreamException)
        {
            return null;
        }
        if (strokes.Count == 0) return null;

        Rect bounds = strokes.GetBounds();
        if (bounds.IsEmpty || bounds.Width <= 0 || bounds.Height <= 0) return null;

        // A stroke is drawn centred on its path, so half the widest pen would be clipped by a
        // viewBox fitted to the geometry alone.
        double pad = strokes.Max(s => Math.Max(s.DrawingAttributes.Width, s.DrawingAttributes.Height)) / 2 + 1;
        double x = bounds.X - pad, y = bounds.Y - pad;
        double w = bounds.Width + 2 * pad, h = bounds.Height + 2 * pad;

        var sb = new StringBuilder();
        sb.Append(Inv, $"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="{N(x)} {N(y)} {N(w)} {N(h)}" width="{N(w)}" height="{N(h)}">""");
        sb.Append('\n');

        foreach (var stroke in strokes)
        {
            var pts = stroke.StylusPoints;
            if (pts.Count == 0) continue;

            var d = new StringBuilder();
            d.Append(Inv, $"M {N(pts[0].X)} {N(pts[0].Y)}");
            for (int i = 1; i < pts.Count; i++) d.Append(Inv, $" L {N(pts[i].X)} {N(pts[i].Y)}");

            var da = stroke.DrawingAttributes;
            double width = Math.Max(0.1, Math.Max(da.Width, da.Height));
            // A highlighter is a translucent wide nib; the alpha channel alone does not say so.
            double opacity = da.IsHighlighter ? 0.4 : da.Color.A / 255.0;

            sb.Append(Inv, $"""  <path d="{d}" fill="none" stroke="{Hex(da.Color)}" stroke-width="{N(width)}" """);
            if (opacity < 1) sb.Append(Inv, $"""stroke-opacity="{N(opacity)}" """);
            sb.Append("""stroke-linecap="round" stroke-linejoin="round"/>""").Append('\n');
        }

        sb.Append("</svg>\n");
        return sb.ToString();
    }

    /// <summary>Trim float noise: ink coordinates carry far more precision than a pixel needs.</summary>
    private static string N(double v) => Math.Round(v, 2).ToString(Inv);

    private static string Hex(System.Windows.Media.Color c) => $"#{c.R:X2}{c.G:X2}{c.B:X2}";
}
