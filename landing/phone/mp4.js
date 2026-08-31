/**
 * mp4.js — a minimal MP4 muxer for a single H.264 video track.
 *
 * WHY THIS EXISTS. WebCodecs' VideoEncoder hands back encoded H.264 chunks and
 * explicitly does NOT produce a container; every example reaches for mp4-muxer
 * or MP4Box.js at this point. This runs inside a service-worker-cached web app
 * that must work offline, and it is needed for exactly one shape — one video
 * track, no audio, constant frame rate — so a few hundred lines here beats a
 * dependency that can fail to load at the moment it is wanted.
 *
 * WHY AN MP4 AT ALL. It is the only way to get the real particle field ANIMATING
 * on an iPhone's wallpaper. iOS will not take a video as a wallpaper, but
 * Shortcuts has a native "Make Live Photo" action, and a Live Photo does animate
 * on the Lock Screen when the phone wakes. So: render the field → encode H.264
 * here → hand the phone an .mp4 → Shortcuts turns it into a Live Photo.
 *
 * The layout is the plain, non-fragmented one — ftyp, mdat, moov — with moov
 * written last, once the sample sizes and offsets are known. Photos and
 * Shortcuts both read that happily, and it avoids having to guess sizes up front.
 *
 * Samples must be in AVCC form (4-byte length prefixes, not Annex-B start
 * codes), which is what VideoEncoder produces when configured with
 * `avc: { format: 'avc' }`. The avcC box comes straight from the encoder's
 * `description`.
 */
