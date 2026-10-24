"""DUIX audio front end, numpy only (runs in the engine's venv): 16 kHz audio → WeNet input fbank exactly as DUIX
computes it (wenet.compute_ctc_att_bnf.wav2mfcc_v2 + hparams1: pre-emphasis 0.97, librosa-style STFT n_fft 1024 /
hop 160 / win 800 hann, centred + reflect pad, slaney mel 80 bins 0–8 kHz, 10·log10(mel + 1e-5) − 20; 0.4 s of
zeros on each side), and the per-frame windows (video frame i ← encoder output [i, i+20), 25 fps)."""
import os
import numpy as np

SR, N_FFT, HOP, WIN, PRE, REF_DB = 16000, 1024, 160, 800, 0.97, 20
_MEL = None
_WIN = np.zeros(N_FFT, np.float64)
_WIN[(N_FFT - WIN) // 2:(N_FFT - WIN) // 2 + WIN] = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(WIN) / WIN)   # periodic hann, centred


def _mel():
    global _MEL
    if _MEL is None:
        _MEL = np.load(os.path.join(os.path.expanduser(os.environ.get('GF_DUIX_MODELS', '~/.terse/gf-live/models/duix')), 'mel_16k_1024_80.npy'))
    return _MEL


def fbank(wav16k):
    x = np.concatenate([np.zeros(int(0.4 * SR)), np.asarray(wav16k, np.float64), np.zeros(int(0.4 * SR))])
    x = np.concatenate([x[:1], x[1:] - PRE * x[:-1]])                     # scipy.signal.lfilter([1, -0.97], [1], x)
    xp = np.pad(x, N_FFT // 2, mode='reflect')
    n = 1 + (len(xp) - N_FFT) // HOP
    frames = np.lib.stride_tricks.as_strided(xp, (n, N_FFT), (xp.strides[0] * HOP, xp.strides[0]))
    power = np.abs(np.fft.rfft(frames * _WIN, axis=1)) ** 2                # [n, 513]
    return (10 * np.log10(power @ _mel().T.astype(np.float64) + 1e-5) - REF_DB).astype(np.float32)


def windows(bnf, n=20):
    """encoder output [T, 256] → per-frame windows [T-n+1, n, 256] (25 fps)."""
    return np.stack([bnf[i:i + n] for i in range(len(bnf) - n + 1)])
