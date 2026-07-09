namespace OneNote2Yamlover.Ssh;

public sealed record SshHost(string Alias, string HostName, string? User, int Port, string? IdentityFile)
{
    /// <summary>SSH.NET cannot read PuTTY keys.</summary>
    public bool KeyUnusable => IdentityFile is not null &&
        IdentityFile.EndsWith(".ppk", StringComparison.OrdinalIgnoreCase);

    public override string ToString() => User is null ? Alias : $"{Alias}  ({User}@{HostName})";
}

/// <summary>
/// A minimal ~/.ssh/config reader. SSH.NET does not read ssh_config at all, so host/user/key must be
/// resolved here. Handles the shapes that actually occur in this user's file: multi-host `Host`
/// lines, indented `#`-comments, `~` and backslash IdentityFile paths, and hosts with no HostName
/// (the alias IS the hostname).
/// </summary>
public static class SshConfig
{
    public static string DefaultPath =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".ssh", "config");

    public static List<SshHost> Load(string? path = null)
    {
        path ??= DefaultPath;
        if (!File.Exists(path)) return [];

        var hosts = new List<SshHost>();
        List<string> aliases = [];
        string? hostName = null, user = null, identity = null;
        int port = 22;

        void Flush()
        {
            foreach (var a in aliases)
                hosts.Add(new SshHost(a, hostName ?? a, user, port, Expand(identity)));
            aliases = [];
            hostName = user = identity = null;
            port = 22;
        }

        foreach (string raw in File.ReadLines(path))
        {
            string line = raw.Trim();
            if (line.Length == 0 || line.StartsWith('#')) continue;   // includes indented `#IdentityFile`

            var parts = line.Split((char[])[' ', '\t'], 2, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 2) continue;
            string key = parts[0], value = parts[1].Trim();

            if (key.Equals("Host", StringComparison.OrdinalIgnoreCase))
            {
                Flush();
                // A `Host` line may name several aliases. Wildcard patterns are match rules, not
                // connectable hosts, so they never reach the picker.
                aliases = value.Split((char[])[' ', '\t'], StringSplitOptions.RemoveEmptyEntries)
                               .Where(a => !a.Contains('*') && !a.Contains('?'))
                               .ToList();
            }
            else if (key.Equals("HostName", StringComparison.OrdinalIgnoreCase)) hostName = value;
            else if (key.Equals("User", StringComparison.OrdinalIgnoreCase)) user = value;
            else if (key.Equals("IdentityFile", StringComparison.OrdinalIgnoreCase)) identity = value;
            else if (key.Equals("Port", StringComparison.OrdinalIgnoreCase) && int.TryParse(value, out int p)) port = p;
        }
        Flush();
        return hosts;
    }

    private static string? Expand(string? p)
    {
        if (string.IsNullOrWhiteSpace(p)) return null;
        p = p.Trim('"');
        if (p.StartsWith('~'))
            p = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) + p[1..].Replace('/', '\\');
        return p;
    }
}
