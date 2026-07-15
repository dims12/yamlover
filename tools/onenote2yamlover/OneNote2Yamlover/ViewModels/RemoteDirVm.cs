using System.Collections.ObjectModel;
using Renci.SshNet;

namespace OneNote2Yamlover.ViewModels;

/// <summary>A remote directory, loaded lazily on expand. A dummy child makes the expander appear first.</summary>
public sealed class RemoteDirVm : ObservableBase
{
    private static readonly RemoteDirVm Placeholder = new();
    private readonly SftpClient? _sftp;
    private bool _loaded;
    private bool _isExpanded;

    private RemoteDirVm() { Name = "…"; Path = ""; }

    public RemoteDirVm(SftpClient sftp, string path, string? name = null)
    {
        _sftp = sftp;
        Path = path;
        Name = name ?? (path == "/" ? "/" : System.IO.Path.GetFileName(path.TrimEnd('/')));
        Children = [Placeholder];
    }

    public string Name { get; }
    public string Path { get; }
    public ObservableCollection<RemoteDirVm> Children { get; } = [];

    public bool IsExpanded
    {
        get => _isExpanded;
        set
        {
            if (!Set(ref _isExpanded, value) || !value) return;
            Load();
        }
    }

    public string? Error { get; private set; }

    private void Load()
    {
        if (_loaded || _sftp is null) return;
        _loaded = true;
        Children.Clear();
        try
        {
            var dirs = _sftp.ListDirectory(Path)
                            .Where(e => e.IsDirectory && e.Name is not ("." or ".."))
                            .OrderBy(e => e.Name, StringComparer.OrdinalIgnoreCase);
            foreach (var d in dirs) Children.Add(new RemoteDirVm(_sftp, d.FullName, d.Name));
        }
        catch (Exception ex)
        {
            Error = ex.Message;
            Raise(nameof(Error));
        }
    }
}
