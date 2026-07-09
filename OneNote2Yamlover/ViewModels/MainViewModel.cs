using System.Collections.ObjectModel;
using System.IO;
using OneNote2Yamlover.Core.Model;
using OneNote2Yamlover.OneNote;
using OneNote2Yamlover.Ssh;
using OneNote2Yamlover.Sync;

namespace OneNote2Yamlover.ViewModels;

public sealed class MainViewModel : ObservableBase
{
    /// <summary>Captured on the UI thread; the sync's log callback fires on the STA worker.</summary>
    private readonly UiMarshal _ui = new();
    private IReadOnlyList<OneNoteNode> _notebooks = [];
    private CancellationTokenSource? _cts;

    private bool _isBusy, _isRemote;
    private string _status = "Load the OneNote tree to begin.";
    private double _progress;
    private string _localPath = "";
    private SshHost? _selectedHost;
    private SshSession? _session;
    private RemoteDirVm? _selectedRemoteDir;

    public MainViewModel()
    {
        LoadTreeCommand = new RelayCommand(async _ => await LoadTreeCoreAsync(), _ => !IsBusy);
        BrowseLocalCommand = new RelayCommand(_ => BrowseLocal(), _ => !IsBusy);
        ConnectCommand = new RelayCommand(async _ => await ConnectAsync(), _ => !IsBusy && SelectedHost is not null);
        SyncCommand = new RelayCommand(async _ => await SyncAsync(), _ => !IsBusy && CanSync);
        CancelCommand = new RelayCommand(_ => _cts?.Cancel(), _ => IsBusy);

        Hosts = new ObservableCollection<SshHost>(SshConfig.Load().OrderBy(h => h.Alias, StringComparer.OrdinalIgnoreCase));
    }

    /// <summary>Set by the view: shows the SHA-256 fingerprint of an unknown host key and asks.</summary>
    public TrustPrompt TrustPrompt { get; set; } = (_, _) => false;
    public Action<string>? PickLocalFolder { get; set; }
    public Func<string, string, bool>? Confirm { get; set; }

    public ObservableCollection<TreeNodeVm> Notebooks { get; } = [];
    public ObservableCollection<SshHost> Hosts { get; }
    public ObservableCollection<RemoteDirVm> RemoteRoots { get; } = [];
    public ObservableCollection<string> Log { get; } = [];

    public RelayCommand LoadTreeCommand { get; }
    public RelayCommand BrowseLocalCommand { get; }
    public RelayCommand ConnectCommand { get; }
    public RelayCommand SyncCommand { get; }
    public RelayCommand CancelCommand { get; }

    public bool IsBusy
    {
        get => _isBusy;
        private set { if (Set(ref _isBusy, value)) RefreshCommands(); }
    }

    public bool IsRemote
    {
        get => _isRemote;
        set { if (Set(ref _isRemote, value)) { Raise(nameof(DestinationSummary)); RefreshCommands(); } }
    }

    public string Status { get => _status; private set => Set(ref _status, value); }
    public double Progress { get => _progress; private set => Set(ref _progress, value); }

    public string LocalPath
    {
        get => _localPath;
        set { if (Set(ref _localPath, value)) { Raise(nameof(DestinationSummary)); RefreshCommands(); } }
    }

    public SshHost? SelectedHost
    {
        get => _selectedHost;
        set { if (Set(ref _selectedHost, value)) RefreshCommands(); }
    }

    public RemoteDirVm? SelectedRemoteDir
    {
        get => _selectedRemoteDir;
        set { if (Set(ref _selectedRemoteDir, value)) { Raise(nameof(DestinationSummary)); RefreshCommands(); } }
    }

    public int SelectedSectionCount => Notebooks.Sum(n => n.CheckedSectionCount());

    public string DestinationSummary => IsRemote
        ? (_session is null ? "not connected"
            : SelectedRemoteDir is null ? $"{SelectedHost?.Alias}: choose a directory"
            : $"{SelectedHost?.Alias}:{SelectedRemoteDir.Path}")
        : (string.IsNullOrWhiteSpace(LocalPath) ? "choose a folder" : LocalPath);

