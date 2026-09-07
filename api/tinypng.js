/**
 * tinypng.js — 一个没有依赖的 PNG 写入器,8 位 RGB。
 *
 * 抽出来是因为**第二个调用方出现了**:种子数据要画封面,从 GitHub 扫出来的项目
 * 也要 —— 而这种"抄一份就好"的小工具一旦有两份,两份就会各自漂移,然后广场上
 * 会有两种看起来不太一样的封面,没人报 bug,只会觉得有点糊。
 */
const zlib = require('zlib');

/* ── A minimal PNG writer ─────────────────────────────────────────────────
   No dependency, no binary blobs checked into the repo. Writes an 8-bit RGB
   image: signature, IHDR, one deflated IDAT (each row prefixed with a zero
   filter byte, which is what the spec calls "None"), IEND. */
function png(width, height, rgbAt) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;                                   // filter: None
    for (let x = 0; x < width; x++) {
      const c = rgbAt(x / (width - 1), y / (height - 1));
      raw[o++] = c[0]; raw[o++] = c[1]; raw[o++] = c[2];
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

module.exports = { png, crc32 };
