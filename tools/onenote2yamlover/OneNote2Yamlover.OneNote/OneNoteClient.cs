using System.Runtime.InteropServices;
using ON = Microsoft.Office.Interop.OneNote;

namespace OneNote2Yamlover.OneNote;

/// <summary>The three OneNote calls the sync needs. Everything else is pure XML.</summary>
public interface IOneNoteSource
{
    /// <summary>Notebooks → section groups → sections. No pages: cheap (~417 KB for 1394 sections).</summary>
    string GetSectionTreeXml();
    /// <summary>The pages of one section, flat with a <c>pageLevel</c> attribute.</summary>
    string GetSectionPagesXml(string sectionId);
    /// <summary>One page, with embedded image bytes as base64 (<c>piBinaryData</c>).</summary>
    string GetPageXml(string pageId);
}

/// <summary>
/// COM is STA-affine: create and use this on ONE dedicated STA thread (see <see cref="StaWorker"/>),
/// then dispose it there.
/// </summary>
public sealed class OneNoteClient : IOneNoteSource, IDisposable
{
    private ON.Application? _app;
    private readonly Action<string>? _log;

    public OneNoteClient(Action<string>? log = null)
    {
        _log = log;
        _app = new ON.Application();
    }

    private ON.Application App => _app ?? throw new ObjectDisposedException(nameof(OneNoteClient));

    public string GetSectionTreeXml() => Retry("GetHierarchy(hsSections)", () =>
    {
        App.GetHierarchy("", ON.HierarchyScope.hsSections, out string xml);
        return xml;
    });

    public string GetSectionPagesXml(string sectionId) => Retry("GetHierarchy(hsPages)", () =>
    {
        App.GetHierarchy(sectionId, ON.HierarchyScope.hsPages, out string xml);
        return xml;
    });

    public string GetPageXml(string pageId) => Retry("GetPageContent", () =>
    {
        App.GetPageContent(pageId, out string xml, ON.PageInfo.piBinaryData);
        return xml;
    });

    // OneNote rejects calls while it is indexing or showing a dialog. The message filter absorbs most
    // of it; this backs off on what leaks through.
    private const int RPC_E_CALL_REJECTED = unchecked((int)0x80010001);
    private const int RPC_E_SERVERCALL_RETRYLATER = unchecked((int)0x8001010A);
    private const int RPC_E_SERVER_UNAVAILABLE = unchecked((int)0x800706BA);

    private T Retry<T>(string what, Func<T> call)
    {
        var delay = TimeSpan.FromMilliseconds(100);
        for (int attempt = 1; ; attempt++)
        {
            try { return call(); }
            catch (COMException ex) when (attempt < 5 && ex.HResult is RPC_E_CALL_REJECTED
                                          or RPC_E_SERVERCALL_RETRYLATER or RPC_E_SERVER_UNAVAILABLE)
            {
                _log?.Invoke($"{what}: 0x{ex.HResult:X8}, retry {attempt} in {delay.TotalMilliseconds:F0}ms");
                Thread.Sleep(delay);
                delay *= 2;
            }
        }
    }

    public void Dispose()
    {
        if (_app is null) return;
        Marshal.FinalReleaseComObject(_app);
        _app = null;
    }
}
