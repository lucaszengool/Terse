// Auto-generated: Terse Pals SVG renderer
// Source: docs/terse-pals-keke.html (kept in sync manually for now)
// Exports: KEKE (pet metadata array), kekeSVG(pal, size) → SVG inner-HTML string

// Colab-style: extremely simple. Each pal = blob silhouette + tiny features.
// shape: blob silhouette template; ear: ear style; tail: tail style; tongue: bool; mouth: 'smile'|'w'|'open'|'none'
const KEKE=[
  {id:'shiro', name:'Shiro', sub:'White Bear',  body:'#F8F4EE', belly:'#FFE8E0', anim:'k-breathe', spd:5.0, shape:'fluff', ear:'round',  tail:'puff', tongue:true,  mouth:'open'},
  {id:'boba',  name:'Boba',  sub:'Honey Bear',  body:'#D49860', belly:'#F0D8B0', anim:'k-breathe', spd:5.4, shape:'fluff', ear:'round',  tail:'puff', tongue:true,  mouth:'open'},
  {id:'koko',  name:'Koko',  sub:'Panda',       body:'#FFFFFF', belly:'#FFFFFF', anim:'k-bob',     spd:4.6, shape:'panda', ear:'panda',  tail:'puff', tongue:false, mouth:'w'},
  {id:'momo',  name:'Momo',  sub:'Pink Cat',    body:'#FFB8CA', belly:'#FFE0E8', anim:'k-walk',    spd:2.8, shape:'cat',   ear:'cat',    tail:'curl', tongue:false, mouth:'w'},
  {id:'kumo',  name:'Kumo',  sub:'Cloud Sheep', body:'#FAF6F0', belly:'#FAF6F0', anim:'k-bob',     spd:5.6, shape:'cloud', ear:'tiny',   tail:'puff', tongue:false, mouth:'smile', face:'#3A2820'},
  {id:'goma',  name:'Goma',  sub:'Dalmatian',   body:'#FFFFFF', belly:'#FFFFFF', anim:'k-walk',    spd:2.4, shape:'corgi', ear:'flop',   tail:'puff', tongue:true,  mouth:'open',  spots:true},
  {id:'toro',  name:'Toro',  sub:'Fox',         body:'#F07840', belly:'#FFF0E0', anim:'k-run',     spd:1.8, shape:'corgi', ear:'point',  tail:'fox',  tongue:true,  mouth:'open'},
  {id:'fafa',  name:'Fafa',  sub:'Tree Frog',   body:'#7AD080', belly:'#F8FFE8', anim:'k-hop',     spd:2.6, shape:'frog',  ear:'frog',   tail:'none', tongue:false, mouth:'smile'},
  {id:'mimi',  name:'Mimi',  sub:'Rabbit',      body:'#FBEDF0', belly:'#FFFFFF', anim:'k-hop',     spd:2.6, shape:'fluff', ear:'long',   tail:'puff', tongue:false, mouth:'w'},
  {id:'nene',  name:'Nene',  sub:'Penguin',     body:'#3A4866', belly:'#FFF8E8', anim:'k-walk',    spd:2.0, shape:'penguin',ear:'none',  tail:'none', tongue:false, mouth:'smile', beak:'#F5A020'},
  {id:'yuki',  name:'Yuki',  sub:'Duck',        body:'#FCE07A', belly:'#FFEFB0', anim:'k-walk',    spd:2.2, shape:'fluff', ear:'none',   tail:'puff', tongue:false, mouth:'none',  beak:'#F09030'},
  {id:'piyo',  name:'Piyo',  sub:'Baby Chick',  body:'#FCE870', belly:'#FFF8D0', anim:'k-bob',     spd:1.6, shape:'chick', ear:'none',   tail:'none', tongue:false, mouth:'none',  beak:'#F09030'},
  {id:'maru',  name:'Maru',  sub:'Hamster',     body:'#E8B880', belly:'#F8DEB8', anim:'k-jiggle',  spd:1.6, shape:'fluff', ear:'tiny',   tail:'none', tongue:false, mouth:'w'},
  {id:'nori',  name:'Nori',  sub:'Harp Seal',   body:'#F4F0EC', belly:'#FFFFFF', anim:'k-paddle',  spd:3.6, shape:'seal',  ear:'none',   tail:'fin',  tongue:false, mouth:'smile'},
  {id:'coco',  name:'Coco',  sub:'Koala',       body:'#A8A4B8', belly:'#D0CCD8', anim:'k-peek',    spd:4.6, shape:'fluff', ear:'koala',  tail:'none', tongue:false, mouth:'w',   nose:'#181818'},
  {id:'piko',  name:'Piko',  sub:'Piglet',      body:'#FFB8C0', belly:'#FFD8DC', anim:'k-jiggle',  spd:2.4, shape:'fluff', ear:'pig',    tail:'curl', tongue:false, mouth:'w',   snout:'pig'},
  {id:'zoro',  name:'Zoro',  sub:'Raccoon',     body:'#B8B4C2', belly:'#EAE6F0', anim:'k-walk',    spd:2.6, shape:'corgi', ear:'point',  tail:'fox',  tongue:true,  mouth:'open', mask:true},
  {id:'hana',  name:'Hana',  sub:'Baby Fawn',   body:'#E0B878', belly:'#FFF4E2', anim:'k-bob',     spd:3.0, shape:'corgi', ear:'long',   tail:'puff', tongue:false, mouth:'w',   spots:true},
  {id:'suika', name:'Suika', sub:'Capybara',    body:'#C0A068', belly:'#E0C898', anim:'k-breathe', spd:6.2, shape:'capy',  ear:'tiny',   tail:'none', tongue:false, mouth:'line'},
  {id:'riri',  name:'Riri',  sub:'Axolotl',     body:'#F8A8C0', belly:'#FFD0E0', anim:'k-paddle',  spd:3.4, shape:'salamander',ear:'gill',tail:'fin', tongue:false, mouth:'w'},
];

