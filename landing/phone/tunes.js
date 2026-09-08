/**
 * tunes.js — 广场的配乐。**真的音乐文件**,不是合成的。
 *
 * ⚠ 这是一次推翻。上一版是当场用振荡器合成的,理由写得很漂亮:没有文件、没有
 * 存储、没有版权、和粒子天生同步。那些理由都成立,但它答错了题 —— 它听起来就是
 * 合成的。几个方波加一个包络可以当"背景音",当不了"配乐"。
 *
 * ⚠ 而且当初那句"要收音频得先有对象存储"是错的。用户上传才需要桶;一个**固定的
 * 曲库**就是 app 的静态资源,和图标字体一样跟着仓库走,Express 的 static 早就在
 * 服务它们了。我把"让用户传音乐"和"app 自带十二首"当成了一件事。
 *
 * 现在是十二首 CC0 / 公有领域的曲子(见 api/fetch-music.js),每首裁成 30 秒的
 * 循环段,总共三兆。CC0 是特意挑的:CC BY 也免费,但要在界面上挂一行署名,而一个
 * 全屏刷视频的界面上没有稳妥的地方放那行字,漏一次就是违规。
 *
 * ⚠ 声音仍然走 AudioContext,不是直接 <audio>.play()。因为粒子要跟着动,而那需要
 * 一个 AnalyserNode —— 把 <audio> 接进音频图里,既能放真曲子,又能拿到实时的频谱。
 *
 * ⚠ iOS 不给自动播放,这条绕不过去:第一次出声必须在一次**真实手势的调用栈里**。
 * 所以"默认开"的意思是:开关默认是开的,而音乐在你第一次碰屏幕的那一刻响 ——
 * 刷一下就是一次手势,所以人感觉不到这层。
 */
(function (root) {
  'use strict';

  var ctx = null, master = null, analyser = null, freq = null;
  var el = null, node = null;
  var current = null, vol = 0.55, muted = false, ready = false;
  var TRACKS = {}, ORDER = [];

  /* 曲库。启动时读一次清单 —— 曲子是随仓库发布的静态文件,所以这份清单也是。 */
  function load() {
    return fetch('/audio/tracks.json', { cache: 'force-cache' })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (list) {
        (list || []).forEach(function (t) { TRACKS[t.id] = t; ORDER.push(t.id); });
        return ORDER.slice();
      })
      .catch(function () { return []; });
  }

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

    el = new Audio();
    el.loop = true;                 // 三十秒的段子,循环着放
    el.preload = 'auto';
    el.crossOrigin = 'anonymous';
    /* ⚠ 必须有。不设的话 iOS 会把它当成一段"影片",进而在锁屏和控制中心上接管
       播放控件,还会跟别的音频抢独占权。 */
    el.playsInline = true;
    try {
      node = ctx.createMediaElementSource(el);
      node.connect(master);
    } catch (e) { node = null; }
    master.connect(analyser);
    analyser.connect(ctx.destination);
    return ctx;
  }

  /** iOS 的那道闸:必须在手势自己的调用栈里调。 */
  function unlock() {
    var c = ensure();
    if (!c) return false;
    if (c.state === 'suspended') { try { c.resume(); } catch (e) {} }
    ready = c.state === 'running';
    return ready;
  }

  function play(id) {
    if (!TRACKS[id]) return false;
    if (!ensure()) return false;
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    if (current === id && !el.paused) return true;
    current = id;
    if (el.getAttribute('src') !== TRACKS[id].file) el.src = TRACKS[id].file;
    var p = el.play();
    // play() 在没有手势的时候会**被拒绝**,而那是一个 rejected promise ——
    // 不接住的话控制台里就是一条没人管的报错,而且没有任何地方说明为什么没声音。
    if (p && p.catch) p.catch(function () { ready = false; });
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
    master.gain.linearRampToValueAtTime(muted ? 0.0001 : vol, ctx.currentTime + 0.4);
    return true;
  }

  function stop() {
    current = null;
    if (!ctx || !master) return;
    // 先淡出再暂停 —— 直接 pause 是"啪"的一声。
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
    master.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.28);
    setTimeout(function () { if (!current && el) { try { el.pause(); } catch (e) {} } }, 320);
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
   *  ⚠ 用低频,不用整体。`all` 是所有频段的平均,而大部分频段一直是安静的 ——
   *  拿它当驱动,场几乎不动(实测 0.011–0.181,均值 0.058)。
   *
   *  ⚠ 而且要**跟着曲子自适应**。十二首真曲子的动态范围差得更远:一首鼓机和一段
   *  氛围完全不是一个量级,写死的阈值必然有几首永远不跳。所以跟一个会衰减的峰值,
   *  一切相对它算 —— 换首曲子几秒内自己校准回来。 */
  function level() {
    if (!analyser || !current || muted) return { bass: 0, all: 0, norm: 0, hit: false };
    analyser.getByteFrequencyData(freq);
    var n = freq.length, bass = 0, all = 0, bn = Math.max(1, Math.floor(n * 0.12));
    for (var i = 0; i < n; i++) { all += freq[i]; if (i < bn) bass += freq[i]; }
    var b = (bass / bn) / 255;
    peak = Math.max(b, peak * 0.995);
    var ref = Math.max(0.12, peak);
    var norm = Math.max(0, Math.min(1, b / ref));
    var now = (root.performance && performance.now()) || Date.now();
    var hit = norm > 0.62 && (now - lastHit) > 130;
    if (hit) lastHit = now;
    return { bass: b, all: (all / n) / 255, norm: norm, hit: hit };
  }

  root.TerseTunes = {
    load: load,
    tracks: function () { return TRACKS; },
    order: function () { return ORDER.slice(); },
    name: function (id) { return (TRACKS[id] && TRACKS[id].name) || id; },
    unlock: unlock, play: play, stop: stop, level: level,
    setMuted: setMuted, muted: function () { return muted; },
    playing: function () { return current; },
    ready: function () { return !!(ctx && ctx.state === 'running' && el && !el.paused); },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.TerseTunes;
}(typeof window !== 'undefined' ? window : globalThis));
