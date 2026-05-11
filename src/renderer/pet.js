// Floating pet companion logic
(function () {
  'use strict';
  const T = window.terse;
  const TP = window.TERSE_PALS;
  if (!T || !TP) { console.warn('[pet] terse or pals not ready'); return; }

  const stage = document.getElementById('stage');
  const host = document.getElementById('pet-host');
  const inner = document.getElementById('pet-inner');
  const bubble = document.getElementById('bubble');
  let currentPalId = null;
  let bubbleHideTimer = null;
  let settings = { showBubbles:true, eatAnimation:true, milestoneAnimation:true, idleAnimation:true };

  // Per-pet personality — idle has many variants, eat/mile/poke have shorter sets
  const MSGS = {
    yuki:  {
      idle: ['Quack quack! 🦆','Wanna swim? 💦','Look at me!','Quaaaaack~','*paddling*','Water is nice~','Quack!','I am duck 🦆'],
      eat:  ['Nom nom! 🍞','Bread please! 🍞','So yummy!','*chomping*','Quack quack NOM'],
      mile: ['Woo! 🦆','Quack quack!!','Amazing!','Duck milestone!!','QUACK!!!'],
      poke: ['Hey! 👀','Quack! 🦆','!?','*ruffles feathers*','Quaaack~'],
    },
    piyo:  {
      idle: ['Cheep cheep! 🐣','So fluffy!','Peep!','Tweet!','*tiny chirp*','Am I growing?','Cheeeep!','So small~'],
      eat:  ['Yummy seeds! 🌾','Cheep!','More!','*gobble*','Tweet tweet nom!'],
      mile: ['Tweet!! 🐣','Growing strong!','Peep peep!!','Becoming big bird!','Cheep!!'],
      poke: ['Peep peep!','So tiny...','Cheep!','*wobbles*','Eep!'],
    },
    momo:  {
      idle: ['Meow~ 🐱','...','Notice me!','*purrs*','Nya~','*licks paw*','...meow','I own this desk'],
      eat:  ['Nom! 🐟','*crunch*','Delish~','Finally. Food.','*satisfied purr*'],
      mile: ['Purrfect! 🐱','More please~','Meooow!','That\'s mine now','*slow blink*'],
      poke: ['Meow!','...','purrr~','How dare you','*flops*'],
    },
    maru:  {
      idle: ['*stores cheeks*','So much energy!','Squeak!','Wiggle wiggle!','*wheel time*','Zoom zoom!','Hoard mode activated','Squeaky!'],
      eat:  ['Storing for later!','Nom nom nom!','Cheeks full!','*stuffs cheeks*','Must save some...'],
      mile: ['My cheeks are FULL! 🐹','Wheee!','Squeak!!','MAXIMUM HOARD','SO MUCH FOOD'],
      poke: ['*puff*','Squeak!','!?','Stop that!','*vibrates*'],
    },
    piko:  {
      idle: ['Oink! 🐷','Mud is cozy~','Roll roll!','Snort!','*rolls in mud*','Oinkety oink!','I love it here','Pig life 🐷'],
      eat:  ['Oink oink! 🥕','So tasty!','*snort*','More food!','*happy oinks*'],
      mile: ['OINK!! 🐷','Best day ever!','Piggy power!','ROLL ROLL ROLL!','*victory oink*'],
      poke: ['Oink!','🐷','*oink*','Snort!','Hey!'],
    },
    goma:  {
      idle: ['Woof! 🐶','Wanna play?','Good boy!','Fetch?','Bark bark!','*tail wagging*','Best friend!','Ball ball ball!'],
      eat:  ['WOOF! 🦴','Yummy!','Tail wag!','*happy zoomies*','Best treat EVER'],
      mile: ['WOOF WOOF!! 🐶','Best pet ever!','So happy!!','ZOOMIES!!!','*mega tail wag*'],
      poke: ['Woof!','🐾','*pant pant*','Play with me!','*licks face*'],
    },
    toro:  {
      idle: ['Yip! 🦊','*sniff sniff*','What\'s that?','Foxy!','*circles around*','So crafty~','Yip yip!','Cleverness: 100'],
      eat:  ['Got it! 🦊','Crafty~','So clever!','*snatches food*','Outwitted again!'],
      mile: ['Score! 🦊','So clever!!','Yip yip!!','FOXED IT!','*flicks tail*'],
      poke: ['Yip!','🦊','*tail wag*','Sneaky!','Gotcha!'],
    },
    fafa:  {
      idle: ['Ribbit! 🐸','Watcha doing?','Boing!','*croak*','Lily pad vibes~','Tongue at the ready','Ribbit ribbit!','Splashzone!'],
      eat:  ['Zap! 🐸','Bug caught!','Ribbit!','*lightning tongue*','Gotcha bug!'],
      mile: ['RIBBIT!! 🐸','Leaping joy!','So bouncy!!','BOING BOING!','*epic croak*'],
      poke: ['Ribbit!','🐸','*boing*','Splash!','*croak*'],
    },
    suika: {
      idle: ['...zz','Vibe check ✅','So peaceful~','*yawn*','...','Just vibing','No thoughts 🍉','Chill mode on'],
      eat:  ['Mmm... 🌿','*chew*','Nice...','...tasty','*slow munch*'],
      mile: ['Oh nice...','...!','Cool!','...wow','*barely excited*'],
      poke: ['...','zz','*blink*','...ok','mmm'],
    },
    coco:  {
      idle: ['*yawn*','So comfy...','...zzz','Koala time~','*hugs tree*','Eucalyptus dream...','*sleepy blink*','Just one more nap'],
      eat:  ['Eucalyptus~ 🍃','Mmm...','*munch*','*barely chews*','Yum... *yawn*'],
      mile: ['Oh! Nice.','More trees! 🌿','...!!','Koala win!','*wakes up briefly*'],
      poke: ['*yawn*','...','hmm','Go away... zzz','*slow blink*'],
    },
    kumo:  {
      idle: ['Baa~ 🐑','So fluffy!','Cloud vibes~','*float*','I am cloud','Wool is cozy','Baaaa!','Soft life~'],
      eat:  ['Baa! 🌿','*munch*','Soft!','Baa baa nom!','Grass is best'],
      mile: ['Baaaa!! ✨','Woolly great!','Puffy!!','FLUFFIEST!','*happy baa*'],
      poke: ['Baa~','🐑','*fluff*','Soft!','*boing*'],
    },
    riri:  {
      idle: ['*bubble*','Splashy!','So squishy~','Blub!','*regenerates*','Water friend~','Blub blub!','Axolotl time!'],
      eat:  ['Gulp! 🌊','*splash*','Regen!','Blub blub nom!','*happy splash*'],
      mile: ['Axolotl!! ✨','Regen time!','Blub blub!!','SPLASHY WIN!','*bubbles everywhere*'],
      poke: ['*bubble*','~',':D','Blub!','*squish*'],
    },
    nori:  {
      idle: ['Arf! 🦭','*flap flap*','Fish?','Splash~','*balances ball*','Arf arf!','Beach life~','*slides on ice*'],
      eat:  ['Fish! 🐟','Arf arf!','Yum!','*catches fish*','ARF! Got it!'],
      mile: ['ARF ARF! 🦭','Best seal!','So happy!','FISH PARTY!','*epic flap*'],
      poke: ['Arf!','🦭','*flap*','Hey!','*barks*'],
    },
    koko:  {
      idle: ['...','*bamboo nom*','So lazy~','Panda time~','*rolls around*','Bamboo forever','...zzz','Panda life 🐼'],
      eat:  ['Bamboo! 🎋','Nom...','Mmm!','*chews slowly*','More bamboo pls'],
      mile: ['Oh! Cool.','🎋🎋🎋','...nice!','*rolls happily*','Panda win!'],
      poke: ['...','*stare*','hmm','...ok','*sits down*'],
    },
    boba:  {
      idle: ['*hug me*','Honey~ 🍯','So sweet!','Mellow~','Boba bear~','*gentle sway*','Sweetness: 100%','Cozy bear 🐻'],
      eat:  ['Honey! 🍯','Yum~','Sweet!','*delighted hum*','So very sweet!'],
      mile: ['Sweet! 🍯','More honey!','Bear hug!!','HONEY OVERLOAD!','*bear happiness*'],
      poke: ['Hug!','🍯','*soft*','So warm~','*bear pat*'],
    },
    shiro: {
      idle: ['*sniff*','Salmon? 🐟','So fluffy!','Rawrr~','Bear patrol active','*yawns big*','White bear vibes','RAWRR~'],
      eat:  ['Yum! 🍣','*happy*','Salmon!!','RAWRR NOM!','*devours with joy*'],
      mile: ['Roar! 🐻','Legendary!','RAWRR!!','BEAR POWER!','*mighty roar*'],
      poke: ['*sniff*','🐻','Rawrr~','That tickles!','*flops*'],
    },
    mimi:  {
      idle: ['*nose twitch*','Hop hop!','So shy...','Eep!','*thumps foot*','Bunny thoughts...','Hoppy day!','*ear wiggle*'],
      eat:  ['Carrot! 🥕','*munch*','Yummy!','*happy thump*','Best carrot ever!'],
      mile: ['Hop! 🐰','Yay carrots!','So fast!!','BUNNY POWER!','*binkies everywhere*'],
      poke: ['Eep!','🐰','*hop*','*thump thump*','Shy~'],
    },
    nene:  {
      idle: ['Waddle waddle 🐧','Brr!','*sliding*','Penguin!','Ice is nice~','*belly slide*','Tuxedo time!','Penguin march!'],
      eat:  ['Fish! 🐟','Waddle~','Cold fish!','*gulps fish*','FISH ACQUIRED'],
      mile: ['PENGUIN!! 🐧','Ice cold!','Waddle waddle!!','EPIC SLIDE!','*penguin parade*'],
      poke: ['Brr!','🐧','*waddle*','Penguins don\'t poke!','*flap flap*'],
    },
    hana:  {
      idle: ['*ear flick*','Bambi!','So gentle~','Peek!','*grazes*','Forest friend~','*prances*','Nature love 🌿'],
      eat:  ['Berries! 🫐','Yum~','Forest!','*gentle munch*','Dewdrop morning!'],
      mile: ['Leap! 🦌','Forest magic!','So graceful!','BAMBI WIN!','*graceful leap*'],
      poke: ['*shy*','🦌','peek~','*hides*','*ear flick*'],
    },
    zoro:  {
      idle: ['*sneak*','Trash panda!','Raccoooon!','Got it!','*examines shiny*','Hehe...','Sneak level: max','*rummages*'],
      eat:  ['Found it! 🦝','*steal*','Score!','*sneaky munch*','Finders keepers!'],
      mile: ['Score!! 🦝','Best thief!','Sneak 100!','HEIST SUCCESS!','*raccoon celebration*'],
      poke: ['Hey!','🦝','*grab*','Not caught!','*scurries*'],
    },
  };

  const EAT_FOODS = ['🍪','🍩','🥨','🌰','🍯','🥕','🐟','🌿','🎋','🍞','🫐','🍣','🦴','🌾','🐛'];

  function randMsg(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  function applyIdleSetting() {
    if (!settings.idleAnimation) { inner.style.animation = 'none'; return; }
    const pal = window.TERSE_PALS?.KEKE?.find(p => p.id === currentPalId);
    inner.style.animation = pal ? `${pal.anim} ${pal.spd}s ease-in-out infinite` : '';
  }

  const PET_SIZE = 200;
  const PAD = 24;

  function renderPet(petId, skinId) {
    const pal = TP.KEKE.find(p => p.id === petId);
    if (!pal) { inner.innerHTML = ''; return; }
    const skinOverlay = (TP.kekeSkinSVG && skinId) ? TP.kekeSkinSVG(skinId, pal, PET_SIZE) : '';
    const W = PET_SIZE + PAD * 2;
    inner.innerHTML = `
      <svg width="${W}" height="${W}" viewBox="-${PAD} -${PAD} ${W} ${W}" style="display:block;overflow:visible">
        ${TP.kekeSVG(pal, PET_SIZE)}
        ${skinOverlay}
      </svg>`;
    // Apply per-pet body motion: breathing / walking / hopping / etc.
    if (pal.anim && settings.idleAnimation) {
      inner.style.animation = `${pal.anim} ${pal.spd}s ease-in-out infinite`;
    }
    host.classList.add('entering');
    setTimeout(() => host.classList.remove('entering'), 600);
    currentPalId = petId;
  }

  function showBubble(text, ms = 2600) {
    if (!text || !settings.showBubbles) return;
    bubble.textContent = text;
    bubble.classList.remove('hide');
    bubble.classList.add('show');
    if (bubbleHideTimer) clearTimeout(bubbleHideTimer);
    bubbleHideTimer = setTimeout(() => {
      bubble.classList.remove('show');
      bubble.classList.add('hide');
    }, ms);
  }

  function playAnim(cls, ms) {
    stage.classList.remove(cls); void stage.offsetWidth;
    stage.classList.add(cls);
    setTimeout(() => stage.classList.remove(cls), ms);
  }

  function playEat()     { if (!settings.eatAnimation) return; playAnim('eating', 650); spawnCrumb(); }
  function playHappy()   { if (!settings.milestoneAnimation) return; playAnim('happy', 950); spawnSparkles(5); }
  function playWiggle()  { playAnim('wiggling', 600); }
  function playSpin()    { playAnim('spinning', 750); }
  function playPoke()    { playAnim('poking', 550); }
  function playTilt()    { playAnim('tilting', 850); }
  function playStretch() { playAnim('stretching', 950); }
  function playScratch() { playAnim('scratching', 550); }
  function playLook()    { playAnim('looking', 1150); }
  function playHop()     { playAnim('hopping', 720); }
  function playSneeze()  { playAnim('sneezing', 600); }
  function playWave()    { playAnim('waving', 700); }

  // Blink: quick inner squish (doesn't override body idle animation)
  function doBlink() {
    const saved = inner.style.animation;
    inner.style.animation = 'pet-blink 0.22s linear';
    setTimeout(() => { inner.style.animation = saved; }, 220);
  }
  // Random blink every 3–8s, occasional double-blink
  function scheduleBlink() {
    setTimeout(() => {
      if (currentPalId) {
        doBlink();
        if (Math.random() < 0.25) setTimeout(doBlink, 350);
      }
      scheduleBlink();
    }, 3000 + Math.random() * 5000);
  }
  scheduleBlink();

  // Per-pet preferred idle animations — matches their personality
  const PET_IDLE_ANIMS = {
    yuki:  [playWiggle, playTilt, playLook, playWave],
    piyo:  [playWiggle, playHop, playTilt, playSneeze],
    momo:  [playStretch, playTilt, () => {}, playLook],
    maru:  [playWiggle, playScratch, playHop, playSneeze],
    piko:  [playWiggle, playLook, playStretch, playWave],
    goma:  [playWiggle, playHop, playSpin, playWave],
    toro:  [playTilt, playLook, playWiggle, playSneeze],
    fafa:  [playHop, playWiggle, playPoke, playWave],
    suika: [playTilt, () => {}, () => {}, playStretch],
    coco:  [playStretch, () => {}, playTilt, playSneeze],
    kumo:  [playWiggle, playStretch, playTilt, playWave],
    riri:  [playWiggle, playHop, playTilt, playSneeze],
    nori:  [playWiggle, playHop, playScratch, playWave],
    koko:  [playStretch, () => {}, playTilt, playLook],
    boba:  [playWiggle, playTilt, playStretch, playWave],
    shiro: [playStretch, playScratch, playLook, playSneeze],
    mimi:  [playHop, playWiggle, playTilt, playWave],
    nene:  [playWiggle, playHop, playLook, playSneeze],
    hana:  [playTilt, playLook, playHop, playWave],
    zoro:  [playLook, playScratch, playWiggle, playSneeze],
  };

  function spawnZzz() {
    const el = document.createElement('div');
    el.className = 'zzz';
    el.textContent = ['z','zz','zzz'][Math.floor(Math.random() * 3)];
    const rect = host.getBoundingClientRect();
    el.style.left = (rect.left + rect.width * 0.6 + Math.random() * 10) + 'px';
    el.style.top  = (rect.top + rect.height * 0.2) + 'px';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  }

  function spawnTickle() {
    const emojis = ['✨','💫','~','♪','★'];
    for (let i = 0; i < 3; i++) {
      const el = document.createElement('div');
      el.className = 'tickle';
      el.textContent = emojis[Math.floor(Math.random() * emojis.length)];
      const rect = host.getBoundingClientRect();
      el.style.left = (rect.left + Math.random() * rect.width) + 'px';
      el.style.top  = (rect.top + Math.random() * rect.height * 0.8) + 'px';
      el.style.animationDelay = (i * 80) + 'ms';
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 600 + i * 80);
    }
  }

  function spawnCrumb() {
    const food = EAT_FOODS[Math.floor(Math.random() * EAT_FOODS.length)];
    const el = document.createElement('div');
    el.className = 'crumb';
    el.textContent = food;
    const rect = host.getBoundingClientRect();
    el.style.left = (rect.left + rect.width/2 - 10 + (Math.random()*30-15)) + 'px';
    el.style.top  = (rect.top + 4) + 'px';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 600);
  }

  function spawnSparkles(n) {
    const rect = host.getBoundingClientRect();
    for (let i = 0; i < n; i++) {
      const el = document.createElement('div');
      el.className = 'sparkle';
      el.textContent = ['✨','⭐','💫','🌟','🎉'][i % 5];
      el.style.left = (rect.left + rect.width/2 - 9 + (Math.random()*80-40)) + 'px';
      el.style.top  = (rect.top + 8 + (Math.random()*20)) + 'px';
      el.style.animationDelay = (i * 80) + 'ms';
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 1300 + i*80);
    }
  }

  // Sleep state: dim pet + Zzz floaters between 10pm–7am
  let isSleeping = false;
  let zzzTimer = null;
  function checkSleepState() {
    const h = new Date().getHours();
    const shouldSleep = h >= 22 || h < 7;
    if (shouldSleep === isSleeping) return;
    isSleeping = shouldSleep;
    stage.classList.toggle('sleeping', isSleeping);
    if (isSleeping) {
      // Start Zzz loop
      zzzTimer = setInterval(() => { if (currentPalId) spawnZzz(); }, 2800);
      const msgs = MSGS[currentPalId];
      const sleepMsgs = ['*yawn* ...zzz','Time to sleep 😴','Night night~','zzz...','*dozes off*'];
      showBubble(randMsg(sleepMsgs), 3200);
    } else {
      clearInterval(zzzTimer);
      stage.classList.remove('droopy');
      playStretch();
      const msgs = MSGS[currentPalId];
      const wakeMsgs = ['Good morning! ☀️','*yaaawn* hi!','Rise and shine!','Morning! 🌅','*stretches*'];
      showBubble(randMsg(wakeMsgs), 3000);
    }
  }
  // Check every 60s so sleep/wake is responsive
  setInterval(checkSleepState, 60000);

  // Greeting when window regains focus after being away
  let lastBlurTime = 0;
  window.addEventListener('blur', () => { lastBlurTime = Date.now(); });
  window.addEventListener('focus', () => {
    const away = Date.now() - lastBlurTime;
    if (lastBlurTime > 0 && away > 4 * 60 * 1000 && currentPalId && !isSleeping) {
      playHop();
      const msgs = MSGS[currentPalId];
      const greetMsgs = ['You\'re back! 🎉','Missed you!!','Welcome back!','*happy wiggle*','Finally!! 🥺'];
      showBubble(randMsg(greetMsgs), 3200);
    }
    lastBlurTime = 0;
  });

  // Autonomous micro-behaviors — fires every 2–5 min, feels like pet has a life
  const MICRO_BEHAVIORS = [
    // Sneeze
    () => { playSneeze(); spawnCrumb(); const m = ['Achoo! 🤧','*sneeze*','Sniff!','...ACHOO!']; showBubble(randMsg(m), 2000); },
    // Wave unprompted
    () => { playWave(); const m = ['Hi! 👋','Hey there!','*waves*','Hello~']; showBubble(randMsg(m), 2200); },
    // Look around suspiciously
    () => { playLook(); setTimeout(playLook, 700); const m = ['...?','What was that?','I heard something','*looks around*']; showBubble(randMsg(m), 2500); },
    // Yawn + stretch
    () => { playStretch(); const m = ['*yawn*','So sleepy~','Stretching!','*big yawn*']; showBubble(randMsg(m), 2400); },
    // Scratch
    () => { playScratch(); const m = ['*scratch*','Itchy!','hmm...','*scratching*']; showBubble(randMsg(m), 1800); },
    // Just a message (no anim) — makes timing feel natural
    () => { const msgs = MSGS[currentPalId]; if (msgs) showBubble(randMsg(msgs.idle), 2600); },
    // Tilt + curious look
    () => { playTilt(); setTimeout(playLook, 600); },
    // Wiggle burst
    () => { playWiggle(); setTimeout(playWiggle, 450); },
  ];
  let microTimer = null;
  function scheduleMicro() {
    clearTimeout(microTimer);
    microTimer = setTimeout(() => {
      if (currentPalId && !isSleeping) {
        MICRO_BEHAVIORS[Math.floor(Math.random() * MICRO_BEHAVIORS.length)]();
      }
      scheduleMicro();
    }, 120000 + Math.random() * 180000); // 2–5 min
  }

  // Smart idle — every 12-28s; occasionally shows Terse status instead of personality msg
  let idleTimer = null;
  let idleCount = 0;
  let lastStatusCheck = 0;
  async function getStatusReminder() {
    // Max one status reminder per 10 min
    if (Date.now() - lastStatusCheck < 10 * 60 * 1000) return null;
    try {
      const stats = await T.getStats('today');
      const saved = stats?.summary?.tokensSaved || 0;
      const compressions = stats?.summary?.compressions || 0;
      const hour = new Date().getHours();
      lastStatusCheck = Date.now();
      if (saved > 5000)    return `Wow — ${(saved/1000).toFixed(1)}k tokens saved today! 🏆`;
      if (saved > 1000)    return `${saved.toLocaleString()} tokens saved today 💪`;
      if (compressions > 20) return `${compressions} optimizations today! 🚀`;
      if (hour >= 17 && saved > 0) return `Good session! ${saved.toLocaleString()} tokens saved 🎉`;
    } catch {}
    return null;
  }
  function scheduleIdle() {
    clearTimeout(idleTimer);
    const delay = 12000 + Math.random() * 16000;
    idleTimer = setTimeout(async () => {
      if (!currentPalId) { scheduleIdle(); return; }
      const msgs = MSGS[currentPalId];
      const anims = PET_IDLE_ANIMS[currentPalId] || [playTilt, playWiggle, () => {}];
      const animFn = anims[idleCount % anims.length];
      idleCount++;
      if (!isSleeping) {
        if (Math.random() > 0.25) animFn();
        // 20% chance: show a Terse status reminder instead of personality msg
        const reminder = Math.random() < 0.2 ? await getStatusReminder() : null;
        if (reminder) showBubble(reminder, 3500);
        else if (msgs) showBubble(randMsg(msgs.idle), 2800);
      }
      scheduleIdle();
    }, delay);
  }

  async function refreshFromState() {
    try {
      const state = await T.getPetState();
      if (!state || !state.data || !state.data.equippedPet) {
        if (T.hidePetWindow) T.hidePetWindow();
        return;
      }
      if (state.data.settings) {
        settings = Object.assign(settings, state.data.settings);
        applyIdleSetting();
      }
      const petId = state.data.equippedPet;
      const skinId = state.data.equippedSkins?.[petId] || 'default';
      renderPet(petId, skinId);
      scheduleIdle();
    } catch (e) { console.warn('[pet] state load failed:', e); }
  }
  refreshFromState().then(() => {
    checkSleepState();
    scheduleMicro();
  });

  if (window.__TAURI__?.event?.listen) {
    const { listen } = window.__TAURI__.event;
    listen('pet-equipped', () => { refreshFromState(); });
    listen('skin-equipped', () => { refreshFromState(); });
    listen('pet-fed', (event) => {
      const p = event.payload || {};
      const saved = p.saved || 0;
      playEat();
      if (saved > 0 && settings.showBubbles) {
        const msgs = MSGS[currentPalId];
        // For large saves, show the number; small ones just say the food line
        if (saved >= 200) {
          const eatMsg = msgs ? randMsg(msgs.eat) : '🍪';
          showBubble(`${eatMsg} −${saved.toLocaleString()} tokens!`);
        } else if (saved >= 50) {
          showBubble(msgs ? randMsg(msgs.eat) : `+${saved} 🍪`);
        } else {
          // Small saves: half the time just animate, no bubble (feels natural)
          if (Math.random() > 0.5 && msgs) showBubble(randMsg(msgs.eat), 1800);
        }
      }
    });
    listen('pet-milestone', (event) => {
      const p = event.payload || {};
      playHappy();
      const msgs = MSGS[currentPalId];
      const text = msgs ? randMsg(msgs.mile) : (p.text || '🌟');
      showBubble(text, 3800);
    });
    listen('pet-settings-updated', (event) => {
      settings = Object.assign(settings, event.payload || {});
      applyIdleSetting();
    });

    // Poll hook stats directly — don't rely only on events.
    // When compressions increase, trigger eat + a body anim immediately.
    if (T && T.getHookStats) {
      let _hookPending = false;
      let _lastCompressions = null; // null = not yet seeded
      setInterval(() => {
        if (_hookPending) return;
        _hookPending = true;
        T.getHookStats().then(hs => {
          const curr = (hs && hs.compressions) ? hs.compressions : 0;
          if (_lastCompressions === null) { _lastCompressions = curr; return; } // seed, no anim
          if (curr > _lastCompressions) {
            _lastCompressions = curr;
            // Eat animation + per-pet body reaction
            playEat();
            const anims = PET_IDLE_ANIMS[currentPalId];
            if (anims) anims[Math.floor(Math.random() * anims.length)]();
            if (settings.showBubbles && MSGS[currentPalId]) {
              showBubble(randMsg(MSGS[currentPalId].eat), 2200);
            }
          }
        }).catch(() => {}).finally(() => { _hookPending = false; });
      }, 2000);
    }
  }

  // Hide button
  const hideBtn = document.getElementById('hide-btn');
  if (hideBtn && T && T.hidePetWindow) {
    hideBtn.addEventListener('click', () => T.hidePetWindow().catch(() => {}));
  }

  // Programmatic drag — only fires after >3px movement so click still works
  let downX = 0, downY = 0, didDrag = false;
  host.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    downX = e.clientX; downY = e.clientY; didDrag = false;
  });
  host.addEventListener('mousemove', (e) => {
    if (e.buttons !== 1 || didDrag) return;
    if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 3) {
      didDrag = true;
      try {
        const inv = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
        if (inv) inv('plugin:window|start_dragging').catch(() => {});
      } catch {}
    }
  });

  // Scroll = tickle (wheel anywhere on window)
  const TICKLE_MSGS = ['Hehe! 😂','Stop! 😆','*giggle*','Tickles!!','Heehee~','Ha ha!','*laughs*'];
  window.addEventListener('wheel', (e) => {
    e.preventDefault();
    playWiggle();
    spawnTickle();
    showBubble(randMsg(TICKLE_MSGS), 1600);
  }, { passive: false });

  // Right-click = surprise reaction
  const SURPRISE_MSGS = ['!?','Whoa!','*gasp*','Hey!!','You sneak!','Eek!','Surprise!'];
  host.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    playPoke();
    showBubble(randMsg(SURPRISE_MSGS), 1800);
  });

  // Click: single poke (wiggle + message), double-click (spin + celebrate)
  let lastClick = 0;
  host.addEventListener('click', () => {
    if (didDrag) { didDrag = false; return; }
    if (bubble.classList.contains('show')) {
      bubble.classList.remove('show');
      bubble.classList.add('hide');
    }
    const now = Date.now();
    if (now - lastClick < 350) {
      lastClick = 0;
      playSpin();
      spawnSparkles(7);
      const msgs = MSGS[currentPalId];
      showBubble(msgs ? randMsg(msgs.mile) : '✨✨✨', 3200);
    } else {
      lastClick = now;
      setTimeout(() => {
        if (Date.now() - lastClick >= 340) {
          const anims = PET_IDLE_ANIMS[currentPalId] || [playWiggle, playPoke, playTilt];
          anims[Math.floor(Math.random() * anims.length)]();
          const msgs = MSGS[currentPalId];
          if (msgs) showBubble(randMsg(msgs.poke), 2200);
        }
      }, 350);
    }
  });
})();