// ================================================================
// Colab-style chibi animal renderer
// ================================================================
// Each pet gets a recognizable silhouette: distinct head + body + ears + tail.
// Colab corgi reference: separate horizontal body + raised head + 4 short legs +
// pointy ears + tongue out + tiny bead eyes + pink cheeks.
function kekeSVG(p, s){
  const cx=s*.50, cy=s*.62, r=s*.30;
  const F = n => n.toFixed(2);
  const BODY = p.body;
  const BELLY = p.belly || p.body;
  const FACE = p.face || '#3a2a20';
  const BLUSH = '#FF9DBA';
  const TONGUE = '#FF7A95';
  const fid = `wc-${p.id}-${Math.random().toString(36).slice(2,7)}`;

  const path = (d,fill,extra='') => `<path d="${d}" fill="${fill}"${extra?' '+extra:''}/>`;
  const ell  = (x,y,rx,ry,fill,extra='') => `<ellipse cx="${F(x)}" cy="${F(y)}" rx="${F(rx)}" ry="${F(ry)}" fill="${fill}"${extra?' '+extra:''}/>`;
  const cir  = (x,y,rad,fill,extra='') => `<circle cx="${F(x)}" cy="${F(y)}" r="${F(rad)}" fill="${fill}"${extra?' '+extra:''}/>`;
  // Wrap ear SVG in an ear-L/ear-R group so CSS k-ear-twitch and WAAPI both reach it
  const earL = (svg, ox, oy) => `<g class="ear-L" style="transform-box:fill-box;transform-origin:${F(ox)}px ${F(oy)}px">${svg}</g>`;
  const earR = (svg, ox, oy) => `<g class="ear-R" style="transform-box:fill-box;transform-origin:${F(ox)}px ${F(oy)}px">${svg}</g>`;

  // Walk-cycle leg counter
  let legCount = 0;
  // Leg styles per species — w/h are leg dimensions, returns SVG g
  // style: 'paw' (corgi/dog/cat), 'thick-paw' (bear/koala), 'sock' (fox/raccoon dark sock + paw),
  //        'spot' (dalmatian/fawn-spotted), 'hoof' (sheep/fawn dark hoof), 'web' (duck/penguin/chick orange),
  //        'thin-hoof' (fawn spindly), 'stubby' (hamster/capybara), 'pig' (cloven), 'bunny-back' (huge back foot)
  function legStub(x, y, w, h, col, style){
    style = style || 'paw';
    const cls = (legCount++ % 2 === 0) ? 'leg-A' : 'leg-B';
    let inner = '';
    if(style === 'paw'){
      // tapered leg + lighter rounded paw at bottom
      inner = path(`M${F(x-w*0.85)},${F(y-h)} Q${F(x-w)},${F(y+h*0.5)} ${F(x-w*0.7)},${F(y+h*0.85)} Q${F(x)},${F(y+h*1.0)} ${F(x+w*0.7)},${F(y+h*0.85)} Q${F(x+w)},${F(y+h*0.5)} ${F(x+w*0.85)},${F(y-h)} Z`, col)
            + ell(x, y+h*0.85, w*0.85, h*0.18, BELLY, ` opacity=".95"`)
            + cir(x-w*0.35, y+h*0.92, w*0.16, FACE, ` opacity=".70"`)
            + cir(x+w*0.20, y+h*0.92, w*0.16, FACE, ` opacity=".70"`);
    } else if(style === 'thick-paw'){
      // bear: thicker, darker pads
      inner = ell(x, y, w*1.05, h, col)
            + ell(x, y+h*0.78, w*0.95, h*0.20, FACE, ` opacity=".70"`)
            + cir(x-w*0.40, y+h*0.78, w*0.16, FACE, ` opacity=".85"`)
            + cir(x+w*0.40, y+h*0.78, w*0.16, FACE, ` opacity=".85"`)
            + cir(x, y+h*0.78, w*0.16, FACE, ` opacity=".85"`);
    } else if(style === 'sock'){
      // fox/raccoon: dark sock at bottom, lighter top
      inner = ell(x, y-h*0.25, w*0.95, h*0.85, col)
            + ell(x, y+h*0.50, w*1.0, h*0.45, '#2a1a14', ` opacity=".95"`)
            + ell(x, y+h*0.85, w*0.85, h*0.13, '#1a0a04');
    } else if(style === 'spot'){
      // dalmatian — white leg with black spot
      inner = ell(x, y, w, h, col)
            + cir(x+w*0.1, y+h*0.3, w*0.32, '#181818', ` opacity=".88"`)
            + ell(x, y+h*0.85, w*0.85, h*0.18, '#181818', ` opacity=".60"`);
    } else if(style === 'hoof'){
      // sheep: dark thin leg, hoof at bottom
      inner = path(`M${F(x-w*0.55)},${F(y-h)} L${F(x-w*0.55)},${F(y+h*0.7)} L${F(x+w*0.55)},${F(y+h*0.7)} L${F(x+w*0.55)},${F(y-h)} Z`, '#3A2820')
            + path(`M${F(x-w*0.75)},${F(y+h*0.7)} Q${F(x-w*0.75)},${F(y+h*1.05)} ${F(x)},${F(y+h*1.05)} Q${F(x+w*0.75)},${F(y+h*1.05)} ${F(x+w*0.75)},${F(y+h*0.7)} Z`, '#1a0a04');
    } else if(style === 'thin-hoof'){
      // fawn — spindly leg, dark hoof
      inner = path(`M${F(x-w*0.45)},${F(y-h)} Q${F(x)},${F(y-h*0.5)} ${F(x-w*0.55)},${F(y+h*0.7)} Q${F(x)},${F(y+h*0.95)} ${F(x+w*0.55)},${F(y+h*0.7)} Q${F(x)},${F(y-h*0.5)} ${F(x+w*0.45)},${F(y-h)} Z`, col)
            + ell(x, y+h*0.92, w*0.65, h*0.13, '#3A2820');
    } else if(style === 'stubby'){
      // hamster/capybara — very short stubby
      inner = ell(x, y+h*0.20, w*1.1, h*0.70, col)
            + ell(x, y+h*0.75, w*0.95, h*0.13, FACE, ` opacity=".75"`);
    } else if(style === 'pig'){
      // pig — cloven hoof (split tip)
      inner = ell(x, y, w*0.95, h*0.95, col)
            + path(`M${F(x-w*0.55)},${F(y+h*0.6)} L${F(x-w*0.55)},${F(y+h*0.95)} L${F(x-w*0.05)},${F(y+h*0.95)} L${F(x-w*0.05)},${F(y+h*0.6)} Z`, '#1a0a04')
            + path(`M${F(x+w*0.05)},${F(y+h*0.6)} L${F(x+w*0.05)},${F(y+h*0.95)} L${F(x+w*0.55)},${F(y+h*0.95)} L${F(x+w*0.55)},${F(y+h*0.6)} Z`, '#1a0a04');
    } else if(style === 'bunny-back'){
      // rabbit — large back foot oval
      inner = ell(x, y, w*1.3, h*0.55, col)
            + ell(x-w*0.4, y, w*0.18, h*0.20, BELLY, ` opacity=".70"`);
    } else if(style === 'pink-paw'){
      inner = ell(x, y, w*0.95, h*0.95, col)
            + ell(x, y+h*0.72, w*0.78, h*0.20, '#9C5060', ` opacity=".70"`);
    } else if(style === 'cat-paw'){
      // slender cat leg + small white paw + pink toe beans
      inner = path(`M${F(x-w*0.55)},${F(y-h)} Q${F(x-w*0.65)},${F(y+h*0.4)} ${F(x-w*0.55)},${F(y+h*0.78)} Q${F(x)},${F(y+h*0.95)} ${F(x+w*0.55)},${F(y+h*0.78)} Q${F(x+w*0.65)},${F(y+h*0.4)} ${F(x+w*0.55)},${F(y-h)} Z`, col)
            + ell(x, y+h*0.85, w*0.85, h*0.18, BELLY, ` opacity=".95"`)
            + cir(x-w*0.25, y+h*0.92, w*0.12, BLUSH, ` opacity=".85"`)
            + cir(x+w*0.10, y+h*0.92, w*0.12, BLUSH, ` opacity=".85"`);
    } else if(style === 'panda-paw'){
      // panda — black thick paws (always black regardless of body color)
      inner = ell(x, y, w*1.05, h, '#181818')
            + cir(x-w*0.30, y+h*0.78, w*0.16, '#3a2820')
            + cir(x+w*0.30, y+h*0.78, w*0.16, '#3a2820');
    } else if(style === 'tiny-paw'){
      // hamster — barely visible tiny stubby
      inner = ell(x, y+h*0.20, w*0.90, h*0.78, col)
            + ell(x, y+h*0.65, w*0.70, h*0.12, FACE, ` opacity=".60"`);
    } else if(style === 'koala-arm'){
      // koala — chunky hugging arm with claw mark
      inner = ell(x, y, w*1.0, h*0.95, col)
            + ell(x, y+h*0.70, w*0.80, h*0.20, '#3a2820', ` opacity=".80"`)
            + cir(x-w*0.22, y+h*0.85, w*0.10, '#1a1212')
            + cir(x+w*0.22, y+h*0.85, w*0.10, '#1a1212');
    } else if(style === 'bunny'){
      // generic bunny leg (small front foot variant)
      inner = ell(x, y+h*0.10, w*0.95, h*0.85, col)
            + ell(x, y+h*0.78, w*0.85, h*0.15, BLUSH, ` opacity=".60"`);
    } else if(style === 'web'){
      // duck/waterfowl — wide flat orange webbed foot
      inner = ell(x, y+h*0.20, w*0.6, h*0.55, '#F09030')
            + ell(x, y+h*0.72, w*1.35, h*0.28, '#F09030');
    } else {
      inner = ell(x, y, w, h, col);
    }
    // Front legs (right side of body, near the head) get pet-arm class for independent animation
    const armCls = (x >= cx * 0.88) ? ' pet-arm' : '';
    // transform-origin: 50% 5% rotates near the top (hip joint) using fill-box percentages
    return `<g class="${cls}${armCls}" style="transform-box:fill-box;transform-origin:50% 5%;">${inner}</g>`;
  }

  // ── tiny eyes + blush (universal Colab face)
  function tinyFace(hx, hy, hr, opts={}){
    const eR = hr*0.10;
    const ex = hr*0.30;
    const ey = hy - hr*0.05;
    let g = '';
    // Eyes — each wrapped in a named group so CSS/JS can animate them independently
    const eyeLInner = cir(hx-ex, ey, eR, FACE) + cir(hx-ex+eR*0.30, ey-eR*0.30, eR*0.40, 'white');
    const eyeRInner = cir(hx+ex, ey, eR, FACE) + cir(hx+ex+eR*0.30, ey-eR*0.30, eR*0.40, 'white');
    g += `<g class="pet-eye-L" style="transform-box:fill-box;transform-origin:50% 50%">${eyeLInner}</g>`;
    g += `<g class="pet-eye-R" style="transform-box:fill-box;transform-origin:50% 50%">${eyeRInner}</g>`;
    // pink cheeks
    g += ell(hx-ex-hr*0.18, ey+hr*0.20, hr*0.16, hr*0.08, BLUSH, ` opacity=".55"`);
    g += ell(hx+ex+hr*0.18, ey+hr*0.20, hr*0.16, hr*0.08, BLUSH, ` opacity=".55"`);
    // mouth — wrapped in a named group for independent animation
    const my = ey + hr*0.30;
    const mouth = opts.mouth || p.mouth;
    let mouthSvg = '';
    if(mouth==='open'){
      mouthSvg += `<path d="M${F(hx-hr*0.14)},${F(my)} Q${F(hx)},${F(my+hr*0.24)} ${F(hx+hr*0.14)},${F(my)} Q${F(hx)},${F(my+hr*0.10)} ${F(hx-hr*0.14)},${F(my)} Z" fill="${FACE}" opacity=".88"/>`;
      mouthSvg += `<path d="M${F(hx+hr*0.04)},${F(my+hr*0.08)} Q${F(hx+hr*0.20)},${F(my+hr*0.24)} ${F(hx+hr*0.22)},${F(my+hr*0.14)} Q${F(hx+hr*0.18)},${F(my+hr*0.04)} ${F(hx+hr*0.06)},${F(my+hr*0.04)} Z" fill="${TONGUE}" class="tongue"/>`;
    } else if(mouth==='w'){
      mouthSvg += `<path d="M${F(hx-hr*0.13)},${F(my)} Q${F(hx-hr*0.06)},${F(my+hr*0.08)} ${F(hx)},${F(my+hr*0.03)} Q${F(hx+hr*0.06)},${F(my+hr*0.08)} ${F(hx+hr*0.13)},${F(my)}" stroke="${FACE}" stroke-width="${F(hr*0.05)}" fill="none" stroke-linecap="round"/>`;
    } else if(mouth==='smile'){
      mouthSvg += `<path d="M${F(hx-hr*0.12)},${F(my)} Q${F(hx)},${F(my+hr*0.13)} ${F(hx+hr*0.12)},${F(my)}" stroke="${FACE}" stroke-width="${F(hr*0.055)}" fill="none" stroke-linecap="round"/>`;
    } else if(mouth==='line'){
      mouthSvg += `<line x1="${F(hx-hr*0.07)}" y1="${F(my)}" x2="${F(hx+hr*0.07)}" y2="${F(my)}" stroke="${FACE}" stroke-width="${F(hr*0.045)}" stroke-linecap="round"/>`;
    }
    g += `<g class="pet-mouth" style="transform-box:fill-box;transform-origin:50% 0%">${mouthSvg}</g>`;
    // optional nose
    if(opts.nose){ g += ell(hx, my-hr*0.05, hr*0.07, hr*0.045, FACE); }
    return g;
  }

  // ── Per-shape recognizable silhouette
  function render(){
    let g = '';
    // ── Per-pal leg config: style, dimensions (w/h relative to r), gait
    // gait: 'pair' = front-pair + back-pair (4 legs total, near+far overlap for depth)
    //       'single' = one front leg + one back leg (2 legs visible — slim animals)
    //       'front'  = 2 feet side-by-side (front-facing chibi: bears, panda, hamster, pig, duck)
    //       'none' = no leg drawing (penguin/seal/frog/chick/duck handle theirs)
    const LEG_CFG = {
      // bears — front-facing: 2 stubby feet side by side
      shiro: {style:'thick-paw',  w:0.18, h:0.16, gait:'front',  spread:0.28},
      boba:  {style:'thick-paw',  w:0.18, h:0.16, gait:'front',  spread:0.28},
      koko:  {style:'panda-paw',  w:0.18, h:0.16, gait:'front',  spread:0.28},
      // dogs/foxes — varied
      goma:  {style:'spot',       w:0.13, h:0.24, gait:'pair',   spread:0.40},  // dalmatian taller
      toro:  {style:'sock',       w:0.10, h:0.26, gait:'single', spread:0.50},  // fox slender, only 2 visible
      zoro:  {style:'sock',       w:0.12, h:0.20, gait:'pair',   spread:0.40},  // raccoon medium
      // cat — slender, only 2 visible legs in side view
      momo:  {style:'cat-paw',    w:0.10, h:0.22, gait:'single', spread:0.48},
      // rabbit — small front + huge back foot
      mimi:  {style:'bunny',      w:0.10, h:0.14, gait:'bunny',  spread:0.40},
      // sheep/fawn — thin hoofed
      kumo:  {style:'hoof',       w:0.08, h:0.22, gait:'pair',   spread:0.36},
      hana:  {style:'thin-hoof',  w:0.07, h:0.32, gait:'pair',   spread:0.40},  // tall spindly
      // hamster — front-facing: 2 tiny feet
      maru:  {style:'tiny-paw',   w:0.10, h:0.07, gait:'front',  spread:0.24},
      suika: {style:'stubby',     w:0.13, h:0.10, gait:'pair',   spread:0.42},
      // koala — sitting/hugging, no extended leg pair
      coco:  {style:'koala-arm',  w:0.14, h:0.14, gait:'sit',    spread:0.38},
      // pig — front-facing: 2 stubby cloven feet
      piko:  {style:'pig',        w:0.12, h:0.13, gait:'front',  spread:0.26},
      // duck — front-facing: 2 webbed feet
      yuki:  {style:'web',        w:0.14, h:0.09, gait:'front',  spread:0.26},
    };
    const legCfg = LEG_CFG[p.id] || {style:'paw', w:0.13, h:0.18, gait:'pair', spread:0.38};
    const legSt = legCfg.style;
    const lw = r * legCfg.w, lh = r * legCfg.h;
    // ground line per pal — bring body down so legs reach it; longer legs = body sits higher
    const gy = cy + r * 0.78;  // shared ground level
    // legPair: draws front-pair (offset right) or back-pair (offset left)
    // pairX = horizontal center of the pair, far leg drawn behind (smaller, darker, slightly back)
    function legPair(pairX, pairY, w, h, col, style){
      let s = '';
      // FAR leg (drawn first, smaller, darker, shifted slightly up & to the side)
      const farX = pairX + (pairX < cx ? w*0.6 : -w*0.6);
      const farY = pairY - h*0.05;
      s += legStub(farX, farY, w*0.85, h*0.95, shade(col, -0.15), style);
      // NEAR leg (foreground)
      s += legStub(pairX, pairY, w, h, col, style);
      return s;
    }
    // shade — darken/lighten hex color by amt (-1..1)
    function shade(hex, amt){
      const m = hex.match(/^#([0-9a-f]{6})/i);
      if(!m) return hex;
      const n = parseInt(m[1],16);
      const c = [(n>>16)&255, (n>>8)&255, n&255].map(v=>{
        const t = amt<0 ? v*(1+amt) : v + (255-v)*amt;
        return Math.max(0, Math.min(255, Math.round(t)));
      });
      return '#'+c.map(v=>v.toString(16).padStart(2,'0')).join('');
    }
    // soft watercolor halo via blurred body underneath
    const filter = `<defs><filter id="${fid}" x="-15%" y="-15%" width="130%" height="130%"><feGaussianBlur stdDeviation="1.4"/></filter></defs>`;

    if(p.shape==='corgi' || p.shape==='dog'){
      // CORGI/DOG — like the Colab chocolate-chip:
      // long horizontal body, raised distinct head at right with pointy ears, tongue out
      // body Y adjusted by leg height so paws just touch ground
      const by_ = gy - lh - r*0.45;
      const bx=cx-r*0.05, by=by_, bw=r*1.05, bh=r*0.50;
      const hx=cx+r*0.70, hy=by - r*0.32, hr=r*0.42;
      g += `<g opacity=".26" filter="url(#${fid})">${ell(bx,by,bw,bh,BODY)}${cir(hx,hy,hr,BODY)}</g>`;
      // tail
      g += path(`M${F(cx-r*0.95)},${F(by-r*0.05)} Q${F(cx-r*1.20)},${F(by-r*0.45)} ${F(cx-r*0.95)},${F(by-r*0.60)} Q${F(cx-r*0.78)},${F(by-r*0.35)} ${F(cx-r*0.85)},${F(by-r*0.05)} Z`, BODY);
      // BACK leg pair (or single for slim)
      const ly = gy;
      if(legCfg.gait==='single'){
        g += legStub(cx-r*0.40, ly, lw, lh, BODY, legSt);
      } else if(legCfg.gait==='bunny'){
        // bunny — large back foot (drawn flat on ground)
        g += ell(cx-r*0.32, gy-r*0.06, r*0.24, r*0.10, BODY);
        g += ell(cx-r*0.32, gy-r*0.02, r*0.16, r*0.05, BLUSH, ` opacity=".60"`);
      } else if(legCfg.gait==='sit'){
        // koala — sitting, tucked back legs
        g += ell(cx-r*0.30, by+bh*0.5, r*0.18, r*0.14, BODY);
      } else {
        g += legPair(cx-r*0.45, ly, lw, lh, BODY, legSt);
      }
      // body
      g += ell(bx, by, bw, bh, BODY);
      g += ell(bx, by+bh*0.4, bw*0.7, bh*0.5, BELLY, ` opacity=".90"`);
      // FRONT leg pair (or single)
      if(legCfg.gait==='single'){
        g += legStub(cx+r*0.40, ly, lw, lh, BODY, legSt);
      } else if(legCfg.gait==='bunny'){
        g += legStub(cx+r*0.30, ly, r*0.10, r*0.16, BODY, 'paw');
      } else if(legCfg.gait==='sit'){
        g += ell(cx+r*0.30, by+bh*0.5, r*0.18, r*0.14, BODY);
      } else {
        g += legPair(cx+r*0.45, ly, lw, lh, BODY, legSt);
      }
      // ears: pointy (or floppy if specified) — wrapped for CSS/WAAPI animation
      if(p.ear==='flop'){
        g += earL(ell(hx-r*0.30, hy+r*0.10, r*0.15, r*0.30, BODY), hx-r*0.30, hy+r*0.10);
        g += earR(ell(hx+r*0.30, hy+r*0.10, r*0.15, r*0.30, BODY), hx+r*0.30, hy+r*0.10);
      } else if(p.ear==='long'){
        g += earL(ell(hx-r*0.18, hy-r*0.45, r*0.10, r*0.36, BODY)+ell(hx-r*0.18, hy-r*0.45, r*0.04, r*0.24, BLUSH, ` opacity=".50"`), hx-r*0.18, hy-r*0.10);
        g += earR(ell(hx+r*0.18, hy-r*0.45, r*0.10, r*0.36, BODY)+ell(hx+r*0.18, hy-r*0.45, r*0.04, r*0.24, BLUSH, ` opacity=".50"`), hx+r*0.18, hy-r*0.10);
      } else { // pointy (corgi/fox/raccoon)
        g += earL(path(`M${F(hx-r*0.32)},${F(hy-r*0.05)} L${F(hx-r*0.20)},${F(hy-r*0.50)} L${F(hx-r*0.05)},${F(hy-r*0.10)} Z`, BODY), hx-r*0.19, hy-r*0.05);
        g += earR(path(`M${F(hx+r*0.05)},${F(hy-r*0.10)} L${F(hx+r*0.20)},${F(hy-r*0.50)} L${F(hx+r*0.32)},${F(hy-r*0.05)} Z`, BODY), hx+r*0.19, hy-r*0.05);
      }
      // head
      g += cir(hx, hy, hr, BODY);
      // body decorations
      if(p.spots){
        const dotCol = p.id==='goma' ? '#181818' : 'white';
        const dots = p.id==='goma'
          ? [[-0.30,-0.05],[0.10,0.05],[-0.10,0.30],[0.40,0.20],[-0.55,0.20]]
          : [[-0.40,0.10],[-0.10,-0.05],[0.20,0.20]];
        dots.forEach(([dx,dy])=>{ g += cir(bx+r*dx, by+r*dy, r*0.06, dotCol, ` opacity=".90"`); });
      }
      // raccoon mask + tail bands
      if(p.mask){
        g += ell(hx-r*0.18, hy-r*0.05, r*0.18, r*0.12, FACE, ` opacity=".75"`);
        g += ell(hx+r*0.18, hy-r*0.05, r*0.18, r*0.12, FACE, ` opacity=".75"`);
      }
      // fox tail tip white
      if(p.tail==='fox'){
        g += ell(cx-r*0.93, cy-r*0.45, r*0.09, r*0.10, 'white');
      }
      // face
      g += tinyFace(hx, hy, hr);
      // raccoon: re-stamp eye dots over mask
      if(p.mask){
        const eR=hr*0.10, ex=hr*0.30, ey=hy-hr*0.05;
        g += cir(hx-ex,ey,eR*0.7,'white');
        g += cir(hx+ex,ey,eR*0.7,'white');
        g += cir(hx-ex,ey,eR*0.55,FACE);
        g += cir(hx+ex,ey,eR*0.55,FACE);
      }
      return filter + g;
    }

    if(p.shape==='cat'){
      // CAT — slender side view, only 2 legs visible (one front + one back)
      const by_ = gy - lh - r*0.45;
      const bx=cx, by=by_, bw=r*0.80, bh=r*0.50;
      const hx=cx+r*0.55, hy=by - r*0.32, hr=r*0.40;
      g += `<g opacity=".26" filter="url(#${fid})">${ell(bx,by,bw,bh,BODY)}${cir(hx,hy,hr,BODY)}</g>`;
      // curly upright tail
      g += `<path d="M${F(cx-r*0.78)},${F(by-r*0.05)} q${F(-r*0.30)},${F(-r*0.10)} ${F(-r*0.20)},${F(-r*0.45)} q${F(r*0.20)},${F(-r*0.20)} ${F(r*0.05)},${F(-r*0.20)}" stroke="${BODY}" stroke-width="${F(r*0.18)}" fill="none" stroke-linecap="round"/>`;
      // BACK leg (single — slender cat)
      g += legStub(cx-r*0.40, gy, lw, lh, BODY, legSt);
      g += ell(bx, by, bw, bh, BODY);
      g += ell(bx, by+bh*0.35, bw*0.65, bh*0.50, BELLY, ` opacity=".90"`);
      // FRONT leg
      g += legStub(cx+r*0.40, gy, lw, lh, BODY, legSt);
      // triangle ears
      g += path(`M${F(hx-r*0.32)},${F(hy-r*0.05)} L${F(hx-r*0.18)},${F(hy-r*0.48)} L${F(hx-r*0.02)},${F(hy-r*0.10)} Z`, BODY);
      g += path(`M${F(hx+r*0.02)},${F(hy-r*0.10)} L${F(hx+r*0.18)},${F(hy-r*0.48)} L${F(hx+r*0.32)},${F(hy-r*0.05)} Z`, BODY);
      g += path(`M${F(hx-r*0.22)},${F(hy-r*0.10)} L${F(hx-r*0.16)},${F(hy-r*0.32)} L${F(hx-r*0.08)},${F(hy-r*0.14)} Z`, BLUSH, ` opacity=".60"`);
      g += path(`M${F(hx+r*0.08)},${F(hy-r*0.14)} L${F(hx+r*0.16)},${F(hy-r*0.32)} L${F(hx+r*0.22)},${F(hy-r*0.10)} Z`, BLUSH, ` opacity=".60"`);
      g += cir(hx, hy, hr, BODY);
      g += tinyFace(hx, hy, hr);
      return filter + g;
    }

    if(p.shape==='panda'){
      // PANDA — iconic black-and-white. White body + round head + black ears,
      // black eye patches, black shoulder/arm band, black back legs.
      const BLK = '#1a1a1a';
      const by_ = gy - lh - r*0.40;
      const bx=cx, by=by_, bw=r*0.78, bh=r*0.52;
      const hx=cx, hy=by - r*0.46, hr=r*0.52;
      g += `<g opacity=".22" filter="url(#${fid})">${ell(bx,by,bw,bh,'#FFFFFF')}${cir(hx,hy,hr,'#FFFFFF')}</g>`;
      // tail puff (tiny black)
      g += cir(cx-r*0.72, by+r*0.05, r*0.08, BLK);
      // BACK legs — black
      const ly = gy;
      if(legCfg.gait==='front'){
        g += legStub(cx - r*legCfg.spread, ly, lw, lh, BLK, 'panda-paw');
      } else {
        g += legPair(cx-r*0.32, ly, lw, lh, BLK, 'panda-paw');
      }
      // body — white
      g += ell(bx, by, bw, bh, '#FFFFFF');
      // black shoulder band wrapping front of body (the iconic panda yoke)
      g += `<path d="M${F(bx-bw*0.95)},${F(by-bh*0.10)} Q${F(bx)},${F(by-bh*0.65)} ${F(bx+bw*0.95)},${F(by-bh*0.10)} Q${F(bx+bw*0.95)},${F(by+bh*0.20)} ${F(bx)},${F(by-bh*0.05)} Q${F(bx-bw*0.95)},${F(by+bh*0.20)} ${F(bx-bw*0.95)},${F(by-bh*0.10)} Z" fill="${BLK}"/>`;
      // soft white belly hint at bottom
      g += ell(bx, by+bh*0.40, bw*0.55, bh*0.40, '#FFFFFF');
      // FRONT legs — black
      if(legCfg.gait==='front'){
        g += legStub(cx + r*legCfg.spread, ly, lw, lh, BLK, 'panda-paw');
      } else {
        g += legPair(cx+r*0.32, ly, lw, lh, BLK, 'panda-paw');
      }
      // ears — round black on top of head
      g += cir(hx-r*0.36, hy-r*0.34, r*0.18, BLK);
      g += cir(hx+r*0.36, hy-r*0.34, r*0.18, BLK);
      // head — white
      g += cir(hx, hy, hr, '#FFFFFF');
      // iconic black eye patches (oval, slightly tilted, around eyes)
      g += `<ellipse cx="${F(hx-r*0.22)}" cy="${F(hy-r*0.06)}" rx="${F(r*0.16)}" ry="${F(r*0.20)}" fill="${BLK}" transform="rotate(-12,${F(hx-r*0.22)},${F(hy-r*0.06)})"/>`;
      g += `<ellipse cx="${F(hx+r*0.22)}" cy="${F(hy-r*0.06)}" rx="${F(r*0.16)}" ry="${F(r*0.20)}" fill="${BLK}" transform="rotate(12,${F(hx+r*0.22)},${F(hy-r*0.06)})"/>`;
      // eyes — small white shine inside the black patches
      g += cir(hx-r*0.22, hy-r*0.04, r*0.06, '#FFFFFF');
      g += cir(hx+r*0.22, hy-r*0.04, r*0.06, '#FFFFFF');
      g += cir(hx-r*0.22, hy-r*0.04, r*0.035, BLK);
      g += cir(hx+r*0.22, hy-r*0.04, r*0.035, BLK);
      g += cir(hx-r*0.215, hy-r*0.05, r*0.012, '#FFFFFF');
      g += cir(hx+r*0.225, hy-r*0.05, r*0.012, '#FFFFFF');
      // small black nose
      g += ell(hx, hy+r*0.16, r*0.05, r*0.035, BLK);
      // tiny mouth — small w under nose
      g += `<path d="M${F(hx-r*0.06)},${F(hy+r*0.24)} Q${F(hx-r*0.03)},${F(hy+r*0.30)} ${F(hx)},${F(hy+r*0.27)} Q${F(hx+r*0.03)},${F(hy+r*0.30)} ${F(hx+r*0.06)},${F(hy+r*0.24)}" stroke="${BLK}" stroke-width="${F(r*0.025)}" fill="none" stroke-linecap="round"/>`;
      // pink cheeks
      g += ell(hx-r*0.40, hy+r*0.14, r*0.10, r*0.05, BLUSH, ` opacity=".60"`);
      g += ell(hx+r*0.40, hy+r*0.14, r*0.10, r*0.05, BLUSH, ` opacity=".60"`);
      return filter + g;
    }

    if(p.shape==='fluff'){
      // Generic chubby quadruped — bear, hamster, koala, rabbit. Distinct head on top of body.
      const by_ = gy - lh - r*0.40;
      const bx=cx, by=by_, bw=r*0.72, bh=r*0.50;
      const hx=cx, hy=by - r*0.42, hr=r*0.50;
      g += `<g opacity=".26" filter="url(#${fid})">${ell(bx,by,bw,bh,BODY)}${cir(hx,hy,hr,BODY)}</g>`;
      if(p.tail==='puff'){ g += cir(cx-r*0.70, by+r*0.10, r*0.10, BODY); }
      // BACK leg/pair — gait-aware
      const ly = gy;
      if(legCfg.gait==='single'){
        g += legStub(cx-r*0.30, ly, lw, lh, BODY, legSt);
      } else if(legCfg.gait==='bunny'){
        // rabbit — large back hop foot, flat
        g += ell(cx-r*0.28, gy-r*0.05, r*0.24, r*0.10, BODY);
        g += ell(cx-r*0.28, gy-r*0.01, r*0.16, r*0.05, BLUSH, ` opacity=".60"`);
      } else if(legCfg.gait==='sit'){
        // koala — sitting, tucked legs visible as soft humps
        g += ell(cx-r*0.30, by+bh*0.55, r*0.20, r*0.14, BODY);
      } else if(legCfg.gait==='front'){
        // front-facing chibi: left foot only (right drawn after body)
        g += legStub(cx - r*legCfg.spread, ly, lw, lh, BODY, legSt);
      } else {
        g += legPair(cx-r*0.32, ly, lw, lh, BODY, legSt);
      }
      // body
      g += ell(bx, by, bw, bh, BODY);
      g += ell(bx, by+bh*0.3, bw*0.6, bh*0.55, BELLY, ` opacity=".90"`);
      // FRONT leg/pair
      if(legCfg.gait==='single'){
        g += legStub(cx+r*0.30, ly, lw, lh, BODY, legSt);
      } else if(legCfg.gait==='bunny'){
        g += legStub(cx+r*0.25, ly, r*0.10, r*0.16, BODY, 'paw');
      } else if(legCfg.gait==='sit'){
        g += ell(cx+r*0.30, by+bh*0.55, r*0.20, r*0.14, BODY);
      } else if(legCfg.gait==='front'){
        // front-facing chibi: right foot
        g += legStub(cx + r*legCfg.spread, ly, lw, lh, BODY, legSt);
      } else {
        g += legPair(cx+r*0.32, ly, lw, lh, BODY, legSt);
      }
      // ears — each wrapped in ear-L/ear-R so CSS k-ear-twitch and WAAPI reach them
      const epy = hy - hr * 0.5; // ear pivot y (base of ear)
      if(p.ear==='round'){
        g += earL(cir(hx-r*0.34, hy-r*0.32, r*0.16, BODY)+cir(hx-r*0.34, hy-r*0.32, r*0.08, BLUSH, ` opacity=".55"`), hx-r*0.34, epy);
        g += earR(cir(hx+r*0.34, hy-r*0.32, r*0.16, BODY)+cir(hx+r*0.34, hy-r*0.32, r*0.08, BLUSH, ` opacity=".55"`), hx+r*0.34, epy);
      } else if(p.ear==='koala'){
        g += earL(cir(hx-r*0.46, hy-r*0.20, r*0.24, BODY)+cir(hx-r*0.46, hy-r*0.20, r*0.16, BELLY), hx-r*0.46, hy);
        g += earR(cir(hx+r*0.46, hy-r*0.20, r*0.24, BODY)+cir(hx+r*0.46, hy-r*0.20, r*0.16, BELLY), hx+r*0.46, hy);
      } else if(p.ear==='long'){
        g += earL(ell(hx-r*0.20, hy-r*0.55, r*0.10, r*0.40, BODY)+ell(hx-r*0.20, hy-r*0.55, r*0.04, r*0.28, BLUSH, ` opacity=".55"`), hx-r*0.20, epy);
        g += earR(ell(hx+r*0.20, hy-r*0.55, r*0.10, r*0.40, BODY)+ell(hx+r*0.20, hy-r*0.55, r*0.04, r*0.28, BLUSH, ` opacity=".55"`), hx+r*0.20, epy);
      } else if(p.ear==='pig'){
        g += earL(path(`M${F(hx-r*0.30)},${F(hy-r*0.15)} L${F(hx-r*0.18)},${F(hy-r*0.45)} L${F(hx-r*0.05)},${F(hy-r*0.18)} Z`, BODY), hx-r*0.18, hy-r*0.15);
        g += earR(path(`M${F(hx+r*0.05)},${F(hy-r*0.18)} L${F(hx+r*0.18)},${F(hy-r*0.45)} L${F(hx+r*0.30)},${F(hy-r*0.15)} Z`, BODY), hx+r*0.18, hy-r*0.15);
      } else if(p.ear==='tiny'){
        g += earL(cir(hx-r*0.30, hy-r*0.30, r*0.08, BODY), hx-r*0.30, hy-r*0.22);
        g += earR(cir(hx+r*0.30, hy-r*0.30, r*0.08, BODY), hx+r*0.30, hy-r*0.22);
      } else if(p.ear==='none'){}
      // head
      g += cir(hx, hy, hr, BODY);
      // pig snout
      if(p.snout==='pig'){
        g += ell(hx, hy+r*0.18, r*0.14, r*0.10, BLUSH);
        g += cir(hx-r*0.04, hy+r*0.18, r*0.020, FACE);
        g += cir(hx+r*0.04, hy+r*0.18, r*0.020, FACE);
      }
      // koala big nose
      if(p.nose){ g += ell(hx, hy+r*0.18, r*0.14, r*0.11, p.nose); }
      // duck bill
      if(p.beak && p.id==='yuki'){ g += ell(hx+r*0.20, hy+r*0.05, r*0.22, r*0.10, p.beak); }
      g += tinyFace(hx, hy, hr);
      return filter + g;
    }

    if(p.shape==='cloud'){
      // SHEEP — cloud body with bumps + black face
      const bx=cx, by=cy+r*0.20, bw=r*0.85, bh=r*0.55;
      // bumpy cloud body via overlapping circles
      g += `<g opacity=".26" filter="url(#${fid})">${ell(bx,by,bw,bh,BODY)}</g>`;
      // legs
      // sheep — thin hoofed legs (back pair + front pair)
      g += legPair(cx-r*0.32, gy, lw, lh, FACE, legSt);
      g += legPair(cx+r*0.32, gy, lw, lh, FACE, legSt);
      // body — overlapping puffs
      const puffs=[[bx-r*0.55,by-r*0.05,r*0.30],[bx-r*0.20,by-r*0.30,r*0.34],[bx+r*0.18,by-r*0.30,r*0.34],[bx+r*0.55,by-r*0.05,r*0.30],[bx,by+r*0.10,r*0.45]];
      puffs.forEach(([x,y,rad])=>{ g += cir(x,y,rad,BODY); });
      // black sheep face on top-right
      const hx=cx+r*0.45, hy=cy-r*0.30, hr=r*0.22;
      g += cir(hx, hy, hr, FACE);
      g += ell(hx-r*0.18, hy+r*0.05, r*0.08, r*0.12, FACE); // ear
      g += ell(hx+r*0.18, hy+r*0.05, r*0.08, r*0.12, FACE); // ear
      // tiny eyes on black face
      g += cir(hx-r*0.07, hy-r*0.03, r*0.035, 'white');
      g += cir(hx+r*0.07, hy-r*0.03, r*0.035, 'white');
      g += cir(hx-r*0.07, hy-r*0.03, r*0.018, FACE);
      g += cir(hx+r*0.07, hy-r*0.03, r*0.018, FACE);
      g += `<path d="M${F(hx-r*0.05)},${F(hy+r*0.08)} Q${F(hx)},${F(hy+r*0.13)} ${F(hx+r*0.05)},${F(hy+r*0.08)}" stroke="white" stroke-width="${F(r*0.025)}" fill="none" stroke-linecap="round"/>`;
      return g;
    }

    if(p.shape==='penguin'){
      // PENGUIN — pear standing, no separate head
      const bx=cx, by=cy, bw=r*0.78, bh=r*0.95;
      g += `<g opacity=".26" filter="url(#${fid})">${ell(bx,by,bw,bh,BODY)}</g>`;
      // feet
      g += path(`M${F(cx-r*0.34)},${F(cy+r*0.92)} Q${F(cx-r*0.18)},${F(cy+r*1.05)} ${F(cx)},${F(cy+r*0.92)} Z`, p.beak||'#F5A020');
      g += path(`M${F(cx)},${F(cy+r*0.92)} Q${F(cx+r*0.18)},${F(cy+r*1.05)} ${F(cx+r*0.34)},${F(cy+r*0.92)} Z`, p.beak||'#F5A020');
      // body
      g += `<path d="M${F(cx)},${F(cy-r*0.95)} C${F(cx+r*0.78)},${F(cy-r*0.92)} ${F(cx+r*0.84)},${F(cy-r*0.10)} ${F(cx+r*0.78)},${F(cy+r*0.40)} C${F(cx+r*0.70)},${F(cy+r*0.85)} ${F(cx-r*0.70)},${F(cy+r*0.85)} ${F(cx-r*0.78)},${F(cy+r*0.40)} C${F(cx-r*0.84)},${F(cy-r*0.10)} ${F(cx-r*0.78)},${F(cy-r*0.92)} ${F(cx)},${F(cy-r*0.95)} Z" fill="${BODY}"/>`;
      // white belly
      g += `<path d="M${F(cx-r*0.22)},${F(cy-r*0.45)} C${F(cx-r*0.62)},${F(cy-r*0.20)} ${F(cx-r*0.60)},${F(cy+r*0.55)} ${F(cx)},${F(cy+r*0.70)} C${F(cx+r*0.60)},${F(cy+r*0.55)} ${F(cx+r*0.62)},${F(cy-r*0.20)} ${F(cx+r*0.22)},${F(cy-r*0.45)} C${F(cx+r*0.10)},${F(cy-r*0.55)} ${F(cx-r*0.10)},${F(cy-r*0.55)} ${F(cx-r*0.22)},${F(cy-r*0.45)} Z" fill="${BELLY}"/>`;
      // flippers
      g += ell(cx-r*0.78, cy+r*0.10, r*0.12, r*0.30, BODY);
      g += ell(cx+r*0.78, cy+r*0.10, r*0.12, r*0.30, BODY);
      // beak
      g += path(`M${F(cx-r*0.10)},${F(cy-r*0.55)} L${F(cx)},${F(cy-r*0.35)} L${F(cx+r*0.10)},${F(cy-r*0.55)} Z`, p.beak||'#F5A020');
      // face on top
      const hx=cx, hy=cy-r*0.70, hr=r*0.30;
      // eyes
      g += cir(hx-r*0.13, hy, r*0.045, FACE);
      g += cir(hx+r*0.13, hy, r*0.045, FACE);
      g += cir(hx-r*0.13+r*0.018, hy-r*0.018, r*0.020, 'white');
      g += cir(hx+r*0.13+r*0.018, hy-r*0.018, r*0.020, 'white');
      g += ell(hx-r*0.25, hy+r*0.10, r*0.10, r*0.05, BLUSH, ` opacity=".55"`);
      g += ell(hx+r*0.25, hy+r*0.10, r*0.10, r*0.05, BLUSH, ` opacity=".55"`);
      return g;
    }

    if(p.shape==='chick'){
      // BABY CHICK — round egg with small features
      const bx=cx, by=cy, bw=r*0.62, bh=r*0.62;
      g += `<g opacity=".26" filter="url(#${fid})">${ell(bx,by,bw,bh,BODY)}</g>`;
      // legs
      g += ell(cx-r*0.18, cy+r*0.65, r*0.07, r*0.05, p.beak||'#F09030');
      g += ell(cx+r*0.18, cy+r*0.65, r*0.07, r*0.05, p.beak||'#F09030');
      // body
      g += cir(cx, cy, r*0.62, BODY);
      // small wing
      g += ell(cx-r*0.40, cy+r*0.05, r*0.13, r*0.20, BODY);
      // tiny tuft top
      g += `<path d="M${F(cx-r*0.06)},${F(cy-r*0.58)} q${F(r*0.04)},${F(-r*0.20)} ${F(r*0.18)},${F(-r*0.06)}" stroke="${BODY}" stroke-width="${F(r*0.10)}" fill="none" stroke-linecap="round"/>`;
      // beak
      g += path(`M${F(cx-r*0.08)},${F(cy-r*0.05)} L${F(cx)},${F(cy+r*0.08)} L${F(cx+r*0.08)},${F(cy-r*0.05)} Z`, p.beak||'#F09030');
      g += tinyFace(cx, cy-r*0.20, r*0.40);
      return g;
    }

    if(p.shape==='frog'){
      // FROG — squat dome, bulgy eyes ON TOP of head
      g += `<g opacity=".26" filter="url(#${fid})">${ell(cx,cy+r*0.05,r*0.95,r*0.65,BODY)}</g>`;
      // back legs splayed
      g += path(`M${F(cx-r*1.0)},${F(cy+r*0.55)} Q${F(cx-r*1.20)},${F(cy)} ${F(cx-r*0.65)},${F(cy-r*0.10)} Z`, BODY);
      g += path(`M${F(cx+r*0.65)},${F(cy-r*0.10)} Q${F(cx+r*1.20)},${F(cy)} ${F(cx+r*1.0)},${F(cy+r*0.55)} Z`, BODY);
      // toe bumps
      [-1.0,-0.85,-0.70].forEach(o=>{ g += cir(cx+r*o, cy+r*0.62, r*0.06, BODY); });
      [0.70,0.85,1.0].forEach(o=>{ g += cir(cx+r*o, cy+r*0.62, r*0.06, BODY); });
      // body squat dome
      g += `<path d="M${F(cx-r*0.85)},${F(cy+r*0.50)} Q${F(cx-r*0.95)},${F(cy-r*0.30)} ${F(cx-r*0.30)},${F(cy-r*0.55)} Q${F(cx)},${F(cy-r*0.65)} ${F(cx+r*0.30)},${F(cy-r*0.55)} Q${F(cx+r*0.95)},${F(cy-r*0.30)} ${F(cx+r*0.85)},${F(cy+r*0.50)} Q${F(cx)},${F(cy+r*0.65)} ${F(cx-r*0.85)},${F(cy+r*0.50)} Z" fill="${BODY}"/>`;
      // belly
      g += ell(cx, cy+r*0.20, r*0.50, r*0.32, BELLY, ` opacity=".90"`);
      // bulgy eyes ON TOP of head
      g += cir(cx-r*0.30, cy-r*0.62, r*0.20, BODY);
      g += cir(cx+r*0.30, cy-r*0.62, r*0.20, BODY);
      g += cir(cx-r*0.30, cy-r*0.60, r*0.13, 'white');
      g += cir(cx+r*0.30, cy-r*0.60, r*0.13, 'white');
      g += cir(cx-r*0.30, cy-r*0.58, r*0.07, FACE);
      g += cir(cx+r*0.30, cy-r*0.58, r*0.07, FACE);
      // smile mouth
      g += `<path d="M${F(cx-r*0.20)},${F(cy-r*0.20)} Q${F(cx)},${F(cy-r*0.05)} ${F(cx+r*0.20)},${F(cy-r*0.20)}" stroke="${FACE}" stroke-width="${F(r*0.05)}" fill="none" stroke-linecap="round"/>`;
      // cheeks
      g += ell(cx-r*0.45, cy-r*0.20, r*0.13, r*0.07, BLUSH, ` opacity=".50"`);
      g += ell(cx+r*0.45, cy-r*0.20, r*0.13, r*0.07, BLUSH, ` opacity=".50"`);
      return g;
    }

    if(p.shape==='seal'){
      // SEAL — long horizontal blob with small head bump and v-flippers tail
      const bx=cx, by=cy+r*0.10, bw=r*1.30, bh=r*0.45;
      g += `<g opacity=".26" filter="url(#${fid})">${ell(bx,by,bw,bh,BODY)}</g>`;
      // tail flippers (V at left)
      g += path(`M${F(cx-r*1.20)},${F(cy)} L${F(cx-r*1.55)},${F(cy-r*0.30)} L${F(cx-r*1.40)},${F(cy)} L${F(cx-r*1.55)},${F(cy+r*0.30)} Z`, BODY);
      // body
      g += ell(bx, by, bw, bh, BODY);
      g += ell(bx, by+bh*0.4, bw*0.85, bh*0.5, BELLY, ` opacity=".90"`);
      // front flippers
      g += ell(cx-r*0.15, cy+r*0.50, r*0.20, r*0.10, BODY);
      g += ell(cx+r*0.45, cy+r*0.50, r*0.20, r*0.10, BODY);
      // small head bump on right
      const hx=cx+r*0.95, hy=cy-r*0.15, hr=r*0.32;
      g += cir(hx, hy, hr, BODY);
      // tiny eyes (sleepy ^^)
      g += `<path d="M${F(hx-r*0.15)},${F(hy)} Q${F(hx-r*0.10)},${F(hy-r*0.06)} ${F(hx-r*0.05)},${F(hy)}" stroke="${FACE}" stroke-width="${F(r*0.04)}" fill="none" stroke-linecap="round"/>`;
      g += `<path d="M${F(hx+r*0.05)},${F(hy)} Q${F(hx+r*0.10)},${F(hy-r*0.06)} ${F(hx+r*0.15)},${F(hy)}" stroke="${FACE}" stroke-width="${F(r*0.04)}" fill="none" stroke-linecap="round"/>`;
      // smile
      g += `<path d="M${F(hx-r*0.06)},${F(hy+r*0.10)} Q${F(hx)},${F(hy+r*0.16)} ${F(hx+r*0.06)},${F(hy+r*0.10)}" stroke="${FACE}" stroke-width="${F(r*0.04)}" fill="none" stroke-linecap="round"/>`;
      g += ell(hx-r*0.20, hy+r*0.10, r*0.08, r*0.04, BLUSH, ` opacity=".55"`);
      g += ell(hx+r*0.20, hy+r*0.10, r*0.08, r*0.04, BLUSH, ` opacity=".55"`);
      return g;
    }

    if(p.shape==='capy'){
      // CAPYBARA — chunky horizontal block with separate big head
      const bx=cx-r*0.10, by=cy+r*0.20, bw=r*1.05, bh=r*0.50;
      const hx=cx+r*0.78, hy=cy-r*0.10, hr=r*0.40;
      g += `<g opacity=".26" filter="url(#${fid})">${ell(bx,by,bw,bh,BODY)}${cir(hx,hy,hr,BODY)}</g>`;
      // legs
      // capybara — short stubby (back pair)
      g += legPair(cx-r*0.40, gy, lw, lh, BODY, legSt);
      g += ell(bx, by, bw, bh, BODY);
      g += ell(bx, by+bh*0.35, bw*0.7, bh*0.50, BELLY, ` opacity=".90"`);
      // capybara — front pair
      g += legPair(cx+r*0.40, gy, lw, lh, BODY, legSt);
      // tiny ears
      g += cir(hx-r*0.22, hy-r*0.32, r*0.08, BODY);
      g += cir(hx+r*0.22, hy-r*0.32, r*0.08, BODY);
      // head (boxy round)
      g += cir(hx, hy, hr, BODY);
      g += tinyFace(hx, hy, hr);
      return g;
    }

    if(p.shape==='salamander'){
      // AXOLOTL — flat body with gills sticking out, paddle tail
      g += `<g opacity=".26" filter="url(#${fid})">${ell(cx-r*0.10,cy+r*0.05,r*1.0,r*0.45,BODY)}</g>`;
      // tail (paddle right)
      g += `<path d="M${F(cx+r*0.85)},${F(cy-r*0.10)} Q${F(cx+r*1.30)},${F(cy)} ${F(cx+r*0.85)},${F(cy+r*0.30)} Z" fill="${BODY}"/>`;
      // splayed limbs
      g += ell(cx-r*0.65, cy+r*0.45, r*0.18, r*0.08, BODY, ` transform="rotate(20,${F(cx-r*0.65)},${F(cy+r*0.45)})"`);
      g += ell(cx-r*0.20, cy+r*0.55, r*0.18, r*0.08, BODY);
      g += ell(cx+r*0.30, cy+r*0.55, r*0.18, r*0.08, BODY);
      g += ell(cx+r*0.65, cy+r*0.45, r*0.18, r*0.08, BODY, ` transform="rotate(-20,${F(cx+r*0.65)},${F(cy+r*0.45)})"`);
      // body
      g += `<path d="M${F(cx-r*0.85)},${F(cy)} C${F(cx-r*0.95)},${F(cy-r*0.50)} ${F(cx-r*0.20)},${F(cy-r*0.65)} ${F(cx)},${F(cy-r*0.55)} C${F(cx+r*0.40)},${F(cy-r*0.60)} ${F(cx+r*0.78)},${F(cy-r*0.40)} ${F(cx+r*0.85)},${F(cy)} C${F(cx+r*0.78)},${F(cy+r*0.50)} ${F(cx-r*0.78)},${F(cy+r*0.50)} ${F(cx-r*0.85)},${F(cy)} Z" fill="${BODY}"/>`;
      g += ell(cx, cy+r*0.10, r*0.55, r*0.25, BELLY, ` opacity=".88"`);
      // gills (3 plumes each side)
      [-0.45,-0.20,0.05].forEach(o=>{
        g += ell(cx+r*o, cy-r*0.55, r*0.08, r*0.16, '#FF9DBA', ` opacity=".88"`);
      });
      // face
      const hx=cx-r*0.10, hy=cy-r*0.20, hr=r*0.32;
      g += cir(hx-r*0.13, hy, r*0.05, FACE);
      g += cir(hx+r*0.13, hy, r*0.05, FACE);
      g += cir(hx-r*0.10, hy-r*0.02, r*0.020, 'white');
      g += cir(hx+r*0.16, hy-r*0.02, r*0.020, 'white');
      g += `<path d="M${F(hx-r*0.10)},${F(hy+r*0.13)} Q${F(hx-r*0.05)},${F(hy+r*0.20)} ${F(hx)},${F(hy+r*0.16)} Q${F(hx+r*0.05)},${F(hy+r*0.20)} ${F(hx+r*0.10)},${F(hy+r*0.13)}" stroke="${FACE}" stroke-width="${F(r*0.04)}" fill="none" stroke-linecap="round"/>`;
      g += ell(hx-r*0.25, hy+r*0.13, r*0.10, r*0.05, BLUSH, ` opacity=".55"`);
      g += ell(hx+r*0.25, hy+r*0.13, r*0.10, r*0.05, BLUSH, ` opacity=".55"`);
      return g;
    }

    // fallback: simple round
    g += cir(cx, cy, r*0.7, BODY);
    g += tinyFace(cx, cy, r*0.5);
    return g;
  }

  return render();
}

// ── Skin / Costume overlays (Phase 4) ──────────────────────────
// Unlockable themed costumes per pet + 'default' (free, owned at unlock).
// Each overlay returns SVG fragments positioned on the pet head/top.
// Overlay coords use the same scale s as kekeSVG (cx=s*.5, cy=s*.62, r=s*.30).
const SKINS = [
  { id: 'default',    name: 'Default',     emoji: '🐾' },
  { id: 'pumpkin',    name: 'Pumpkin',     emoji: '🎃' },
  { id: 'ghost',      name: 'Ghost',       emoji: '👻' },
  { id: 'santa',      name: 'Santa',       emoji: '🎅' },
  { id: 'birthday',   name: 'Birthday',    emoji: '🎂' },
  { id: 'wizard',     name: 'Wizard',      emoji: '🧙' },
  { id: 'crown',      name: 'Crown',       emoji: '👑' },
  { id: 'sunglasses', name: 'Sunglasses',  emoji: '🕶️' },
  { id: 'flower',     name: 'Flower Crown',emoji: '🌸' },
  { id: 'sailor',     name: 'Sailor',      emoji: '⛵' },
  { id: 'cowboy',     name: 'Cowboy',      emoji: '🤠' },
  { id: 'catears',    name: 'Cat Ears',    emoji: '🐱' },
  { id: 'beret',      name: 'Beret',       emoji: '🎨' },
  { id: 'startiara',  name: 'Star Tiara',  emoji: '⭐' },
  { id: 'strawhut',   name: 'Straw Hat',   emoji: '🌾' },
  { id: 'bow',        name: 'Bow',         emoji: '🎀' },
  { id: 'mushroom',   name: 'Mushroom',    emoji: '🍄' },
  { id: 'unicorn',    name: 'Unicorn',     emoji: '🦄' },
  { id: 'chef',       name: 'Chef',        emoji: '👨‍🍳' },
  { id: 'graduation', name: 'Graduation',  emoji: '🎓' },
];

// Per-pet leg-height fraction (matches LEG_CFG h values inside kekeSVG)
const _LEG_H = {
  shiro:0.18, boba:0.18, koko:0.18, momo:0.22, mimi:0.14,
  kumo:0.22,  goma:0.18, toro:0.22, fafa:0,    zoro:0.18,
  nene:0,     yuki:0.09, piyo:0,    maru:0.07,  nori:0,
  coco:0.14,  piko:0.13, hana:0.32, suika:0.10, riri:0,
};

// Returns the exact head geometry used by kekeSVG for this pet.
// hx/hy = head circle center, hr = head radius, hy_top = top edge of head (hat base).
function getHeadGeom(pal, s) {
  const cx = s*0.50, cy = s*0.62, r = s*0.30;
  const lhFrac = _LEG_H[pal.id] !== undefined ? _LEG_H[pal.id] : 0.18;
  const lh = r * lhFrac;
  const gy = cy + r*0.78;
  let hx, hy, hr;
  switch (pal.shape) {
    case 'fluff': { const by = gy-lh-r*0.40; hx=cx;        hy=by-r*0.42; hr=r*0.50; break; }
    case 'panda': { const by = gy-lh-r*0.40; hx=cx;        hy=by-r*0.46; hr=r*0.52; break; }
    case 'corgi':
    case 'dog':   { const by = gy-lh-r*0.45; hx=cx+r*0.70; hy=by-r*0.32; hr=r*0.42; break; }
    case 'cat':   { const by = gy-lh-r*0.45; hx=cx+r*0.55; hy=by-r*0.32; hr=r*0.40; break; }
    case 'penguin':    hx=cx;          hy=cy-r*0.70; hr=r*0.30; break;
    case 'chick':      hx=cx;          hy=cy-r*0.20; hr=r*0.40; break;
    case 'frog':       hx=cx;          hy=cy-r*0.30; hr=r*0.45; break;
    case 'seal':       hx=cx+r*0.95;   hy=cy-r*0.15; hr=r*0.32; break;
    case 'capy':       hx=cx+r*0.78;   hy=cy-r*0.10; hr=r*0.40; break;
    case 'salamander': hx=cx-r*0.10;   hy=cy-r*0.20; hr=r*0.32; break;
    case 'cloud':      hx=cx+r*0.45;   hy=cy-r*0.30; hr=r*0.22; break;
    default:         { const by = gy-lh-r*0.40; hx=cx; hy=by-r*0.42; hr=r*0.50; }
  }
  return { hx, hy, hr, hy_top: hy - hr };
}

function kekeSkinSVG(skinId, pal, s) {
  if (!skinId || skinId === 'default') return '';
  const F = n => n.toFixed(2);
  const r = s * 0.30;
  const { hx, hy: hHead, hr, hy_top } = getHeadGeom(pal, s);
  // hy = top edge of head (hat brim sits here); hHead = circle center
  const hy = hy_top;

  if (skinId === 'pumpkin') {
    // Pumpkin head/hat: orange dome + green stem
    const w = r * 0.55, h = r * 0.45;
    return `
      <ellipse cx="${F(hx)}" cy="${F(hy)}" rx="${F(w)}" ry="${F(h)}" fill="#F08020"/>
      <ellipse cx="${F(hx-w*0.55)}" cy="${F(hy)}" rx="${F(w*0.35)}" ry="${F(h*0.95)}" fill="#E07010" opacity=".7"/>
      <ellipse cx="${F(hx+w*0.55)}" cy="${F(hy)}" rx="${F(w*0.35)}" ry="${F(h*0.95)}" fill="#E07010" opacity=".7"/>
      <rect x="${F(hx-r*0.04)}" y="${F(hy-h*1.05)}" width="${F(r*0.08)}" height="${F(r*0.18)}" fill="#3D6E2A" rx="2"/>
      <path d="M${F(hx)},${F(hy-h*0.95)} q${F(r*0.18)},${F(-r*0.10)} ${F(r*0.16)},${F(-r*0.30)}" stroke="#3D6E2A" stroke-width="${F(r*0.05)}" fill="none" stroke-linecap="round"/>`;
  }

  if (skinId === 'ghost') {
    // White drape sheet over the pet; eyes at head-center level
    const cx = s * 0.50, cy = s * 0.62;
    const ey = hHead;
    return `
      <path d="M${F(cx-r*1.0)},${F(cy+r*0.6)}
        Q${F(cx-r*1.05)},${F(hy-r*0.10)} ${F(cx)},${F(hy-r*0.25)}
        Q${F(cx+r*1.05)},${F(hy-r*0.10)} ${F(cx+r*1.0)},${F(cy+r*0.6)}
        L${F(cx+r*0.7)},${F(cy+r*0.5)}
        L${F(cx+r*0.4)},${F(cy+r*0.7)}
        L${F(cx)},${F(cy+r*0.5)}
        L${F(cx-r*0.4)},${F(cy+r*0.7)}
        L${F(cx-r*0.7)},${F(cy+r*0.5)} Z" fill="rgba(255,255,255,.92)" stroke="#888" stroke-width=".5"/>
      <circle cx="${F(cx-r*0.18)}" cy="${F(ey)}" r="${F(r*0.07)}" fill="#1a1a1a"/>
      <circle cx="${F(cx+r*0.18)}" cy="${F(ey)}" r="${F(r*0.07)}" fill="#1a1a1a"/>`;
  }

  if (skinId === 'santa') {
    const w = r * 0.50;
    return `
      <path d="M${F(hx-w*0.85)},${F(hy)} Q${F(hx-w*0.55)},${F(hy-r*0.85)} ${F(hx+w*0.55)},${F(hy-r*0.65)} L${F(hx+w*0.85)},${F(hy)} Z" fill="#D03030"/>
      <ellipse cx="${F(hx)}" cy="${F(hy+r*0.02)}" rx="${F(w*0.95)}" ry="${F(r*0.07)}" fill="white"/>
      <circle cx="${F(hx+w*0.55)}" cy="${F(hy-r*0.65)}" r="${F(r*0.10)}" fill="white"/>`;
  }

  if (skinId === 'birthday') {
    const w = r * 0.32;
    return `
      <path d="M${F(hx-w)},${F(hy)} L${F(hx)},${F(hy-r*0.85)} L${F(hx+w)},${F(hy)} Z" fill="#FF80B0"/>
      <path d="M${F(hx-w*0.65)},${F(hy-r*0.20)} L${F(hx)},${F(hy-r*0.50)}" stroke="white" stroke-width="${F(r*0.05)}" fill="none"/>
      <path d="M${F(hx+w*0.30)},${F(hy-r*0.45)} L${F(hx+w*0.10)},${F(hy-r*0.10)}" stroke="white" stroke-width="${F(r*0.05)}" fill="none"/>
      <polygon points="${F(hx)},${F(hy-r*1.05)} ${F(hx+r*0.08)},${F(hy-r*0.85)} ${F(hx+r*0.04)},${F(hy-r*0.78)} ${F(hx-r*0.04)},${F(hy-r*0.78)} ${F(hx-r*0.08)},${F(hy-r*0.85)}" fill="#FFE040"/>`;
  }

  if (skinId === 'wizard') {
    const w = r * 0.42;
    return `
      <ellipse cx="${F(hx)}" cy="${F(hy+r*0.04)}" rx="${F(w*1.25)}" ry="${F(r*0.07)}" fill="#3a2880"/>
      <path d="M${F(hx-w)},${F(hy)} Q${F(hx-w*0.60)},${F(hy-r*0.50)} ${F(hx+r*0.10)},${F(hy-r*1.05)} L${F(hx+w)},${F(hy)} Z" fill="#5040A0"/>
      <text x="${F(hx-r*0.22)}" y="${F(hy-r*0.30)}" fill="#FFE060" font-size="${F(r*0.18)}" text-anchor="middle">✦</text>
      <text x="${F(hx+r*0.10)}" y="${F(hy-r*0.55)}" fill="#FFE060" font-size="${F(r*0.14)}" text-anchor="middle">✧</text>`;
  }

  if (skinId === 'crown') {
    const w = r * 0.45;
    return `
      <path d="M${F(hx-w)},${F(hy)}
        L${F(hx-w)},${F(hy-r*0.30)}
        L${F(hx-w*0.5)},${F(hy-r*0.10)}
        L${F(hx-w*0.25)},${F(hy-r*0.45)}
        L${F(hx)},${F(hy-r*0.10)}
        L${F(hx+w*0.25)},${F(hy-r*0.45)}
        L${F(hx+w*0.5)},${F(hy-r*0.10)}
        L${F(hx+w)},${F(hy-r*0.30)}
        L${F(hx+w)},${F(hy)} Z" fill="#FFC830" stroke="#B07820" stroke-width=".6"/>
      <circle cx="${F(hx-w*0.5)}" cy="${F(hy-r*0.10)}" r="${F(r*0.05)}" fill="#FF4060"/>
      <circle cx="${F(hx)}" cy="${F(hy-r*0.10)}" r="${F(r*0.05)}" fill="#3070FF"/>
      <circle cx="${F(hx+w*0.5)}" cy="${F(hy-r*0.10)}" r="${F(r*0.05)}" fill="#30C070"/>`;
  }

  if (skinId === 'sunglasses') {
    const w = r * 0.16;
    const ey = hHead + hr * 0.05;
    return `
      <ellipse cx="${F(hx-r*0.18)}" cy="${F(ey)}" rx="${F(w)}" ry="${F(r*0.10)}" fill="#101010" stroke="#444" stroke-width=".8"/>
      <ellipse cx="${F(hx+r*0.18)}" cy="${F(ey)}" rx="${F(w)}" ry="${F(r*0.10)}" fill="#101010" stroke="#444" stroke-width=".8"/>
      <line x1="${F(hx-r*0.04)}" y1="${F(ey)}" x2="${F(hx+r*0.04)}" y2="${F(ey)}" stroke="#101010" stroke-width="${F(r*0.04)}"/>
      <ellipse cx="${F(hx-r*0.22)}" cy="${F(ey-r*0.04)}" rx="${F(w*0.30)}" ry="${F(r*0.025)}" fill="white" opacity=".55"/>
      <ellipse cx="${F(hx+r*0.14)}" cy="${F(ey-r*0.04)}" rx="${F(w*0.30)}" ry="${F(r*0.025)}" fill="white" opacity=".55"/>`;
  }

  if (skinId === 'flower') {
    // Pastel flower crown — 5 flowers arced across the top of the head
    const flPetals = (fx, fy, fr, col) => {
      let s2 = '';
      for (let i=0; i<5; i++) {
        const a = (i/5)*Math.PI*2;
        s2 += `<circle cx="${F(fx+Math.cos(a)*fr*0.9)}" cy="${F(fy+Math.sin(a)*fr*0.9)}" r="${F(fr*0.55)}" fill="${col}" opacity=".92"/>`;
      }
      s2 += `<circle cx="${F(fx)}" cy="${F(fy)}" r="${F(fr*0.40)}" fill="#FFE060"/>`;
      return s2;
    };
    const spread = hr * 0.88;
    const positions = [
      {x:hx,        y:hy-r*0.04, col:'#FF9DBA'},
      {x:hx-spread*0.60, y:hy+r*0.10, col:'#C8A8FF'},
      {x:hx+spread*0.60, y:hy+r*0.10, col:'#A8E0FF'},
      {x:hx-spread*0.95, y:hy+r*0.28, col:'#FFD0A0'},
      {x:hx+spread*0.95, y:hy+r*0.28, col:'#B0F0C0'},
    ];
    return positions.map(p => flPetals(p.x, p.y, r*0.10, p.col)).join('') +
      `<path d="M${F(hx-spread)},${F(hy+r*0.35)} Q${F(hx)},${F(hy-r*0.10)} ${F(hx+spread)},${F(hy+r*0.35)}" stroke="#6AAF40" stroke-width="${F(r*0.04)}" fill="none"/>`;
  }

  if (skinId === 'sailor') {
    // White sailor cap with navy band and brim
    const w = r * 0.52;
    return `
      <ellipse cx="${F(hx)}" cy="${F(hy+r*0.06)}" rx="${F(w*1.15)}" ry="${F(r*0.075)}" fill="#DDEEFF" stroke="#223399" stroke-width=".8"/>
      <ellipse cx="${F(hx)}" cy="${F(hy-r*0.16)}" rx="${F(w*0.88)}" ry="${F(r*0.28)}" fill="white"/>
      <ellipse cx="${F(hx)}" cy="${F(hy+r*0.02)}" rx="${F(w*0.88)}" ry="${F(r*0.07)}" fill="#223399"/>
      <rect x="${F(hx-r*0.04)}" y="${F(hy-r*0.38)}" width="${F(r*0.08)}" height="${F(r*0.14)}" rx="2" fill="#223399"/>
      <ellipse cx="${F(hx)}" cy="${F(hy-r*0.42)}" rx="${F(r*0.10)}" ry="${F(r*0.04)}" fill="#223399"/>`;
  }

  if (skinId === 'cowboy') {
    // Tan cowboy hat with rope band
    const w = r * 0.44;
    return `
      <ellipse cx="${F(hx)}" cy="${F(hy+r*0.06)}" rx="${F(w*1.40)}" ry="${F(r*0.08)}" fill="#C49A50" stroke="#8B6020" stroke-width=".7"/>
      <path d="M${F(hx-w*0.88)},${F(hy)} Q${F(hx-w*0.50)},${F(hy-r*0.20)} ${F(hx)},${F(hy-r*0.70)} Q${F(hx+w*0.50)},${F(hy-r*0.20)} ${F(hx+w*0.88)},${F(hy)} Z" fill="#D4AA60"/>
      <ellipse cx="${F(hx)}" cy="${F(hy+r*0.04)}" rx="${F(w*0.88)}" ry="${F(r*0.055)}" fill="#8B6020" opacity=".70"/>
      <path d="M${F(hx-w*0.55)},${F(hy-r*0.08)} Q${F(hx)},${F(hy-r*0.12)} ${F(hx+w*0.55)},${F(hy-r*0.08)}" stroke="#8B6020" stroke-width="${F(r*0.04)}" fill="none" stroke-dasharray="${F(r*0.08)} ${F(r*0.05)}"/>`;
  }

  if (skinId === 'catears') {
    // Pink cat-ear headband
    const ew = r * 0.14, eh = r * 0.26;
    return `
      <rect x="${F(hx-hr*1.05)}" y="${F(hy+r*0.14)}" width="${F(hr*2.10)}" height="${F(r*0.07)}" rx="${F(r*0.035)}" fill="#FF9DBA"/>
      <path d="M${F(hx-hr*0.80)},${F(hy+r*0.14)} L${F(hx-hr*0.72)},${F(hy-r*0.18)} L${F(hx-hr*0.44)},${F(hy+r*0.14)} Z" fill="#FF9DBA"/>
      <path d="M${F(hx-hr*0.76)},${F(hy+r*0.10)} L${F(hx-hr*0.70)},${F(hy-r*0.10)} L${F(hx-hr*0.50)},${F(hy+r*0.10)} Z" fill="#FFD0E8"/>
      <path d="M${F(hx+hr*0.44)},${F(hy+r*0.14)} L${F(hx+hr*0.72)},${F(hy-r*0.18)} L${F(hx+hr*0.80)},${F(hy+r*0.14)} Z" fill="#FF9DBA"/>
      <path d="M${F(hx+hr*0.50)},${F(hy+r*0.10)} L${F(hx+hr*0.70)},${F(hy-r*0.10)} L${F(hx+hr*0.76)},${F(hy+r*0.10)} Z" fill="#FFD0E8"/>`;
  }

  if (skinId === 'beret') {
    // Soft round beret tilted to one side, with tiny stem
    const bw = r * 0.56, bh = r * 0.22;
    return `
      <ellipse cx="${F(hx+r*0.08)}" cy="${F(hy+r*0.04)}" rx="${F(bw)}" ry="${F(bh)}" fill="#CC2233"/>
      <ellipse cx="${F(hx-r*0.10)}" cy="${F(hy-r*0.08)}" rx="${F(bw*0.88)}" ry="${F(bh*0.78)}" fill="#DD3344"/>
      <ellipse cx="${F(hx)}" cy="${F(hy+r*0.06)}" rx="${F(bw*0.55)}" ry="${F(r*0.045)}" fill="#991122" opacity=".55"/>
      <circle cx="${F(hx+bw*0.68)}" cy="${F(hy-r*0.04)}" r="${F(r*0.055)}" fill="#881122"/>`;
  }

  if (skinId === 'startiara') {
    // Thin gold tiara band with 5 stars
    const tw = r * 0.52;
    const star = (x, y, sr, col) => {
      let pts = '';
      for (let i=0; i<10; i++) {
        const a = (i/10)*Math.PI*2 - Math.PI/2;
        const dist = i%2===0 ? sr : sr*0.45;
        pts += `${F(x+Math.cos(a)*dist)},${F(y+Math.sin(a)*dist)} `;
      }
      return `<polygon points="${pts.trim()}" fill="${col}"/>`;
    };
    return `
      <path d="M${F(hx-tw)},${F(hy+r*0.10)} Q${F(hx)},${F(hy-r*0.04)} ${F(hx+tw)},${F(hy+r*0.10)}" stroke="#FFD030" stroke-width="${F(r*0.045)}" fill="none"/>
      ${star(hx, hy-r*0.20, r*0.12, '#FFE040')}
      ${star(hx-tw*0.55, hy+r*0.02, r*0.085, '#FFD030')}
      ${star(hx+tw*0.55, hy+r*0.02, r*0.085, '#FFD030')}
      ${star(hx-tw*0.95, hy+r*0.08, r*0.065, '#FFC820')}
      ${star(hx+tw*0.95, hy+r*0.08, r*0.065, '#FFC820')}`;
  }

  if (skinId === 'strawhut') {
    // Tan straw hat with yellow ribbon
    const w = r * 0.42;
    return `
      <ellipse cx="${F(hx)}" cy="${F(hy+r*0.07)}" rx="${F(w*1.45)}" ry="${F(r*0.09)}" fill="#D4B870" stroke="#B09040" stroke-width=".7"/>
      <path d="M${F(hx-w*0.88)},${F(hy)} Q${F(hx-w*0.44)},${F(hy-r*0.56)} ${F(hx)},${F(hy-r*0.62)} Q${F(hx+w*0.44)},${F(hy-r*0.56)} ${F(hx+w*0.88)},${F(hy)} Z" fill="#E0C878"/>
      <ellipse cx="${F(hx)}" cy="${F(hy+r*0.04)}" rx="${F(w*0.86)}" ry="${F(r*0.055)}" fill="#F5A828" opacity=".80"/>
      <path d="M${F(hx-w*0.55)},${F(hy-r*0.08)} L${F(hx+w*0.55)},${F(hy-r*0.08)}" stroke="#C09020" stroke-width="${F(r*0.035)}" stroke-dasharray="${F(r*0.07)} ${F(r*0.04)}" fill="none"/>`;
  }

  if (skinId === 'bow') {
    // Big ribbon bow on top of head
    const bw = r * 0.28, bh = r * 0.16;
    return `
      <path d="M${F(hx)},${F(hy-r*0.04)} Q${F(hx-bw*0.5)},${F(hy-bh*2.0)} ${F(hx-bw)},${F(hy-bh)} Q${F(hx-bw*0.5)},${F(hy+bh*0.4)} ${F(hx)},${F(hy-r*0.04)} Z" fill="#FF4488" stroke="#DD2266" stroke-width=".5"/>
      <path d="M${F(hx)},${F(hy-r*0.04)} Q${F(hx+bw*0.5)},${F(hy-bh*2.0)} ${F(hx+bw)},${F(hy-bh)} Q${F(hx+bw*0.5)},${F(hy+bh*0.4)} ${F(hx)},${F(hy-r*0.04)} Z" fill="#FF4488" stroke="#DD2266" stroke-width=".5"/>
      <path d="M${F(hx)},${F(hy-r*0.04)} Q${F(hx-bw*0.4)},${F(hy-bh*1.5)} ${F(hx-bw*0.7)},${F(hy-bh*0.7)}" stroke="#FF80B0" stroke-width="${F(r*0.04)}" fill="none"/>
      <path d="M${F(hx)},${F(hy-r*0.04)} Q${F(hx+bw*0.4)},${F(hy-bh*1.5)} ${F(hx+bw*0.7)},${F(hy-bh*0.7)}" stroke="#FF80B0" stroke-width="${F(r*0.04)}" fill="none"/>
      <circle cx="${F(hx)}" cy="${F(hy-r*0.04)}" r="${F(r*0.07)}" fill="#FF2266"/>`;
  }

  if (skinId === 'mushroom') {
    // Red mushroom cap with white spots
    const mw = r * 0.56, mh = r * 0.38;
    return `
      <path d="M${F(hx-mw)},${F(hy+r*0.06)} Q${F(hx-mw*1.08)},${F(hy-mh*0.20)} ${F(hx-mw*0.70)},${F(hy-mh*0.80)} Q${F(hx)},${F(hy-mh*1.30)} ${F(hx+mw*0.70)},${F(hy-mh*0.80)} Q${F(hx+mw*1.08)},${F(hy-mh*0.20)} ${F(hx+mw)},${F(hy+r*0.06)} Z" fill="#DD2222"/>
      <ellipse cx="${F(hx)}" cy="${F(hy+r*0.06)}" rx="${F(mw*0.60)}" ry="${F(r*0.06)}" fill="#FFEECC"/>
      <circle cx="${F(hx)}" cy="${F(hy-mh*0.55)}" r="${F(r*0.10)}" fill="white" opacity=".92"/>
      <circle cx="${F(hx-mw*0.46)}" cy="${F(hy-mh*0.30)}" r="${F(r*0.075)}" fill="white" opacity=".92"/>
      <circle cx="${F(hx+mw*0.46)}" cy="${F(hy-mh*0.30)}" r="${F(r*0.075)}" fill="white" opacity=".92"/>
      <circle cx="${F(hx-mw*0.22)}" cy="${F(hy-mh*0.88)}" r="${F(r*0.055)}" fill="white" opacity=".88"/>
      <circle cx="${F(hx+mw*0.22)}" cy="${F(hy-mh*0.88)}" r="${F(r*0.055)}" fill="white" opacity=".88"/>`;
  }

  if (skinId === 'unicorn') {
    // Spiral golden unicorn horn + rainbow mane wisps
    const hlen = r * 0.72;
    return `
      <path d="M${F(hx-r*0.06)},${F(hy)} L${F(hx)},${F(hy-hlen)} L${F(hx+r*0.06)},${F(hy)} Z" fill="#FFD040"/>
      <path d="M${F(hx-r*0.04)},${F(hy-hlen*0.22)} L${F(hx+r*0.04)},${F(hy-hlen*0.26)}" stroke="#FFA020" stroke-width="${F(r*0.025)}" fill="none"/>
      <path d="M${F(hx-r*0.04)},${F(hy-hlen*0.44)} L${F(hx+r*0.04)},${F(hy-hlen*0.48)}" stroke="#FFA020" stroke-width="${F(r*0.025)}" fill="none"/>
      <path d="M${F(hx-r*0.04)},${F(hy-hlen*0.66)} L${F(hx+r*0.04)},${F(hy-hlen*0.70)}" stroke="#FFA020" stroke-width="${F(r*0.025)}" fill="none"/>
      <path d="M${F(hx-r*0.28)},${F(hy+r*0.04)} q${F(-r*0.20)},${F(-r*0.18)} ${F(-r*0.04)},${F(-r*0.38)}" stroke="#FF6699" stroke-width="${F(r*0.07)}" fill="none" stroke-linecap="round"/>
      <path d="M${F(hx-r*0.20)},${F(hy+r*0.04)} q${F(-r*0.16)},${F(-r*0.14)} ${F(-r*0.02)},${F(-r*0.30)}" stroke="#A0D8FF" stroke-width="${F(r*0.05)}" fill="none" stroke-linecap="round"/>
      <path d="M${F(hx+r*0.26)},${F(hy+r*0.04)} q${F(r*0.18)},${F(-r*0.16)} ${F(r*0.02)},${F(-r*0.36)}" stroke="#B0FFB0" stroke-width="${F(r*0.06)}" fill="none" stroke-linecap="round"/>`;
  }

  if (skinId === 'chef') {
    // White chef toque with puffed top
    const cw = r * 0.34;
    return `
      <ellipse cx="${F(hx)}" cy="${F(hy+r*0.04)}" rx="${F(cw*1.10)}" ry="${F(r*0.06)}" fill="#E8E8E8" stroke="#CCCCCC" stroke-width=".6"/>
      <rect x="${F(hx-cw)}" y="${F(hy-r*0.32)}" width="${F(cw*2)}" height="${F(r*0.36)}" fill="white"/>
      <ellipse cx="${F(hx)}" cy="${F(hy-r*0.32)}" rx="${F(cw*0.96)}" ry="${F(r*0.28)}" fill="white"/>
      <ellipse cx="${F(hx)}" cy="${F(hy-r*0.52)}" rx="${F(cw*0.80)}" ry="${F(r*0.22)}" fill="white"/>
      <ellipse cx="${F(hx)}" cy="${F(hy-r*0.68)}" rx="${F(cw*0.62)}" ry="${F(r*0.18)}" fill="white"/>
      <ellipse cx="${F(hx)}" cy="${F(hy-r*0.30)}" rx="${F(cw)}" ry="${F(r*0.048)}" fill="#DDDDDD" opacity=".50"/>`;
  }

  if (skinId === 'graduation') {
    // Black mortarboard cap with gold tassel
    const gw = r * 0.52;
    return `
      <ellipse cx="${F(hx)}" cy="${F(hy+r*0.04)}" rx="${F(gw*0.75)}" ry="${F(r*0.10)}" fill="#1a1a1a"/>
      <rect x="${F(hx-gw)}" y="${F(hy-r*0.08)}" width="${F(gw*2)}" height="${F(r*0.12)}" rx="${F(r*0.02)}" fill="#1a1a1a"/>
      <rect x="${F(hx-gw*0.98)}" y="${F(hy-r*0.10)}" width="${F(gw*1.96)}" height="${F(r*0.04)}" rx="${F(r*0.02)}" fill="#333"/>
      <circle cx="${F(hx)}" cy="${F(hy-r*0.04)}" r="${F(r*0.045)}" fill="#FFD030"/>
      <line x1="${F(hx)}" y1="${F(hy-r*0.04)}" x2="${F(hx+gw*0.70)}" y2="${F(hy+r*0.12)}" stroke="#FFD030" stroke-width="${F(r*0.035)}"/>
      <circle cx="${F(hx+gw*0.70)}" cy="${F(hy+r*0.12)}" r="${F(r*0.06)}" fill="#FFD030"/>
      <line x1="${F(hx+gw*0.70)}" y1="${F(hy+r*0.12)}" x2="${F(hx+gw*0.64)}" y2="${F(hy+r*0.26)}" stroke="#FFD030" stroke-width="${F(r*0.025)}"/>
      <line x1="${F(hx+gw*0.70)}" y1="${F(hy+r*0.12)}" x2="${F(hx+gw*0.76)}" y2="${F(hy+r*0.26)}" stroke="#FFD030" stroke-width="${F(r*0.025)}"/>`;
  }

  return '';
}

// ── ESM exports ──────────────────────────────────────────────
window.TERSE_PALS = { KEKE, kekeSVG, SKINS, kekeSkinSVG };