(function (root) {
  'use strict';

  function u32(n) {
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  }
  function u16(n) { return [(n >>> 8) & 255, n & 255]; }
  function str(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 255);
    return out;
  }

  /** A box: 4-byte length, 4-char type, then the payload. */
  function box(type, ...parts) {
    var body = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (typeof p === 'string') body = body.concat(str(p));
      else if (Array.isArray(p)) body = body.concat(p);
      else if (p instanceof Uint8Array) body = body.concat(Array.from(p));
    }
    return u32(body.length + 8).concat(str(type)).concat(body);
  }

  /** A full box — a box whose payload starts with a version and flags. */
  function fbox(type, version, flags, ...parts) {
    return box(type, [version].concat([(flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255]), ...parts);
  }

  /**
   * Wrap encoded chunks into an MP4.
   *
   *   samples     [{ data: Uint8Array, duration, isKey }]  in decode order
   *   description the encoder's avcC bytes
   *   width/height in pixels
   *   timescale   ticks per second that the durations are expressed in
   */
  function mux(opts) {
    var samples = opts.samples;
    var width = opts.width, height = opts.height;
    var timescale = opts.timescale || 90000;
    var avcC = opts.description;

    var total = samples.reduce(function (n, s) { return n + s.data.length; }, 0);
    var duration = samples.reduce(function (n, s) { return n + s.duration; }, 0);

    // ── Sample tables ──
    // stts is run-length encoded: a constant frame rate collapses to one entry,
    // which is both smaller and what every decoder expects to see.
    var stts = [];
    var run = null;
    samples.forEach(function (s) {
      if (run && run.delta === s.duration) { run.count++; return; }
      run = { count: 1, delta: s.duration };
      stts.push(run);
    });

    var syncs = [];
    samples.forEach(function (s, i) { if (s.isKey) syncs.push(i + 1); });   // 1-based

    var sttsBox = fbox('stts', 0, 0, u32(stts.length),
      stts.reduce(function (a, r) { return a.concat(u32(r.count)).concat(u32(r.delta)); }, []));

    // Omitted entirely when every frame is a keyframe: stss means "these are the
    // sync samples", and a table listing all of them says nothing.
    var stssBox = (syncs.length && syncs.length !== samples.length)
      ? fbox('stss', 0, 0, u32(syncs.length), syncs.reduce(function (a, n) { return a.concat(u32(n)); }, []))
      : [];

    var stszBox = fbox('stsz', 0, 0, u32(0), u32(samples.length),
      samples.reduce(function (a, s) { return a.concat(u32(s.data.length)); }, []));

    // One chunk holding every sample: simplest valid arrangement, and the whole
    // mdat is contiguous anyway.
    var stscBox = fbox('stsc', 0, 0, u32(1), u32(1).concat(u32(samples.length)).concat(u32(1)));

    var avc1 = box('avc1',
      [0, 0, 0, 0, 0, 0], u16(1),                    // reserved, data_reference_index
      u16(0), u16(0), u32(0), u32(0), u32(0),        // pre_defined / reserved
      u16(width), u16(height),
      u32(0x00480000), u32(0x00480000),              // 72 dpi horiz/vert
      u32(0), u16(1),
      [32].concat(new Array(31).fill(0)),            // compressorname (32 bytes, len-prefixed)
      u16(24), u16(0xffff),                          // depth, pre_defined = -1
      box('avcC', avcC));

    var stblContents = [box('stsd', [0], [0, 0, 0], u32(1), avc1), sttsBox];
    if (stssBox.length) stblContents.push(stssBox);
    stblContents.push(stscBox, stszBox);

    // stco holds absolute file offsets, so it can only be written once the size
    // of everything before mdat is known. Built with a placeholder, patched below.
    var stcoBox = fbox('stco', 0, 0, u32(1), u32(0));
    stblContents.push(stcoBox);

    var stbl = box.apply(null, ['stbl'].concat(stblContents));

    var minf = box('minf',
      box('vmhd', [0], [0, 0, 1], u16(0), u16(0), u16(0), u16(0)),
      box('dinf', fbox('dref', 0, 0, u32(1), fbox('url ', 0, 1))),
      stbl);

    var mdia = box('mdia',
      fbox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u16(0x55c4), u16(0)),
      fbox('hdlr', 0, 0, u32(0), 'vide', u32(0), u32(0), u32(0), 'Terse\0'),
      minf);

    var UNITY = [0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0,
                 0, 0, 0, 0, 0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0,
                 0, 0, 0, 0, 0, 0, 0, 0, 0x40, 0x00, 0x00, 0x00];

    var trak = box('trak',
      fbox('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(duration),
        u32(0), u32(0), u16(0), u16(0), u16(0), u16(0), UNITY,
        u32(width * 65536), u32(height * 65536)),
      mdia);

    var moov = box('moov',
      fbox('mvhd', 0, 0, u32(0), u32(0), u32(timescale), u32(duration),
        u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0), UNITY,
        u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(2)),
      trak);

    var ftyp = box('ftyp', 'isom', u32(0x200), 'isomiso2avc1mp41');

    // mdat's payload begins 8 bytes after the box starts.
    var mdatStart = ftyp.length;
    var dataOffset = mdatStart + 8;

    // Patch stco now that the offset is known. Located by searching moov rather
    // than tracked by index: the surrounding boxes are assembled by concatenation
    // and any hand-kept index would silently rot the first time one changed.
    var moovBytes = new Uint8Array(moov);
    var stcoAt = -1;
    for (var i = 0; i + 4 <= moovBytes.length; i++) {
      if (moovBytes[i] === 0x73 && moovBytes[i + 1] === 0x74 &&
          moovBytes[i + 2] === 0x63 && moovBytes[i + 3] === 0x6f) { stcoAt = i; break; }
    }
    if (stcoAt < 0) throw new Error('mp4: stco not found');
    // stco: type(4) version+flags(4) entry_count(4) then the offset.
    var off = stcoAt + 4 + 4 + 4;
    moovBytes[off] = (dataOffset >>> 24) & 255;
    moovBytes[off + 1] = (dataOffset >>> 16) & 255;
    moovBytes[off + 2] = (dataOffset >>> 8) & 255;
    moovBytes[off + 3] = dataOffset & 255;

    var out = new Uint8Array(ftyp.length + 8 + total + moovBytes.length);
    var at = 0;
    out.set(new Uint8Array(ftyp), at); at += ftyp.length;
    out.set(new Uint8Array(u32(total + 8).concat(str('mdat'))), at); at += 8;
    samples.forEach(function (s) { out.set(s.data, at); at += s.data.length; });
    out.set(moovBytes, at);
    return out;
  }

  root.TerseMP4 = { mux: mux };
})(window);