    private bool CanSync =>
        _notebooks.Count > 0 && SelectedSectionCount > 0 &&
        (IsRemote ? _session is not null && SelectedRemoteDir is not null : Directory.Exists(LocalPath));

    public void OnSelectionChanged()
    {
        Raise(nameof(SelectedSectionCount));
        RefreshCommands();
    }

    private void RefreshCommands()
    {
        LoadTreeCommand.RaiseCanExecuteChanged();
        BrowseLocalCommand.RaiseCanExecuteChanged();
        ConnectCommand.RaiseCanExecuteChanged();
        SyncCommand.RaiseCanExecuteChanged();
        CancelCommand.RaiseCanExecuteChanged();
    }

    /// <summary>
    /// Safe to call from the STA sync thread. Log is bound to a ListBox, and WPF only tolerates
    /// CollectionChanged from the UI thread — an off-thread Add throws "An ItemsControl is
    /// inconsistent with its items source" on the next layout pass. (Verified by reverting this.)
    /// </summary>
    private void Say(string line) => _ui.Post(() =>
    {
        Log.Add(line);
        while (Log.Count > 400) Log.RemoveAt(0);
    });

    /// <summary>True after a sync completes without an exception. Used by the CLI to set an exit code.</summary>
    public bool LastSyncSucceeded { get; private set; }

    /// <summary>Tick the named sections of a notebook. Returns how many matched.</summary>
    public int SelectSections(string notebook, IEnumerable<string> sectionNames)
    {
        var wanted = sectionNames.ToHashSet(StringComparer.Ordinal);
        int hits = 0;

        void Walk(TreeNodeVm n)
        {
            if (n.IsSection && wanted.Contains(n.Name)) { n.IsChecked = true; hits++; }
            foreach (var c in n.Children) Walk(c);
        }

        foreach (var nb in Notebooks.Where(n => n.Name == notebook)) Walk(nb);
        OnSelectionChanged();
        return hits;
    }

    public async Task ConnectToAsync(string alias)
    {
        SelectedHost = Hosts.FirstOrDefault(h => h.Alias == alias)
                       ?? throw new InvalidOperationException($"host '{alias}' not found in ~/.ssh/config");
        IsRemote = true;
        await ConnectAsync();
        if (_session is null) throw new InvalidOperationException(Status);
    }

    /// <summary>
    /// Restore the destination remembered from the last run. Failures are reported, never fatal —
    /// a remote host may simply be unreachable right now.
    /// </summary>
    public async Task RestoreDestinationAsync(Settings s)
    {
        if (!string.IsNullOrWhiteSpace(s.LocalPath)) LocalPath = s.LocalPath;

        if (s.IsRemote && !string.IsNullOrWhiteSpace(s.RemoteHost))
        {
            try
            {
                await ConnectToAsync(s.RemoteHost);
                if (!string.IsNullOrWhiteSpace(s.RemotePath)) UseRemotePath(s.RemotePath);
            }
            catch (Exception ex)
            {
                Status = $"Could not restore {s.RemoteHost}: {ex.Message}";
                Say(Status);
            }
        }
    }

    /// <summary>Point at an arbitrary remote directory without browsing to it.</summary>
    public void UseRemotePath(string path)
    {
        if (_session is null) throw new InvalidOperationException("not connected");
        SelectedRemoteDir = new RemoteDirVm(_session.Sftp, path);
    }

    public Task LoadTreeAsync() => LoadTreeCoreAsync();
    public Task RunSyncAsync() => SyncAsync();

