# Microsoft Store screenshots — submission 3 (1.3.8.0)

Direct captures of the submitted `Terse.msix` (build run 35696744115) running on
a GitHub `windows-latest` runner at 1920x1080, taken by
`.github/workflows/store-screenshots.yml` (run 35699776216) and cropped to
1366x768 around the app window. Nothing is composited or retouched.

Submission 2 failed 10.1.1.3 because its frames minimized every window to make
the live wallpaper the subject — direct captures, but what a reviewer saw was a
Windows desktop. Every frame here is the app's own UI.

Staging, and nothing else: the runner's desktop is a solid dark colour (the
Windows theme is clear glass, so a bright wallpaper showed through the UI and
washed out its text), desktop icons are hidden, Windows' own dialogs are
dismissed, the app is signed in with a capture account, and a sample agent
session runs so the numbers on screen are real rather than zeros. The Pro
styles on the wallpaper page render under a local test licence, as they would
on a subscriber's machine.

| File | Caption |
|---|---|
| 01-overview.png | Watch what your AI coding agents are doing right now — burn rate, spend today, context use and agent health in one window. |
| 02-optimize.png | Optimize: check your agents in one click, reclaim wasted tokens and disk, and set your own compression rules. |
| 03-monitor.png | Monitor: follow a session step by step, see where the tokens went, and check an agent's connection. |
| 04-speed-up.png | Speed Up Mode: cache-safe trimming, a local result cache and tool-result compression — with the tradeoffs spelled out. |
| 05-live-wallpaper.png | Live wallpaper: your agents' work drawn as particles on the desktop. Cinematic styles need a Pro subscription. |

Not used, and why: the Settings page shows the capture account's email; the Code
Town page shows the runner's own temp folder; photographs of the desktop with
the wallpaper running are what failed certification twice.
