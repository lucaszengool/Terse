/**
 * beds.js — the backdrops Terse ships, so nobody has to supply a photo.
 *
 * WHY THESE EXIST. On the Mac the field is a transparent window over the user's
 * real desktop picture: the engine samples that image to colour its particles
 * and never draws it. A phone has no desktop picture, and asking someone to go
 * and pick one before they can see anything is a wall in front of the feature.
 * So Terse brings its own.
 *
 * WHY THEY ARE PAINTED, NOT SHIPPED AS FILES. A wallpaper has to be sharp on a
 * 1290×2796 panel, and eight of those as JPEGs is several megabytes fetched
 * before the first frame. These are a handful of gradients each: a few hundred
 * bytes of code, rendered at whatever size is asked for, identical on every
 * device and needing no network at all. That also means a capture at full
 * wallpaper resolution costs nothing extra.
 *
 * Each one is dark on purpose. This ends up behind Home Screen icons and their
 * labels, and behind the Lock Screen clock — a bright backdrop makes both
 * unreadable, which is a wallpaper that gets changed back within a day.
 */
(function (root) {
  'use strict';

  /** Paint a full-bleed vertical gradient. */
  function ground(x, w, h, stops) {
    var g = x.createLinearGradient(0, 0, w * 0.35, h);
    for (var i = 0; i < stops.length; i++) g.addColorStop(stops[i][0], stops[i][1]);
    x.fillStyle = g;
    x.fillRect(0, 0, w, h);
  }

  /** A soft pool of light. The engine builds an edge/depth map from whatever it
   *  is given, so a flat fill would leave it nothing to work with — these are
   *  what make the particles pick up structure rather than a single tint. */
  function pool(x, w, h, cx, cy, colour, alpha, spread) {
    var r = Math.max(w, h) * (spread || 0.45);
    var g = x.createRadialGradient(w * cx, h * cy, 0, w * cx, h * cy, r);
    g.addColorStop(0, colour);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    x.globalAlpha = alpha;
    x.fillStyle = g;
    x.fillRect(0, 0, w, h);
    x.globalAlpha = 1;
  }

  /* Grain, at a deliberately low amplitude. Large smooth gradients band badly
     on an OLED panel at these sizes, and a little noise is what hides it. */
  function grain(x, w, h, amount) {
    var n = Math.round((w * h) / 1400);
    x.globalAlpha = amount;
    x.fillStyle = '#ffffff';
    for (var i = 0; i < n; i++) {
      x.fillRect(Math.random() * w, Math.random() * h, 1, 1);
    }
    x.globalAlpha = 1;
  }

  /* The palettes lean on the same idea Apple's stock wallpapers do: two or three
     saturated hues bleeding into a dark ground, with the brightest mass placed
     LOW and off-centre so the clock and the top row of icons sit over the quiet
     part. A flat two-stop gradient reads as a placeholder; overlapping blobs at
     different scales read as a wallpaper. */
  var BEDS = [
    {
      id: 'aurora', en: 'Aurora', zh: '极光', swatch: ['#2FE6A8', '#0a1a24'],
      paint: function (x, w, h) {
        ground(x, w, h, [[0, '#071722'], [0.5, '#0a1a24'], [1, '#040d10']]);
        pool(x, w, h, 0.22, 0.62, '#2FE6A8', 0.52, 0.52);
        pool(x, w, h, 0.78, 0.40, '#3AA0FF', 0.40, 0.46);
        pool(x, w, h, 0.52, 0.86, '#7CF5C0', 0.26, 0.38);
      },
    },
    {
      id: 'dusk', en: 'Dusk', zh: '黄昏', swatch: ['#FF7A45', '#1a0f2e'],
      paint: function (x, w, h) {
        ground(x, w, h, [[0, '#140a24'], [0.55, '#1a0f2e'], [1, '#07040d']]);
        pool(x, w, h, 0.5, 0.88, '#FF7A45', 0.56, 0.5);
        pool(x, w, h, 0.18, 0.52, '#8B4BD8', 0.42, 0.46);
        pool(x, w, h, 0.86, 0.66, '#FF4D8D', 0.28, 0.36);
      },
    },
    {
      id: 'tide', en: 'Tide', zh: '潮汐', swatch: ['#3AA0FF', '#071018'],
      paint: function (x, w, h) {
        ground(x, w, h, [[0, '#08131d'], [0.55, '#071018'], [1, '#03080c']]);
        pool(x, w, h, 0.72, 0.58, '#3AA0FF', 0.50, 0.5);
        pool(x, w, h, 0.24, 0.74, '#5AD8FF', 0.34, 0.42);
        pool(x, w, h, 0.5, 0.24, '#2C5FB8', 0.26, 0.44);
      },
    },
    {
      id: 'ember', en: 'Ember', zh: '余烬', swatch: ['#FF6B3D', '#160805'],
      paint: function (x, w, h) {
        ground(x, w, h, [[0, '#180a06'], [0.5, '#160805'], [1, '#080302']]);
        pool(x, w, h, 0.5, 0.9, '#FF6B3D', 0.55, 0.5);
        pool(x, w, h, 0.2, 0.6, '#C4321B', 0.36, 0.44);
        pool(x, w, h, 0.82, 0.74, '#FFB03A', 0.24, 0.34);
      },
    },
    {
      id: 'moss', en: 'Moss', zh: '苔藓', swatch: ['#5FBF7A', '#08150e'],
      paint: function (x, w, h) {
        ground(x, w, h, [[0, '#0a180f'], [0.55, '#08150e'], [1, '#040906']]);
        pool(x, w, h, 0.3, 0.7, '#5FBF7A', 0.46, 0.5);
        pool(x, w, h, 0.78, 0.34, '#A8D98B', 0.28, 0.42);
        pool(x, w, h, 0.56, 0.9, '#2E8B57', 0.30, 0.36);
      },
    },
    {
      id: 'violet', en: 'Violet', zh: '紫域', swatch: ['#A06BFF', '#100b22'],
      paint: function (x, w, h) {
        ground(x, w, h, [[0, '#120c26'], [0.5, '#100b22'], [1, '#06040c']]);
        pool(x, w, h, 0.66, 0.36, '#A06BFF', 0.52, 0.5);
        pool(x, w, h, 0.26, 0.76, '#FF6BC1', 0.36, 0.44);
        pool(x, w, h, 0.5, 0.6, '#5A3FCF', 0.28, 0.4);
      },
    },
    {
      id: 'ink', en: 'Ink', zh: '水墨', swatch: ['#9AA8B4', '#090b0e'],
      paint: function (x, w, h) {
        ground(x, w, h, [[0, '#0d1014'], [0.6, '#090b0e'], [1, '#050608']]);
        pool(x, w, h, 0.38, 0.44, '#9AA8B4', 0.26, 0.58);
        pool(x, w, h, 0.74, 0.78, '#C9D6DE', 0.14, 0.4);
      },
    },
    {
      id: 'void', en: 'Void', zh: '虚空', swatch: ['#3A3F4A', '#040405'],
      paint: function (x, w, h) {
        // The quietest, for anyone who wants the particles and nothing else.
        // Still not flat black: the engine needs something to sample.
        ground(x, w, h, [[0, '#0a0b0d'], [0.6, '#040405'], [1, '#020203']]);
        pool(x, w, h, 0.5, 0.5, '#3A3F4A', 0.18, 0.7);
      },
    },
  ];

  var byId = {};
  BEDS.forEach(function (b) { byId[b.id] = b; });

  var DEFAULT_ID = 'aurora';

  /** Render one bed to a data URL at the size asked for. */
  function render(id, w, h, quality) {
    var bed = byId[id] || byId[DEFAULT_ID];
    var c = document.createElement('canvas');
    c.width = Math.max(2, Math.round(w));
    c.height = Math.max(2, Math.round(h));
    var x = c.getContext('2d');
    bed.paint(x, c.width, c.height);
    grain(x, c.width, c.height, 0.05);
    return c.toDataURL('image/jpeg', quality || 0.9);
  }

  /** A small square for the picker. Rendered at the aspect of a phone so the
   *  thumbnail is a true preview rather than a differently-shaped crop. */
  function thumb(id, size) {
    var w = Math.round((size || 96) * 0.46);
    return render(id, w, size || 96, 0.82);
  }

  root.TerseBeds = {
    list: function () { return BEDS.slice(); },
    ids: function () { return BEDS.map(function (b) { return b.id; }); },
    get: function (id) { return byId[id] || null; },
    render: render,
    thumb: thumb,
    DEFAULT_ID: DEFAULT_ID,
  };
})(window);
