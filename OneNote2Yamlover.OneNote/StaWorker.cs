namespace OneNote2Yamlover.OneNote;

/// <summary>
/// Runs work on one dedicated STA thread. OneNote's RCW has thread affinity, so the whole
/// enumerate→convert loop lives here rather than hopping threads per call.
/// <para>
/// An <see cref="IProgress{T}"/> created on the UI thread captures its SynchronizationContext, so
/// <c>Report</c> marshals back to the UI by itself — no Dispatcher.Invoke needed.
/// </para>
/// </summary>
public static class StaWorker
{
    public static Task<T> RunAsync<T>(Func<CancellationToken, T> work, CancellationToken ct = default)
    {
        var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);

        var thread = new Thread(() =>
        {
            using var filter = OleMessageFilter.Register();
            try { tcs.SetResult(work(ct)); }
            catch (OperationCanceledException) { tcs.TrySetCanceled(ct); }
            catch (Exception ex) { tcs.TrySetException(ex); }
        })
        {
            IsBackground = true,
            Name = "OneNote-STA",
        };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();

        return tcs.Task;
    }
}
