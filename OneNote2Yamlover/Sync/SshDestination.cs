using System.Formats.Tar;
using System.IO.Compression;
using OneNote2Yamlover.Core.Sync;
using Renci.SshNet;

namespace OneNote2Yamlover.Sync;

/// <summary>An SFTP/SSH destination. Stages locally, ships ONE tarball, extracts remotely.</summary>
public sealed class SshDestination(SftpClient sftp, SshClient ssh, string host, string remoteRoot) : ISyncDestination
{
    public string Describe => $"{host}:{remoteRoot}";
    public IDestinationIndex Index { get; } = new SftpDestinationIndex(sftp, remoteRoot);

    public void Publish(string stageRoot, IReadOnlyCollection<string> mirrorRelPaths,
                        IProgress<SyncProgress> progress, CancellationToken ct)
    {
        foreach (string rel in mirrorRelPaths) Guard(Posix(remoteRoot, rel));

        string tgz = Path.Combine(Path.GetTempPath(), $"o2y-{Guid.NewGuid():N}.tgz");
        try
        {
            long bytes = Package(stageRoot, tgz, progress, ct);

            ct.ThrowIfCancellationRequested();
            string remoteTmp = $"/tmp/{Path.GetFileName(tgz)}";
            using (var fs = File.OpenRead(tgz))
                sftp.UploadFile(fs, remoteTmp, uploaded =>
                    progress.Report(new SyncProgress(Phase.Upload, (long)uploaded, bytes)));

            ct.ThrowIfCancellationRequested();
            progress.Report(new SyncProgress(Phase.Extract, 0, 1, "extracting"));
            Extract(mirrorRelPaths, remoteTmp);
            progress.Report(new SyncProgress(Phase.Extract, 1, 1));
        }
        finally { if (File.Exists(tgz)) File.Delete(tgz); }
    }

    /// <summary>PAX carries UTF-8 filenames, which the Cyrillic page titles need.</summary>
    private static long Package(string stageRoot, string tgz, IProgress<SyncProgress> progress, CancellationToken ct)
    {
        string root = Fs.Long(stageRoot);
        var files = Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories).ToList();

        using (var outFile = File.Create(tgz))
        using (var gz = new GZipStream(outFile, CompressionLevel.Optimal))
        using (var tar = new TarWriter(gz, TarEntryFormat.Pax, leaveOpen: false))
        {
            long done = 0;
            foreach (string abs in files)
            {
                ct.ThrowIfCancellationRequested();
                string rel = Path.GetRelativePath(root, abs).Replace('\\', '/');
                using var fs = File.OpenRead(abs);
                tar.WriteEntry(new PaxTarEntry(TarEntryType.RegularFile, rel) { DataStream = fs });
                progress.Report(new SyncProgress(Phase.Package, ++done, files.Count, rel));
            }
        }
        return new FileInfo(tgz).Length;
    }

    private void Extract(IReadOnlyCollection<string> mirrorRelPaths, string remoteTmp)
    {
        var rm = string.Join("\n", mirrorRelPaths.Select(r => $"rm -rf {Quote(Posix(remoteRoot, r))}"));

        // Judge by exit status, never stderr: GNU tar warns "unknown extended header keyword
        // LIBARCHIVE.creationtime" about bsdtar/pax headers, which is noise.
        string script = $"""
            set -e
            {rm}
            mkdir -p {Quote(remoteRoot)}
            tar --warning=no-unknown-keyword -xzf {Quote(remoteTmp)} -C {Quote(remoteRoot)}
            rm -f {Quote(remoteTmp)}
            """;

        using var cmd = ssh.CreateCommand(script);
        cmd.Execute();
        if (cmd.ExitStatus != 0)
            throw new InvalidOperationException($"remote extract failed (exit {cmd.ExitStatus}): {cmd.Error}");
    }

    /// <summary>Ported from Push-Remote: never let a bad path turn into `rm -rf` on something real.</summary>
    private static void Guard(string p)
    {
        if (p.Length < 10 || System.Text.RegularExpressions.Regex.IsMatch(p, "^/(home|usr|etc|var|opt|tmp)?/?$"))
            throw new InvalidOperationException($"refusing to delete remote path '{p}'");
    }

    private static string Posix(string root, string rel) => root.TrimEnd('/') + "/" + rel;
    private static string Quote(string s) => "'" + s.Replace("'", "'\\''") + "'";

    /// <summary>No-op: the SSH session is owned by the caller, which keeps browsing after a sync.</summary>
    public void Dispose() { }
}

public sealed class SftpDestinationIndex(SftpClient sftp, string remoteRoot) : IDestinationIndex
{
    private readonly Dictionary<string, HashSet<string>> _cache = [];

    public bool ContainerChildExists(string relContainerPath, string childName)
    {
        if (!_cache.TryGetValue(relContainerPath, out var names))
        {
            string dir = remoteRoot.TrimEnd('/') + "/" + relContainerPath;
            names = new HashSet<string>(StringComparer.Ordinal);
            try
            {
                foreach (var e in sftp.ListDirectory(dir))
                    if (e.IsDirectory && e.Name != "." && e.Name != "..")
                        names.Add(e.Name);
            }
            catch (Renci.SshNet.Common.SftpPathNotFoundException) { /* nothing synced here yet */ }
            _cache[relContainerPath] = names;
        }
        return names.Contains(childName);
    }
}
