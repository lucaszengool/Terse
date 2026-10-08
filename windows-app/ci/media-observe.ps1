# Asks Windows what is playing — the system's answer, independent of Terse.
#
# Run under Windows PowerShell 5.1 (see media-host.ps1). Its only job is to
# separate "Terse missed the track" from "the runner never published one": the
# runner has no sound card, and a check that cannot tell those apart would blame
# whichever side it happened to be written against.
#
# Prints one line: SYSTEM: app=… title=… artist=… status=… end=…
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
    $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
    # IAsyncOperation<T> -> Task<T>, so the answer can be waited for.
    $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
    function Await($op, [Type]$t) {
        $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op))
        $null = $task.Wait(10000)
        $task.Result
    }
    $M = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
    $mgr = Await ($M::RequestAsync()) $M
    $s = $mgr.GetCurrentSession()
    if ($null -eq $s) { 'SYSTEM: no current media session'; return }
    $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $tl = $s.GetTimelineProperties()
    'SYSTEM: app={0} title={1} artist={2} status={3} end={4} position={5}' -f `
        $s.SourceAppUserModelId, $props.Title, $props.Artist, $s.GetPlaybackInfo().PlaybackStatus, $tl.EndTime, $tl.Position
} catch {
    'SYSTEM: could not ask (' + $_.Exception.Message + ')'
}
