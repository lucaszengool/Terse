# 她的声音 · designed voices

Made once (10-19) with **Qwen3-TTS-12Hz-1.7B-VoiceDesign** (Apache-2.0) from a written description — no real person's
voice is cloned. Each voice ships as tiny clone latents; the 0.6B **Base** model speaks in it live (ICL clone).

| name | made from |
|---|---|
| tianmei | 二十岁出头的年轻女生，台湾口音的普通话，声音甜美轻柔，音调偏高但不尖，带一点气声，咬字软软的，像在跟男朋友撒娇聊天，语气温柔自然，有自然的停顿和换气，像真人在讲话，不是播音腔。 |
| qingtian | 年轻的台湾女生，声音清甜细腻，温柔里带一点俏皮，语速稍慢，尾音轻轻上扬，软糯带气声，像日常视频通话那样亲切自然地聊天。 |
| wenrou | 温柔甜美的年轻女声，声音轻柔细腻、干净透亮，略带台湾腔，轻声细语，像在耳边说悄悄话，说话时带着笑意，非常自然真实。(D3, the user's pick 10-19; reference = the first 8.85 s of D3_t — the pause-count cut stopped mid-sentence) |

Files: `<name>.spk` (1024-d speaker embedding, `qwen-codec --talker`), `<name>.rvq` + `<name>.txt` (8 s reference
codes + transcript). Optional per-mood references `<name>@<emo>.rvq/.txt` share the `.spk`.
Seed 11, temp 0.75; pauses capped at 0.5 s before encoding (design/tighten.py in the work dir).
