"""Wav2Lip audio features (mel spectrogram) — numpy only, so the live engine's runtime needs no librosa/torch.

Exactly Wav2Lip's audio.py hparams (16 kHz, n_fft 800, hop 200, 80 mels 55–7600 Hz, preemphasis 0.97,
symmetric ±4 normalisation). Verified against torchaudio's slaney filterbank + reflect-padded STFT
(max relative difference ~1e-7, 2026-10-17).
"""
import os, subprocess, tempfile, wave
import numpy as np

SR, N_FFT, HOP, WIN, N_MELS, FMIN, FMAX = 16000, 800, 200, 800, 80, 55, 7600
MAX_ABS, MIN_DB, REF_DB = 4.0, -100.0, 20.0


def hz_to_mel(f):      # slaney (librosa htk=False)
    f = np.asanyarray(f, dtype=np.float64)
    return np.where(f >= 1000.0, 15.0 + np.log(np.maximum(f, 1e-10) / 1000.0) / (np.log(6.4) / 27.0), f / (200.0 / 3))


def mel_to_hz(m):
    m = np.asanyarray(m, dtype=np.float64)
    return np.where(m >= 15.0, 1000.0 * np.exp((np.log(6.4) / 27.0) * (m - 15.0)), m * (200.0 / 3))


_BASIS = None


def mel_basis():
    global _BASIS
    if _BASIS is None:
        fft_f = np.linspace(0, SR / 2, 1 + N_FFT // 2)
        mel_f = mel_to_hz(np.linspace(hz_to_mel(FMIN), hz_to_mel(FMAX), N_MELS + 2))
        fdiff = np.diff(mel_f)
        ramps = mel_f[:, None] - fft_f[None, :]
        w = np.zeros((N_MELS, len(fft_f)))
        for i in range(N_MELS):
            w[i] = np.maximum(0, np.minimum(-ramps[i] / fdiff[i], ramps[i + 2] / fdiff[i + 1]))
        w *= (2.0 / (mel_f[2:N_MELS + 2] - mel_f[:N_MELS]))[:, None]
        _BASIS = w
    return _BASIS


def stft_mag(y):
    y = np.pad(y, N_FFT // 2, mode="reflect")
    win = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(WIN) / WIN)
    n = 1 + (len(y) - N_FFT) // HOP
    frames = np.lib.stride_tricks.as_strided(y, (n, N_FFT), (y.strides[0] * HOP, y.strides[0]))
    return np.abs(np.fft.rfft(frames * win, axis=1)).T


def melspectrogram(wav):
    wav = np.asarray(wav, dtype=np.float32)
    y = np.append(wav[0], wav[1:] - 0.97 * wav[:-1])
    S = 20 * np.log10(np.maximum(1e-5, mel_basis() @ stft_mag(y))) - REF_DB
    return np.clip(2 * MAX_ABS * ((S - MIN_DB) / -MIN_DB) - MAX_ABS, -MAX_ABS, MAX_ABS).astype(np.float32)


def say_wav(text, voice=None):
    """macOS `say` -> mono float32 @16 kHz (last-resort voice)."""
    d = tempfile.mkdtemp(prefix="gf-say-")
    aiff = os.path.join(d, "s.aiff")
    subprocess.run(["say", "-o", aiff, "--data-format=LEI16@16000"] + (["-v", voice] if voice else []) + [text], check=True)
    out = os.path.join(d, "s.wav")
    subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, out], check=True)
    with wave.open(out) as w:
        a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    return a, out
