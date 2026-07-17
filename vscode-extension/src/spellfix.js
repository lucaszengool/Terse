/**
 * Terse SpellFix — Advanced spell correction engine.
 *
 * 1. Edit-distance (Norvig-style) correction with word frequency ranking
 * 2. QWERTY keyboard proximity weighting (prefer adjacent-key typos)
 * 3. Context-aware real-word error correction using bigram probabilities
 * 4. Word segmentation for merged words ("withes" → "with es"? or "withes")
 *
 * Designed to catch what nspell/Hunspell misses: heavily mangled words,
 * keyboard-adjacent typos, and real-word errors (valid words used in wrong context).
 */

// ── Top ~1500 English words by frequency (compact) ──
// Used for candidate ranking and known-word checks.
// Format: space-separated, ordered by descending frequency.
const FREQ_WORDS_RAW = `the be to of and a in that have i it for not on with he as you do at this but his by from they we say her she or an will my one all would there their what so up out if about who get which go me when make can like time no just him know take people into year your good some could them see other than then now look only come its over think also back after use two how our work first well way even new want because any these give day most us`;

const FREQ_WORDS_2 = `find here thing many well great tell ask seem feel try leave call long been make need through still mean keep let begin since help show every good should right next same start much hand high too place world must small very point where home stand own between never off while turn large great last always give school group country under same problem might tell fact number think long hand part during high still learn change well help lead world city close house does each found life long where place state line should right high last part another write come`;

const FREQ_WORDS_3 = `want start finish write book read work help tell create build want need should could would might done doing going getting making taking having being trying writing reading working building looking thinking getting something everything anything nothing always never often usually sometimes really actually probably certainly perhaps definitely maybe already still here there where what which when while because although however therefore actually important different possible available several together without between before after during within against along until behind toward around despite about above below under between through during following including according`;

// Parse into frequency map (higher index = lower frequency, but all are "known")
const KNOWN_WORDS = new Set();
const WORD_FREQ = new Map();
let _freqRank = 0;
for (const raw of [FREQ_WORDS_RAW, FREQ_WORDS_2, FREQ_WORDS_3]) {
  for (const w of raw.split(/\s+/)) {
    const lw = w.toLowerCase();
    if (lw && !WORD_FREQ.has(lw)) {
      WORD_FREQ.set(lw, 1000 - _freqRank);
      KNOWN_WORDS.add(lw);
      _freqRank++;
    }
  }
}

