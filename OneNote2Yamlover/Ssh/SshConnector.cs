using Renci.SshNet;

namespace OneNote2Yamlover.Ssh;

/// <summary>Decides whether to trust a host key we have never seen. Returns false to refuse.</summary>
public delegate bool TrustPrompt(SshHost host, string fingerprint);

public sealed record SshSession(SshClient Ssh, SftpClient Sftp) : IDisposable
{
    public void Dispose() { Sftp.Dispose(); Ssh.Dispose(); }
}

public static class SshConnector
{
    /// <exception cref="InvalidOperationException">the key is unusable, or the host key changed.</exception>
    public static SshSession Connect(SshHost host, TrustPrompt trustPrompt, string? passphrase = null)
    {
        if (host.KeyUnusable)
            throw new InvalidOperationException($"{host.Alias}: SSH.NET cannot read PuTTY (.ppk) keys. Convert it to OpenSSH format.");
        string? identity = host.IdentityFile;
        if (identity is null || !File.Exists(identity))
            throw new InvalidOperationException($"{host.Alias}: no usable IdentityFile ({identity ?? "none"}).");

        var key = passphrase is null ? new PrivateKeyFile(identity) : new PrivateKeyFile(identity, passphrase);

        string user = host.User ?? Environment.UserName;
        var info = new ConnectionInfo(host.HostName, host.Port, user, new PrivateKeyAuthenticationMethod(user, key));

        var known = new KnownHosts();
        var ssh = new SshClient(info);
        var sftp = new SftpClient(info);

        void Verify(object? _, Renci.SshNet.Common.HostKeyEventArgs e)
        {
            switch (known.Check(host.HostName, host.Port, e.HostKeyName, e.HostKey))
            {
                case KnownHostStatus.Match:
                    e.CanTrust = true;
                    break;
                case KnownHostStatus.Unknown:
                    e.CanTrust = trustPrompt(host, KnownHosts.Fingerprint(e.HostKey));
                    if (e.CanTrust) known.Add(host.HostName, host.Port, e.HostKeyName, e.HostKey);
                    break;
                default:
                    // An entry exists and the key changed. Refuse loudly rather than "just work".
                    e.CanTrust = false;
                    break;
            }
        }

        ssh.HostKeyReceived += Verify;
        sftp.HostKeyReceived += Verify;

        try
        {
            ssh.Connect();
            sftp.Connect();
        }
        catch
        {
            ssh.Dispose();
            sftp.Dispose();
            throw;
        }
        return new SshSession(ssh, sftp);
    }
}
