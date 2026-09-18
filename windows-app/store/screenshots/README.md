# Microsoft Store screenshots (submission 2, 1.3.4.0)

Direct captures of the submitted `Terse.msix` (build run 35336138438) running on a
GitHub `windows-latest` runner at 1920×1080, taken by
`.github/workflows/store-screenshots.yml` (runs 35339817820 and 35340819166).
Nothing is composited; the stage was cleared (runner console minimized, desktop
icons hidden) and the wallpaper switched on via `~/.terse/wallpaper.json`.

Wallpaper shots 01–03 use Pro styles under a local test license (the page only
draws Pro styles for Pro), so their captions say Pro. The HUD values are real:
a CI box runs no agents, so it reads 0 tokens/min.

| File | Caption |
|---|---|
| 01-wallpaper-vortex-3d.png | Live particle wallpaper on your Windows desktop — Pro style: Vortex, 3D view |
| 02-wallpaper-neon.png | Pro style: Neon |
| 03-wallpaper-zen-3d.png | Pro style: Zen, 3D view |
| 04-doctor.png | Terse Doctor: a read-only health check of your AI agent setup |
| 05-agent-steps-on-wallpaper.png | Your agent's steps drawn on the wallpaper as it works (sample session) |
| 06-doctor-live-tokens.png | Terse Doctor with live token activity on a Pro wallpaper (sample session) |

05–06 come from run 35354594829: a Claude Code-format sample transcript is
replayed step by step so Terse's own agent monitor and renderer draw the text.
The token counts come from that sample, not a real workload, so the captions say
"sample session".