// Add more common words that should be in the known set
const EXTRA_COMMON = [
  // Pronouns, determiners, prepositions
  'i','me','my','mine','myself','you','your','yours','yourself',
  'he','him','his','himself','she','her','hers','herself',
  'it','its','itself','we','us','our','ours','ourselves',
  'they','them','their','theirs','themselves',
  'this','that','these','those','the','a','an',
  'is','am','are','was','were','be','been','being',
  'have','has','had','having','do','does','did','doing',
  'will','would','shall','should','may','might','can','could','must',
  'to','of','in','for','on','with','at','by','from','into','through',
  'during','before','after','above','below','between','under','again',
  'further','then','once','here','there','when','where','why','how',
  'all','both','each','few','more','most','other','some','such','no',
  'not','only','own','same','so','than','too','very',
  'and','but','or','nor','if','while','as','until','because','although',
  // Very common verbs
  'go','went','gone','get','got','say','said','make','made',
  'know','knew','known','think','thought','take','took','taken',
  'see','saw','seen','come','came','want','give','gave','given',
  'tell','told','ask','asked','use','used','find','found',
  'put','run','set','move','play','pay','hear','heard',
  'let','begin','began','show','showed','keep','kept',
  'start','started','turn','write','wrote','written',
  'read','learn','change','follow','stop','watch',
  'talk','walk','carry','happen','hold','held',
  'bring','brought','sit','sat','stand','stood',
  'lose','lost','open','close','send','sent',
  'fall','fell','leave','left','feel','felt',
  // Common nouns
  'time','year','people','way','day','man','woman','child',
  'world','life','hand','part','place','case','week','company',
  'system','program','question','work','government','number',
  'night','point','home','water','room','mother','area','money',
  'story','fact','month','lot','right','study','book','eye',
  'job','word','business','issue','side','kind','head','house',
  'service','friend','father','power','hour','game','line',
  'end','member','result','level','team','city','state',
  'name','idea','body','information','back','parent','face',
  'thing','student','research','group','country','problem',
  // Common adjectives
  'good','new','first','last','long','great','little','own',
  'old','right','big','high','different','small','large',
  'next','early','young','important','few','public','bad',
  'same','able','best','better','sure','free','real','full',
  // Common adverbs
  'up','out','just','now','then','also','very','often',
  'well','still','already','even','back','much',
  // Common casual / informal words (must be recognized to prevent false corrections)
  'hey','hi','hello','yeah','yep','nope','okay','ok','cool','nice',
  'gonna','wanna','gotta','kinda','sorta','ain\'t',
  'crap','crab','cram','crate','craft','cram','crank','crash',
  'souls','soul','soil','sold','sole','solo','solve',
  'babe','baby','bake','base','bare','bale','bane',
  'whelp','help','heap','heal','hear','heat','hell',
  'dude','mate','bro','fam','buddy','pal','hun','hon',
  'lol','omg','btw','fyi','imo','tbh','idk','nvm','brb',
  // Words commonly mistyped that should be recognized
  'help','please','what','should','would','could','want',
  'need','about','start','finish','next','tell','give',
  'book','write','research','chapter','craft','method',
  'approach','topic','subject','begin','complete','done',
  'first','second','step','plan','outline','draft',
  'quantitative','qualitative','standard','handle',
  // Common English words that MUST NOT be falsely corrected
  'list','lists','listed','listing','takes','taken','taking',
  'numbers','number','numbered','file','files','filed','filing',
  'protocols','protocol','average','averages','error','errors',
  'empty','function','functions','returns','return','returned',
  'add','adds','added','adding','also','than','then','them',
  'handling','handles','handled','handler','type','types','typed',
  'called','calls','calling','class','classes','using','uses','user',
  'string','strings','check','checks','checked','checking',
  'test','tests','tested','testing','code','codes','coded','coding',
  'line','lines','run','runs','running','set','sets','setting',
  'true','false','null','undefined','void','let','const','var',
  'value','values','key','keys','data','index','item','items',
  'name','names','named','naming','text','texts','link','links',
  'page','pages','view','views','show','shows','shown','showing',
  'send','sends','sent','sending','load','loads','loaded','loading',
  'save','saves','saved','saving','edit','edits','edited','editing',
  'move','moves','moved','moving','copy','copies','copied','copying',
  'sort','sorts','sorted','sorting','filter','filters','filtered',
  'count','counts','counted','counting','search','searches','searched',
  'print','prints','printed','printing','read','reads','reading',
  'include','includes','included','including','require','requires',
  'define','defines','defined','defining','pass','passes','passed',
  'raise','raises','raised','throw','throws','thrown','catch','caught',
  'try','tries','tried','trying','break','breaks','broke','broken',
  'wait','waits','waited','waiting','watch','watches','watched',
  'pull','pulls','pulled','pushing','push','pushed','pop','popped',
  'join','joins','joined','joining','split','splits','merge','merged',
  'parse','parses','parsed','parsing','format','formats','formatted',
  'build','builds','built','building','deploy','deploys','deployed',
  'install','installs','installed','config','configure','configured',
  'update','updates','updated','updating','delete','deletes','deleted',
  'create','creates','created','creating','insert','inserts','inserted',
  'select','selects','selected','selecting','query','queries','queried',
  'table','tables','column','columns','row','rows','field','fields',
  'array','arrays','object','objects','map','maps','mapped','mapping',
  'reduce','reduces','reduced','reducing','each','every','some','any',
  'before','after','between','above','below','inside','outside',
  'explain','explains','explained','explaining','describe','describes',
  'compare','compares','compared','comparing','analyze','analyzes',
  'review','reviews','reviewed','reviewing','summarize','summarizes',
  'generate','generates','generated','generating','convert','converts',
  'different','difference','differences','similar','similarity',
  'example','examples','instance','instances','case','cases',
  'simple','complex','basic','advanced','specific','general',
  'local','global','static','dynamic','public','private',
  'input','inputs','output','outputs','result','results',
  'process','processes','processed','processing','task','tasks',
  'event','events','action','actions','state','states',
  'response','responses','request','requests','message','messages',
  'server','servers','client','clients','host','hosts',
  'database','databases','cache','caches','queue','queues',
  'image','images','video','videos','audio','sound',
  'color','colors','size','sizes','width','height','length',
  'option','options','setting','settings','feature','features',
  'issue','issues','bug','bugs','fix','fixes','fixed','fixing',
  'error','warning','info','debug','log','logs','logged','logging',
  'version','versions','release','releases','branch','branches',
  'commit','commits','committed','push','pull','fetch','clone',
  'folder','folders','directory','directories','path','paths',
  'window','windows','screen','screens','button','buttons',
  'click','clicks','clicked','clicking','press','pressed',
  'enter','exit','open','close','closed','opening','closing',
  'enable','disable','enabled','disabled','toggle','toggled',
  'accept','reject','allow','deny','grant','revoke',
  'possible','available','required','optional','valid','invalid',
  'success','failure','complete','incomplete','active','inactive',
  'visible','hidden','shown','display','displayed','render','rendered',
  'connect','connected','disconnect','disconnected','online','offline',
  'upload','download','stream','streaming','sync','synced','syncing',
  'encrypt','decrypt','hash','hashed','token','tokens','sign','signed',
  'authenticate','authorize','login','logout','register','registered',
  'profile','account','user','users','admin','role','roles',
  'email','phone','address','contact','form','forms',
  'title','description','content','body','header','footer',
  'section','article','paragraph','sentence','word','words',
  'character','characters','letter','letters','symbol','symbols',
  'upper','lower','case','match','matches','matched','matching',
  'replace','replaces','replaced','replacing','remove','removed',
  'append','prepend','insert','trim','trimmed','strip','stripped',
  'encode','decode','escape','unescape','wrap','unwrap',
  'point','points','node','nodes','edge','edges','graph','graphs',
  'tree','trees','root','leaf','leaves','parent','child','children',
  'head','tail','body','block','blocks','chunk','chunks',
  'frame','frames','layer','layers','level','levels','depth',
  'bit','bits','byte','bytes','char','chars','int','float','double',
  'bool','boolean','enum','struct','union','tuple','dict','hash',
  'stack','heap','buffer','pointer','reference','scope','closure',
  'loop','loops','iterate','iterator','recursive','recursion',
  'async','await','promise','callback','handler','listener',
  'route','routes','routing','endpoint','endpoints','middleware',
  'component','components','module','modules','package','packages',
  'library','libraries','framework','frameworks','plugin','plugins',
  'api','rest','http','https','url','urls','uri','dns','tcp','udp',
  'get','post','put','patch','delete','head','options',
  'json','xml','html','css','yaml','toml','csv','sql',
  'react','vue','angular','svelte','next','nuxt','express','flask',
  'django','rails','spring','laravel','node','deno','bun',
  'python','javascript','typescript','java','ruby','rust','go','swift',
  'docker','kubernetes','nginx','redis','postgres','mongo','mysql',
  'git','github','gitlab','npm','yarn','pip','cargo','brew',
  'linux','macos','windows','ios','android','web','mobile','desktop',
  'app','apps','site','sites','website','websites','tool','tools',
  'software','hardware','network','internet','cloud','virtual',
  'machine','learning','model','models','train','trained','training',
  'neural','deep','artificial','intelligence','algorithm','algorithms',
  'predict','prediction','classify','classification','cluster',
  'optimize','optimization','loss','accuracy','precision','recall',
  'tensor','vector','matrix','dimension','dimensions','weight','weights',
  'batch','epoch','gradient','descent','backpropagation',
  'attention','transformer','embedding','tokenizer','encoder','decoder',
];
for (const w of EXTRA_COMMON) {
  const lw = w.toLowerCase();
  if (!WORD_FREQ.has(lw)) {
    WORD_FREQ.set(lw, 500);
  }
  KNOWN_WORDS.add(lw);
}

