/* Voice input the way beiyege-01/dsh-voice-ai-girlfriend does it (user 10-21: "复刻一模一样的步骤") — a plain-JS port of its
   dsh-plugin client: worklets/mic-capture.ts (the worklet verbatim), voice/recorder.ts (MicRecorder), bridge.ts (stt, VadStream)
   and MicButton.tsx's continuous listening (GfMic.listen). The engine stands in for its voice bridge: POST /stt = /api/stt
   (Paraformer-large, one pass per utterance), WS /vad = /api/vad (Silero VAD v4 barge-in).

   How it feels smooth: the page cuts your speech itself — 16 kHz PCM16 in 40 ms chunks, a −35 dB noise gate, and an utterance
   ends after 1.8 s under −40 dB (30 s cap) — so a pause to think never splits a sentence; utterances go to /stt one at a time
   (a serial queue); while she talks the mic streams to /vad instead, and only a real voice (384 ms of it) stops her, after
   which your speech simply becomes the next utterance. Turning the mic on cuts her off too.

   Changes from the repo, none of them to its thresholds or timing — they only stop words getting lost:
   · before speech only the last 1 s of chunks is kept (the repo keeps everything since the last utterance, so after a long
     pause the next one exceeded X-Max-Audio-Sec and was dropped);
   · a barge-in keeps the 0.6 s the VAD heard before it fired (the repo starts the utterance after silero's 384 ms
     confirmation, losing the first syllables);
   · an utterance still in progress when she starts talking is carried, not dropped: it goes on if the VAD hears you, or is
     sent at its 1.8 s endpoint (the repo's speaker is synchronous, so it never hit this; her reply here starts with a render);
   · the VAD socket closes once it has fired, so her next reply gets a fresh detector instead of a stale state;
   · after a barge-in, barge-in mode waits until she has actually stopped (her /stop lands asynchronously here). */
