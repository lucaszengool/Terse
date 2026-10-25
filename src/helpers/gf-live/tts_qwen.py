"""Qwen3-TTS voice clone for the live engine (tutorial step 5 / 9: ref.wav + its exact transcript).

The tutorial runs Qwen3-TTS-1.7B-Base on a 4090; its "显存不够" advice is to go smaller, so this uses
the 0.6B-Base checkpoint on the CPU (the Radeon is busy with lip-sync). Must be a -Base model, not
-CustomVoice — CustomVoice ignores the reference and the timbre drifts every reply (tutorial 排错速查).
"""
import os
import numpy as np

MODEL_DIR = os.path.expanduser(os.environ.get("GF_TTS_MODEL", "~/.cache/terse-gf-models/qwen3-tts-0.6b-base"))


class QwenVoice:
    def __init__(self, ref_wav, ref_text, model_dir=MODEL_DIR):
        import torch
        from qwen_tts import Qwen3TTSModel
        torch.set_num_threads(max(1, (os.cpu_count() or 8) // 2))
        self.torch = torch
        self.m = Qwen3TTSModel.from_pretrained(model_dir, device_map="cpu", dtype=torch.float32, attn_implementation="sdpa")
        self.ref, self.ref_text = ref_wav, ref_text
        self.prompt = None
        # The reference is the same every reply: encode it once if this version can (saves ~1 s per reply).
        make = getattr(self.m, "create_voice_clone_prompt", None)
        if make:
            try:
                self.prompt = make(ref_audio=ref_wav, ref_text=ref_text)
            except Exception:
                self.prompt = None

    def say(self, text, language="Chinese"):
        """-> mono float32 at 16 kHz (what wav2lip's mel features expect)."""
        kw = dict(text=text, language=language)
        if self.prompt is not None:
            kw["voice_clone_prompt"] = self.prompt
        else:
            kw.update(ref_audio=self.ref, ref_text=self.ref_text)
        wavs, sr = self.m.generate_voice_clone(**kw)
        w = np.asarray(wavs[0], dtype=np.float32)
        if sr != 16000:
            import torchaudio
            w = torchaudio.functional.resample(self.torch.from_numpy(w), sr, 16000).numpy()
        return w


CUSTOM_DIR = os.path.expanduser(os.environ.get("GF_TTS_CUSTOM_MODEL", "~/.cache/terse-gf-models/qwen3-tts-0.6b-customvoice"))

# 情绪标签 → Qwen3-TTS CustomVoice 的语气指令(和页面的表情底片是同一套标签:她的脸和声音一起变)
# 她的声音 = 用户 10-18 选的 A2:Serena 温柔轻声、贴着耳边说,像真人视频通话一样自然(换气、停顿、不朗读),
# 每句按情绪加一点点语气。暖声 EQ / 换气声 / 房间感在 engine.py 里加(A2 的后期)。
BASE_STYLE = ("用温柔甜美的声音轻声说，声音轻柔细腻，像在耳边和男朋友说悄悄话；像真人视频通话时自然说话，语速自然，"
              "有自然的换气和停顿，不要播音腔，不要朗读感")
MOOD_INSTRUCT = {k: BASE_STYLE + v for k, v in {
    "温柔": "，带着宠溺的笑意",
    "撒娇": "，有一点撒娇",
    "傲娇": "，带点小傲娇，但声音还是软软的",
    "害羞": "，有点害羞",
    "开心": "，带着笑意，开心但不大声",
    "委屈": "，有一点委屈",
    "调皮": "，有点调皮",
}.items()}


class QwenCustomVoice:
    """Qwen3-TTS CustomVoice: a fixed premium timbre (Vivian / Serena) + a per-sentence tone instruction, so the
    mood tag that picks her face (【撒娇】…) also changes how she sounds. Fixed speaker = no timbre drift."""

    def __init__(self, speaker=None, model_dir=CUSTOM_DIR, device=None):
        import torch
        from qwen_tts import Qwen3TTSModel
        self.torch = torch
        dev = device or os.environ.get("GF_TTS_DEVICE") or ("mps" if torch.backends.mps.is_available() else "cpu")
        dtype = torch.float32 if dev == "cpu" else torch.float16
        if dev == "cpu": torch.set_num_threads(max(1, (os.cpu_count() or 8) // 2))
        self.m = Qwen3TTSModel.from_pretrained(model_dir, device_map=dev, dtype=dtype, attn_implementation="sdpa")
        self.speaker = speaker or os.environ.get("GF_TTS_SPEAKER", "Serena")
        self.device = dev

    def say(self, text, mood=None, language="Chinese"):
        """-> (mono float32, sample_rate)."""
        wavs, sr = self.m.generate_custom_voice(text=text, language=language, speaker=self.speaker,
                                                instruct=MOOD_INSTRUCT.get(mood or "温柔", MOOD_INSTRUCT["温柔"]))
        return np.asarray(wavs[0], dtype=np.float32), sr
