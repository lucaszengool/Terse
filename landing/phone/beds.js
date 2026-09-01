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

  var BEDS = [
    {
      id: 'aurora', en: 'Aurora', zh: '极光', swatch: ['#2FE6A8', '#1b2f3d'],
      paint: function (x, w, h) {
        ground(x, w, h, [[0, '#0d1b2a'], [0.45, '#1b2f3d'], [1, '#07100f']]);
        pool(x, w, h, 0.28, 0.30, '#2FE6A8', 0.30);
        pool(x, w, h, 0.74, 0.66, '#5AD8FF', 0.22);
      },
    },
    {
      id: 'dusk', en: 'Dusk', zh: '黄昏', swatch: ['#E0713F', '#221436'],
      paint: function (x, w, h) {
        ground(x, w, h, [[0, '#160d26'], [0.55, '#221436'], [1, '#0a0710']]);
        pool(x, w, h, 0.5, 0.86, '#E0713F', 0.34, 0.55);
        pool(x, w, h, 0.22, 0.30, '#7A4BD0', 0.20);
      },
    },
    {
      id: 'ink', en: 'Ink', zh: '水墨', swatch: ['#8899A6', '#0b0d10'],
      paint: function (x, w, h) {
        ground(x, w, h, [[0, '#0f1216'], [0.6, '#0b0d10'], [1, '#07080a']]);
        pool(x, w, h, 0.38, 0.42, '#8899A6', 0.16, 0.6);
        pool(x, w, h, 0.72, 0.18, '#C9D6DE', 0.08);
      },
    },
    {
      id: 'ember', en: 'Ember', zh: '余烬', swatch: ['#FF6B3D', '#1a0c08'],
      paint: function (x, w, h) {
        ground(x, w, h, [[0, '#1a0c08'], [0.5, '#210f0a'], [1, '#0a0504']]);
        pool(x, w, h, 0.5, 0.92, '#FF6B3D', 0.30, 0.5);
        pool(x, w, h, 0.18, 0.55, '#B32D1C', 0.16);
      },
    },
    {
      id: 'moss', en: 'Moss', zh: '苔藓', swatch: ['#5FBF7A', '#0b160f'],
      paint: function (x, w, h) {
        ground(x, w, h, [[0, '#0d1a12'], [0.55, '#0b160f'], [1, '#060b08']]);
        pool(x, w, h, 0.3, 0.7, '#5FBF7A', 0.22);
        pool(x, w, h, 0.76, 0.28, '#A8D98B', 0.12);
      },
    },
    {
      id: 'violet', en: 'Violet', zh: '紫域', swatch: ['#A06BFF', '#150f28'],
      paint: function (x, w, h) {
        ground(x, w, h, [[0, '#150f28'], [0.5, '#1d1440'], [1, '#08060f']]);
        pool(x, w, h, 0.66, 0.34, '#A06BFF', 0.26);
        pool(x, w, h, 0.24, 0.78, '#FF6BC1', 0.16);
      },
    },
    {
      id: 'steel', en: 'Steel', zh: '钢蓝', swatch: ['#6D9BC9', '#0c1219'],
      paint: function (x, w, h) {
        ground(x, w, h, [[0, '#0c1219'], [0.5, '#111b26'], [1, '#070a0e']]);
        pool(x, w, h, 0.5, 0.16, '#6D9BC9', 0.22, 0.55);
        pool(x, w, h, 0.5, 0.9, '#2B4966', 0.20);
      },
    },
    {
      id: 'void', en: 'Void', zh: '虚空', swatch: ['#3A3F4A', '#050506'],
      paint: function (x, w, h) {
        // The quietest of them, for anyone who wants the particles and nothing
        // else. Still not flat black: the engine needs something to sample.
        ground(x, w, h, [[0, '#0a0b0d'], [0.6, '#050506'], [1, '#030304']]);
        pool(x, w, h, 0.5, 0.45, '#3A3F4A', 0.14, 0.7);
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
