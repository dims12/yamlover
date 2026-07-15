using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Threading;

namespace OneNote2Yamlover;

public partial class App : Application
{
    public static CliOptions? Cli { get; private set; }

    [DllImport("kernel32.dll")] private static extern bool AttachConsole(int processId);
    private const int AttachParentProcess = -1;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        if (e.Args.Contains("--help") || e.Args.Contains("-h"))
        {
            AttachConsole(AttachParentProcess);
            Console.WriteLine(CliOptions.Usage);   // an explicit help request is a success, on stdout
            Shutdown(0);
            return;
        }

        try
        {
            Cli = CliOptions.Parse(e.Args);
        }
        catch (ArgumentException ex)
        {
            AttachConsole(AttachParentProcess);
            Console.Error.WriteLine(ex.Message);
            Shutdown(2);
            return;
        }

        if (Cli is not null)
        {
            // A WinExe has no console of its own; borrow the launching shell's.
            AttachConsole(AttachParentProcess);
            Console.OutputEncoding = System.Text.Encoding.UTF8;

            // In CLI mode a UI fault must fail the run, not pop a dialog nobody sees.
            DispatcherUnhandledException += OnDispatcherUnhandledException;
        }

        // Created here rather than via StartupUri, so the two exits above never build a window.
        new MainWindow().Show();
    }

    private void OnDispatcherUnhandledException(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        Console.Error.WriteLine("UNHANDLED (UI thread): " + e.Exception);
        e.Handled = true;
        Shutdown(1);
    }
}
