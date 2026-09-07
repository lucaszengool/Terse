/**
 * tunes.js — 广场的声音。**没有一个音频文件**,全部是当场合成出来的。
 *
 * ⚠ 这个决定不是省事,是这个产品本来就该这么做。
 *
 * 一首歌 1–3MB,而一颗胶囊的上限是 160KB 的 JSON,存在 SQLite 里;这台服务器没有
 * 对象存储,数据库挂在 Railway 的卷上。要收用户上传的音频,得先有个存储桶、一套
 * 清理策略,以及一个"这段音乐谁有权发"的答案 —— 那是三个决定,不是一个功能。
 *
 * 而这个 app 从第一天起就是**传参数,不传画面**:项目发出去的是几十个数字,城市在
 * 看的人自己机器上长出来。声音走同一条路 —— 胶囊里只有一个曲子的名字,音是每台
 * 设备自己用 WebAudio 弹的。于是没有文件、没有存储、没有版权问题、离线也响,
 * 而且**和粒子天生同步**:驱动画面的那个响度就是此刻正在发声的那个数,不是从一段
 * 录音里事后分析出来的。
 *
 * ⚠ iOS 不给自动播放。AudioContext 必须由一次真实的手势解锁,而且**必须在那次
 * 手势的调用栈里**恢复 —— 放进 Promise 之后再 resume 是不算的。所以 unlock() 挂在
 * 第一次 touch 上,之后这个上下文就一直活着。
 */
