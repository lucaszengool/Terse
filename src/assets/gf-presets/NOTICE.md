# Girlfriend preset avatars

Each `char_*/` directory is one character. Clips are cut out with Apple Vision person
segmentation (scripts/gf/matte.swift) and stored as HEVC-with-alpha `.mov`, so only the
person shows on the wallpaper. `manifest.json` per character: `alpha`, `seamless`
(all clips start/end on the same frame -> same-frame cuts instead of crossfades), and
per-gesture timing (`impact` seconds, fingertip `tip` and text `aim` in clip coordinates).

Filename prefix = which agent event plays the clip:
`write` / `point` / `wave` / `think` / `nod` / `talk` (loops while she speaks) / `listen` (loops while
you hold the mic); `clip_*` = idle loop.

## Original characters

| character | source |
|-----------|--------|
| char_aria | Original AI-generated character made for Terse (portrait + 11 motion clips generated on 豆包 / Doubao from Terse's prompt pack, 2026-10-17). Cut out to alpha with scripts/gf/build_character.py. Shown in the app as an AI digital human. |
| char_mia  | Original AI-generated character made for Terse (portrait on 豆包 Seedream, idle + gesture clips on 豆包 Seedance 2.0 with first frame = last frame, 2026-10-18). Full frame with her own room as background (`frame:"full"`, `fit:"cover"`), not cut out. Shown in the app as an AI digital human. |

## From Pixabay (Pixabay Content License — free for commercial use, no attribution required)

AI-generated, re-encoded by Terse to 720 px wide and cut out to alpha. Bundled as part of
the app feature, not redistributed as standalone stock.

| character    | Pixabay page                                                       | creator   |
|--------------|--------------------------------------------------------------------|-----------|
| char_scarlet | https://pixabay.com/videos/ai-generated-woman-model-kimono-181057/ | Walkerssk |