(function () {
  'use strict';

  // ── worklets/mic-capture.ts, verbatim ─────────────────────────────────────────────────────────────────────────
  const MIC_CAPTURE_WORKLET_SOURCE = `
const TARGET_RATE = 16000;
const DEFAULT_CHUNK_MS = 40;
const GATE_ATTACK_MS = 5;
const GATE_HOLD_MS = 250;
const GATE_RELEASE_MS = 80;

class MicCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const chunkMs = options?.processorOptions?.chunkMs ?? DEFAULT_CHUNK_MS;
    this._inputRate = sampleRate;
    this._ratio = this._inputRate / TARGET_RATE;
    this._chunkSamples16k = Math.round((TARGET_RATE * chunkMs) / 1000);
    this._scratch = new Float32Array(0);
    this._decimated = new Float32Array(this._chunkSamples16k);
    this._enabled = true;

    this._gateEnabled = false;
    this._thresholdLin = 0;
    this._gateGain = 1;
    this._holdRemaining = 0;
    this._attackCoef = Math.exp(-1 / ((GATE_ATTACK_MS / 1000) * TARGET_RATE));
    this._releaseCoef = Math.exp(-1 / ((GATE_RELEASE_MS / 1000) * TARGET_RATE));
    this._holdSamples = Math.round((GATE_HOLD_MS / 1000) * TARGET_RATE);

    this.port.onmessage = (e) => {
      const data = e.data;
      if (data?.kind === "enable") this._enabled = !!data.value;
      else if (data?.kind === "gate") {
        this._gateEnabled = !!data.enabled;
        this._thresholdLin = data.enabled ? Math.pow(10, data.thresholdDb / 20) : 0;
      }
    };
  }

  _ingest(incoming) {
    if (incoming.length === 0) return;
    const next = new Float32Array(this._scratch.length + incoming.length);
    next.set(this._scratch, 0);
    next.set(incoming, this._scratch.length);
    this._scratch = next;
    this._maybeEmit();
  }

  _maybeEmit() {
    const r = this._ratio;
    const n = this._chunkSamples16k;
    const needIn = Math.ceil(n * r);
    const dec = this._decimated;
    while (this._scratch.length >= needIn) {
      let sumSq = 0;
      if (Math.abs(r - 3) < 1e-6) {
        for (let i = 0; i < n; i++) {
          const idx = i * 3;
          const s = (this._scratch[idx] + this._scratch[idx + 1] + this._scratch[idx + 2]) / 3;
          dec[i] = s;
          sumSq += s * s;
        }
      } else {
        for (let i = 0; i < n; i++) {
          const srcPos = i * r;
          const idx = Math.floor(srcPos);
          const frac = srcPos - idx;
          const a = this._scratch[idx];
          const b = this._scratch[idx + 1] ?? a;
          const s = a + (b - a) * frac;
          dec[i] = s;
          sumSq += s * s;
        }
      }
      const rms = Math.sqrt(sumSq / n);

      let target = 1;
      if (this._gateEnabled) {
        if (rms >= this._thresholdLin) {
          this._holdRemaining = this._holdSamples;
        } else if (this._holdRemaining > 0) {
          this._holdRemaining -= n;
        } else {
          target = 0;
        }
      }

      const out = new Int16Array(n);
      let gain = this._gateGain;
      for (let i = 0; i < n; i++) {
        const coef = target > gain ? this._attackCoef : this._releaseCoef;
        gain = target + (gain - target) * coef;
        const s = dec[i] * gain;
        const clamped = s < -1 ? -1 : s > 1 ? 1 : s;
        out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      }
      this._gateGain = gain;

      const consumed = Math.floor(n * r);
      this._scratch = this._scratch.slice(consumed);

      this.port.postMessage({ kind: "level", rms });

      if (this._enabled) {
        this.port.postMessage(out.buffer, [out.buffer]);
      }
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;
    const mono = input[0];
    if (mono.length > 0) this._ingest(mono);
    return true;
  }
}

registerProcessor("mic-capture", MicCaptureProcessor);
`;

  // ── bridge.ts: stt + VadStream (the engine is the bridge) ───────────────────────────────────────────────────────
  async function stt(base, pcm16) {
    const resp = await fetch(base + '/stt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Max-Audio-Sec': '30' },
      body: pcm16,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`engine /stt failed: ${resp.status} ${body}`.trim());
    }
    return resp.json();
  }

  class VadStream {
    constructor(base) { this.base = base; this.ws = null; this.buffered = []; this.closed = false; this.connected = false; }
    /** whether the socket is actually connected; the recorder falls back to RMS while it is not */
    get available() { return this.connected; }
    open(onSpeechStart) {
      if (this.ws !== null) return;
      this.closed = false;
      const ws = new WebSocket(this.base.replace(/^http/, 'ws') + '/vad');
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        if (this.ws !== ws) return;
        this.connected = true;
        for (const chunk of this.buffered.splice(0)) ws.send(chunk);
      };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data));
          if (msg.event === 'speech_start') onSpeechStart();
        } catch (e) { /* ignore malformed frames */ }
      };
      ws.onclose = () => {
        if (this.ws === ws) this.ws = null;
        this.connected = false;
      };
    }
    /** push one 16 kHz PCM16 chunk (no-op while the socket is down) */
    send(pcm16) {
      const ws = this.ws;
      if (ws === null || this.closed) return;
      if (ws.readyState === WebSocket.OPEN) ws.send(pcm16);
      else if (ws.readyState === WebSocket.CONNECTING) {
        this.buffered.push(pcm16);
        if (this.buffered.length > 64) this.buffered.shift();
      }
    }
    close() {
      this.closed = true;
      this.buffered = [];
      const ws = this.ws;
      this.ws = null;
      this.connected = false;
      if (ws !== null) { try { ws.close(); } catch (e) { /* already closed */ } }
    }
  }

  // ── voice/recorder.ts: MicRecorder ──────────────────────────────────────────────────────────────────────────────
  const DEFAULT_MIN_SILENCE_MS = 1800;
  const DEFAULT_MAX_UTTERANCE_MS = 30000;
  const DEFAULT_RMS_THRESHOLD = 0.01;            // ~ −40 dBFS
  const DEFAULT_INTERRUPT_THRESHOLD = 0.06;      // ~ −24 dBFS: the RMS fallback when /vad is unreachable
  const DEFAULT_INTERRUPT_HOLD_MS = 250;
  const DEFAULT_INTERRUPT_CONFIRM_MS = 180;
  // the worklet's noise gate, for an external source (the app's mic helper sends 16 kHz PCM16 chunks already cleaned of her
  // voice by macOS's echo canceller — 10-22): the same envelope, sample by sample
  const GATE_ATT = Math.exp(-1 / (0.005 * 16000)), GATE_REL = Math.exp(-1 / (0.080 * 16000)), GATE_HOLD = Math.round(0.250 * 16000);
  const PREROLL_CHUNKS = 25;                     // 1 s of 40 ms chunks kept before speech (repo: unbounded)
  const HEARD_CHUNKS = 15;                       // 0.6 s the VAD heard, carried into a barge-in utterance

  class MicRecorder {
    constructor(opts) {
      this.opts = opts;
      this.ctx = null; this.stream = null; this.source = null; this.node = null;
      this.chunks = []; this.chunkBytes = 0; this.speaking = false; this.lastVoiceAt = 0; this.maxTimer = null;
      this.released = false; this.paused = false;
      this.interruptMode = false; this.interruptArmed = false; this.interruptHoldStart = 0;
      this.confirmArmed = false; this.confirmStart = 0;
      this.heard = [];
    }

    get active() { return !this.released && this.ctx !== null; }

    setPaused(paused) {
      if (this.paused === paused) return;
      this.paused = paused;
      if (paused) this.resetBuffers();
    }

    /** barge-in listening (while she talks): chunks go to the engine's Silero VAD, never into a new utterance */
    setInterruptMode(enabled) {
      if (this.interruptMode === enabled) return;
      this.interruptMode = enabled;
      this.interruptArmed = false;
      this.confirmArmed = false;
      this.heard = [];
      if (enabled) {
        if (this.opts.vad) this.opts.vad.open(() => this.onVadSpeechStart());
      } else {
        if (this.opts.vad) this.opts.vad.close();
        if (!this.speaking) this.resetBuffers();        // a carried utterance goes on
      }
    }

    /** the VAD heard a real voice: stop her, and accumulate the speech that is still going on */
    onVadSpeechStart() {
      if (!this.interruptMode) return;
      this.interruptMode = false;
      this.interruptArmed = false;
      this.confirmArmed = false;
      if (!this.speaking) {
        this.resetBuffers();
        for (const b of this.heard) { this.chunks.push(b); this.chunkBytes += b.byteLength; }
        this.speaking = true;
        this.armMaxTimer();
        if (this.opts.onSpeakingChange) this.opts.onSpeakingChange(true);
      }
      this.heard = [];
      if (this.opts.vad) this.opts.vad.close();
      this.lastVoiceAt = performance.now();
      if (this.opts.onSpeechInterrupt) this.opts.onSpeechInterrupt();
    }

    resetBuffers() {
      if (this.maxTimer !== null) { clearTimeout(this.maxTimer); this.maxTimer = null; }
      this.chunks = [];
      this.chunkBytes = 0;
      if (this.speaking && this.opts.onSpeakingChange) this.opts.onSpeakingChange(false);
      this.speaking = false;
      this.interruptArmed = false;
      this.confirmArmed = false;
    }

    async start() {
      this.released = false;
      if (this.opts.source) {                            // chunks from elsewhere (opts.source.subscribe(fn) → unsubscribe)
        const db = this.opts.noiseGateDb;
        this._gate = { on: db !== undefined && db !== 0, thr: db ? Math.pow(10, db / 20) : 0, gain: 1, hold: 0 };
        this.ctx = { external: true };                   // `active`
        this._unsub = this.opts.source.subscribe((buf) => { if (!this.released) this._feed(buf); });
        return;
      }
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx = ctx;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.stream = stream;
      const workletUrl = URL.createObjectURL(new Blob([MIC_CAPTURE_WORKLET_SOURCE], { type: 'text/javascript' }));
      try { await ctx.audioWorklet.addModule(workletUrl); } finally { URL.revokeObjectURL(workletUrl); }
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'mic-capture', {
        numberOfInputs: 1, numberOfOutputs: 0, processorOptions: { chunkMs: 40 },
      });
      const gateDb = this.opts.noiseGateDb;           // dBFS, negative; 0 / undefined = off
      if (gateDb !== undefined && gateDb !== 0) node.port.postMessage({ kind: 'gate', enabled: true, thresholdDb: gateDb });
      node.port.onmessage = (e) => {
        if (this.released) return;
        const data = e.data;
        if (data instanceof ArrayBuffer) this.onChunk(data);
        else if (data !== null && typeof data === 'object' && data.kind === 'level') this.onLevel(data.rms);
      };
      source.connect(node);
      this.source = source;
      this.node = node;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});   // never awaited: without a user gesture it stays pending
    }

    /** one external 16 kHz PCM16 chunk: level (before the gate, as the worklet posts it), then the gated chunk */
    _feed(buf) {
      const x = new Int16Array(buf), n = x.length; if (!n) return;
      const f = new Float32Array(n); let sumSq = 0;
      for (let i = 0; i < n; i++) { const v = x[i] / 32768; f[i] = v; sumSq += v * v; }
      const rms = Math.sqrt(sumSq / n), G = this._gate;
      let target = 1;
      if (G.on) {
        if (rms >= G.thr) G.hold = GATE_HOLD;
        else if (G.hold > 0) G.hold -= n;
        else target = 0;
      }
      const out = new Int16Array(n); let gain = G.gain;
      for (let i = 0; i < n; i++) {
        gain = target + (gain - target) * (target > gain ? GATE_ATT : GATE_REL);
        const s = Math.max(-1, Math.min(1, f[i] * gain));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      G.gain = gain;
      this.onLevel(rms);
      this.onChunk(out.buffer);
    }

    stop() {
      if (this.released) return;
      this.released = true;
      if (this._unsub) { try { this._unsub(); } catch (e) {} this._unsub = null; }
      if (this.maxTimer !== null) { clearTimeout(this.maxTimer); this.maxTimer = null; }
      if (this.opts.vad) this.opts.vad.close();
      try { this.node && this.node.port.close(); } catch (e) {}
      try { this.source && this.source.disconnect(); } catch (e) {}
      if (this.stream) this.stream.getTracks().forEach(track => track.stop());
      if (this.ctx && !this.ctx.external) this.ctx.close().catch(() => {});
      this.node = null; this.source = null; this.stream = null; this.ctx = null;
      this.chunks = []; this.chunkBytes = 0; this.speaking = false;
      this.interruptMode = false; this.interruptArmed = false; this.confirmArmed = false; this.heard = [];
    }

    onLevel(rms) {
      if (this.released || this.paused) return;
      if (this.interruptMode) {
        if (this.opts.vad === undefined || !this.opts.vad.available) {     // no /vad: the repo's RMS fallback
          const threshold = this.opts.interruptThreshold ?? DEFAULT_INTERRUPT_THRESHOLD;
          const now = performance.now();
          if (rms >= threshold) {
            if (!this.interruptArmed) {
              this.interruptArmed = true;
              this.interruptHoldStart = now;
            } else if (!this.confirmArmed && now - this.interruptHoldStart >= (this.opts.interruptHoldMs ?? DEFAULT_INTERRUPT_HOLD_MS)) {
              if (this.opts.onSpeechInterrupt) this.opts.onSpeechInterrupt();
              this.confirmArmed = true;
              this.confirmStart = now;
            } else if (this.confirmArmed && now - this.confirmStart >= (this.opts.interruptConfirmMs ?? DEFAULT_INTERRUPT_CONFIRM_MS)) {
              this.confirmArmed = false;
              this.interruptArmed = false;
              this.interruptMode = false;
              this.resetBuffers();
            }
          } else {
            this.interruptArmed = false;
            this.confirmArmed = false;
          }
        }
        return;
      }
      const threshold = this.opts.rmsThreshold ?? DEFAULT_RMS_THRESHOLD;
      if (rms >= threshold) {
        this.lastVoiceAt = performance.now();
        if (!this.speaking) {
          this.speaking = true;
          this.armMaxTimer();
          if (this.opts.onSpeakingChange) this.opts.onSpeakingChange(true);
        }
      }
    }

    onChunk(buffer) {
      if (this.released || this.paused) return;
      if (this.interruptMode) {
        if (this.opts.vad) this.opts.vad.send(buffer);
        if (this.speaking) {                             // a carried utterance: keep it, and end it at its endpoint
          this.chunks.push(buffer);
          this.chunkBytes += buffer.byteLength;
          if (performance.now() - this.lastVoiceAt >= (this.opts.minSilenceMs ?? DEFAULT_MIN_SILENCE_MS)) this.flush();
        } else {
          this.heard.push(buffer);
          if (this.heard.length > HEARD_CHUNKS) this.heard.shift();
        }
        return;
      }
      this.chunks.push(buffer);
      this.chunkBytes += buffer.byteLength;
      if (!this.speaking) {
        while (this.chunks.length > PREROLL_CHUNKS) this.chunkBytes -= this.chunks.shift().byteLength;
        return;
      }
      const silenceMs = performance.now() - this.lastVoiceAt;
      if (silenceMs >= (this.opts.minSilenceMs ?? DEFAULT_MIN_SILENCE_MS)) this.flush();
    }

    armMaxTimer() {
      if (this.maxTimer !== null) clearTimeout(this.maxTimer);
      this.maxTimer = setTimeout(() => this.flush(), this.opts.maxUtteranceMs ?? DEFAULT_MAX_UTTERANCE_MS);
    }

    flush() {
      if (this.released) return;
      if (this.maxTimer !== null) { clearTimeout(this.maxTimer); this.maxTimer = null; }
      const pcm = this.chunkBytes > 0 ? this.concatChunks() : null;
      this.chunks = [];
      this.chunkBytes = 0;
      if (this.speaking) {
        this.speaking = false;
        if (this.opts.onSpeakingChange) this.opts.onSpeakingChange(false);
      }
      if (pcm !== null) this.opts.onUtterance(pcm);
    }

    concatChunks() {
      const out = new Uint8Array(this.chunkBytes);
      let offset = 0;
      for (const chunk of this.chunks) { out.set(new Uint8Array(chunk), offset); offset += chunk.byteLength; }
      return out.buffer;
    }
  }

  // ── MicButton.tsx: continuous listening ─────────────────────────────────────────────────────────────────────────
  /** start listening; returns { stop() }.
   *  o.base          engine URL
   *  o.isBusy()      is she talking (or about to: a reply rendering)? — the repo's speaker.speaking; polled every 100 ms
   *  o.interrupt()   stop her and swallow the rest of the reply (the repo's interruptReply)
   *  o.send(text)    one recognised utterance, awaited before the next is transcribed (the repo's sendText)
   *  o.onPhase(p)    'listening' | 'transcribing' | 'idle';  o.onSpeaking(bool) the voice-active flag;  o.onHeard(r) each /stt result
   *  o.source        optional { subscribe(fn) → unsubscribe }: 16 kHz PCM16 chunks from elsewhere instead of the microphone */
  async function listen(o) {
    const queue = [];
    let draining = false, rec = null;
    const phase = (p) => { if (o.onPhase) o.onPhase(p); };
    const drain = async () => {
      if (draining) return;
      draining = true;
      try {
        while (queue.length > 0) {
          if (rec === null) break;                         // listening stopped
          const pcm = queue.shift();
          phase('transcribing');
          try {
            const r = await stt(o.base, pcm);
            if (o.onHeard) o.onHeard(r);
            const text = (r && r.text || '').trim();
            if (text !== '') await o.send(text);
          } catch (err) {
            console.error('[gf-mic] stt/send failed:', err);
          }
        }
      } finally {
        draining = false;
        phase(rec !== null ? 'listening' : 'idle');
      }
    };
    // the user is about to speak: cut any reply being read aloud and swallow the rest of it
    let holdUntil = performance.now() + 2500;              // until her stop has landed (isBusy() false), or 2.5 s
    o.interrupt();
    rec = new MicRecorder({
      minSilenceMs: 1800,
      maxUtteranceMs: 30000,
      rmsThreshold: 0.01,
      noiseGateDb: -35,
      vad: new VadStream(o.base),
      source: o.source,                                  // the app: the mic helper's cleaned stream (no getUserMedia)
      interruptThreshold: 0.06,
      interruptHoldMs: 250,
      interruptConfirmMs: 180,
      onSpeechInterrupt: () => { holdUntil = performance.now() + 2500; o.interrupt(); },
      onSpeakingChange: (speaking) => { if (o.onSpeaking) o.onSpeaking(speaking); },
      onUtterance: (pcm) => { queue.push(pcm); drain(); },
    });
    const watch = setInterval(() => {                    // the repo's speaker.subscribe → setInterruptMode(speaker.speaking)
      if (rec === null) return;
      const busy = !!o.isBusy();
      if (!busy) holdUntil = 0;
      rec.setPaused(false);
      rec.setInterruptMode(busy && performance.now() >= holdUntil);
    }, 100);
    const handle = {
      get recorder() { return rec; },
      stop() {
        clearInterval(watch);
        if (rec !== null) rec.stop();
        rec = null;
        queue.length = 0;
        phase('idle');
      },
    };
    phase('listening');
    try {
      await rec.start();
    } catch (err) {
      handle.stop();
      throw err;
    }
    return handle;
  }

  window.GfMic = { MIC_CAPTURE_WORKLET_SOURCE, MicRecorder, VadStream, stt, listen };
})();
