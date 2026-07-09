using System.Security.Cryptography;

namespace OneNote2Yamlover.Core.Text;

/// <summary>Asset naming and typing. Ported from <c>Mime-FromName</c>, <c>Ext-FromFormat</c>, <c>Short-Hash</c>.</summary>
public static class Mime
{
    // Declared in .yamlover/meta.yamlover so /api/blob streams the asset with the right
    // Content-Type; the engine's own EXT_FORMAT knows images but not media.
    private static readonly Dictionary<string, string> ByExtension = new(StringComparer.OrdinalIgnoreCase)
    {
        [".png"] = "image/png", [".jpg"] = "image/jpeg", [".jpeg"] = "image/jpeg", [".gif"] = "image/gif",
        [".bmp"] = "image/bmp", [".tif"] = "image/tiff", [".tiff"] = "image/tiff", [".webp"] = "image/webp",
        [".svg"] = "image/svg+xml", [".ico"] = "image/x-icon", [".heic"] = "image/heic",
        [".3gp"] = "audio/3gpp", [".3g2"] = "audio/3gpp2", [".m4a"] = "audio/mp4", [".mp3"] = "audio/mpeg",
        [".wav"] = "audio/wav", [".wma"] = "audio/x-ms-wma", [".ogg"] = "audio/ogg", [".oga"] = "audio/ogg",
        [".opus"] = "audio/opus", [".aac"] = "audio/aac", [".flac"] = "audio/flac", [".amr"] = "audio/amr",
        [".mp4"] = "video/mp4", [".m4v"] = "video/mp4", [".mov"] = "video/quicktime", [".avi"] = "video/x-msvideo",
        [".wmv"] = "video/x-ms-wmv", [".mkv"] = "video/x-matroska", [".webm"] = "video/webm",
        [".pdf"] = "application/pdf", [".zip"] = "application/zip", [".rtf"] = "application/rtf",
        [".doc"] = "application/msword", [".xls"] = "application/vnd.ms-excel",
        [".ppt"] = "application/vnd.ms-powerpoint",
        [".docx"] = "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        [".xlsx"] = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        [".pptx"] = "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        [".epub"] = "application/epub+zip", [".djvu"] = "image/vnd.djvu",
        [".psd"] = "image/vnd.adobe.photoshop",
        [".txt"] = "text/plain", [".csv"] = "text/csv", [".htm"] = "text/html", [".html"] = "text/html",
        [".json"] = "application/json", [".xml"] = "application/xml",
    };

    public static string FromName(string name) =>
        ByExtension.GetValueOrDefault(Path.GetExtension(name), "application/octet-stream");

    /// <summary>OneNote's <c>one:Image/@format</c> → a file extension.</summary>
    public static string ExtFromFormat(string? format) => format switch
    {
        "image/png" => ".png",
        "image/jpeg" => ".jpg",
        "image/gif" => ".gif",
        "image/bmp" => ".bmp",
        "image/tiff" => ".tiff",
        _ => ".png",
    };

    /// <summary>
    /// The real extension, sniffed from the magic bytes. OneNote leaves <c>one:Image/@format</c>
    /// EMPTY on every image in practice, so trusting it names a JPEG "image-xxxx.png" and the
    /// engine then serves it with the wrong Content-Type. Falls back to the declared format.
    /// </summary>
    public static string ExtFromBytes(byte[] b, string? declaredFormat = null)
    {
        static bool Starts(byte[] b, params byte[] magic) =>
            b.Length >= magic.Length && b.AsSpan(0, magic.Length).SequenceEqual(magic);

        if (Starts(b, 0x89, 0x50, 0x4E, 0x47)) return ".png";
        if (Starts(b, 0xFF, 0xD8, 0xFF)) return ".jpg";
        if (Starts(b, 0x47, 0x49, 0x46, 0x38)) return ".gif";
        if (Starts(b, 0x42, 0x4D)) return ".bmp";
        if (Starts(b, 0x49, 0x49, 0x2A, 0x00) || Starts(b, 0x4D, 0x4D, 0x00, 0x2A)) return ".tiff";
        // RIFF....WEBP
        if (b.Length >= 12 && Starts(b, 0x52, 0x49, 0x46, 0x46) &&
            b[8] == 0x57 && b[9] == 0x45 && b[10] == 0x42 && b[11] == 0x50) return ".webp";
        if (b.Length >= 4 && b[0] == 0x00 && b[1] == 0x00 && b[2] == 0x01 && b[3] == 0x00) return ".ico";

        return ExtFromFormat(string.IsNullOrEmpty(declaredFormat) ? null : declaredFormat);
    }

    /// <summary>First 4 bytes of SHA-1, hex. Content id for an extracted image.</summary>
    // System.Convert must be qualified: the namespace OneNote2Yamlover.Core.Convert shadows it.
    public static string ShortHash(byte[] bytes) => System.Convert.ToHexStringLower(SHA1.HashData(bytes).AsSpan(0, 4));
}
