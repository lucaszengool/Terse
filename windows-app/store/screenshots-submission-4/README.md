# Microsoft Store screenshots — submission 4 (1.3.8.0)

Direct captures of the submitted `Terse.msix` (build run 35696744115) running on
a GitHub `windows-latest` runner at 1920x1080, taken by
`.github/workflows/store-screenshots.yml` (run 36024400995). Nothing is
composited or retouched.

## Why submission 3 failed, and what changed

Submission 3's frames were direct captures too, and certification rejected them
under 10.1.1.3 all the same. The fault was the crop: the app window was 996x659
on a bare dark desktop, and the listing files were cut to 1366x768 around it. A
transparent window with a glow, standing in black with no desktop, no taskbar and
no clock, reads as a rendered mockup — every pixel that proved it was a screen
had been cropped away.

So the window now fills the screen instead of floating in it. It is grown once to
1920x1032 after onboarding and never moved again, every page is photographed at
that size, and the only crop is the bottom 105 px, which carries the runner's
"Test Mode / Windows Server 2025" watermark. What is left is 1920x975 of the
product and nothing else.

Two things had to be solved to get there. UI Automation cannot maximize the
window at all — it is borderless (`decorations: false`), so it has no
WS_MAXIMIZEBOX and `CanMaximize` is false; Win32 `MoveWindow` does the job. And
growing then shrinking the window around each shot left a hollow box on screen at
every rect it had just left, one more with each cycle, drawn over the app: the
compositor holding a stale surface for a layered transparent window on a runner
with no GPU. Nothing accumulates if nothing cycles.

Staging, and nothing else: the desktop is a solid dark colour (Terse's Windows
theme is clear glass, so a bright wallpaper showed through the UI and washed out
its text), desktop icons are hidden, Windows' own dialogs are pushed off screen,
the app is signed in with a capture account, and a sample agent session runs so
the numbers on screen are real rather than zeros. The Pro styles on the wallpaper
page render under a local test licence, as they would on a subscriber's machine.

| File | Caption |
|---|---|
| 01-overview.png | Watch what your AI coding agents are doing right now — burn rate, spend today, context use and agent health in one window. |
| 02-optimize.png | Optimize: check your agents in one click, reclaim wasted tokens and disk, and set your own compression rules. |
| 03-monitor.png | Monitor: follow a session step by step, see where the tokens went, and check an agent's connection. |
| 04-speed-up.png | Speed Up Mode: cache-safe trimming, a local result cache and tool-result compression — with the tradeoffs spelled out. |
| 05-live-wallpaper.png | Live wallpaper: your agents' work drawn as particles on the desktop. Cinematic styles need a Pro subscription. |

Not used, and why: Code Town shows the runner's own temp path (`D:\a\_temp`),
and Settings shows the capture account's email address.
