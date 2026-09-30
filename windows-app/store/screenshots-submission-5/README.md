# Microsoft Store screenshots — submission 5 (1.4.0.0)

Direct captures of the submitted `Terse.msix` (build run 36766526910) running on
a GitHub `windows-latest` runner at 1920x1080, cropped to 1920x980 to cut the
runner's "Test Mode / Windows Server" watermark. Nothing composited, no text
added to any image — policy 10.1.1.3 has failed this listing three times, twice
for artwork that was not a capture at all.

The app is photographed over its own live wallpaper rather than a bare desktop:
maximised on a plain background the glass theme washed out to near-white with
half the frame empty, while over its own particle field the same UI reads dark
and sharp. A sample agent session runs throughout, so the numbers and the
particle text on screen are the app's own output.

| File | Caption |
|---|---|
| 01-overview.png | Watch what your AI coding agents are spending, live — and the agent's own words forming in particles behind the window. |
| 02-live-wallpaper-3d.png | The live wallpaper in 3D: every agent step becomes particle text on your desktop. Cinematic styles need a Pro subscription. |
| 03-optimize.png | Optimize: check your agents in one click, reclaim wasted tokens and disk, and set your own compression rules. |
| 04-monitor.png | Monitor: follow a session step by step, see where the tokens went, and check an agent's connection. |
| 05-speed-up.png | Speed Up Mode: cache-safe trimming, a local result cache and tool-result compression — with the tradeoffs spelled out. |
| 06-wallpaper-styles.png | Pick a wallpaper style, free or Pro, and keep the particles above every window. |
| 07-code-town.png | Code Town: your projects as a particle town you can walk around on the desktop. |

⚠ Only the Vortex style rendered its particle field on the runner. Orbit,
Starfall and Aurora each came back as the plain Windows wallpaper with the text
layer alone, across two capture runs — worth checking whether those styles fail
on a machine with no GPU, or fail generally.