// ── QWERTY Keyboard Layout ──
const QWERTY_ROWS = [
  'qwertyuiop',
  'asdfghjkl',
  'zxcvbnm',
];
const KEY_POS = {};
for (let row = 0; row < QWERTY_ROWS.length; row++) {
  for (let col = 0; col < QWERTY_ROWS[row].length; col++) {
    KEY_POS[QWERTY_ROWS[row][col]] = { row, col: col + row * 0.5 }; // stagger
  }
}

function keyDistance(a, b) {
  const pa = KEY_POS[a.toLowerCase()];
  const pb = KEY_POS[b.toLowerCase()];
  if (!pa || !pb) return 2; // unknown key
  const dr = pa.row - pb.row;
  const dc = pa.col - pb.col;
  return Math.sqrt(dr * dr + dc * dc);
}

function isKeyboardAdjacent(a, b) {
  return keyDistance(a, b) <= 1.5;
}

// ── Norvig-style edit distance candidates ──
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

function edits1(word) {
  const results = new Set();
  const w = word.toLowerCase();
  const n = w.length;

  // Deletes
  for (let i = 0; i < n; i++) {
    results.add(w.slice(0, i) + w.slice(i + 1));
  }
  // Transpositions
  for (let i = 0; i < n - 1; i++) {
    results.add(w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2));
  }
  // Replacements
  for (let i = 0; i < n; i++) {
    for (const c of ALPHABET) {
      if (c !== w[i]) {
        results.add(w.slice(0, i) + c + w.slice(i + 1));
      }
    }
  }
  // Insertions
  for (let i = 0; i <= n; i++) {
    for (const c of ALPHABET) {
      results.add(w.slice(0, i) + c + w.slice(i));
    }
  }
  return results;
}

