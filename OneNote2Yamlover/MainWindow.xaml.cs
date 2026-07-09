using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using Microsoft.Win32;
using OneNote2Yamlover.ViewModels;

namespace OneNote2Yamlover;

public partial class MainWindow : Window
{
    private readonly MainViewModel _vm = new();
    private readonly Settings _settings = Settings.Load();

    public MainWindow()
    {
        InitializeComponent();
        DataContext = _vm;
        ApplyGeometry(_settings);

        // OpenFolderDialog is in-box WPF since .NET 8 — no WinForms, no Windows API Code Pack.
        _vm.PickLocalFolder = current =>
        {
            var dlg = new OpenFolderDialog { Title = "Choose destination folder" };
            if (!string.IsNullOrWhiteSpace(current) && Directory.Exists(current)) dlg.InitialDirectory = current;
            if (dlg.ShowDialog(this) == true) _vm.LocalPath = dlg.FolderName;
        };

        _vm.Confirm = (title, message) =>
            MessageBox.Show(this, message, title, MessageBoxButton.OKCancel, MessageBoxImage.Warning)
            == MessageBoxResult.OK;

        // Trust on first use — never trust silently. A CHANGED host key is refused before we get here.
        // The connect runs on a worker thread, so the dialog has to hop back to the UI thread.
        _vm.TrustPrompt = (host, fingerprint) => Dispatcher.Invoke(() => MessageBox.Show(this,
            $"The authenticity of '{host.Alias}' ({host.HostName}:{host.Port}) can't be established.\n\n" +
            $"Key fingerprint: {fingerprint}\n\nAdd it to known_hosts and continue?",
            "Unknown host key", MessageBoxButton.YesNo, MessageBoxImage.Warning) == MessageBoxResult.Yes);

        Loaded += App.Cli is { Sync: true } ? RunCliSync : OnLoadedInteractive;
        Closing += OnClosing;
    }

    // ── startup ────────────────────────────────────────────────────────────────────────────────
    private async void OnLoadedInteractive(object? sender, RoutedEventArgs e)
    {
        RestoreSplit(_settings);

        if (_settings.IsRemote) RemoteRadio.IsChecked = true; else LocalRadio.IsChecked = true;

        await _vm.LoadTreeAsync();                 // the tree is what the window is for — load it now
        await _vm.RestoreDestinationAsync(_settings);
    }

    private void ApplyGeometry(Settings s)
    {
        Width = Math.Max(MinWidth, s.WindowWidth);
        Height = Math.Max(MinHeight, s.WindowHeight);

        // Only honour a saved position if it still lands on a visible screen.
        if (!double.IsNaN(s.WindowLeft) && !double.IsNaN(s.WindowTop) &&
            s.WindowLeft > -32000 && s.WindowTop > -32000 &&
            s.WindowLeft < SystemParameters.VirtualScreenWidth &&
            s.WindowTop < SystemParameters.VirtualScreenHeight)
        {
            WindowStartupLocation = WindowStartupLocation.Manual;
            Left = s.WindowLeft;
            Top = s.WindowTop;
        }
        if (s.Maximized) WindowState = WindowState.Maximized;
    }

    private void RestoreSplit(Settings s)
    {
        double r = Math.Clamp(s.SplitRatio, 0.15, 0.85);
        LeftColumn.Width = new GridLength(r, GridUnitType.Star);
        RightColumn.Width = new GridLength(1 - r, GridUnitType.Star);
        LogRow.Height = new GridLength(Math.Max(0, s.LogHeight));
    }

    // ── shutdown ───────────────────────────────────────────────────────────────────────────────
    private void OnClosing(object? sender, CancelEventArgs e)
    {
        // A --sync run must not overwrite the interactive settings with its throwaway destination,
        // and a window that never rendered has no geometry worth saving (Left/Top are NaN).
        if (App.Cli is not null || !IsLoaded) return;

        _settings.Maximized = WindowState == WindowState.Maximized;
        if (WindowState == WindowState.Normal)
        {
            _settings.WindowWidth = Width;
            _settings.WindowHeight = Height;
            _settings.WindowLeft = Left;
            _settings.WindowTop = Top;
        }

        double left = LeftColumn.ActualWidth, right = RightColumn.ActualWidth;
        if (left + right > 0) _settings.SplitRatio = left / (left + right);
        _settings.LogHeight = LogRow.ActualHeight;

        _vm.CaptureInto(_settings);
        _settings.Save();
    }

    // ── bindings ───────────────────────────────────────────────────────────────────────────────
    private void OnNodeChecked(object sender, RoutedEventArgs e) => _vm.OnSelectionChanged();

    private void OnLocalChecked(object sender, RoutedEventArgs e) => _vm.IsRemote = false;

    private void OnRemoteChecked(object sender, RoutedEventArgs e) => _vm.IsRemote = true;

    private void OnRemoteDirSelected(object sender, RoutedPropertyChangedEventArgs<object> e) =>
        _vm.SelectedRemoteDir = e.NewValue as RemoteDirVm;

    // ── CLI ────────────────────────────────────────────────────────────────────────────────────
    /// <summary>
    /// Drives the real, bound UI from the command line. Deliberately not headless: WPF faults such as
    /// mutating a bound ObservableCollection off the UI thread only surface once an ItemsControl is
    /// attached, so a console harness would miss them.
    /// </summary>
    private async void RunCliSync(object? sender, RoutedEventArgs e)
    {
        var cli = App.Cli!;
        int exit = 1;
        try
        {
            _vm.Confirm = (_, _) => true;                       // no dialogs in CLI mode
            _vm.TrustPrompt = (host, fp) => { Console.WriteLine($"TOFU {host.Alias} {fp}"); return true; };

            await _vm.LoadTreeAsync();

            int matched = _vm.SelectSections(cli.Notebook, cli.Sections);
            Console.WriteLine($"selected {matched} of {cli.Sections.Count} requested section(s)");
            if (matched != cli.Sections.Count)
                throw new InvalidOperationException("some --section names did not match");

            if (cli.IsRemote)
            {
                await _vm.ConnectToAsync(cli.RemoteHost!);
                _vm.UseRemotePath(cli.RemotePath!);
            }
            else
            {
                _vm.IsRemote = false;
                _vm.LocalPath = cli.LocalDest!;
                Directory.CreateDirectory(cli.LocalDest!);
            }

            await _vm.RunSyncAsync();

            // Let the bound ListBox/TreeView lay out once more — this is where an off-thread
            // collection mutation would finally throw.
            await Dispatcher.InvokeAsync(() => { }, System.Windows.Threading.DispatcherPriority.ApplicationIdle);

            Console.WriteLine(_vm.Status);
            exit = _vm.LastSyncSucceeded ? 0 : 1;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("CLI sync failed: " + ex);
        }
        finally
        {
            foreach (var line in _vm.Log) Console.WriteLine("  log: " + line);
            if (!cli.KeepOpen) Application.Current.Shutdown(exit);
        }
    }
}
