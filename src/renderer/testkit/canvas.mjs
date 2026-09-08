/**
 * canvas.mjs — 一块够用的 2D 画布,给 node 里的取样函数用。
 *
 * sampleLabel() 把名字**写进一块画布再读回像素**,靠 alpha 找出笔画在哪。node 里
 * 没有画布,于是整条路在测试里根本走不了 —— 而它是这一幕里唯一带副作用的一段。
 *
 * 所以这个替身要做到一件事:fillText 之后 getImageData 真的能读到"墨"。它画的
 * 不是字,是字**大致占的那一块**(中间一条横带),因为被测的是取样和排版,不是
 * 字形本身 —— 字形是浏览器的事。⚠ 一块永远读回全零的画布会让 sampleLabel 返回
 * null,于是标签一个点都不画,而测试照样"通过"。替身宁可粗糙,不能是空的。
 */
class Ctx {
  constructor(cv) { this.cv = cv; this.font = ''; this.fillStyle = '#000'; }
  measureText(t) {
    const m = (this.font.match(/(\d+)px/) || [])[1] || 10;
    return { width: String(t).length * m * 0.58 };    // 等宽近似,足够排版用
  }
  fillRect(x, y, w, h) {
    const on = this.fillStyle !== '#000' ? 255 : 0;
    for (let py = Math.max(0, y | 0); py < Math.min(this.cv.height, (y + h) | 0); py++) {
      for (let px = Math.max(0, x | 0); px < Math.min(this.cv.width, (x + w) | 0); px++) {
        const i = (py * this.cv.width + px) * 4;
        this.cv.buf[i] = this.cv.buf[i + 1] = this.cv.buf[i + 2] = on;
        this.cv.buf[i + 3] = 255;
      }
    }
  }
  fillText(t) {
    // 字大致落在中间那条带上。宽度按 measureText 折算,居中。
    const w = Math.min(this.cv.width, this.measureText(t).width);
    const x0 = Math.max(0, Math.round((this.cv.width - w) / 2));
    const y0 = Math.round(this.cv.height * 0.28), y1 = Math.round(this.cv.height * 0.72);
    const keep = this.fillStyle; this.fillStyle = '#fff';
    this.fillRect(x0, y0, w, y1 - y0);
    this.fillStyle = keep;
  }
  getImageData(x, y, w, h) { return { data: this.cv.buf, width: w, height: h }; }
  drawImage() {}
}
class Canvas {
  constructor() { this._w = 1; this._h = 1; this.buf = new Uint8ClampedArray(4); }
  get width() { return this._w; }
  set width(v) { this._w = v | 0; this._alloc(); }
  get height() { return this._h; }
  set height(v) { this._h = v | 0; this._alloc(); }
  _alloc() { this.buf = new Uint8ClampedArray(Math.max(1, this._w * this._h) * 4); }
  getContext() { return new Ctx(this); }
  toDataURL() { return 'data:,'; }
}
if (typeof globalThis.document === 'undefined') {
  globalThis.document = { createElement: (t) => (t === 'canvas' ? new Canvas() : {}) };
}
