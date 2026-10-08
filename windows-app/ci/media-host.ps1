# Publishes a real "now playing" session to Windows, for CI.
#
# Run under Windows PowerShell 5.1 (powershell.exe), not pwsh: WinRT type
# projection was removed from .NET Core. 音乐模式 reads the system media
# transport controls — the service behind the volume flyout's media tile — so a
# session published here is indistinguishable from Spotify's.
#
#   powershell -File media-host.ps1 <log-file>
#
# The controls are driven BY HAND (CommandManager off), the way a player that
# owns its own audio pipeline does it. The first version let MediaPlayer
# publish them from actual playback, and on the runner playback never started
# (Windows Server, no sound device): the player sat in state None and no
# session ever appeared. Nothing about lyrics depends on audio, so the check
# should not either.
#
# Lives as long as the check needs it (about four minutes), then exits, which
# closes the session.
$log = $args[0]
function L($m) { Add-Content -Path $log -Value ("{0:HH:mm:ss} {1}" -f (Get-Date), $m) }
try {
    $null = [Windows.Media.Playback.MediaPlayer, Windows.Media.Playback, ContentType = WindowsRuntime]
    $null = [Windows.Media.SystemMediaTransportControls, Windows.Media, ContentType = WindowsRuntime]
    $null = [Windows.Media.SystemMediaTransportControlsTimelineProperties, Windows.Media, ContentType = WindowsRuntime]
    $null = [Windows.Media.MediaPlaybackType, Windows.Media, ContentType = WindowsRuntime]
    $null = [Windows.Media.MediaPlaybackStatus, Windows.Media, ContentType = WindowsRuntime]

    $mp = [Windows.Media.Playback.MediaPlayer]::new()
    $mp.CommandManager.IsEnabled = $false
    $smtc = $mp.SystemMediaTransportControls
    $smtc.IsEnabled = $true
    $smtc.IsPlayEnabled = $true
    $smtc.IsPauseEnabled = $true
    # The same three fields a music player fills in. Lyric lookup is by
    # artist + title (+ album), matched to the track's length within 15 s.
    $du = $smtc.DisplayUpdater
    $du.Type = [Windows.Media.MediaPlaybackType]::Music
    $du.MusicProperties.Title = 'Yellow'
    $du.MusicProperties.Artist = 'Coldplay'
    $du.MusicProperties.AlbumTitle = 'Parachutes'
    $du.Update()
    $smtc.PlaybackStatus = [Windows.Media.MediaPlaybackStatus]::Playing
    L "host: session published by hand (CommandManager off)"

    # A player that reports its progress, every 4 s, like most do.
    $t0 = Get-Date
    for ($i = 0; $i -lt 60; $i++) {
        $tl = [Windows.Media.SystemMediaTransportControlsTimelineProperties]::new()
        $tl.StartTime = [TimeSpan]::Zero
        $tl.EndTime = [TimeSpan]::FromSeconds(269)
        $tl.MinSeekTime = [TimeSpan]::Zero
        $tl.MaxSeekTime = [TimeSpan]::FromSeconds(269)
        $tl.Position = [TimeSpan]::FromSeconds(20 + ((Get-Date) - $t0).TotalSeconds)
        $smtc.UpdateTimelineProperties($tl)
        if ($i % 5 -eq 0) { L ("host: status={0} position={1:N0}s" -f $smtc.PlaybackStatus, $tl.Position.TotalSeconds) }
        Start-Sleep -Seconds 4
    }
} catch {
    L ("host: FAILED " + $_.Exception.Message)
}
