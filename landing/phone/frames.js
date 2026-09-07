/**
 * frames.js — 从一张动图或一段视频里取出**帧**,交给粒子去演。
 *
 * ⚠ 为什么不解码 GIF。WebCodecs 的 ImageDecoder 能按帧解 GIF,但它到 **Safari 26**
 * 才登陆 iOS —— 16.4 到 18.7 只给了视频那几个接口。这个 app 首先是给 iPhone 用的,
 * 所以"最正确"的那条路恰好是这里最不能走的一条。自己写一个 LZW 解码器是另一条,
 * 两三百行位运算,而且错了会安静地错。
 *
 * 用的是一个到处都成立的办法:**动图自己会动**。把 `<img>` 画进 canvas,拿到的就是
 * 它此刻显示的那一帧;隔一会儿再画一次,就是下一帧。不需要解码器,不需要库,
 * Safari、Chrome、老 iOS 全都吃这一套。视频同理,只是改成 seek 到某个时间再画。
 *
 * 帧要**小**:胶囊整颗有 160KB 的上限,而 12 张 128px 的 JPEG 大约 30–70KB。
 * 反正最终是要被采样成几万颗粒子的,128px 已经比粒子网格细了 —— 再大只是把
 * 带宽花在没人看得见的细节上。
 */
(function (root) {
  'use strict';

  var SIZE = 128;          // 帧的长边
  var COUNT = 12;          // 取多少帧
  var QUALITY = 0.72;

  function canvasOf(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  /** 等比缩到长边 SIZE 以内,画进 canvas,输出 JPEG data URL。 */
  function shrink(src, sw, sh) {
    var k = Math.min(1, SIZE / Math.max(sw || SIZE, sh || SIZE));
    var w = Math.max(8, Math.round((sw || SIZE) * k));
    var h = Math.max(8, Math.round((sh || SIZE) * k));
    var c = canvasOf(w, h);
    var g = c.getContext('2d');
    g.drawImage(src, 0, 0, w, h);
    // JPEG,不是 PNG:这是照片和动图,PNG 在这种内容上大三到五倍,而胶囊有闸门。
    return c.toDataURL('image/jpeg', QUALITY);
  }

  /** 一张静图 → 一帧。 */
  function fromImageFile(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var im = new Image();
      im.onload = function () {
        var out = shrink(im, im.naturalWidth, im.naturalHeight);
        URL.revokeObjectURL(url);
        resolve({ frames: [out], fps: 12, animated: false });
      };
      im.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not read that image')); };
      im.src = url;
    });
  }

  /** 一张动图 → 一串帧。靠"它自己在动"这件事采样,见文件顶部。 */
  function fromAnimatedImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var im = new Image();
      im.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not read that image')); };
      im.onload = function () {
        var frames = [];
        var last = null, same = 0;
        var iv = setInterval(function () {
          var shot;
          try { shot = shrink(im, im.naturalWidth, im.naturalHeight); }
          catch (e) { clearInterval(iv); URL.revokeObjectURL(url); reject(e); return; }
          /* 一张静图每次画出来都一样。连着几次没变就说明它根本不是动图 ——
             与其存十二张一模一样的帧,不如老实说这是一张图。 */
          if (shot === last) { same++; } else { same = 0; frames.push(shot); }
          last = shot;
          if (frames.length >= COUNT || same >= 3) {
            clearInterval(iv);
            URL.revokeObjectURL(url);
            resolve({ frames: frames, fps: 12, animated: frames.length > 1 });
          }
        }, 90);
      };
      im.src = url;
    });
  }

  /** 一段视频 → 一串帧。seek 到均匀分布的时间点,每次画一张。 */
  function fromVideo(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'metadata'; v.src = url;
      var frames = [], at = 0, times = [];
      var done = function (err) {
        URL.revokeObjectURL(url);
        if (err) reject(err);
        else resolve({ frames: frames, fps: 12, animated: frames.length > 1 });
      };
      v.onerror = function () { done(new Error('Could not read that video')); };
      v.onloadedmetadata = function () {
        var dur = isFinite(v.duration) && v.duration > 0 ? Math.min(v.duration, 6) : 1;
        for (var i = 0; i < COUNT; i++) times.push((dur * (i + 0.5)) / COUNT);
        v.currentTime = times[0];
      };
      v.onseeked = function () {
        try { frames.push(shrink(v, v.videoWidth, v.videoHeight)); }
        catch (e) { return done(e); }
        at++;
        if (at >= times.length) return done(null);
        v.currentTime = times[at];
      };
    });
  }

  /** 交给它一个文件,它自己决定怎么拆。 */
  function extract(file) {
    if (!file) return Promise.reject(new Error('No file'));
    var type = String(file.type || '').toLowerCase();
    if (type.indexOf('video/') === 0) return fromVideo(file);
    // GIF 和 APNG/WebP 动图走采样那条路;其余当静图,快得多。
    if (type === 'image/gif' || type === 'image/webp' || type === 'image/apng') {
      return fromAnimatedImage(file);
    }
    if (type.indexOf('image/') === 0) return fromImageFile(file);
    return Promise.reject(new Error('Pick an image or a video'));
  }

  root.TerseFrames = { extract: extract, SIZE: SIZE, COUNT: COUNT };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.TerseFrames;
}(typeof window !== 'undefined' ? window : globalThis));