    private async Task LoadTreeCoreAsync()
    {
        IsBusy = true;
        Status = "Reading OneNote hierarchy…";
        try
        {
            // GetHierarchy(hsSections): notebooks -> section groups -> sections, no pages.
            var notebooks = await StaWorker.RunAsync(_ =>
            {
                using var one = new OneNoteClient();
                return HierarchyParser.ParseNotebooks(one.GetSectionTreeXml());
            });

            _notebooks = notebooks;
            Notebooks.Clear();
            foreach (var nb in notebooks) Notebooks.Add(new TreeNodeVm(nb));

            int sections = notebooks.SelectMany(n => n.DescendantsAndSelf()).Count(n => n.IsSection);
            Status = $"{notebooks.Count} notebook(s), {sections} section(s). Tick what to sync.";
            Say(Status);
        }
        catch (Exception ex)
        {
            Status = "OneNote failed: " + ex.Message;
            Say(Status);
        }
        finally
        {
            IsBusy = false;
            OnSelectionChanged();
        }
    }

    private void BrowseLocal() => PickLocalFolder?.Invoke(LocalPath);

    private async Task ConnectAsync()
    {
        if (SelectedHost is null) return;
        var host = SelectedHost;
        IsBusy = true;
        Status = $"Connecting to {host.Alias}…";
        try
        {
            _session?.Dispose();
            _session = null;

            // The TCP handshake and key exchange must not block the UI thread.
            _session = await Task.Run(() => SshConnector.Connect(host, TrustPrompt));

            RemoteRoots.Clear();
            string home = _session.Sftp.WorkingDirectory;
            RemoteRoots.Add(new RemoteDirVm(_session.Sftp, home, home));
            RemoteRoots.Add(new RemoteDirVm(_session.Sftp, "/", "/"));
            Status = $"Connected to {host.Alias}. Pick a destination directory.";
            Say(Status);
        }
        catch (Exception ex)
        {
            _session = null;
            Status = $"{host.Alias}: {ex.Message}";
            Say(Status);
        }
        finally
        {
            IsBusy = false;
            Raise(nameof(DestinationSummary));
        }
    }

    /// <summary>What the view should persist for the next run.</summary>
    public void CaptureInto(Settings s)
    {
        s.IsRemote = IsRemote;
        s.LocalPath = LocalPath;
        s.RemoteHost = SelectedHost?.Alias ?? "";
        s.RemotePath = SelectedRemoteDir?.Path ?? "";
    }

    private async Task SyncAsync()
    {
        var ids = Notebooks.SelectMany(n => n.CheckedSectionIds()).ToHashSet(StringComparer.Ordinal);
        if (ids.Count == 0) return;

        ISyncDestination destination = IsRemote
            ? new SshDestination(_session!.Sftp, _session.Ssh, SelectedHost!.Alias, SelectedRemoteDir!.Path)
            : new LocalDestination(LocalPath);

        // Mirroring deletes each selected section directory at the destination before writing.
        if (Confirm?.Invoke("Confirm sync",
                $"Sync {ids.Count} section(s) to\n\n{destination.Describe}\n\n" +
                "Each selected section's folder at the destination will be replaced.") == false)
            return;

        _cts = new CancellationTokenSource();
        IsBusy = true;
        Progress = 0;
        LastSyncSucceeded = false;

        var progress = new Progress<SyncProgress>(p =>
        {
            Progress = p.Overall * 100;
            Status = p.Item is null ? p.Phase.ToString() : $"{p.Phase}  {p.Current}/{p.Total}  {p.Item}";
        });

        try
        {
            var result = await SyncOrchestrator.RunAsync(_notebooks, ids, destination, progress, Say, _cts.Token);
            Progress = 100;
            LastSyncSucceeded = true;
            Status = $"Done: {result.Sections} section(s), {result.Pages} page(s) → {result.Destination}";
            Say(Status);
        }
        catch (OperationCanceledException)
        {
            Status = "Cancelled.";
            Say(Status);
        }
        catch (Exception ex)
        {
            Status = "Sync failed: " + ex.Message;
            Say(Status);
        }
        finally
        {
            // The SSH session is owned by the view model, not the destination — keep browsing alive.
            if (destination is LocalDestination local) local.Dispose();
            _cts?.Dispose();
            _cts = null;
            IsBusy = false;
        }
    }
}
