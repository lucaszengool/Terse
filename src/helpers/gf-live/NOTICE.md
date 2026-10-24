# Live digital human (实时数字人) — third-party components

Nothing below ships inside Terse.app except the code in this folder. `setup.sh` downloads the rest onto the
user's Mac (into `~/.terse/gf-live`) when they press 「一键配置」.

| component | used for | license | how it arrives |
|-----------|----------|---------|----------------|
| LiveTalking `wav2lip256` checkpoint (lipku/LiveTalking, Wav2Lip lineage) | real-time lip-sync | **Wav2Lip weights are for research / non-commercial use** — clear this before selling the feature | downloaded, converted to Core ML on the Mac (`convert_w2l.py`) |
| LiveTalking Wav2Lip generator code (`w2l_model.py`) | defines the network for conversion | Apache-2.0 | vendored here |
| Kokoro-82M v1.1 multi-lang (hexgrad), packaged by sherpa-onnx | her voice (TTS) | Apache-2.0 | downloaded |
| sherpa-onnx (k2-fsa) | runs Kokoro on CPU | Apache-2.0 | pip, into the setup's venv |
| Hunyuan-1.8B-Instruct GGUF (Tencent; bartowski's quant) | local brain (since 10-20: ~4x faster than Qwen3-4B here) | **Tencent Hunyuan Community License** — the territory EXCLUDES the EU, UK and South Korea (Terse is not offered there); > 100 M MAU needs a Tencent license | downloaded |
| MeloTTS zh_en (MyShell, packaged by sherpa-onnx) | her real-time voice (+ `sweet.py`: pitch / formant / breath via WORLD) | MIT | downloaded |
| pyworld (WORLD vocoder) | `sweet.py` | MIT | pip, into the setup's venv |
| Qwen3-4B Instruct GGUF (Alibaba Qwen) | the brain before 10-20 (replaced on upgrade) | Apache-2.0 | no longer downloaded |
| llama.cpp `llama-server` b11706 (ggml-org) | serves the brain | MIT | prebuilt release, downloaded |
| uv (astral-sh) + python-build-standalone | Python runtime without Xcode | MIT / Apache-2.0 | downloaded |
| Qwen3-TTS 0.6B-Base (optional "clone" voice) | voice cloning | Apache-2.0 | not installed by default (too slow on Intel CPUs) |
| Qwen3-TTS 0.6B-Base + qwentts.cpp (ServeurpersoCom, MIT) | her designed voices (`voices/`, made with Qwen3-TTS 1.7B VoiceDesign) | Apache-2.0 | downloaded |
| **DUIX face2face (Duix.Avatar / HeyGem: DINet v1, WeNet BNF, SCRFD, PFLD)** | HD replies (高清回复) | **DUIX.COM Community License** (`duix/LICENSE-DUIX.COM.txt`): free while the product has ≤ 1,000 monthly active users, above that a commercial license from DUIX.COM is required; must show "Built with DUIX.COM" in the UI / docs, ship the license + this notice, and say in the terms of service that the product is built with DUIX.COM technology | downloaded, Core ML on the Mac |
| **DUIX real-time engine (Duix-Mobile: Mobunet::domodel + BlendGramAlpha, ported) + duix.com-mia-mouth** | real-time DUIX mouth on every line (CPU) | **DUIX.COM Community License**: same terms as above; "Powered by Duix.com" shown in the UI; Mia's model was trained with DUIX materials (distilled from DUIX DINetV1), so its name starts with "duix.com" as the license requires | downloaded (~5 MB), ncnn on the CPU |
| OmniVoice (k2-fsa) | the Douyin repo's voice — **local experiments only** | code Apache-2.0, **pretrained model CC-BY-NC** (training data) | **never installed by setup.sh** (Terse is paid; `omni/` stays a developer option) |
| Breeze2-VITS (MediaTek Research, sherpa-onnx export) | her voice (台湾腔, `VOICE_STYLES`) | **model card states no license**; it ships inside MediaTek's Apache-2.0 BreezeApp — **confirm with MediaTek before a paid release** | downloaded from Hugging Face, sha256-pinned |
| Silero VAD v4.0 (snakers4) | barge-in (打断, engine `/vad`) and the no-speech check before `/stt` | MIT | downloaded, ONNX Runtime |
| Paraformer-large zh (FunASR, Alibaba DAMO; k2-fsa sherpa-onnx int8 export `sherpa-onnx-paraformer-zh-2023-09-14`) | voice input (engine `/stt`, the beiyege-01/dsh-voice-ai-girlfriend recipe) | **FunASR Model License**: use / copy / modify / share with attribution and the model name kept; silent on commercial use, "reference and learning" disclaimer — **confirm with Alibaba before a paid release** | downloaded from the sherpa-onnx release, sha256-pinned |

DUIX.COM is licensed under the DUIX.COM Community License, Copyright © DUIX.COM Platforms, Inc. All Rights Reserved.

The tutorial this follows: freedidi.com 24984 (LiveTalking + Qwen3-TTS + faster-whisper + llama.cpp on an RTX 4090).
Here the lip model runs on the Mac's GPUs through Core ML, speech recognition is Apple's on-device recogniser
(`terse-listen`), and the voice is Kokoro because Qwen3-TTS measured 11–14× slower than real time on this CPU.

Character clips were made sharper offline with Real-ESRGAN x2plus (BSD-3-Clause; `scripts/gf/sr.swift`), not at run time.
