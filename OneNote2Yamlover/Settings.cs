using System.Text.Json;

namespace OneNote2Yamlover;

/// <summary>Remembered between runs so the app comes up where you left it, already pointed at a destination.</summary>
public sealed class Settings
{
    public double WindowWidth { get; set; } = 1060;
    public double WindowHeight { get; set; } = 660;
    public double WindowLeft { get; set; } = double.NaN;
    public double WindowTop { get; set; } = double.NaN;
    public bool Maximized { get; set; }

    /// <summary>Left pane's share of the horizontal space, 0..1.</summary>
    public double SplitRatio { get; set; } = 0.5;
    public double LogHeight { get; set; } = 120;

    public bool IsRemote { get; set; }
    public string LocalPath { get; set; } = "";
    public string RemoteHost { get; set; } = "";
    public string RemotePath { get; set; } = "";

    private static string Path_ => System.IO.Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "OneNote2Yamlover", "settings.json");

    public static Settings Load()
    {
        try
        {
            if (File.Exists(Path_))
                return JsonSerializer.Deserialize<Settings>(File.ReadAllText(Path_)) ?? new Settings();
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            // A corrupt or unreadable settings file must never stop the app from starting.
        }
        return new Settings();
    }

    public void Save()
    {
        // System.Text.Json refuses to write NaN/Infinity, and an unpositioned window reports NaN for
        // Left/Top. Drop those back to the "no saved position" sentinel the loader already handles.
        if (!double.IsFinite(WindowLeft) || !double.IsFinite(WindowTop)) { WindowLeft = WindowTop = 0; }
        if (!double.IsFinite(WindowWidth) || WindowWidth <= 0) WindowWidth = 1060;
        if (!double.IsFinite(WindowHeight) || WindowHeight <= 0) WindowHeight = 660;
        if (!double.IsFinite(SplitRatio)) SplitRatio = 0.5;
        if (!double.IsFinite(LogHeight) || LogHeight < 0) LogHeight = 120;

        try
        {
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(Path_)!);
            File.WriteAllText(Path_, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException
                                      or ArgumentException or NotSupportedException)
        {
            // Persisting preferences must never take the app down on the way out.
        }
    }
}
