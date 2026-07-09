using System.Runtime.InteropServices;

namespace OneNote2Yamlover.OneNote;

/// <summary>
/// The canonical Office-automation fix: while OneNote is busy (indexing, or a modal dialog is up) it
/// rejects incoming COM calls with RPC_E_CALL_REJECTED / RPC_E_SERVERCALL_RETRYLATER. Without a
/// message filter the CLR surfaces those immediately; with one, it retries transparently after the
/// delay we return. Must be registered on the STA thread that makes the calls.
/// </summary>
public sealed class OleMessageFilter : IDisposable
{
    [DllImport("ole32.dll")]
    private static extern int CoRegisterMessageFilter(IMessageFilter? newFilter, out IMessageFilter? oldFilter);

    private IMessageFilter? _previous;
    private bool _disposed;

    public static OleMessageFilter Register()
    {
        var filter = new OleMessageFilter();
        CoRegisterMessageFilter(filter._impl, out filter._previous);
        return filter;
    }

    private readonly Impl _impl = new();

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        CoRegisterMessageFilter(_previous, out _);
    }

    private const int SERVERCALL_RETRYLATER = 2;
    private const int PENDINGMSG_WAITDEFPROCESS = 2;

    private sealed class Impl : IMessageFilter
    {
        public int HandleInComingCall(int callType, IntPtr htaskCaller, int tickCount, IntPtr lpInterfaceInfo) => 0; // SERVERCALL_ISHANDLED

        /// <summary>Return a retry delay in ms (&lt; 100 means "retry immediately"); -1 cancels.</summary>
        public int RetryRejectedCall(IntPtr htaskCallee, int tickCount, int rejectType)
        {
            if (rejectType != SERVERCALL_RETRYLATER) return -1;
            return tickCount < 30_000 ? 250 : -1;   // keep retrying for 30s, then give up
        }

        public int MessagePending(IntPtr htaskCallee, int tickCount, int pendingType) => PENDINGMSG_WAITDEFPROCESS;
    }

    [ComImport, Guid("00000016-0000-0000-C000-000000000046"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMessageFilter
    {
        [PreserveSig] int HandleInComingCall(int callType, IntPtr htaskCaller, int tickCount, IntPtr lpInterfaceInfo);
        [PreserveSig] int RetryRejectedCall(IntPtr htaskCallee, int tickCount, int rejectType);
        [PreserveSig] int MessagePending(IntPtr htaskCallee, int tickCount, int pendingType);
    }
}
