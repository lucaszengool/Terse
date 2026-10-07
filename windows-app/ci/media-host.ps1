# Publishes a real "now playing" session to Windows, for CI.
#
# Run under Windows PowerShell 5.1 (powershell.exe), not pwsh: WinRT type
# projection was removed from .NET Core, and this is what every player on the
# machine does to show up in the volume flyout's media tile — a MediaPlayer
# with display properties. 音乐模式 reads exactly that service, so a session
# published here is indistinguishable from Spotify's.
#
#   powershell -File media-host.ps1 <path-to-wav> <log-file>
#
# Lives as long as the check needs it (about four minutes), then exits, which
# closes the session.
$wav = $args[0]
$log = $args[1]
function L($m) { Add-Content -Path $log -Value ("{0:HH:mm:ss} {1}" -f (Get-Date), $m) }
try {
    $null = [Windows.Media.Playback.MediaPlayer, Windows.Media.Playback, ContentType = WindowsRuntime]
    $null = [Windows.Media.Playback.MediaPlaybackItem, Windows.Media.Playback, ContentType = WindowsRuntime]
    $null = [Windows.Media.Core.MediaSource, Windows.Media.Core, ContentType = WindowsRuntime]
    $null = [Windows.Media.MediaPlaybackType, Windows.Media, ContentType = WindowsRuntime]

    $src = [Windows.Media.Core.MediaSource]::CreateFromUri([Uri]$wav)
    $item = [Windows.Media.Playback.MediaPlaybackItem]::new($src)
    # The same three fields a music player fills in. Lyric lookup is by
    # artist + title (+ album), matched to the track's length within 15 s —
    # which is why the WAV is as long as the real song.
    $p = $item.GetDisplayProperties()
    $p.Type = [Windows.Media.MediaPlaybackType]::Music
    $p.MusicProperties.Title = 'Yellow'
    $p.MusicProperties.Artist = 'Coldplay'
    $p.MusicProperties.AlbumTitle = 'Parachutes'
    $item.ApplyDisplayProperties($p)

    $mp = [Windows.Media.Playback.MediaPlayer]::new()
    $mp.Source = $item
    $mp.Play()
    L "host: play requested for $wav"
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 4
        L ("host: state={0} position={1}" -f $mp.PlaybackSession.PlaybackState, $mp.PlaybackSession.Position)
    }
} catch {
    L ("host: FAILED " + $_.Exception.Message)
}