// edits2 — only generate for short words to keep it fast
function edits2(word) {
  const results = new Set();
  for (const e1 of edits1(word)) {
    // Only generate edits2 for edits1 that are known words or short
    for (const e2 of edits1(e1)) {
      results.add(e2);
    }
  }
  return results;
}

/**
 * Find the best correction for an unknown word.
 * Uses edits1 first, then edits2 for short words.
 * Ranks by: word frequency × keyboard proximity bonus.
 *
 * CONSERVATIVE: only corrects words that are clearly not real English.
 * Skips: acronyms, proper nouns, tech terms, words recognized by external dict.
 */
function correctUnknown(word, externalDict) {
  const lower = word.toLowerCase();
  if (lower.length < 2) return null;
  if (KNOWN_WORDS.has(lower)) return null; // already a known word

  // Skip ALL-CAPS (acronyms: TCP, UDP, HTML, API, etc.)
  if (word.length >= 2 && word === word.toUpperCase() && /^[A-Z]+$/.test(word)) return null;

  // Skip Capitalized words (proper nouns: React, Node, Python, etc.)
  if (word.length >= 2 && word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase()
      && word.slice(1) !== word.slice(1).toUpperCase()) return null;

  // Skip words with digits or special chars (Node.js, v2, etc.)
  if (/[0-9._\-\/]/.test(word)) return null;

  // Check if external dictionary says it's valid
  if (externalDict && externalDict.correct && externalDict.correct(lower)) return null;

  // Generate edit-1 candidates
  const e1 = edits1(lower);
  let candidates = [];

  for (const candidate of e1) {
    if (KNOWN_WORDS.has(candidate)) {
      const freq = WORD_FREQ.get(candidate) || 100;
      // Bonus for keyboard-adjacent substitutions
      let bonus = 0;
      if (candidate.length === lower.length) {
        for (let i = 0; i < candidate.length; i++) {
          if (candidate[i] !== lower[i]) {
            if (isKeyboardAdjacent(candidate[i], lower[i])) bonus = 200;
            break;
          }
        }
      }
      candidates.push({ word: candidate, score: freq + bonus, dist: 1 });
    } else if (externalDict && externalDict.correct && externalDict.correct(candidate)) {
      // External dict recognizes it — lower confidence score
      candidates.push({ word: candidate, score: 50, dist: 1 });
    }
  }

  // If no edit-1 candidates and word is short enough, try edit-2
  if (candidates.length === 0 && lower.length <= 7) {
    for (const e1word of e1) {
      for (const candidate of edits1(e1word)) {
        if (KNOWN_WORDS.has(candidate) && candidate !== lower) {
          const freq = WORD_FREQ.get(candidate) || 100;
          // Only accept edit-2 candidates with high frequency (common words)
          if (freq >= 400) {
            candidates.push({ word: candidate, score: freq, dist: 2 });
          }
        }
      }
    }
    // Fallback to external dict suggestions
    if (candidates.length === 0 && externalDict && externalDict.suggest) {
      const suggestions = externalDict.suggest(lower);
      if (suggestions.length > 0) {
        return suggestions[0];
      }
    }
  }

  if (candidates.length === 0) return null;

  // Sort by score (descending), then by edit distance
  candidates.sort((a, b) => b.score - a.score || a.dist - b.dist);

  // Confidence check: without external dict, require high-score candidates
  // This prevents correcting uncommon-but-valid words to common words
  if (!externalDict && candidates[0].dist >= 2 && candidates[0].score < 500) return null;

  return candidates[0].word;
}

