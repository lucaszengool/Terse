/* ── QR encoder ──────────────────────────────────────────────────────────────
   Byte-mode QR (versions 1–40, EC levels L/M/Q/H), written out in full because
   the alternatives don't fit this app: a CDN script is dead the moment the
   machine is offline, and Terse's whole point is running locally.

   It exists for one reason — an invite you can SCAN. A phone camera in WeChat
   or Douyin cannot open a `terse://` link (see landing/join.html), so the QR
   carries the https invite page instead, and scanning it lands the friend
   somewhere that works in those apps.

   Exposes TerseQR.matrix(text, ecl) -> boolean[][] and TerseQR.svg(text, opts).
   ---------------------------------------------------------------------------- */
(function (root) {
  'use strict';

  // Per-version, per-EC-level tables from the spec. Index 0 is unused so the
  // version number can index directly.
  var ECC_PER_BLOCK = {
    L: [-1,7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28,28,28,30,30,26,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
    M: [-1,10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28],
    Q: [-1,13,22,18,26,18,24,18,22,20,24,28,26,24,20,30,24,28,28,26,30,28,30,30,30,30,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
    H: [-1,17,28,22,16,22,28,26,26,24,28,24,28,22,24,24,30,28,28,26,28,30,24,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30]
  };
  var NUM_BLOCKS = {
    L: [-1,1,1,1,1,1,2,2,2,2,4,4,4,4,4,6,6,6,6,7,8,8,9,9,10,12,12,12,13,14,15,16,17,18,19,19,20,21,22,24,25],
    M: [-1,1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49],
    Q: [-1,1,1,2,2,4,4,6,6,8,8,8,10,12,16,12,17,16,18,21,20,23,23,25,27,29,34,34,35,38,40,43,45,48,51,53,56,59,62,65,68],
    H: [-1,1,1,2,4,4,4,5,6,8,8,11,11,16,16,18,16,19,21,25,25,25,34,30,32,35,37,40,42,45,48,51,54,57,60,63,66,70,74,77,81]
  };
  var ECL_BITS = { L: 1, M: 0, Q: 3, H: 2 };

  // ── GF(2^8) arithmetic, modulus x^8+x^4+x^3+x^2+1 ──
  function gfMul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
  }

  /** Coefficients of the divisor polynomial (x-r^0)(x-r^1)…, highest term omitted. */
  function rsDivisor(degree) {
    var result = new Uint8Array(degree);
    result[degree - 1] = 1;
    var root = 1;
    for (var i = 0; i < degree; i++) {
      for (var j = 0; j < degree; j++) {
        result[j] = gfMul(result[j], root);
        if (j + 1 < degree) result[j] ^= result[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return result;
  }

  function rsRemainder(data, divisor) {
    var result = new Uint8Array(divisor.length);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ result[0];
      result.copyWithin(0, 1);
      result[result.length - 1] = 0;
      for (var j = 0; j < divisor.length; j++) result[j] ^= gfMul(divisor[j], factor);
    }
    return result;
  }

  // ── Capacity ──
  function rawDataModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }
  function dataCodewords(ver, ecl) {
    return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ecl][ver] * NUM_BLOCKS[ecl][ver];
  }

  function alignPositions(ver) {
    if (ver === 1) return [];
    var numAlign = Math.floor(ver / 7) + 2;
    var step = (ver === 32) ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    var result = [6];
    for (var pos = ver * 4 + 10; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  // ── Bit stream ──
  function BitBuf() { this.bits = []; }
  BitBuf.prototype.push = function (val, len) {
    for (var i = len - 1; i >= 0; i--) this.bits.push((val >>> i) & 1);
  };

  function utf8Bytes(str) {
    var out = [], s = encodeURIComponent(str);
    for (var i = 0; i < s.length; i++) {
      if (s[i] === '%') { out.push(parseInt(s.substr(i + 1, 2), 16)); i += 2; }
      else out.push(s.charCodeAt(i));
    }
    return out;
  }

  /** Smallest version that holds `bytes` at `ecl`, or 0 when it never fits. */
  function pickVersion(byteLen, ecl) {
    for (var ver = 1; ver <= 40; ver++) {
      var capacityBits = dataCodewords(ver, ecl) * 8;
      var ccBits = ver <= 9 ? 8 : 16;
      if (4 + ccBits + byteLen * 8 <= capacityBits) return ver;
    }
    return 0;
  }

  function codewords(bytes, ver, ecl) {
    var bb = new BitBuf();
    bb.push(0x4, 4);                                   // byte mode
    bb.push(bytes.length, ver <= 9 ? 8 : 16);
    for (var i = 0; i < bytes.length; i++) bb.push(bytes[i], 8);

    var capacityBits = dataCodewords(ver, ecl) * 8;
    bb.push(0, Math.min(4, capacityBits - bb.bits.length));
    bb.push(0, (8 - bb.bits.length % 8) % 8);
    for (var pad = 0xEC; bb.bits.length < capacityBits; pad ^= 0xEC ^ 0x11) bb.push(pad, 8);

    var data = new Uint8Array(bb.bits.length / 8);
    for (var k = 0; k < bb.bits.length; k++) data[k >>> 3] |= bb.bits[k] << (7 - (k & 7));

    // Interleave the blocks: short blocks first, then the longer ones, with the
    // ECC of every block appended in the same order.
    var numBlocks = NUM_BLOCKS[ecl][ver];
    var eccLen = ECC_PER_BLOCK[ecl][ver];
    var rawCodewords = Math.floor(rawDataModules(ver) / 8);
    var numShort = numBlocks - rawCodewords % numBlocks;
    var shortLen = Math.floor(rawCodewords / numBlocks) - eccLen;

    // Every block is stored at the LONG length, short ones carrying a filler at
    // index `shortLen` that the interleave below skips. Without that filler the
    // ECC of the short and long blocks would sit at different offsets and the
    // interleaved stream would be shuffled.
    var divisor = rsDivisor(eccLen), blocks = [], off = 0;
    for (var b = 0; b < numBlocks; b++) {
      var len = shortLen + (b < numShort ? 0 : 1);
      var dat = data.slice(off, off + len); off += len;
      var block = new Uint8Array(shortLen + 1 + eccLen);
      block.set(dat, 0);
      block.set(rsRemainder(dat, divisor), shortLen + 1);
      blocks.push(block);
    }
    var out = [];
    for (var i2 = 0; i2 < blocks[0].length; i2++) {
      for (var j = 0; j < blocks.length; j++) {
        // Every short block is missing exactly the last data codeword.
        if (i2 !== shortLen || j >= numShort) out.push(blocks[j][i2]);
      }
    }
    return out;
  }

  // ── Drawing ──
  function build(ver, ecl, dataCw, forcedMask) {
    var size = ver * 4 + 17;
    var modules = [], isFn = [];
    for (var i = 0; i < size; i++) {
      modules.push(new Array(size).fill(false));
      isFn.push(new Array(size).fill(false));
    }
    function set(x, y, dark) {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      modules[y][x] = dark; isFn[y][x] = true;
    }
    function finder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var dist = Math.max(Math.abs(dx), Math.abs(dy));
        set(cx + dx, cy + dy, dist !== 2 && dist !== 4);
      }
    }
    // Timing patterns
    for (var t = 0; t < size; t++) { set(6, t, t % 2 === 0); set(t, 6, t % 2 === 0); }
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);

    var align = alignPositions(ver);
    for (var a = 0; a < align.length; a++) for (var c = 0; c < align.length; c++) {
      // The three finder corners have no alignment pattern.
      if ((a === 0 && c === 0) || (a === 0 && c === align.length - 1) || (a === align.length - 1 && c === 0)) continue;
      for (var dy2 = -2; dy2 <= 2; dy2++) for (var dx2 = -2; dx2 <= 2; dx2++)
        set(align[c] + dx2, align[a] + dy2, Math.max(Math.abs(dx2), Math.abs(dy2)) !== 1);
    }

    // Claim the format area by drawing it once (mask 0 — the real mask is written
    // in again below). Reserving it by hand instead would have to re-list which
    // cells it covers, and the two lists would drift: an earlier version of this
    // blanked (8,6) and (6,8), which belong to the timing patterns, not to the
    // format field.
    drawFormat(0);

    if (ver >= 7) {
      var rem = ver;
      for (var v = 0; v < 12; v++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      var bitsV = ver << 12 | rem;
      for (var i4 = 0; i4 < 18; i4++) {
        var bit = ((bitsV >>> i4) & 1) === 1;
        var aa = size - 11 + i4 % 3, bbp = Math.floor(i4 / 3);
        set(aa, bbp, bit); set(bbp, aa, bit);
      }
    }

    // Data, laid out in the two-wide zigzag from the bottom-right corner.
    var idx = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;                       // skip the timing column
      for (var vert = 0; vert < size; vert++) {
        for (var jj = 0; jj < 2; jj++) {
          var x = right - jj;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? size - 1 - vert : vert;
          if (!isFn[y][x] && idx < dataCw.length * 8) {
            modules[y][x] = ((dataCw[idx >>> 3] >>> (7 - (idx & 7))) & 1) !== 0;
            idx++;
          }
        }
      }
    }

    function maskFn(m, x, y) {
      switch (m) {
        case 0: return (x + y) % 2 === 0;
        case 1: return y % 2 === 0;
        case 2: return x % 3 === 0;
        case 3: return (x + y) % 3 === 0;
        case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
        case 5: return x * y % 2 + x * y % 3 === 0;
        case 6: return (x * y % 2 + x * y % 3) % 2 === 0;
        case 7: return ((x + y) % 2 + x * y % 3) % 2 === 0;
      }
    }
    function applyMask(m) {
      for (var y = 0; y < size; y++) for (var x = 0; x < size; x++)
        if (!isFn[y][x] && maskFn(m, x, y)) modules[y][x] = !modules[y][x];
    }
    function drawFormat(m) {
      var d = ECL_BITS[ecl] << 3 | m, r = d;
      for (var i5 = 0; i5 < 10; i5++) r = (r << 1) ^ ((r >>> 9) * 0x537);
      var bits = ((d << 10 | r) ^ 0x5412) & 0x7FFF;
      for (var i6 = 0; i6 <= 5; i6++) set(8, i6, ((bits >>> i6) & 1) === 1);
      set(8, 7, ((bits >>> 6) & 1) === 1);
      set(8, 8, ((bits >>> 7) & 1) === 1);
      set(7, 8, ((bits >>> 8) & 1) === 1);
      for (var i7 = 9; i7 < 15; i7++) set(14 - i7, 8, ((bits >>> i7) & 1) === 1);
      for (var i8 = 0; i8 < 8; i8++) set(size - 1 - i8, 8, ((bits >>> i8) & 1) === 1);
      for (var i9 = 8; i9 < 15; i9++) set(8, size - 15 + i9, ((bits >>> i9) & 1) === 1);
      set(8, size - 8, true);
    }

    // Pick the mask the spec prefers: lowest penalty over the four rules.
    // `forcedMask` skips the choice — nothing in the app passes it; it exists so
    // qr.test.mjs can drive this encoder and the reference one to the same mask
    // and compare module for module. The two disagree about the tie-break (see
    // that file), so without it every comparison would be noise.
    var best = 0, bestPenalty = Infinity;
    if (forcedMask != null) {
      best = forcedMask;
    } else {
      for (var m2 = 0; m2 < 8; m2++) {
        applyMask(m2); drawFormat(m2);
        var p = penalty(modules, size);
        if (p < bestPenalty) { bestPenalty = p; best = m2; }
        applyMask(m2);                                  // undo (XOR is its own inverse)
      }
    }
    applyMask(best); drawFormat(best);
    return modules;
  }

  /* The four penalty rules. Only used to choose the mask, so a scanner never
     sees this number — but a bad choice makes the code harder to read, which is
     exactly what the rules are for. Rule 3 is expressed as the two literal
     11-module sequences (finder-like 1:1:3:1:1 plus its 4-module light margin)
     rather than as run-length bookkeeping, because that is what it means. */
  function penalty(mod, size) {
    var N1 = 3, N2 = 3, N3 = 40, N4 = 10, result = 0;
    var P1 = [1,0,1,1,1,0,1,0,0,0,0], P2 = [0,0,0,0,1,0,1,1,1,0,1];

    function line(get) {
      var runColor = get(0), runLen = 1, i;
      for (i = 1; i < size; i++) {
        if (get(i) === runColor) {
          runLen++;
          if (runLen === 5) result += N1; else if (runLen > 5) result++;
        } else { runColor = get(i); runLen = 1; }
      }
      for (i = 0; i + 10 < size; i++) {
        var m1 = true, m2 = true;
        for (var j = 0; j < 11; j++) {
          var v = get(i + j) ? 1 : 0;
          if (v !== P1[j]) m1 = false;
          if (v !== P2[j]) m2 = false;
        }
        if (m1 || m2) result += N3;
      }
    }
    for (var y = 0; y < size; y++) line((function (yy) { return function (x) { return mod[yy][x]; }; })(y));
    for (var x = 0; x < size; x++) line((function (xx) { return function (y2) { return mod[y2][xx]; }; })(x));

    for (var y3 = 0; y3 < size - 1; y3++) for (var x3 = 0; x3 < size - 1; x3++) {
      var c = mod[y3][x3];
      if (c === mod[y3][x3 + 1] && c === mod[y3 + 1][x3] && c === mod[y3 + 1][x3 + 1]) result += N2;
    }

    var dark = 0;
    for (var y4 = 0; y4 < size; y4++) for (var x4 = 0; x4 < size; x4++) if (mod[y4][x4]) dark++;
    var total = size * size;
    var k = Math.floor(Math.abs(dark * 100 / total - 50) / 5);
    result += k * N4;
    return result;
  }

  function matrix(text, ecl, forcedMask) {
    ecl = ecl || 'M';
    var bytes = utf8Bytes(String(text));
    var ver = pickVersion(bytes.length, ecl);
    if (!ver) throw new Error('QR: payload too long');
    return build(ver, ecl, codewords(bytes, ver, ecl), forcedMask);
  }

  /** An SVG string — one <path> for every dark module, so it scales cleanly. */
  function svg(text, opts) {
    opts = opts || {};
    var mod = matrix(text, opts.ecl || 'M');
    var size = mod.length, quiet = opts.quiet == null ? 2 : opts.quiet;
    var dim = size + quiet * 2;
    var parts = [];
    for (var y = 0; y < size; y++) for (var x = 0; x < size; x++)
      if (mod[y][x]) parts.push('M' + (x + quiet) + ',' + (y + quiet) + 'h1v1h-1z');
    var px = opts.size || 132;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim +
      '" width="' + px + '" height="' + px + '" shape-rendering="crispEdges">' +
      '<rect width="' + dim + '" height="' + dim + '" fill="' + (opts.light || '#fff') + '"/>' +
      '<path d="' + parts.join('') + '" fill="' + (opts.dark || '#000') + '"/></svg>';
  }

  var api = { matrix: matrix, svg: svg };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TerseQR = api;
})(typeof window !== 'undefined' ? window : globalThis);
