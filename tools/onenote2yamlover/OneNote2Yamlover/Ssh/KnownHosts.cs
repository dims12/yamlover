using System.Security.Cryptography;
using System.Text;

namespace OneNote2Yamlover.Ssh;

public enum KnownHostStatus
{
    /// <summary>The stored key for this host matches — trust.</summary>
    Match,
    /// <summary>No entry for this host — ask the user once (trust on first use).</summary>
    Unknown,
    /// <summary>An entry exists and the key is DIFFERENT — refuse. Possible MITM.</summary>
    Mismatch,
}

/// <summary>
/// SSH.NET does not verify host keys and does not read known_hosts; without this every connection
/// silently trusts whatever answers. Compares the raw key blob, not a fingerprint, so it is immune
/// to hash-algorithm differences.
/// </summary>
public sealed class KnownHosts(string? path = null)
{
    private readonly string _path = path ??
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".ssh", "known_hosts");

    public KnownHostStatus Check(string host, int port, string keyType, byte[] keyBlob)
    {
        if (!File.Exists(_path)) return KnownHostStatus.Unknown;

        string wanted = Convert.ToBase64String(keyBlob);
        bool sawHost = false;

        foreach (string raw in File.ReadLines(_path))
        {
            string line = raw.Trim();
            if (line.Length == 0 || line.StartsWith('#') || line.StartsWith('@')) continue;

            var f = line.Split(' ', 3, StringSplitOptions.RemoveEmptyEntries);
            if (f.Length < 3) continue;
            if (!f[1].Equals(keyType, StringComparison.OrdinalIgnoreCase)) continue;
            if (!Matches(f[0], host, port)) continue;

            sawHost = true;
            if (f[2].Trim() == wanted) return KnownHostStatus.Match;
        }
        return sawHost ? KnownHostStatus.Mismatch : KnownHostStatus.Unknown;
    }

    private static bool Matches(string patterns, string host, int port)
    {
        string bracketed = port == 22 ? host : $"[{host}]:{port}";

        foreach (string p in patterns.Split(','))
        {
            // This machine's known_hosts is plain (104 entries, none hashed), but handle |1| anyway.
            if (p.StartsWith("|1|", StringComparison.Ordinal))
            {
                var bits = p.Split('|', StringSplitOptions.RemoveEmptyEntries);
                if (bits.Length != 3) continue;
                try
                {
                    using var hmac = new HMACSHA1(Convert.FromBase64String(bits[1]));
                    string h = Convert.ToBase64String(hmac.ComputeHash(Encoding.ASCII.GetBytes(bracketed)));
                    if (h == bits[2]) return true;
                }
                catch (FormatException) { /* malformed line — ignore */ }
            }
            else if (p.Equals(bracketed, StringComparison.OrdinalIgnoreCase)
                  || p.Equals(host, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }
        return false;
    }

    /// <summary>Append a newly-trusted host key, the way `ssh` itself would.</summary>
    public void Add(string host, int port, string keyType, byte[] keyBlob)
    {
        string name = port == 22 ? host : $"[{host}]:{port}";
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        File.AppendAllText(_path, $"{name} {keyType} {Convert.ToBase64String(keyBlob)}\n");
    }

    /// <summary>The SHA-256 fingerprint OpenSSH shows, for the trust prompt.</summary>
    public static string Fingerprint(byte[] keyBlob) =>
        "SHA256:" + Convert.ToBase64String(SHA256.HashData(keyBlob)).TrimEnd('=');
}