// ── Context-Aware Real-Word Error Correction ──
// These are valid English words that are commonly typed when the user meant something else.
// Each entry: { wrong: "word", right: "correction", context: regex that must match nearby }
const REAL_WORD_FIXES = [
  // "souls" → "should" when near "I", "you", "we", "what"
  { wrong: 'souls', right: 'should', leftCtx: /\b(what|i|you|we|they|it|he|she)\s*$/i, rightCtx: /^\s*(i|you|we|they|he|she|it|be|do|have|not)\b/i },

  // "whelp" → "help" when near "me", "us", "with", "please"
  { wrong: 'whelp', right: 'help', leftCtx: /\b(please|can|could|will|would|to|and|hey|just)\s*$/i, rightCtx: /^\s*(me|us|with|the|this|that|it|a)\b/i },

  // "crap" → "craft" when near "research", "work", "writing", "art"
  { wrong: 'crap', right: 'craft', leftCtx: /./i, rightCtx: /^\s*(research|work|writing|project|art|skill|trade)\b/i },
  { wrong: 'crap', right: 'craft', leftCtx: /\b(the|a|my|your|this|about|on|of)\s*$/i, rightCtx: /^\s*(what|how|where|when|which|and|or|,|\.)/i },

  // "quantize" → "quantitative" when near "research", "analysis", "data", "study"
  { wrong: 'quantize', right: 'quantitative', leftCtx: /./i, rightCtx: /^\s*(research|analysis|data|study|method|approach)\b/i },

  // "dastard" → "standard" (common scramble)
  { wrong: 'dastard', right: 'standard', leftCtx: /./i, rightCtx: /./i },

  // "withes" → "with these" / "with this" in common contexts
  { wrong: 'withes', right: 'with these', leftCtx: /\b(start|begin|go|work|deal|do|help)\s*$/i, rightCtx: /./i },
  { wrong: 'withes', right: 'with this', leftCtx: /./i, rightCtx: /./i },

  // "form" → "from" when context suggests preposition
  { wrong: 'form', right: 'from', leftCtx: /\b(data|come|came|get|got|result|different|away|far|apart)\s*$/i, rightCtx: /^\s*(the|a|an|this|that|my|your|it|here|there)\b/i },

  // "there" → "their" before nouns
  { wrong: 'there', right: 'their', leftCtx: /./i, rightCtx: /^\s*(own|new|old|first|last|best|worst|code|work|app|project|team|company|data|system|product|service|name|home|car|house|money|life|job|plan|idea|goal)\b/i },

  // "then" → "than" after comparatives
  { wrong: 'then', right: 'than', leftCtx: /\b(more|less|better|worse|bigger|smaller|faster|slower|higher|lower|greater|larger|longer|shorter|easier|harder|rather|other)\s*$/i, rightCtx: /./i },

  // "quiet" → "quite"
  { wrong: 'quiet', right: 'quite', leftCtx: /\b(is|it's|was|be|been|not|a)\s*$/i, rightCtx: /^\s*(a|good|bad|big|small|different|simple|hard|easy|useful|important|common|difficult|clear|sure|well|right|long|new|old|the)\b/i },

  // "loose" → "lose" in verb context
  { wrong: 'loose', right: 'lose', leftCtx: /\b(will|would|could|might|may|can|to|don't|didn't|won't|not)\s*$/i, rightCtx: /./i },

  // "effect" → "affect" as verb
  { wrong: 'effect', right: 'affect', leftCtx: /\b(will|would|could|might|may|can|to|not|doesn't|don't|didn't)\s*$/i, rightCtx: /^\s*(the|my|your|our|this|that|how|it|a)\b/i },

  // "bare" → "bear" in "bear in mind"
  { wrong: 'bare', right: 'bear', leftCtx: /./i, rightCtx: /^\s*in\s+mind/i },

  // "principle" → "principal" before nouns
  { wrong: 'principle', right: 'principal', leftCtx: /\b(the|a|our|my|your|this)\s*$/i, rightCtx: /^\s*(reason|cause|concern|issue|goal|objective|component|engineer|developer|investigator|analyst)\b/i },

  // "babe" → likely just a filler/term of address — no correction needed unless context

  // "tow" → "two"
  { wrong: 'tow', right: 'two', leftCtx: /\b(the|these|those|about|around|first|last|top|next|or|and)\s*$/i, rightCtx: /^\s*(things|items|ways|steps|parts|options|types|kinds|more|of|or)\b/i },

  // "no" → "know"
  { wrong: 'no', right: 'know', leftCtx: /\b(i|you|we|they|don't|didn't|doesn't|do|does|did|to|should|would|could|let|let's)\s*$/i, rightCtx: /^\s*(how|what|where|when|why|if|about|the|that|this|it)\b/i },

  // "now" → "know" (less common but happens)
  { wrong: 'now', right: 'know', leftCtx: /\b(i|you|we|they|don't|didn't|to|should|would|let)\s*$/i, rightCtx: /^\s*(how|what|where|when|why|if|about|that)\b/i },

  // "sue" → "use"
  { wrong: 'sue', right: 'use', leftCtx: /\b(to|can|could|should|would|will|i|you|we|they|let's|how\s+to|want\s+to)\s*$/i, rightCtx: /^\s*(the|a|an|this|that|it|them)\b/i },

  // "he" → "the" at start or after period (very common typo)
  { wrong: 'he', right: 'the', leftCtx: /(^|[.!?]\s*)$/i, rightCtx: /^\s*[a-z]/i },
];

/**
 * Apply context-aware real-word fixes.
 * Checks each word against REAL_WORD_FIXES, using surrounding context.
 */
function fixRealWordErrors(text) {
  // Tokenize preserving whitespace
  const tokens = text.split(/(\s+)/);
  let changed = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (/^\s+$/.test(token)) continue; // skip whitespace

    const lower = token.toLowerCase().replace(/[.,!?;:]+$/, '');
    const punct = token.slice(lower.length);

    // Build left/right context strings
    const leftParts = [];
    for (let j = Math.max(0, i - 6); j < i; j++) leftParts.push(tokens[j]);
    const left = leftParts.join('');

    const rightParts = [];
    for (let j = i + 1; j < Math.min(tokens.length, i + 7); j++) rightParts.push(tokens[j]);
    const right = rightParts.join('');

    for (const fix of REAL_WORD_FIXES) {
      if (lower === fix.wrong) {
        const leftMatch = fix.leftCtx.test(left);
        const rightMatch = fix.rightCtx.test(right);
        if (leftMatch && rightMatch) {
          // Preserve original casing
          let replacement = fix.right;
          if (token[0] === token[0].toUpperCase() && token[0] !== token[0].toLowerCase()) {
            replacement = replacement[0].toUpperCase() + replacement.slice(1);
          }
          tokens[i] = replacement + punct;
          changed = true;
          break; // only apply first matching fix
        }
      }
    }
  }

  return changed ? tokens.join('') : text;
}

// ── Semantic deduplication for repeated questions/ideas ──
/**
 * Detect and merge semantically similar clauses.
 * Uses Jaccard similarity on word bags.
 */
function deduplicateClauses(text, threshold = 0.40) {
  // Split by sentence boundaries, question marks, AND commas (for run-on sentences)
  const parts = text.split(/([.!?,;]+\s*)/);
  if (parts.length < 4) return text;

  // Reconstruct clauses
  const sentences = [];
  for (let i = 0; i < parts.length; i += 2) {
    const sent = parts[i] + (parts[i + 1] || '');
    if (sent.trim() && sent.trim().split(/\s+/).length >= 3) sentences.push(sent.trim());
    else if (sent.trim()) sentences.push(sent.trim()); // keep short fragments
  }

  if (sentences.length < 2) return text;

  const wordBags = sentences.map(s => {
    const words = s.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 2);
    return new Set(words);
  });

  const keep = [0]; // always keep first sentence
  for (let i = 1; i < sentences.length; i++) {
    let isDup = false;
    for (const ki of keep) {
      const a = wordBags[ki];
      const b = wordBags[i];
      if (a.size === 0 || b.size === 0) continue;
      const intersection = [...b].filter(w => a.has(w)).length;
      const union = new Set([...a, ...b]).size;
      const jaccard = intersection / union;
      if (jaccard > threshold) {
        isDup = true;
        break;
      }
    }
    if (!isDup) keep.push(i);
  }

  if (keep.length === sentences.length) return text; // nothing removed
  return keep.map(i => sentences[i]).join(' ');
}

// ── Repeated phrase compression ──
/**
 * Find phrases repeated 2+ times and keep only the first occurrence.
 * Targets patterns like "what should I do" appearing multiple times.
 */
function compressRepeatedPhrases(text) {
  // Find repeated 3+ word sequences
  const words = text.split(/\s+/);
  if (words.length < 10) return text;

  // Build trigram/4-gram frequency
  const seen = new Map(); // phrase → [first_index]
  const toRemove = new Set(); // indices to remove

  for (let len = 5; len >= 3; len--) {
    for (let i = 0; i <= words.length - len; i++) {
      if (toRemove.has(i)) continue;
      const phrase = words.slice(i, i + len).join(' ').toLowerCase().replace(/[.,!?]/g, '');
      if (!seen.has(phrase)) {
        seen.set(phrase, i);
      } else {
        // Mark this occurrence for removal
        const first = seen.get(phrase);
        if (i - first >= len) { // don't remove overlapping
          let canRemove = true;
          for (let j = i; j < i + len; j++) {
            if (toRemove.has(j)) { canRemove = false; break; }
          }
          if (canRemove) {
            for (let j = i; j < i + len; j++) toRemove.add(j);
          }
        }
      }
    }
  }

  if (toRemove.size === 0) return text;
  const result = words.filter((_, i) => !toRemove.has(i));
  return result.join(' ');
}

// ── Main API ──

/**
 * Full spell correction pipeline:
 * 1. Fast-path TYPOS dictionary
 * 2. Edit-distance correction for unknown words
 * 3. Context-aware real-word error correction
 * 4. nspell fallback
 */
function spellCorrect(text, typoDict, nspellInstance) {
  // Step 1: Apply hardcoded typo dictionary (fast path)
  // Match words including contractions (don't, can't, etc.) and plain words
  let result = text.replace(/\b[a-zA-Z]+(?:'[a-zA-Z]+)?\b/g, (word) => {
    const lower = word.toLowerCase();
    if (typoDict && typoDict[lower]) {
      const fix = typoDict[lower];
      if (word[0] === word[0].toUpperCase() && word.length > 1) {
        return fix[0].toUpperCase() + fix.slice(1);
      }
      return fix;
    }
    return word;
  });

  // Step 2: Edit-distance correction for remaining unknown words
  // IMPORTANT: Only run edit-distance when nspell is available for validation,
  // otherwise we risk "correcting" valid words not in our compact KNOWN_WORDS set.
  const hasExternalDict = !!(nspellInstance && nspellInstance.correct);

  result = result.replace(/\b[a-zA-Z]+(?:'[a-zA-Z]+)?\b/g, (word) => {
    const lower = word.toLowerCase();
    if (lower.length < 2) return word;
    if (KNOWN_WORDS.has(lower)) return word;
    // Skip contractions (already handled by TYPOS dict)
    if (word.includes("'")) return word;

    // Skip ALL-CAPS (acronyms: TCP, UDP, etc.)
    if (word.length >= 2 && word === word.toUpperCase() && /^[A-Z]+$/.test(word)) return word;
    // Skip Capitalized (proper nouns: React, Python, etc.)
    if (word.length >= 2 && word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase()
        && word.slice(1) !== word.slice(1).toUpperCase()) return word;

    // If nspell says it's valid, skip
    if (hasExternalDict && nspellInstance.correct(lower)) return word;

    // Without nspell, we can't reliably distinguish valid-but-uncommon words from typos.
    // Only run edit-distance when nspell is available to validate candidates.
    if (!hasExternalDict) return word;

    // Try Norvig correction (nspell available for candidate validation)
    const fix = correctUnknown(word, nspellInstance);
    if (fix && fix !== lower) {
      if (word[0] === word[0].toUpperCase() && word.length > 1) {
        return fix[0].toUpperCase() + fix.slice(1);
      }
      return fix;
    }

    // Fallback to nspell suggestions
    if (nspellInstance.suggest) {
      const suggestions = nspellInstance.suggest(lower);
      if (suggestions.length > 0) {
        const best = suggestions[0];
        if (word[0] === word[0].toUpperCase() && word.length > 1) {
          return best[0].toUpperCase() + best.slice(1);
        }
        return best;
      }
    }

    return word;
  });

  // Step 3: Context-aware real-word error correction
  result = fixRealWordErrors(result);

  return result;
}

module.exports = {
  spellCorrect,
  correctUnknown,
  fixRealWordErrors,
  deduplicateClauses,
  compressRepeatedPhrases,
  KNOWN_WORDS,
  WORD_FREQ,
  keyDistance,
  isKeyboardAdjacent,
};
