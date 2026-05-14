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

  // Body-part element caches — populated by renderPet, used by animation primitives
  let _eyeL = [], _eyeR = [], _mouth = [], _arms = [], _earL = [], _earR = [];
  // _bodySvg: the inner <svg>. Body WAAPI animations target this so they stack on top of
  // the CSS idle animation (k-bob/k-breathe/etc.) which lives on the parent #pet-inner.
  let _bodySvg = null;
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

  // ── BIG FOOD LIBRARY (60+ varieties) — flown into the pet's mouth on every tool call ───
  // Grouped only for readability; runtime picks randomly across the flat ALL_FOODS array.
  const FOOD_LIB = {
    bakery:  ['🍞','🥐','🥖','🥨','🥯','🧇','🥞','🍪','🍩','🧁','🎂','🍰','🥮','🥧'],
    sweets:  ['🍭','🍬','🍫','🍮','🍯','🍡','🍧','🍨','🍦','🌰'],
    savory:  ['🍕','🍔','🌭','🥪','🌮','🌯','🥙','🥗','🍝','🍜','🍣','🍱','🍙','🍘','🍚','🍛','🍲','🥘','🍤','🍳','🥚','🧆','🥟','🍢'],
    fruits:  ['🍎','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍐'],
    veggies: ['🥕','🌽','🥒','🥬','🥦','🧄','🧅','🍄','🌶️','🫑','🥔','🍠'],
    drinks:  ['☕','🍵','🥤','🧋','🥛','🧃'],
    nature:  ['🌿','🎋','🌾','🐟','🦴','🐛','🪱','🍯'],
  };
  const ALL_FOODS = Object.values(FOOD_LIB).reduce((a, x) => a.concat(x), []);
  // Track recently-shown foods so each call picks something fresh
  let _recentFoods = [];
  function pickFood() {
    let tries = 0, f;
    do { f = ALL_FOODS[Math.floor(Math.random() * ALL_FOODS.length)]; tries++; }
    while (_recentFoods.includes(f) && tries < 10);
    _recentFoods.push(f);
    if (_recentFoods.length > 12) _recentFoods.shift();
    return f;
  }

  function randMsg(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  // ── Work reactions: keyed by tool category ──────────────────────────────
  // Each entry: { anims: [fn, fn], msgs: [...], emoji }
  // anims: pick one randomly; msgs: 8+ lines so it never feels repetitive
  function mkWork(anims, msgs, emoji) { return { anims, msgs, emoji }; }

  // ── PER-TOOL CHOREOGRAPHIES ──────────────────────────────────────────────
  // Each tool has 4 rich variations with 3–5 staggered body-part steps.
  // Must be defined BEFORE WORK_REACTIONS which references it at init time.
  const CHOREO = {
    // Eyes+ears only — body animations are owned exclusively by spawnWorkOverlay to avoid
    // _currentBodyAnim cancellation races. Delayed bodyAnim calls from CHOREO would fire
    // after the overlay's body anim starts and cancel it, so all playBody* are removed here.
    bash: [
      ()=>{ playEyeNarrow(0); playEarFlatten(200); playEyeScan(900); playEarAlert(1200); playGrin(1600); },
      ()=>{ playEarAlert(0); playEyeNarrow(100); playEyeWide(900); playGrin(1300); },
      ()=>{ playEyeDart(200); playMouthTalk(400); playEyeWide(1000); },
      ()=>{ playEyeNarrow(0); playEarFlatten(100); playEyeScan(800); playEyeShine(1400); playGrin(1800); },
    ],
    read: [
      ()=>{ playEyeScan(0); playEarCurious(200); playEyeNarrow(700); playEyeScan(1100); },
      ()=>{ playEarAlert(0); playEyeScan(200); playEyeDown(700); playEarCurious(1100); },
      ()=>{ playEyeDown(0); playEarFlatten(100); playEyeScan(500); playEyeDart(1000); playEyeWide(1500); },
      ()=>{ playEyeNarrow(0); playEyeScan(500); playEarAlert(900); playEyeShine(1800); },
    ],
    write: [
      ()=>{ playEyeDown(0); playEarCurious(200); playEyeScan(900); playGrin(1500); },
      ()=>{ playEyeLook(0); playEarAlert(200); playEyeScan(1000); playGrin(1600); },
      ()=>{ playEarAlert(0); playEyeDown(200); playEyeWide(1100); },
      ()=>{ playEyeNarrow(0); playEyeDown(300); playEyeScan(900); playEyeShine(1400); playGrin(1900); },
    ],
    edit: [
      ()=>{ playEyeNarrow(0); playEarFlatten(100); playEyeScan(700); playEyeWide(1200); playGrin(1700); },
      ()=>{ playEyeDown(0); playEarCurious(200); playEyeScan(600); playEyeShine(1600); },
      ()=>{ playEarAlert(0); playEyeNarrow(200); playEyeDart(700); playEyeWide(1300); },
      ()=>{ playEyeDown(100); playEyeScan(500); playEarAlert(900); playGrin(1500); },
    ],
    grep: [
      ()=>{ playEyeDart(0); playEarAlert(200); playEyeDart(600); playEyeWide(1100); },
      ()=>{ playEyeNarrow(100); playEyeDart(400); playEarTwitch(700); playEyeDart(1000); playEyeWide(1500); },
      ()=>{ playEarAlert(0); playEyeDart(200); playEyeDart(800); playGrin(1400); },
      ()=>{ playEyeScan(0); playEarFlatten(100); playEyeDart(600); playEarAlert(1100); playEyeWide(1600); },
    ],
    web: [
      ()=>{ playEyeLook(0); playEarAlert(200); playMouthO(700); playEyeWide(1100); playGrin(1600); },
      ()=>{ playEarAlert(0); playEyeLook(200); playChomp(900,2); playEyeWide(1500); },
      ()=>{ playEyeLook(200); playEarCurious(400); playEyeWide(700); playGrin(1200); playEyeShine(1700); },
      ()=>{ playEyeNarrow(0); playEyeLook(300); playMouthO(800); playEyeShine(1400); },
    ],
    agent: [
      ()=>{ playEyeWide(0); playEarAlert(100); playMouthTalk(500); playGrin(1100); playEyeShine(1600); },
      ()=>{ playEyeWide(200); playEarAlert(300); playGrin(700); },
      ()=>{ playEarAlert(0); playEyeWide(200); playGrin(1300); playEyeShine(1700); },
      ()=>{ playGrin(0); playEyeWide(200); playEarAlert(300); playMouthTalk(500); playEyeShine(1500); },
    ],
    todo: [
      ()=>{ playEyeScan(0); playEarCurious(200); playEyeScan(900); },
      ()=>{ playEyeNarrow(0); playEarAlert(200); playEyeScan(700); playGrin(1300); },
      ()=>{ playEyeScan(200); playEarCurious(400); playEyeShine(1400); },
      ()=>{ playEarAlert(0); playEyeScan(200); playEyeScan(1000); },
    ],
    ls: [
      ()=>{ playEyeScan(0); playEarCurious(300); playEyeScan(800); playEarAlert(1200); playEyeWide(1600); },
      ()=>{ playEarAlert(0); playEyeDart(200); playEyeDown(600); },
      ()=>{ playEyeNarrow(0); playEyeScan(400); playEarTwitch(800); playEyeWide(1300); },
      ()=>{ playEyeDown(0); playEyeScan(500); playEarCurious(900); playEyeShine(1400); },
    ],
    notebook: [
      ()=>{ playEyeLook(0); playEarCurious(200); playEyeDown(600); playGrin(1200); },
      ()=>{ playEarAlert(0); playEyeDown(200); playEyeScan(600); playEyeWide(1100); playChomp(1400,2); },
      ()=>{ playEyeDown(200); playEarAlert(500); playEyeDart(900); playEyeWide(1400); playGrin(1800); },
      ()=>{ playEyeLook(200); playEyeDown(500); playGrin(1000); playEyeShine(1500); },
    ],
    mcp: [
      ()=>{ playEarAlert(0); playEarTwitch(200); playEyeLook(400); playEyeWide(900); },
      ()=>{ playEarTwitch(0); playEarAlert(200); playEyeLook(500); playGrin(1200); },
      ()=>{ playEarAlert(200); playEyeNarrow(500); playEyeWide(1000); playEyeShine(1500); },
      ()=>{ playEarFlatten(0); playEarAlert(300); playEyeLook(500); playEyeWide(1100); },
    ],
    plan: [
      ()=>{ playEyeLook(0); playEarFlatten(100); playEyeNarrow(700); playEyeWide(1300); playGrin(1800); },
      ()=>{ playEyeLook(200); playEarFlatten(300); playEyeNarrow(700); playEyeShine(1700); },
      ()=>{ playEyeLook(0); playEarTwitch(300); playEyeScan(700); playGrin(1600); },
      ()=>{ playEarFlatten(0); playEyeNarrow(100); playEyeDart(600); playEyeShine(1600); playGrin(2000); },
    ],
  };

  const WORK_REACTIONS = {
    bash:     mkWork(CHOREO.bash,     ['Running it! 💻','Shell go brrr 🐚','Execute! 🖥️','Command time!','Code is running~','Compiling vibes ⚙️','Terminal activated!','chmod +x 🐾','Making it happen!','Shell magic ✨','npm run go!','Building... 🔨','Bash bash bash!','Script engaged!','One sec... 💨','chmod 777 my heart','./run.sh 🏃'],'💻'),
    read:     mkWork(CHOREO.read,     ['Reading... 📖','Scanning file~','*squints at code*','Hmm, let me see...','File check! 📄','Skimming... 👀','What\'s in here?','Peeking at file 🔍','Found something!','On it, reading!','File goes brrrr 📂','*studies intently*','Eyes on file 👁️','Let me read that~','Inspecting... 🧐'],'📖'),
    write:    mkWork(CHOREO.write,    ['Writing! ✍️','Creating file~','Typing away... ⌨️','New file, who dis?','Manifesting code ✨','Authoring... 📝','Word by word!','File created! 📄','*types furiously*','Writing magic 🪄','Code into existence!','Bringing it to life~','New file unlocked!','Putting it in writing!'],'✍️'),
    edit:     mkWork(CHOREO.edit,     ['Editing! ✂️','Fixing it up~','Patch applied!','Code surgery 🩺','Making it better!','Refactoring vibes ♻️','Snip snip! ✂️','Edit mode: ON','*carefully edits*','Improving code~','Touch up time!','Polishing... ✨','Changed! diff looks good','*applies patch*','Clean edit! 🎯'],'✂️'),
    grep:     mkWork(CHOREO.grep,     ['Searching... 🔍','Found anything?','grep grep grep!','Hunting in code 🕵️','Pattern match!','*sniffs for clues*','On the hunt! 🔎','Scanning for it...','rg --context vibes','*investigates*','Searching the shadows~','CSI: Codebase 🔬','Needle in haystack!','Looking everywhere!','Any matches?'],'🔍'),
    web:      mkWork(CHOREO.web,      ['Browsing web! 🌐','Fetching page~','HTTP request out!','Surfing the net 🏄','Web fetch time!','Loading... 🌐','curl vibes 📡','Pinging internet~','GET request sent!','Web search!','*checks browser*','Online mode! 🛜','Fetching data~','Downloading info 📥','Web crawling! 🕷️'],'🌐'),
    agent:    mkWork(CHOREO.agent,    ['Agent summoned! 🤖','Calling for backup!','Multi-agent mode! 🚀','Spawning helper~','Team effort!','Agent GO! 🤖','More brains! 🧠','Recruiting agent!','Dream team activate!','*calls reinforcement*','Agents assemble! 🦸','Parallel thinking!','Sub-agent spawned!','Bot army deployed 🤖','Let them cook!'],'🤖'),
    todo:     mkWork(CHOREO.todo,     ['Task list time! 📋','Organizing! 🗂️','Making a plan~','Todo updated!','Checklist vibes ✅','*manages tasks*','Planning mode! 🧩','Roadmap updating~','Ticketing away 📌','Got it noted!','Strategic planning!','Task master! 📋','Check! ✅','Scrum meeting energy','Kanban board!'],'📋'),
    ls:       mkWork(CHOREO.ls,       ['Exploring files 🗂️','What\'s in here?','Directory scan!','File system walk~','ls -la vibes','*peeks in folder*','Mapping territory 🗺️','File explorer mode','Looking around~','Indexing...'],'🗂️'),
    notebook: mkWork(CHOREO.notebook, ['Notebook time! 📓','Science! 🔬','Running cells~','Jupyter vibes 📊','Data crunching!','*runs experiment*','Cell executed! ⚗️','Python science!','Plot twist! 📈','Data goes brrr 📉'],'📓'),
    mcp:      mkWork(CHOREO.mcp,      ['MCP tool! 🔌','Plugin activated~','Calling MCP... 🔧','Tool integration!','External power! ⚡','*plugs in tool*','MCP go brrr!','Connected! 🔗','System expansion!','API call out! 📡'],'🔌'),
    plan:     mkWork(CHOREO.plan,     ['Planning... 🧠','Thinking it through','*architect mode*','Designing solution~','Strategy time! ♟️','Big brain moment!','Architecture vibes 🏗️','Thinking deeply...','Map the path!','Blueprint time! 📐'],'🧠'),
  };

  // Map raw tool name → category key
  function classifyTool(toolName) {
    const n = (toolName || '').toLowerCase();
    if (!n) return null;
    if (/bash|shell|run|exec|cmd|terminal|command/.test(n)) return 'bash';
    if (/^read$|readfile|read_file/.test(n)) return 'read';
    if (/^write$|writefile|write_file|create/.test(n)) return 'write';
    if (/^edit$|edit_file|replace|patch|str_replace/.test(n)) return 'edit';
    if (/grep|search|find|glob|ripgrep|rg/.test(n)) return 'grep';
    if (/fetch|web|http|url|browse|curl/.test(n)) return 'web';
    if (/agent|task|spawn|sub.?agent/.test(n)) return 'agent';
    if (/todo|task.?write|task.?read/.test(n)) return 'todo';
    if (/^ls$|list.?dir|readdir|dir/.test(n)) return 'ls';
    if (/notebook|jupyter|ipynb/.test(n)) return 'notebook';
    if (/^mcp|plugin/.test(n)) return 'mcp';
    if (/plan|design|arch/.test(n)) return 'plan';
    return null;
  }

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
    // Wrap SVG in a plain <div> so WAAPI body animations target an HTML element.
    // WKWebView (WebKit) does not reliably animate CSS transforms on SVG elements
    // via element.animate(); HTML divs work fine.
    inner.innerHTML = `
      <div id="pet-body-wrap" style="transform-origin:50% 100%;will-change:transform;line-height:0">
        <svg width="${W}" height="${W}" viewBox="-${PAD} -${PAD} ${W} ${W}" style="display:block;overflow:visible">
          ${TP.kekeSVG(pal, PET_SIZE)}
          ${skinOverlay}
        </svg>
      </div>`;
    // Apply per-pet body motion: breathing / walking / hopping / etc.
    if (pal.anim && settings.idleAnimation) {
      inner.style.animation = `${pal.anim} ${pal.spd}s ease-in-out infinite`;
    }
    host.classList.add('entering');
    setTimeout(() => host.classList.remove('entering'), 600);
    currentPalId = petId;
    // Cache body-part references immediately after SVG is in DOM
    _eyeL  = [...inner.querySelectorAll('.pet-eye-L')];
    _eyeR  = [...inner.querySelectorAll('.pet-eye-R')];
    _mouth = [...inner.querySelectorAll('.pet-mouth')];
    _arms  = []; // .pet-arm elements already have CSS walk-cycle; WAAPI on them compounds transforms → paws fly off
    _earL  = [...inner.querySelectorAll('.ear-L')];
    _earR  = [...inner.querySelectorAll('.ear-R')];
    // Target the wrapper div for WAAPI body anims (not the SVG — WebKit WAAPI + SVG transforms are broken)
    _bodySvg = inner.querySelector('#pet-body-wrap');
    // Demo: eye scan + body bounce on load to show animations are working
    setTimeout(() => { playEyeScan(); playBodyBounce(200); playEarAlert(500); }, 800);
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

  // Whole-body animation (CSS class on stage)
  function playAnim(cls, ms) {
    stage.classList.remove(cls); void stage.offsetWidth;
    stage.classList.add(cls);
    setTimeout(() => stage.classList.remove(cls), ms);
  }

  // ── WAAPI body-part engine ─────────────────────────────────────────────
  // Uses cached element arrays (_eyeL, _eyeR, etc.) populated at render time.
  function wa(els, kf, opts, delay = 0) {
    if (!els || !els.length) return;
    setTimeout(() => els.forEach(el => { try { el.animate(kf, { fill:'none', easing:'ease-in-out', ...opts }); } catch(e){} }), delay);
  }

  // ── EYE PRIMITIVES ──────────────────────────────────────────────────────
  // Scan left → right → center (reading)
  function playEyeScan(d=0) {
    const kf=[{transform:'translateX(0px) scaleX(1)'},{transform:'translateX(-4px) scaleX(0.82)',offset:.25},{transform:'translateX(4px) scaleX(0.82)',offset:.68},{transform:'translateX(0px) scaleX(1)'}];
    wa(_eyeL,kf,{duration:1000},d); wa(_eyeR,kf,{duration:1000},d+120);
  }
  // Look up and squint (thinking / examining above)
  function playEyeLook(d=0) {
    const kf=[{transform:'translateY(0px) scaleY(1)'},{transform:'translateY(-3px) scaleY(0.72)',offset:.4},{transform:'translateY(-3px) scaleY(0.72)',offset:.65},{transform:'translateY(0px) scaleY(1)'}];
    wa(_eyeL,kf,{duration:900},d); wa(_eyeR,kf,{duration:900},d);
  }
  // Eyes go very wide (shock / excitement)
  function playEyeWide(d=0) {
    const kf=[{transform:'scale(1)'},{transform:'scale(1.35)',offset:.35},{transform:'scale(1.35)',offset:.65},{transform:'scale(1)'}];
    wa(_eyeL,kf,{duration:600},d); wa(_eyeR,kf,{duration:600},d);
  }
  // Narrow slits — intense focus / suspicion
  function playEyeNarrow(d=0) {
    const kf=[{transform:'scaleY(1)'},{transform:'scaleY(0.32)',offset:.35},{transform:'scaleY(0.32)',offset:.65},{transform:'scaleY(1)'}];
    wa(_eyeL,kf,{duration:700},d); wa(_eyeR,kf,{duration:700},d);
  }
  // Rapid dart L-R-L-R (frantic search)
  function playEyeDart(d=0) {
    const kf=[{transform:'translateX(0px)'},{transform:'translateX(-4px)',offset:.17},{transform:'translateX(4px)',offset:.37},{transform:'translateX(-3px)',offset:.57},{transform:'translateX(3px)',offset:.77},{transform:'translateX(0px)'}];
    wa(_eyeL,kf,{duration:700},d); wa(_eyeR,kf,{duration:700},d+60);
  }
  // Look downward (examining, studying)
  function playEyeDown(d=0) {
    const kf=[{transform:'translateY(0px)'},{transform:'translateY(3px) scaleY(0.85)',offset:.4},{transform:'translateY(3px) scaleY(0.85)',offset:.65},{transform:'translateY(0px)'}];
    wa(_eyeL,kf,{duration:800},d); wa(_eyeR,kf,{duration:800},d);
  }
  // Sparkle bounce (happy/proud)
  function playEyeShine(d=0) {
    const kf=[{transform:'scale(1)'},{transform:'scale(1.28) translateY(-3px)',offset:.3},{transform:'scale(1)',offset:.6},{transform:'scale(1.20) translateY(-2px)',offset:.8},{transform:'scale(1)'}];
    wa(_eyeL,kf,{duration:700},d); wa(_eyeR,kf,{duration:700},d+100);
  }
  // Wink left eye shut
  function playWink(d=0) {
    const kf=[{transform:'scaleY(1)'},{transform:'scaleY(0.04)',offset:.3},{transform:'scaleY(0.04)',offset:.65},{transform:'scaleY(1)'}];
    wa(_eyeL,kf,{duration:650},d);
  }

  // ── MOUTH PRIMITIVES ────────────────────────────────────────────────────
  // Chomp open-close × N (eating / excited)
  function playChomp(d=0,n=3) {
    const kf=[{transform:'scaleY(1)'},{transform:'scaleY(0.07)',offset:.22},{transform:'scaleY(1.35)',offset:.52},{transform:'scaleY(0.07)',offset:.78},{transform:'scaleY(1)'}];
    wa(_mouth,kf,{duration:380,iterations:n},d);
  }
  // Big wide grin
  function playGrin(d=0) {
    const kf=[{transform:'scaleX(1) scaleY(1)'},{transform:'scaleX(1.5) scaleY(1.3)',offset:.38},{transform:'scaleX(1.5) scaleY(1.3)',offset:.65},{transform:'scaleX(1) scaleY(1)'}];
    wa(_mouth,kf,{duration:650},d);
  }
  // Rapid chatter (excited talking)
  function playMouthTalk(d=0) {
    const kf=[{transform:'scaleY(1)'},{transform:'scaleY(0.15)',offset:.25},{transform:'scaleY(0.85)',offset:.5},{transform:'scaleY(0.15)',offset:.75},{transform:'scaleY(1)'}];
    wa(_mouth,kf,{duration:160,iterations:6},d);
  }
  // Slow yawn (big open, hold, close)
  function playYawn(d=0) {
    const kf=[{transform:'scaleY(1) scaleX(1)'},{transform:'scaleY(1.9) scaleX(1.25)',offset:.4},{transform:'scaleY(1.9) scaleX(1.25)',offset:.7},{transform:'scaleY(1) scaleX(1)'}];
    wa(_mouth,kf,{duration:1100},d);
  }
  // "Ooh" round surprise shape
  function playMouthO(d=0) {
    const kf=[{transform:'scaleY(1) scaleX(1)'},{transform:'scaleY(1.5) scaleX(0.65)',offset:.35},{transform:'scaleY(1.5) scaleX(0.65)',offset:.65},{transform:'scaleY(1) scaleX(1)'}];
    wa(_mouth,kf,{duration:700},d);
  }
  // Pout / frown reaction
  function playPout(d=0) {
    const kf=[{transform:'scaleX(1) translateY(0px)'},{transform:'scaleX(0.7) translateY(4px)',offset:.4},{transform:'scaleX(0.7) translateY(4px)',offset:.65},{transform:'scaleX(1) translateY(0px)'}];
    wa(_mouth,kf,{duration:800},d);
  }

  // ── ARM PRIMITIVES ──────────────────────────────────────────────────────
  // Reach up high (grab / summon)
  function playArmReach(d=0) {
    const kf=[{transform:'rotate(0deg) translate(0px,0px)'},{transform:'rotate(-65deg) translate(-7px,-22px)',offset:.45},{transform:'rotate(-75deg) translate(-9px,-26px)',offset:.68},{transform:'rotate(0deg) translate(0px,0px)'}];
    wa(_arms,kf,{duration:820,easing:'cubic-bezier(.34,1.56,.64,1)'},d);
  }
  // Wave back and forth (greeting)
  function playArmWave(d=0) {
    const kf=[{transform:'rotate(0deg)'},{transform:'rotate(-48deg) translateY(-13px)',offset:.2},{transform:'rotate(22deg) translateY(-7px)',offset:.5},{transform:'rotate(-38deg) translateY(-11px)',offset:.77},{transform:'rotate(0deg)'}];
    wa(_arms,kf,{duration:880,iterations:2},d);
  }
  // Rapid tap / type
  function playArmTap(d=0,n=5) {
    const kf=[{transform:'translateY(0px) rotate(0deg)'},{transform:'translateY(-11px) rotate(-26deg)',offset:.32},{transform:'translateY(-5px) rotate(-13deg)',offset:.62},{transform:'translateY(0px) rotate(0deg)'}];
    wa(_arms,kf,{duration:210,iterations:n},d);
  }
  // Scrub side-to-side (erase / clean)
  function playArmScrub(d=0) {
    const kf=[{transform:'translateX(0px) rotate(0deg)'},{transform:'translateX(-12px) rotate(-20deg)',offset:.15},{transform:'translateX(10px) rotate(16deg)',offset:.4},{transform:'translateX(-9px) rotate(-14deg)',offset:.65},{transform:'translateX(6px) rotate(10deg)',offset:.85},{transform:'translateX(0px) rotate(0deg)'}];
    wa(_arms,kf,{duration:580},d);
  }
  // Arc sweep (writing / drawing)
  function playArmSweep(d=0) {
    const kf=[{transform:'rotate(15deg) translateX(6px)'},{transform:'rotate(-55deg) translate(-10px,-18px)',offset:.45},{transform:'rotate(-20deg) translate(-4px,-8px)',offset:.75},{transform:'rotate(15deg) translateX(6px)'}];
    wa(_arms,kf,{duration:900,easing:'cubic-bezier(.25,.46,.45,.94)'},d);
  }
  // Poke / point forward
  function playArmPoke(d=0) {
    const kf=[{transform:'rotate(0deg) translateX(0px)'},{transform:'rotate(-30deg) translateX(10px)',offset:.35},{transform:'rotate(-30deg) translateX(10px)',offset:.6},{transform:'rotate(0deg) translateX(0px)'}];
    wa(_arms,kf,{duration:700,easing:'cubic-bezier(.34,1.56,.64,1)'},d);
  }
  // Fist pump upward (triumph)
  function playArmPump(d=0) {
    const kf=[{transform:'rotate(0deg) translateY(0px)'},{transform:'rotate(-80deg) translateY(-28px)',offset:.3},{transform:'rotate(-70deg) translateY(-22px)',offset:.55},{transform:'rotate(-80deg) translateY(-28px)',offset:.7},{transform:'rotate(0deg) translateY(0px)'}];
    wa(_arms,kf,{duration:650,easing:'cubic-bezier(.34,1.56,.64,1)'},d);
  }
  // Hug self (pull in)
  function playArmHug(d=0) {
    const kf=[{transform:'rotate(0deg) translateX(0px)'},{transform:'rotate(40deg) translateX(-8px)',offset:.4},{transform:'rotate(40deg) translateX(-8px)',offset:.65},{transform:'rotate(0deg) translateX(0px)'}];
    wa(_arms,kf,{duration:750},d);
  }

  // ── EAR PRIMITIVES ──────────────────────────────────────────────────────
  // Both ears perk alert
  function playEarAlert(d=0) {
    const kf=[{transform:'rotate(0deg) scaleY(1)'},{transform:'rotate(-11deg) scaleY(1.28)',offset:.3},{transform:'rotate(-11deg) scaleY(1.28)',offset:.72},{transform:'rotate(0deg) scaleY(1)'}];
    wa(_earL,kf,{duration:720},d); wa(_earR,kf,{duration:720},d);
  }
  // Ears flatten (stress / concentration)
  function playEarFlatten(d=0) {
    const kf=[{transform:'rotate(0deg) scaleY(1)'},{transform:'rotate(18deg) scaleY(0.6)',offset:.4},{transform:'rotate(18deg) scaleY(0.6)',offset:.65},{transform:'rotate(0deg) scaleY(1)'}];
    wa(_earL,kf,{duration:700},d); wa(_earR,kf,{duration:700},d);
  }
  // Rapid twitch (sensing something)
  function playEarTwitch(d=0) {
    const kf=[{transform:'rotate(0deg)'},{transform:'rotate(-14deg)',offset:.2},{transform:'rotate(8deg)',offset:.45},{transform:'rotate(-10deg)',offset:.7},{transform:'rotate(0deg)'}];
    wa(_earL,kf,{duration:500},d); wa(_earR,kf,{duration:500,easing:'ease-in'},d+100);
  }
  // One ear curious tilt
  function playEarCurious(d=0) {
    const kf=[{transform:'rotate(0deg) scaleY(1)'},{transform:'rotate(-18deg) scaleY(1.2)',offset:.4},{transform:'rotate(-18deg) scaleY(1.2)',offset:.7},{transform:'rotate(0deg) scaleY(1)'}];
    wa(_earL,kf,{duration:900},d);
  }

  // ── BODY PRIMITIVES ──────────────────────────────────────────────────────
  // Body anims target the inner <svg>, NOT #pet-inner. The CSS idle animation
  // (k-bob/k-breathe/etc.) lives on #pet-inner, so the two compose on
  // different elements and don't fight for the same transform. Both visible.
  // We track the currently-playing action animation so a new one cancels the old.
  let _currentBodyAnim = null;
  function bodyAnim(kf, opts, d=0) {
    setTimeout(() => {
      if (!_bodySvg) return;
      try {
        if (_currentBodyAnim) { try { _currentBodyAnim.cancel(); } catch(e){} _currentBodyAnim = null; }
        const a = _bodySvg.animate(kf, {fill:'none', easing:'ease-in-out', ...opts});
        _currentBodyAnim = a;
        const clear = () => { if (_currentBodyAnim === a) _currentBodyAnim = null; };
        a.onfinish = clear; a.oncancel = clear;
      } catch(e) {}
    }, d);
  }
  // Lean forward (attentive)
  function playBodyLean(d=0) {
    bodyAnim([{transform:'translateY(0px) rotate(0deg)'},{transform:'translateY(-6px) rotate(5deg)',offset:.4},{transform:'translateY(-6px) rotate(5deg)',offset:.65},{transform:'translateY(0px) rotate(0deg)'}],{duration:900},d);
  }
  // Nod (approval / agreement)
  function playBodyNod(d=0) {
    bodyAnim([{transform:'translateY(0px)'},{transform:'translateY(-8px)',offset:.25},{transform:'translateY(3px)',offset:.55},{transform:'translateY(-5px)',offset:.75},{transform:'translateY(0px)'}],{duration:700},d);
  }
  // Rapid shiver (excited / loading)
  function playBodyShiver(d=0) {
    bodyAnim([{transform:'translateX(0px)'},{transform:'translateX(-5px) rotate(-2deg)',offset:.14},{transform:'translateX(5px) rotate(2deg)',offset:.29},{transform:'translateX(-4px) rotate(-1deg)',offset:.43},{transform:'translateX(4px) rotate(1deg)',offset:.57},{transform:'translateX(-3px)',offset:.72},{transform:'translateX(3px)',offset:.86},{transform:'translateX(0px)'}],{duration:600},d);
  }
  // Bounce (happy jump in place)
  function playBodyBounce(d=0) {
    bodyAnim([{transform:'translateY(0px) scale(1)'},{transform:'translateY(-14px) scale(1.04)',offset:.35},{transform:'translateY(2px) scale(0.97)',offset:.65},{transform:'translateY(0px) scale(1)'}],{duration:500,easing:'cubic-bezier(.34,1.56,.64,1)'},d);
  }

  // ── ACTION BODY ANIMATIONS (used by spawnWorkOverlay choreography) ────────
  // Targets the inner SVG (same as bodyAnim) so it composes with the idle CSS animation.
  function _actionAnim(kf, dur, totalMs) {
    if (!_bodySvg) return;
    try {
      if (_currentBodyAnim) { try { _currentBodyAnim.cancel(); } catch(e){} _currentBodyAnim = null; }
      const a = _bodySvg.animate(kf, {duration:dur, iterations:Math.ceil(totalMs/dur), fill:'none'});
      _currentBodyAnim = a;
      const clear = () => { if (_currentBodyAnim === a) _currentBodyAnim = null; };
      a.onfinish = clear; a.oncancel = clear;
    } catch(e) {}
  }
  // Typing: gentle lean-rock so it reads as focused work without rapid jitter
  function playBodyTyping(totalMs) {
    _actionAnim([{transform:'translateX(0) translateY(0) rotate(0)'},{transform:'translateX(-1.5px) translateY(-2px) rotate(-0.7deg)',offset:.25},{transform:'translateX(1px) translateY(-0.5px) rotate(0.4deg)',offset:.5},{transform:'translateX(-1px) translateY(-1.5px) rotate(-0.4deg)',offset:.75},{transform:'translateX(0) translateY(0) rotate(0)'}], 340, totalMs);
  }
  // Reading: slow left-right scan rock — clearly visible over idle bob
  function playBodyReading(totalMs) {
    _actionAnim([{transform:'translateX(0) rotate(0)'},{transform:'translateX(8px) rotate(3deg)',offset:.35},{transform:'translateX(8px) rotate(3deg)',offset:.55},{transform:'translateX(-7px) rotate(-2.5deg)',offset:.80},{transform:'translateX(0) rotate(0)'}], 1100, totalMs);
  }
  // Eating lunge: rapid forward dip
  function playBodyEatLunge(totalMs) {
    _actionAnim([{transform:'translateY(0) rotate(0)'},{transform:'translateY(-10px) rotate(-5deg)',offset:.2},{transform:'translateY(6px) rotate(3deg)',offset:.5},{transform:'translateY(-6px) rotate(-3deg)',offset:.75},{transform:'translateY(0) rotate(0)'}], 380, totalMs);
  }
  // Searching dart: left-right excitement
  function playBodySearching(totalMs) {
    _actionAnim([{transform:'translateX(0) rotate(0)'},{transform:'translateX(-9px) rotate(-3deg)',offset:.2},{transform:'translateX(9px) rotate(3deg)',offset:.5},{transform:'translateX(-5px) rotate(-1.5deg)',offset:.75},{transform:'translateX(0) rotate(0)'}], 300, totalMs);
  }

  // ── HIGH-LEVEL PLAY FUNCTIONS (used by click/idle handlers) ─────────────

  function playEat()     { if (!settings.eatAnimation) return; playChomp(0,3); playBodyBounce(200); spawnCrumb(); }
  function playHappy()   { if (!settings.milestoneAnimation) return; playBodyBounce(0); playEyeWide(100); playGrin(300); playBodyBounce(600); spawnSparkles(5); }
  function playWiggle()  { playBodyShiver(0); playEyeScan(200); }
  function playSpin()    { playAnim('spinning', 750); }
  function playPoke()    { playAnim('poking', 550); }
  function playTilt()    { playEyeLook(0); playEarAlert(100); playBodyLean(200); }
  function playStretch() { playBodyLean(0); playEyeLook(150); playEarAlert(300); }
  function playScratch() { playBodyShiver(0); playEyeDart(200); playEarTwitch(500); }
  function playLook()    { playEyeScan(0); playEarCurious(150); playBodyLean(300); }
  function playHop()     { playAnim('hopping', 720); playEyeWide(80); playBodyBounce(100); }
  function playSneeze()  { playAnim('sneezing', 600); playMouthO(80); playEyeWide(200); }
  function playWave()    { playBodyBounce(0); playWink(300); playEyeShine(500); }

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

  // ── Work overlay: full-scene action animations ──────────────────────────
  // Window is 240×260. Pet sits at bottom-center (200×200).
  // Overlays use position:fixed (to stage) so they appear over the pet.
  // Key y positions: top≈10, mouth≈140, paw≈210, ground≈250.
  function spawnWorkOverlay(category) {
    const W = 240, H = 260;
    const cx = W / 2;          // horizontal center = 120
    const pawY = 210;          // paw/ground level
    const mouthY = 130;        // pet mouth area
    const aboveY = 30;         // clear space above pet

    function mk(cls, extraStyle) {
      const el = document.createElement('div');
      el.className = 'work-overlay ' + cls;
      el.style.position = 'fixed';
      if (extraStyle) {
        for (const [k, v] of Object.entries(extraStyle)) {
          if (k.startsWith('--')) el.style.setProperty(k, v);
          else el.style[k] = v;
        }
      }
      stage.appendChild(el);
      return el;
    }
    function cleanup(ms) {
      setTimeout(() => stage.querySelectorAll('.work-overlay').forEach(e => { try { e.remove(); } catch {} }), ms);
    }

    // Helper: random integer in [0, n)
    const variant = (n) => Math.floor(Math.random() * n);
    // Helper: drop a generic emoji prop into the scene
    function prop(emoji, x, y, opts) {
      const o = opts || {};
      const el = mk('wo-prop', {
        left: x + 'px', top: y + 'px',
        '--d': (o.delay || 0) + 'ms',
        '--sz': (o.size || 22) + 'px',
        '--sway': (o.sway != null ? o.sway : 4) + 'px',
      });
      el.textContent = emoji;
      return el;
    }
    function tag(text, x, y, color, delay) {
      const el = mk('wo-tag ' + (color || ''), {
        left: x + 'px', top: y + 'px', '--d': (delay || 0) + 'ms',
      });
      el.textContent = text;
      return el;
    }

    // ── BASH: terminal + keyboard | code editor | shell output cascade ────
    if (category === 'bash') {
      playBodyTyping(2400);
      const v = variant(3);
      if (v === 0) {
        // v1: classic terminal + keyboard at paws
        const cmds = ['$ npm run build','$ cargo check','$ git status','$ pytest -q',
                      '$ node index.js','$ make all','$ ./run.sh','$ python main.py'];
        const cmd = cmds[variant(cmds.length)];
        const term = mk('wo-terminal', { left: (cx - 68) + 'px', top: aboveY + 'px' });
        term.innerHTML = '<div style="opacity:.5;font-size:8px;margin-bottom:3px">● ● ●</div>';
        const line = document.createElement('div');
        term.appendChild(line);
        let i = 0;
        const type = setInterval(() => {
          if (i >= cmd.length) { clearInterval(type); line.innerHTML += '<span class="wo-cursor"></span>'; return; }
          line.textContent += cmd[i++];
        }, 38);
        const kb = mk('wo-keyboard', { left: (cx - 50) + 'px', top: (pawY - 28) + 'px' });
        kb.innerHTML = '<div class="wo-kb-row"><span class="wo-key">Q</span><span class="wo-key">W</span><span class="wo-key">E</span><span class="wo-key">R</span><span class="wo-key">T</span><span class="wo-key">Y</span></div><div class="wo-kb-row"><span class="wo-key a2">A</span><span class="wo-key">S</span><span class="wo-key a3">D</span><span class="wo-key">F</span><span class="wo-key a1">G</span></div><div class="wo-kb-row"><span class="wo-key wo-space">SPACE</span></div>';
      } else if (v === 1) {
        // v2: code editor with cascading output lines + spinner
        const term = mk('wo-terminal', { left: (cx - 70) + 'px', top: aboveY + 'px' });
        term.innerHTML = '<div style="opacity:.5;font-size:8px;margin-bottom:3px">● ● ● — build.log</div>';
        const lines = ['compiling...','✓ deps resolved','✓ linking...','▸ done in 1.2s'];
        lines.forEach((ln, i) => {
          const d = document.createElement('div');
          d.style.cssText = `opacity:0;animation:wo-type .25s ${i*220+250}ms forwards`;
          d.textContent = ln;
          term.appendChild(d);
        });
        prop('⚙️', cx - 12, pawY - 22, { size: 22, delay: 100 });
        prop('💻', cx + 22, pawY - 28, { size: 20, delay: 280 });
      } else {
        // v3: shell prompt cascade with multi-line $ commands
        const term = mk('wo-terminal', { left: (cx - 72) + 'px', top: aboveY + 'px' });
        term.innerHTML = '<div style="opacity:.5;font-size:8px;margin-bottom:3px">zsh — terminal</div>';
        ['$ ls','$ cd src/','$ vim app.js','$ git diff'].forEach((c, i) => {
          const d = document.createElement('div');
          d.style.cssText = `opacity:0;animation:wo-type .2s ${i*180+200}ms forwards`;
          d.textContent = c;
          term.appendChild(d);
        });
        prop('⌨️', cx - 12, pawY - 26, { size: 24, delay: 60 });
      }
      cleanup(2600);
    }

    // ── READ: book + scan beam | scroll/parchment | doc stack + magnifier ─
    else if (category === 'read') {
      playBodyReading(2200);
      const v = variant(3);
      if (v === 0) {
        const book = mk('wo-book', { left: (cx - 75) + 'px', top: (mouthY - 60) + 'px' });
        book.innerHTML = '<div class="wo-book-spine"></div><div class="wo-book-page wo-book-left"><div class="wo-bline"></div><div class="wo-bline"></div><div class="wo-bline"></div><div class="wo-bline"></div><div class="wo-bline short"></div></div><div class="wo-book-page wo-book-right"><div class="wo-bline"></div><div class="wo-bline"></div><div class="wo-bline"></div><div class="wo-bline short"></div></div>';
        mk('wo-scanbeam', { left: (cx - 72) + 'px', top: (mouthY - 40) + 'px', width: '140px' });
      } else if (v === 1) {
        // v2: scroll/parchment + reading glasses
        const pad = mk('wo-notepad', { left: (cx - 52) + 'px', top: (aboveY + 10) + 'px', background:'#fff8e7', borderColor:'#d4b896' });
        pad.innerHTML = '<div class="wo-pad-lines"><div class="wo-pline" style="--w:85%;--d:0ms"></div><div class="wo-pline" style="--w:70%;--d:160ms"></div><div class="wo-pline" style="--w:90%;--d:320ms"></div><div class="wo-pline" style="--w:65%;--d:480ms"></div><div class="wo-pline" style="--w:80%;--d:640ms"></div></div>';
        prop('📜', cx - 50, aboveY + 6, { size: 18, delay: 50 });
        prop('👓', cx + 32, aboveY + 8, { size: 18, delay: 200 });
      } else {
        // v3: doc stack + magnifier sweeping
        prop('📄', cx - 28, aboveY + 30, { size: 26, delay: 0 });
        prop('📄', cx - 18, aboveY + 38, { size: 26, delay: 80 });
        prop('📄', cx - 8,  aboveY + 46, { size: 26, delay: 160 });
        prop('🔍', cx + 14, aboveY + 50, { size: 26, delay: 240 });
        mk('wo-scanbeam', { left: (cx - 40) + 'px', top: (aboveY + 60) + 'px', width: '100px' });
      }
      cleanup(2200);
    }

    // ── WRITE: notepad+pencil | typewriter | fountain pen + inkwell ──────
    else if (category === 'write') {
      playBodyTyping(2000);
      const v = variant(3);
      if (v === 0) {
        const pad = mk('wo-notepad', { left: (cx - 52) + 'px', top: (mouthY - 48) + 'px' });
        pad.innerHTML = '<div class="wo-pad-lines"><div class="wo-pline" style="--w:80%;--d:0ms"></div><div class="wo-pline" style="--w:70%;--d:200ms"></div><div class="wo-pline" style="--w:90%;--d:400ms"></div><div class="wo-pline" style="--w:60%;--d:600ms"></div><div class="wo-pline" style="--w:50%;--d:800ms"></div></div>';
        const pencil = mk('wo-pencil', { left: (cx + 12) + 'px', top: (mouthY - 30) + 'px' });
        pencil.textContent = '✏️';
      } else if (v === 1) {
        // v2: typewriter + paper feed
        prop('⌨️', cx - 18, mouthY - 36, { size: 32, delay: 0, sway: 2 });
        const pad = mk('wo-notepad', { left: (cx - 28) + 'px', top: (aboveY + 6) + 'px' });
        pad.innerHTML = '<div class="wo-pad-lines"><div class="wo-pline" style="--w:85%;--d:200ms"></div><div class="wo-pline" style="--w:65%;--d:500ms"></div><div class="wo-pline" style="--w:90%;--d:800ms"></div></div>';
      } else {
        // v3: fountain pen + inkwell + flowing script
        prop('🖋️', cx + 22, mouthY - 28, { size: 22, delay: 0, sway: 6 });
        prop('🪶', cx + 6, mouthY - 38, { size: 20, delay: 200, sway: 5 });
        const pad = mk('wo-notepad', { left: (cx - 56) + 'px', top: (mouthY - 50) + 'px', background:'#fffff0' });
        pad.innerHTML = '<div class="wo-pad-lines"><div class="wo-pline" style="--w:75%;--d:0ms"></div><div class="wo-pline" style="--w:88%;--d:280ms"></div><div class="wo-pline" style="--w:60%;--d:560ms"></div></div>';
      }
      cleanup(2000);
    }

    // ── EDIT: diff+scissors | red-pen + corrections | tool kit ────────────
    else if (category === 'edit') {
      playBodySearching(600); playBodyLean(700);
      const v = variant(3);
      if (v === 0) {
        const diff = mk('wo-diff', { left: (cx - 58) + 'px', top: (aboveY + 10) + 'px', background: 'rgba(14,14,26,.96)' });
        diff.innerHTML = '<div style="opacity:.45;font-size:7px;margin-bottom:3px">CHANGES</div><div class="wo-diff-del">- old code...</div><div class="wo-diff-add">+ improved! ✓</div><div class="wo-diff-add" style="animation-delay:.3s">+ tests pass ✓</div>';
        const sc = mk('wo-scissors', { left: (cx + 28) + 'px', top: (aboveY + 16) + 'px' });
        sc.textContent = '✂️';
      } else if (v === 1) {
        // v2: red pen marking corrections + notepad
        const pad = mk('wo-notepad', { left: (cx - 50) + 'px', top: (aboveY + 8) + 'px' });
        pad.innerHTML = '<div class="wo-pad-lines"><div class="wo-pline" style="--w:85%;--d:0ms;background:#ff6b6b"></div><div class="wo-pline" style="--w:70%;--d:180ms;background:#51cf66"></div><div class="wo-pline" style="--w:90%;--d:360ms;background:#51cf66"></div></div>';
        prop('🖍️', cx + 28, aboveY + 10, { size: 22, delay: 60, sway: 6 });
        prop('✏️', cx - 56, aboveY + 14, { size: 18, delay: 200, sway: 4 });
      } else {
        // v3: toolbox kit — wrench, hammer, screwdriver
        prop('🔧', cx - 28, aboveY + 20, { size: 26, delay: 0, sway: 3 });
        prop('🔨', cx,      aboveY + 14, { size: 26, delay: 120, sway: 3 });
        prop('🪛', cx + 28, aboveY + 22, { size: 26, delay: 240, sway: 3 });
        tag('+ fixed', cx - 12, aboveY + 56, 'green', 700);
      }
      cleanup(2400);
    }

    // ── GREP: spotlight sweep | magnifier+? marks | radar with blip ──────
    else if (category === 'grep') {
      playBodySearching(1800);
      const v = variant(3);
      if (v === 0) {
        const spot = mk('wo-spotlight', { left: (cx - 80) + 'px', top: (aboveY + 20) + 'px' });
        spot.innerHTML = '🔦';
        ['filename.ts:42','lib/util.js:18','src/main.rs:91'].forEach((txt, i) => {
          const ln = mk('wo-match', {
            left: (cx - 55) + 'px', top: (aboveY + 50 + i * 18) + 'px',
            background: 'rgba(255,220,60,.95)', color: '#553300',
            '--delay': (i * 250) + 'ms', fontSize: '9px', padding: '1px 5px',
          });
          ln.textContent = txt;
        });
        setTimeout(() => {
          const found = mk('wo-match', { left: (cx - 20) + 'px', top: (aboveY + 5) + 'px', background: 'rgba(80,240,120,.95)', color: '#004020', '--delay': '0ms', fontWeight: '800', fontSize: '11px' });
          found.textContent = '✓ found!';
        }, 1400);
      } else if (v === 1) {
        // v2: detective magnifier sweeping over code with ? and ! marks
        const glass = mk('wo-glass', { left: (cx - 30) + 'px', top: (aboveY + 30) + 'px' });
        glass.textContent = '🔎';
        tag('grep -r', cx - 56, aboveY + 8, 'yellow', 100);
        tag('?', cx - 30, aboveY + 4, 'yellow', 300);
        tag('?', cx + 10, aboveY + 12, 'yellow', 500);
        tag('!', cx + 32, aboveY + 6, 'green', 900);
        setTimeout(() => tag('match!', cx - 6, aboveY + 60, 'green', 0), 1200);
      } else {
        // v3: radar sweep with blip
        for (let i = 0; i < 3; i++) {
          mk('wo-ring', { left: (cx - 22) + 'px', top: (aboveY + 30) + 'px', '--sz': '44px', '--d': (i * 350) + 'ms', borderColor:'rgba(255,200,60,.85)' });
        }
        prop('📡', cx - 12, aboveY + 36, { size: 26, delay: 0, sway: 2 });
        setTimeout(() => tag('● blip!', cx + 10, aboveY + 28, 'yellow', 0), 1000);
      }
      cleanup(2200);
    }

    // ── WEB: browser | globe + signal rings | satellite + ✉️ packets ──────
    else if (category === 'web') {
      playBodyBounce(400);
      const v = variant(3);
      if (v === 0) {
        const browser = mk('wo-browser', { left: (cx - 70) + 'px', top: (aboveY + 5) + 'px' });
        browser.innerHTML = '<div class="wo-browser-bar"><span class="wo-browser-dot d1"></span><span class="wo-browser-dot d2"></span><span class="wo-browser-dot d3"></span><span class="wo-browser-url">fetching...</span></div><div class="wo-browser-body"><div class="wo-loadbar"></div><div class="wo-browser-content">🌐<br><span class="wo-bline2"></span><span class="wo-bline2 short2"></span></div></div>';
      } else if (v === 1) {
        // v2: spinning globe + concentric signal rings
        prop('🌐', cx - 14, aboveY + 24, { size: 32, delay: 0, sway: 2 });
        for (let i = 0; i < 3; i++) {
          mk('wo-ring', { left: (cx - 22) + 'px', top: (aboveY + 28) + 'px', '--sz': '44px', '--d': (i * 280) + 'ms' });
        }
        tag('GET /api', cx + 28, aboveY + 8, 'blue', 400);
      } else {
        // v3: satellite + flying envelopes (packets)
        prop('🛰️', cx - 20, aboveY + 8, { size: 24, delay: 0, sway: 6 });
        prop('📡', cx + 30, aboveY + 16, { size: 22, delay: 120, sway: 4 });
        ['📨','📨','📩'].forEach((e, i) => prop(e, cx - 30 + i * 24, aboveY + 50, { size: 18, delay: 250 + i * 180, sway: 8 }));
        tag('200 OK', cx - 10, aboveY + 76, 'green', 1100);
      }
      cleanup(2300);
    }

    // ── AGENT: robot squad | brain + neurons | gears spinning ─────────────
    else if (category === 'agent') {
      playBodyBounce(0); playBodyBounce(550);
      const v = variant(3);
      if (v === 0) {
        [
          { x: cx - 38, y: mouthY, tx: '-40px', ty: '-90px', delay: 0 },
          { x: cx,      y: mouthY, tx: '0px',   ty: '-110px', delay: 100 },
          { x: cx + 38, y: mouthY, tx: '40px',  ty: '-90px',  delay: 200 },
        ].forEach(b => {
          const bot = mk('wo-agentbot', { left: b.x + 'px', top: b.y + 'px', '--tx': b.tx, '--ty': b.ty, '--delay': b.delay + 'ms' });
          bot.innerHTML = '🤖';
        });
        const spark = mk('wo-bolt', { left: (cx - 10) + 'px', top: (aboveY + 30) + 'px' });
        spark.textContent = '⚡';
      } else if (v === 1) {
        // v2: brain + neural pulse rings
        prop('🧠', cx - 14, aboveY + 26, { size: 30, delay: 0, sway: 2 });
        for (let i = 0; i < 4; i++) {
          mk('wo-ring', { left: (cx - 24) + 'px', top: (aboveY + 30) + 'px', '--sz': '48px', '--d': (i * 220) + 'ms', borderColor:'rgba(180,100,255,.85)' });
        }
        prop('✨', cx + 28, aboveY + 10, { size: 18, delay: 200, sway: 5 });
        prop('✨', cx - 34, aboveY + 50, { size: 16, delay: 400, sway: 5 });
      } else {
        // v3: gear cluster + spark
        prop('⚙️', cx - 22, aboveY + 24, { size: 28, delay: 0, sway: 3 });
        prop('⚙️', cx + 4,  aboveY + 16, { size: 22, delay: 120, sway: 3 });
        prop('⚙️', cx + 26, aboveY + 32, { size: 26, delay: 240, sway: 3 });
        const spark = mk('wo-bolt', { left: cx + 'px', top: (aboveY + 50) + 'px' });
        spark.textContent = '⚡';
        tag('agent.run', cx - 22, aboveY + 64, 'purple', 700);
      }
      cleanup(2000);
    }

    // ── TODO: checklist | sticky-note wall | calendar marks ───────────────
    else if (category === 'todo') {
      playBodyNod(0); playBodyNod(750); playBodyNod(1500);
      const v = variant(3);
      if (v === 0) {
        const list = mk('wo-checklist', { left: (cx - 52) + 'px', top: (aboveY + 15) + 'px' });
        list.innerHTML = ['✓ Plan','✓ Build','✓ Ship','→ Deploy'].map((t, i) =>
          `<div class="wo-checkrow" style="--delay:${i*220}ms"><span class="wo-check-icon">${t[0]}</span>${t.slice(2)}</div>`
        ).join('');
      } else if (v === 1) {
        // v2: sticky note wall — colorful 2x2 grid
        const tasks = [
          { t: 'Plan',   c: 'yellow' },
          { t: 'Build',  c: 'green'  },
          { t: 'Test',   c: 'blue'   },
          { t: 'Ship',   c: 'pink'   },
        ];
        tasks.forEach((task, i) => {
          const col = i % 2, row = Math.floor(i / 2);
          tag(task.t, cx - 44 + col * 50, aboveY + 14 + row * 26, task.c, i * 220);
        });
        prop('📌', cx - 50, aboveY + 8, { size: 16, delay: 0 });
      } else {
        // v3: kanban — three columns with cards sliding in
        ['To Do','Doing','Done'].forEach((col, ci) => {
          tag(col, cx - 60 + ci * 42, aboveY + 8, ci===2?'green':ci===1?'yellow':'blue', ci * 80);
          for (let r = 0; r < 2; r++) {
            const ttext = ci===2?'✓':ci===1?'…':'·';
            tag(ttext, cx - 60 + ci * 42, aboveY + 30 + r * 16, ci===2?'green':null, ci * 80 + 220 + r * 150);
          }
        });
      }
      cleanup(2500);
    }

    // ── MCP: chip board | USB + cables | server rack with status ──────────
    else if (category === 'mcp') {
      playBodyLean(300); playBodyNod(1300);
      const v = variant(3);
      if (v === 0) {
        const chip = mk('wo-chipboard', { left: (cx - 42) + 'px', top: (aboveY + 20) + 'px' });
        chip.innerHTML = '<div class="wo-chip-icon">🔌</div><div class="wo-chip-lines"><div class="wo-chip-line"></div><div class="wo-chip-line" style="--d:120ms"></div><div class="wo-chip-line" style="--d:240ms"></div></div>';
        for (let i = 0; i < 3; i++) {
          const sz = 16 + i * 14;
          mk('wo-pulse', { left: (cx - sz/2) + 'px', top: (aboveY + 55 - sz/2) + 'px', '--sz': sz + 'px', '--delay': (i * 220) + 'ms' });
        }
      } else if (v === 1) {
        // v2: USB plug connecting to socket + signal waves
        prop('🔌', cx - 38, aboveY + 30, { size: 28, delay: 0, sway: 3 });
        prop('🔗', cx,      aboveY + 30, { size: 22, delay: 200, sway: 2 });
        prop('🖲️', cx + 32, aboveY + 30, { size: 26, delay: 400, sway: 2 });
        for (let i = 0; i < 3; i++) {
          mk('wo-ring', { left: (cx - 16) + 'px', top: (aboveY + 36) + 'px', '--sz': '32px', '--d': (i * 280) + 'ms', borderColor:'rgba(140,200,255,.85)' });
        }
      } else {
        // v3: server rack — three blinking lights + a router/cable
        prop('🖥️', cx - 14, aboveY + 20, { size: 30, delay: 0, sway: 2 });
        tag('● connected', cx - 30, aboveY + 56, 'green', 200);
        tag('▸ mcp.tool',  cx - 22, aboveY + 76, 'purple', 500);
        prop('🛜', cx + 28, aboveY + 12, { size: 18, delay: 100, sway: 5 });
      }
      cleanup(2000);
    }

    // ── NOTEBOOK: lab chart | microscope + droplets | bubbling beaker ─────
    else if (category === 'notebook') {
      playBodyReading(1800);
      const v = variant(3);
      if (v === 0) {
        const lab = mk('wo-lab', { left: (cx - 55) + 'px', top: (aboveY + 10) + 'px' });
        lab.innerHTML = '<div class="wo-lab-title">⚗️ Running...</div><div class="wo-lab-chart">' +
          ['#ff6b6b','#ffd43b','#74c0fc','#51cf66','#cc5de8'].map((c, i) => {
            const h = 10 + Math.round(Math.random() * 22);
            return `<div class="wo-bar" style="height:${h}px;background:${c};--d:${i*100}ms"></div>`;
          }).join('') + '</div>';
      } else if (v === 1) {
        // v2: microscope + sample droplets
        prop('🔬', cx - 14, aboveY + 18, { size: 32, delay: 0, sway: 2 });
        prop('🧪', cx + 26, aboveY + 16, { size: 22, delay: 180, sway: 5 });
        prop('🧫', cx - 50, aboveY + 50, { size: 20, delay: 280, sway: 4 });
        tag('▸ data.csv', cx - 24, aboveY + 76, 'blue', 600);
      } else {
        // v3: bubbling beaker + atom
        prop('⚗️', cx - 18, aboveY + 24, { size: 30, delay: 0, sway: 2 });
        // Bubbles rising out of beaker
        for (let i = 0; i < 5; i++) {
          mk('wo-bubble', {
            left: (cx - 6 + Math.random() * 14) + 'px',
            top: (aboveY + 20) + 'px',
            '--sz': (4 + Math.random() * 5) + 'px',
            '--d': (i * 220) + 'ms',
          });
        }
        prop('⚛️', cx + 30, aboveY + 14, { size: 22, delay: 240, sway: 6 });
      }
      cleanup(2200);
    }

    // ── LS: folder explodes | file tree | file cabinet drawer ─────────────
    else if (category === 'ls') {
      playBodyLean(300);
      const v = variant(3);
      if (v === 0) {
        const folder = mk('wo-folderbig', { left: (cx - 22) + 'px', top: (aboveY + 30) + 'px' });
        folder.textContent = '📂';
        ['📄','📁','📄','🖼️','📄'].forEach((f, i) => {
          const angle = -60 + i * 30;
          const rad = (angle * Math.PI) / 180;
          const tx = Math.round(Math.cos(rad) * 38);
          const ty = Math.round(Math.sin(rad) * 28) - 30;
          const c = mk('wo-filescatter', { left: (cx - 10) + 'px', top: (aboveY + 50) + 'px', '--tx': tx + 'px', '--ty': ty + 'px', '--delay': (i * 80) + 'ms' });
          c.textContent = f;
        });
      } else if (v === 1) {
        // v2: file tree expanding
        const items = [
          { e: '📁', label: 'src/',       indent: 0 },
          { e: '📄', label: 'main.rs',    indent: 1 },
          { e: '📄', label: 'lib.rs',     indent: 1 },
          { e: '📁', label: 'tests/',     indent: 0 },
          { e: '📄', label: 'config.toml',indent: 0 },
        ];
        items.forEach((it, i) => {
          tag(it.e + ' ' + it.label, cx - 50 + it.indent * 10, aboveY + 10 + i * 16, null, i * 140);
        });
      } else {
        // v3: file cabinet drawer + multiple file types
        prop('🗄️', cx - 16, aboveY + 30, { size: 30, delay: 0, sway: 2 });
        const types = ['📄','🖼️','🎵','📊','📋'];
        types.forEach((e, i) => {
          prop(e, cx - 56 + i * 24, aboveY + 70, { size: 18, delay: 200 + i * 100, sway: 3 });
        });
      }
      cleanup(1900);
    }

    // ── PLAN: thought bubble | chess thinking | flowchart nodes ───────────
    else if (category === 'plan') {
      playBodyLean(0);
      const v = variant(3);
      if (v === 0) {
        const bubble = mk('wo-thoughtbubble', { left: (cx - 42) + 'px', top: (aboveY + 5) + 'px' });
        bubble.innerHTML = '<div class="wo-thought-dots"><span class="wo-td">·</span><span class="wo-td">·</span><span class="wo-td">·</span></div><div class="wo-thought-ideas"><span class="wo-idea" style="--d:500ms">💡</span><span class="wo-idea" style="--d:900ms">📐</span><span class="wo-idea" style="--d:1300ms">✅</span></div>';
      } else if (v === 1) {
        // v2: chess pieces — strategic thinking
        prop('♟️', cx - 40, aboveY + 20, { size: 28, delay: 0, sway: 2 });
        prop('♞', cx - 12, aboveY + 14, { size: 28, delay: 180, sway: 2 });
        prop('♛', cx + 16, aboveY + 20, { size: 28, delay: 360, sway: 2 });
        prop('♚', cx + 40, aboveY + 14, { size: 28, delay: 540, sway: 2 });
        tag('checkmate?', cx - 22, aboveY + 56, 'purple', 800);
      } else {
        // v3: flowchart nodes connected by lines
        tag('start', cx - 50, aboveY + 14, 'blue',   0);
        tag('plan',  cx - 6,  aboveY + 14, 'yellow', 280);
        tag('exec',  cx + 38, aboveY + 14, 'green',  560);
        tag('done',  cx - 8,  aboveY + 50, 'green',  900);
        // Connecting lines
        mk('wo-line', { left: (cx - 28) + 'px', top: (aboveY + 22) + 'px', width: '24px', '--d': '120ms' }).style.setProperty('--w', '24px');
        const ln1 = mk('wo-line', { left: (cx - 28) + 'px', top: (aboveY + 22) + 'px', '--d': '120ms' }); ln1.style.width = '24px';
        const ln2 = mk('wo-line', { left: (cx + 12) + 'px', top: (aboveY + 22) + 'px', '--d': '400ms' }); ln2.style.width = '26px';
        const ln3 = mk('wo-line', { left: (cx + 4) + 'px',  top: (aboveY + 36) + 'px', '--d': '700ms', transform:'rotate(70deg)' }); ln3.style.width = '20px';
        prop('💡', cx + 12, aboveY + 70, { size: 22, delay: 1100, sway: 4 });
      }
      cleanup(2500);
    }

    // ── TOKEN SAVE: big feast — 8 random foods arc into mouth ─────────────
    else if (category === '_tokens') {
      playBodyEatLunge(1800); playChomp(0, 5);
      // Use the broader spawnFoodIntoMouth in two waves for a real feast effect
      spawnFoodIntoMouth(4);
      setTimeout(() => spawnFoodIntoMouth(4), 380);
      // Add a few ⭐💰 confetti coins flying down too
      ['⭐','💰','💎','⭐'].forEach((f, i) => {
        const startX = 20 + Math.random() * 200;
        const startY = 10 + Math.random() * 30;
        const food = mk('wo-foodfall', {
          left: startX + 'px', top: startY + 'px',
          '--tx': (cx - startX - 10) + 'px',
          '--ty': (mouthY - startY - 10) + 'px',
          '--delay': (i * 200) + 'ms',
          '--dur': (0.7 + Math.random() * 0.3) + 's',
        });
        food.textContent = f;
      });
      cleanup(2500);
    }
  }

  function spawnCrumb() {
    const food = pickFood();
    const el = document.createElement('div');
    el.className = 'crumb';
    el.textContent = food;
    const rect = host.getBoundingClientRect();
    el.style.left = (rect.left + rect.width/2 - 10 + (Math.random()*30-15)) + 'px';
    el.style.top  = (rect.top + 4) + 'px';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 600);
  }

  // ── FOOD INTO MOUTH ─────────────────────────────────────────────────────
  // Fires on every work event. Spawns N foods that arc gracefully from random
  // top positions down into the pet's mouth, with rotation, scale wobble, and
  // a tiny "chomp" reaction as each one lands. Targets the stage (240x260
  // pet window) so positions match the work overlays.
  function spawnFoodIntoMouth(count) {
    if (!settings.eatAnimation) return;
    const W = 240, mouthX = W / 2, mouthY = 138;
    const n = Math.max(1, Math.min(4, count || 1));
    for (let i = 0; i < n; i++) {
      const food = pickFood();
      // Random start point along top half of window
      const side = Math.random() < 0.5 ? -1 : 1;
      const startX = mouthX + side * (50 + Math.random() * 70);
      const startY = 8 + Math.random() * 38;
      const el = document.createElement('div');
      el.className = 'work-overlay food-arc';
      el.textContent = food;
      el.style.position = 'fixed';
      el.style.left = startX + 'px';
      el.style.top  = startY + 'px';
      // Translate vector into mouth (account for emoji size ~18px center)
      const tx = (mouthX - startX - 9);
      const ty = (mouthY - startY - 9);
      // Mid-arc apex: pull upward for arc effect, side-correct
      const midTx = tx * 0.35 + side * 18;
      const midTy = ty * 0.35 - 14 - Math.random() * 8;
      el.style.setProperty('--mtx', midTx + 'px');
      el.style.setProperty('--mty', midTy + 'px');
      el.style.setProperty('--tx', tx + 'px');
      el.style.setProperty('--ty', ty + 'px');
      el.style.setProperty('--rot', (Math.random() * 540 - 270).toFixed(0) + 'deg');
      el.style.setProperty('--dur', (0.85 + Math.random() * 0.25).toFixed(2) + 's');
      el.style.setProperty('--delay', (i * 110) + 'ms');
      stage.appendChild(el);
      // Tiny chomp at landing time
      setTimeout(() => { playChomp(0, 1); }, (i * 110) + 850);
      setTimeout(() => { try { el.remove(); } catch {} }, (i * 110) + 1200);
    }
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
      const toolName = p.toolName || '';
      const msgs = MSGS[currentPalId];
      // Wake the pet if it's sleeping — Claude is working, pet should react
      if (isSleeping) {
        isSleeping = false;
        clearInterval(zzzTimer);
        stage.classList.remove('sleeping', 'droopy');
      }
      // Classify the tool and pick a reaction
      const category = classifyTool(toolName);
      const reaction = category ? WORK_REACTIONS[category] : null;

      // Always show food flying into the mouth — this is the "eating tokens" feedback.
      // Count scales with savings so big saves visibly = bigger feast.
      const foodCount = saved >= 500 ? 4 : saved >= 150 ? 3 : saved >= 40 ? 2 : 1;
      spawnFoodIntoMouth(foodCount);

      if (reaction && Math.random() > 0.15) {
        // Tool-specific body animation
        const animFn = reaction.anims[Math.floor(Math.random() * reaction.anims.length)];
        animFn();
        // Visual overlay showing exactly what's happening
        spawnWorkOverlay(category);
        if (settings.showBubbles) {
          if (msgs && Math.random() < 0.40) {
            showBubble(reaction.emoji + ' ' + randMsg(msgs.eat), 2200);
          } else {
            showBubble(randMsg(reaction.msgs), 2200);
          }
        }
      } else {
        // Generic eat reaction (token savings or unknown tool)
        playEat();
        if (saved >= 100) spawnWorkOverlay('_tokens');
        if (settings.showBubbles) {
          if (saved >= 200) {
            const eatMsg = msgs ? randMsg(msgs.eat) : '🍪';
            showBubble(`${eatMsg} −${saved.toLocaleString()} tokens!`);
          } else if (saved >= 50) {
            showBubble(msgs ? randMsg(msgs.eat) : `+${saved} 🍪`);
          } else if (Math.random() > 0.4 && msgs) {
            showBubble(randMsg(msgs.eat), 1800);
          }
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