(function (root) {
  'use strict';

  var ctx = null, master = null, analyser = null, freq = null;
  var timer = null, step = 0, nextAt = 0, current = null, vol = 0.5, muted = false;

  var LOOKAHEAD = 0.12;     // 提前排这么多秒的音
  var TICK = 25;            // 排程器多久跑一次(毫秒)

  /* 四首。每一首是"第 n 个十六分音符该响什么",而不是一段波形 —— 所以一首曲子
     在这里就是几十行,不是几兆。 */
  var TRACKS = {
    pulse: { bpm: 104, name: 'Pulse' },
    drift: { bpm: 72, name: 'Drift' },
    arp: { bpm: 120, name: 'Arp' },
    neon: { bpm: 96, name: 'Neon' },
    lofi: { bpm: 84, name: 'Lo-fi' },
    rush: { bpm: 140, name: 'Rush' },
    glass: { bpm: 90, name: 'Glass' },
    deep: { bpm: 68, name: 'Deep' },
    chime: { bpm: 112, name: 'Chime' },
    dust: { bpm: 60, name: 'Dust' },
    march: { bpm: 100, name: 'March' },
    bloom: { bpm: 80, name: 'Bloom' },
  };
  var ORDER = ['pulse', 'drift', 'arp', 'neon', 'lofi', 'rush',
               'glass', 'deep', 'chime', 'dust', 'march', 'bloom'];

  function ensure() {
    if (ctx) return ctx;
    var AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0;
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.75;
    freq = new Uint8Array(analyser.frequencyBinCount);
    master.connect(analyser);
    analyser.connect(ctx.destination);
    return ctx;
  }

  /** iOS 的那道闸。必须在手势的同步调用栈里调。 */
  function unlock() {
    var c = ensure();
    if (!c) return false;
    if (c.state === 'suspended') { try { c.resume(); } catch (e) {} }
    return c.state !== 'suspended';
  }

  /* ── 一点点乐器 ───────────────────────────────────────────────────────── */

  function env(node, at, a, d, peak) {
    var g = node.gain;
    g.setValueAtTime(0.0001, at);
    g.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + a);
    g.exponentialRampToValueAtTime(0.0001, at + a + d);
  }

  function tone(at, hz, dur, peak, type, glideTo) {
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(hz, at);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, at + dur);
    env(g, at, 0.006, dur, peak);
    o.connect(g); g.connect(master);
    o.start(at); o.stop(at + dur + 0.05);
  }

  /** 噪声,做鼓的“沙”。每次现做一小段 buffer —— 短到不值得缓存。 */
  function noise(at, dur, peak, hp) {
    var n = Math.max(1, Math.floor(ctx.sampleRate * dur));
    var buf = ctx.createBuffer(1, n, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    var s = ctx.createBufferSource(); s.buffer = buf;
    var f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp || 4000;
    var g = ctx.createGain(); env(g, at, 0.002, dur, peak);
    s.connect(f); f.connect(g); g.connect(master);
    s.start(at);
  }

  function chord(at, roots, dur, peak) {
    for (var i = 0; i < roots.length; i++) {
      var o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
      o.type = 'sawtooth';
      // 微微失谐,两个一模一样的锯齿叠起来是死的。
      o.frequency.setValueAtTime(roots[i] * (i % 2 ? 1.004 : 0.997), at);
      f.type = 'lowpass'; f.frequency.setValueAtTime(900, at);
      f.frequency.linearRampToValueAtTime(420, at + dur);
      env(g, at, dur * 0.35, dur * 0.8, peak / roots.length);
      o.connect(f); f.connect(g); g.connect(master);
      o.start(at); o.stop(at + dur + 0.1);
    }
  }

  var A = 55;                                   // A1
  var MINOR = [0, 3, 7, 10, 12, 15, 19, 22];    // 小调七和弦音阶,怎么弹都不难听
  /* ⚠ 调号。十二首曲子分给五十条帖子,每首要出现四遍 —— "配了乐"就成了
     "又是这首"。移调是最便宜的解法:同一套音型换个调,听上去就是另一段音乐,
     而代码一个字节都不用多。12 首 × 12 个调 = 144 种不重样的组合。 */
  var key = 0;
  var hz = function (semi) { return A * Math.pow(2, (semi + key) / 12); };

  /* ── 四首曲子。参数 s = 第几个十六分音符 ────────────────────────────── */
  var PLAY = {
    pulse: function (at, s) {
      if (s % 4 === 0) tone(at, 130, 0.16, 0.9, 'sine', 44);          // kick
      if (s % 8 === 4) noise(at, 0.05, 0.12, 6000);                    // hat
      if (s % 2 === 0) tone(at, hz(MINOR[(s / 2) % 4]), 0.14, 0.16, 'square');
    },
    drift: function (at, s) {
      if (s % 32 === 0) {
        var r = [hz(MINOR[(s / 32) % 4] + 12), hz(MINOR[((s / 32) % 4) + 2] + 12), hz(MINOR[((s / 32) % 4) + 4] + 12)];
        chord(at, r, 3.4, 0.30);
      }
      if (s % 16 === 8) tone(at, hz(MINOR[(s / 16) % 6] + 24), 1.1, 0.06, 'triangle');
    },
    arp: function (at, s) {
      tone(at, hz(MINOR[s % MINOR.length] + 12), 0.13, 0.13, 'triangle');
      if (s % 8 === 0) tone(at, hz(MINOR[0]), 0.28, 0.35, 'sine', 40);
      if (s % 4 === 2) noise(at, 0.03, 0.07, 7000);
    },
    neon: function (at, s) {
      if (s % 8 === 0) tone(at, 120, 0.2, 0.8, 'sine', 42);
      if (s % 8 === 6) noise(at, 0.06, 0.10, 5200);
      if (s % 16 === 0 || s % 16 === 10) {
        chord(at, [hz(MINOR[(s / 16) % 5] + 12), hz(MINOR[((s / 16) % 5) + 3] + 12)], 0.5, 0.22);
      }
      if (s % 2 === 1) tone(at, hz(MINOR[(s % 6)]), 0.1, 0.09, 'sawtooth');
    },
    /* 这八首是后加的。四首撑不起一个广场:五十条帖子分四首,每一首都要出现十二遍,
       "配了乐"就变成"又是那一首"。十二首之后,连着刷十条才可能撞上一次重复。 */
    lofi: function (at, s) {
      if (s % 8 === 0) tone(at, 110, 0.18, 0.55, 'sine', 48);
      // 摇摆:反拍不落在正中间,落在三分之二处 —— lo-fi 的全部人格在这一点上。
      if (s % 8 === 5) noise(at, 0.045, 0.07, 5200);
      if (s % 16 === 0) chord(at, [hz(MINOR[0] + 12), hz(MINOR[2] + 12), hz(MINOR[4] + 12)], 1.6, 0.18);
      if (s % 16 === 8) chord(at, [hz(MINOR[1] + 12), hz(MINOR[3] + 12), hz(MINOR[5] + 12)], 1.6, 0.18);
    },
    rush: function (at, s) {
      tone(at, hz(MINOR[s % 4]), 0.07, 0.14, 'sawtooth');
      if (s % 4 === 0) tone(at, 140, 0.12, 0.85, 'sine', 46);
      if (s % 4 === 2) noise(at, 0.03, 0.11, 7500);
      if (s % 16 === 12) tone(at, hz(MINOR[6] + 12), 0.22, 0.2, 'square');
    },
    glass: function (at, s) {
      // 钟:三角波加一个高八度的泛音,衰减长。
      if (s % 6 === 0) {
        var n = hz(MINOR[(s / 6) % MINOR.length] + 24);
        tone(at, n, 1.4, 0.10, 'triangle');
        tone(at + 0.02, n * 2, 0.9, 0.04, 'sine');
      }
      if (s % 32 === 0) chord(at, [hz(MINOR[0]), hz(MINOR[4])], 2.6, 0.12);
    },
    deep: function (at, s) {
      if (s % 16 === 0) tone(at, 96, 0.5, 1.0, 'sine', 34);
      if (s % 8 === 0) tone(at, hz(MINOR[(s / 8) % 3]) / 2, 1.0, 0.22, 'sine');
      if (s % 32 === 16) noise(at, 0.3, 0.03, 900);
    },
    chime: function (at, s) {
      if (s % 3 === 0) tone(at, hz(MINOR[(s / 3) % MINOR.length] + 24), 0.5, 0.09, 'sine');
      if (s % 8 === 0) tone(at, hz(MINOR[0] + 12), 0.3, 0.16, 'triangle');
      if (s % 16 === 8) noise(at, 0.04, 0.06, 8000);
    },
    dust: function (at, s) {
      // 几乎全是质感:一层低噪,偶尔一个音。安静的那一首,广场也需要一首安静的。
      if (s % 4 === 0) noise(at, 0.5, 0.035, 700);
      if (s % 24 === 0) tone(at, hz(MINOR[(s / 24) % 5] + 12), 1.8, 0.07, 'sine');
    },
    march: function (at, s) {
      if (s % 4 === 0) tone(at, 150, 0.13, 0.6, 'sine', 70);
      if (s % 4 === 2) tone(at, 190, 0.10, 0.35, 'sine', 90);
      if (s % 8 === 6) noise(at, 0.05, 0.09, 4200);
      if (s % 32 === 0) chord(at, [hz(MINOR[0] + 12), hz(MINOR[3] + 12)], 1.2, 0.14);
    },
    bloom: function (at, s) {
      // 涨上来再散开。和弦的起音故意慢,所以它是"浮现",不是"敲下去"。
      if (s % 24 === 0) {
        var k = (s / 24) % 4;
        chord(at, [hz(MINOR[k] + 12), hz(MINOR[k + 2] + 12), hz(MINOR[k + 4] + 12)], 2.8, 0.26);
      }
      if (s % 12 === 6) tone(at, hz(MINOR[(s / 12) % 6] + 24), 0.8, 0.06, 'triangle');
    },
  };

  /* 排程器。WebAudio 的标准写法:用 setInterval 提前把音排进音频时钟,
     而不是"到点了再播" —— setTimeout 的抖动在音乐上是听得出来的。 */
  function pump() {
    if (!ctx || !current) return;
    var spb = 60 / (TRACKS[current].bpm * 4);            // 一个十六分音符多久
    while (nextAt < ctx.currentTime + LOOKAHEAD) {
      try { PLAY[current](nextAt, step); } catch (e) {}
      step = (step + 1) % 64;
      nextAt += spb;
    }
  }

  function play(id, opts) {
    if (!TRACKS[id]) { stop(); return false; }
    if (!ensure()) return false;
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    var k = Math.max(0, Math.min(11, ((opts && opts.key) | 0)));
    if (current === id && key === k) return true;
    key = k;
    current = id; step = 0;
    nextAt = ctx.currentTime + 0.06;
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
    master.gain.linearRampToValueAtTime(muted ? 0 : vol, ctx.currentTime + 0.35);
    clearInterval(timer);
    timer = setInterval(pump, TICK);
    pump();
    return true;
  }

  function stop() {
    clearInterval(timer); timer = null;
    current = null;
    if (!ctx || !master) return;
    // 淡出,不是硬切 —— 硬切一个正在响的振荡器会"啪"一声。
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
    master.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
  }

  function setMuted(v) {
    muted = !!v;
    if (!ctx || !master) return;
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
    master.gain.linearRampToValueAtTime(muted ? 0.0001 : (current ? vol : 0.0001), ctx.currentTime + 0.2);
  }

  var peak = 0.15, lastHit = 0;

  /** 此刻的响度,给粒子用。
   *
   *  ⚠ 这是**正在发声的那个数**,不是从一段录音里分析出来的 —— 画面和声音天然
   *  就是同一件事,不需要对齐。
   *
   *  ⚠ 用低频,不用整体。`all` 是所有频段的平均,而大部分频段一直是安静的,
   *  所以它实测下来是 0.011–0.181(均值 0.058)—— 拿它当驱动,场几乎不动。
   *  低频是 0.096–0.504,这才是有幅度的那个数。
   *
   *  ⚠ 而且必须**按曲子自适应**。四首曲子的低频完全不是一个量级:pulse 有底鼓,
   *  drift 是一块垫子。一个写死的阈值只会让其中一首永远不跳。所以这里跟一个
   *  会衰减的峰值,一切都相对它来算 —— 换首曲子,几秒内自己校准回来。 */
  function level() {
    if (!analyser || !current || muted) return { bass: 0, all: 0, norm: 0, hit: false };
    analyser.getByteFrequencyData(freq);
    var n = freq.length, bass = 0, all = 0, bn = Math.max(1, Math.floor(n * 0.12));
    for (var i = 0; i < n; i++) { all += freq[i]; if (i < bn) bass += freq[i]; }
    var b = (bass / bn) / 255;
    peak = Math.max(b, peak * 0.995);          // 慢慢往下漏,不然一次巨响锁死整首
    var ref = Math.max(0.12, peak);
    var norm = Math.max(0, Math.min(1, b / ref));
    var now = (root.performance && performance.now()) || Date.now();
    var hit = norm > 0.62 && (now - lastHit) > 130;
    if (hit) lastHit = now;
    return { bass: b, all: (all / n) / 255, norm: norm, hit: hit };
  }

  root.TerseTunes = {
    TRACKS: TRACKS, ORDER: ORDER,
    unlock: unlock, play: play, stop: stop, level: level,
    setMuted: setMuted, muted: function () { return muted; },
    playing: function () { return current; },
    ready: function () { return !!(ctx && ctx.state === 'running'); },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.TerseTunes;
}(typeof window !== 'undefined' ? window : globalThis));
