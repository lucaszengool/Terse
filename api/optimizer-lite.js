/**
 * Terse Optimizer Lite
 * Self-contained port of the Tauri app optimizer for the API server.
 * Implements the same three modes (soft/normal/aggressive) using the same
 * regex/dictionary techniques — no heavy NLP deps required.
 *
 * Technique parity with src/optimizer.js:
 *  soft       → light  : typos, whitespace, phrase shortening, filler, contractions
 *  normal     → balanced: + politeness removal, question→imperative, hedging, meta-lang,
 *                          redundancy, dedup, list/code compression, numeralize
 *  aggressive → aggressive: + abbreviations, markdown strip, article removal,
 *                            telegraph compression, entropy drop
 */

'use strict';

// ─────────────────────────────────────────────────────────────
//  TYPOS dictionary (subset of the full optimizer map)
// ─────────────────────────────────────────────────────────────
const TYPOS = {
  'teh':'the','hte':'the','tge':'the','yhe':'the','rhe':'the',
  'fo':'of','ot':'to','si':'is','ti':'it','ni':'in','os':'so',
  'adn':'and','nad':'and','anf':'and','anbd':'and','abd':'and',
  'nto':'not','ont':'not',
  'cna':'can','cane':'can','acn\'t':'can\'t',
  'jsut':'just','juts':'just','jst':'just',
  'liek':'like','lkie':'like','likee':'like',
  'knwo':'know','konw':'know','nkow':'know','kow':'know',
  'amke':'make','mkae':'make','maek':'make',
  'tkae':'take','teka':'take',
  'godo':'good','goood':'good',
  'nwe':'new','enw':'new',
  'owrk':'work','wokr':'work','wrk':'work',
  'tiem':'time','tmie':'time','itme':'time',
  'yuo':'you','yoru':'your','yuor':'your','yur':'your',
  'sued':'used','uesd':'used',
  'alos':'also','aslo':'also',
  'evne':'even','eevn':'even',
  'onyl':'only','olny':'only',
  'veyr':'very','vrey':'very',
  'somthing':'something','soemthing':'something','somethign':'something',
  'eveything':'everything','evreything':'everything','everythign':'everything',
  'abuot':'about','abotu':'about','baout':'about',
  'agian':'again','agin':'again',
  'alraedy':'already','alredy':'already','alreayd':'already',
  'alwyas':'always','alwasy':'always',
  'befoer':'before','befroe':'before',
  'beign':'being','bieng':'being',
  'bewteen':'between','betwen':'between',
  'chnage':'change','chnge':'change','cahnge':'change',
  'diffreent':'different','differnt':'different','diffrent':'different',
  'doestn':'doesn\'t','dosen\'t':'doesn\'t','dosent':'doesn\'t',
  'enoguh':'enough','enogh':'enough',
  'exapmle':'example','exmaple':'example','examle':'example',
  'firts':'first','fisrt':'first','frist':'first',
  'gerat':'great','graet':'great',
  'otehr':'other','ohter':'other','toher':'other',
  'poeple':'people','peopel':'people','peolpe':'people',
  'probelm':'problem','problme':'problem','porblem':'problem',
  'realy':'really','relaly':'really','relly':'really',
  'rigth':'right','rihgt':'right',
  'smae':'same','saem':'same',
  'strat':'start','satrt':'start',
  'sttil':'still','sitll':'still',
  'thnk':'think','thnik':'think',
  'thorugh':'through','throught':'through','trhough':'through',
  'todya':'today','toaday':'today',
  'udnerstand':'understand','undersatnd':'understand','understnad':'understand',
  'wrok':'work',
  'worls':'world','wrold':'world','wolrd':'world',
  'acutally':'actually','actualy':'actually','actaully':'actually',
  'recieve':'receive','recieves':'receives',
  'seperate':'separate','seperately':'separately',
  'occured':'occurred','occurence':'occurrence',
  'toeks':'tokens','tokesn':'tokens','toeknss':'tokens','toekns':'tokens',
  'agnet':'agent','agetn':'agent',
  'clayde':'claude','cluade':'claude',
  'monitro':'monitor','moniotr':'monitor',
  'optmization':'optimization','optimziation':'optimization',
  'fucntion':'function','funtion':'function','funciton':'function',
  'impelment':'implement','implment':'implement',
  'applicaiton':'application','applcation':'application',
  'databse':'database','datbase':'database',
  'sevrer':'server','sever':'server',
  'clinet':'client','cleint':'client',
  'proejct':'project','porject':'project','projcet':'project',
  'reuqest':'request','requst':'request','rquest':'request',
  'repsone':'response','repsonse':'response',
  'featrue':'feature','feautre':'feature',
  'isssue':'issue','isseu':'issue',
  'methdo':'method','metohd':'method',
  'varialbe':'variable','varibale':'variable',
  'paramter':'parameter','parmaeter':'parameter',
  'arguemnt':'argument','arugment':'argument',
  'reutrn':'return','retrun':'return',
  'improt':'import','imoprt':'import',
  'exoprt':'export','exprot':'export',
  'conifg':'config','confgi':'config','ocnfig':'config',
  'compoennt':'component','comopnent':'component','componet':'component',
  'libary':'library','librayr':'library',
  'strign':'string','stirng':'string',
  'arrary':'array','arary':'array','arrya':'array',
  'objcet':'object','obejct':'object',
  'leanring':'learning','learnign':'learning',
  'machien':'machine',
  'algortihm':'algorithm','algorythm':'algorithm',
  'traning':'training','tarining':'training',
  'modle':'model','mdoel':'model',
  'anlaysis':'analysis','anlysis':'analysis',
  'cretae':'create','craete':'create',
  'delte':'delete','deleet':'delete',
  'udpate':'update','updaet':'update',
  'qurey':'query','queyr':'query',
  'deploey':'deploy','deplyo':'deploy',
  'initailize':'initialize','initialze':'initialize',
  'deubg':'debug','debg':'debug',
  'repsitory':'repository','repositoy':'repository',
  'fraemwork':'framework','framwork':'framework','framewrok':'framework',
  'dont':'don\'t','didnt':'didn\'t','cant':'can\'t','wont':'won\'t',
  'isnt':'isn\'t','wasnt':'wasn\'t','hasnt':'hasn\'t','havent':'haven\'t',
  'wouldnt':'wouldn\'t','shouldnt':'shouldn\'t','couldnt':'couldn\'t',
  'werent':'weren\'t','arent':'aren\'t',
  'thats':'that\'s','whats':'what\'s',
  'youre':'you\'re','theyre':'they\'re',
  'im':'I\'m','id':'I\'d',
  'alot':'a lot','aswell':'as well','infact':'in fact',
  'workign':'working','workin':'working',
  'codeing':'coding','codign':'coding',
  'runnign':'running','runnin':'running',
  'gettign':'getting',
  'makign':'making',
  'smth':'something','sth':'something',
  'bc':'because','cuz':'because',
  'rly':'really',
  'ppl':'people',
  'buidl':'build','biuld':'build',
  'recat':'react','raect':'react',
  'ned':'need','nee':'need',
  'wnat':'want','wabt':'want',
  'wirte':'write','wrie':'write',
};

// ─────────────────────────────────────────────────────────────
//  TOKEN ESTIMATION
// ─────────────────────────────────────────────────────────────
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

// ─────────────────────────────────────────────────────────────
//  CODE BLOCK PROTECTION
// ─────────────────────────────────────────────────────────────
function protectCode(text) {
  const blocks = [];
  const result = text.replace(/```[\s\S]*?```|`[^`]+`/g, (match) => {
    const ph = `\x00CODE${blocks.length}\x00`;
    blocks.push(match);
    return ph;
  });
  return { text: result, blocks };
}

function restoreCode(text, blocks) {
  return text.replace(/\x00CODE(\d+)\x00/g, (_, i) => blocks[parseInt(i)] || '');
}

// ─────────────────────────────────────────────────────────────
//  TYPO CORRECTION
// ─────────────────────────────────────────────────────────────
function correctTypos(text) {
  return text.replace(/\b[\w']+\b/g, (word) => {
    const lower = word.toLowerCase();
    if (TYPOS[lower]) {
      // Preserve original casing pattern
      const fix = TYPOS[lower];
      if (word[0] === word[0].toUpperCase() && word !== word.toUpperCase()) {
        return fix[0].toUpperCase() + fix.slice(1);
      }
      return fix;
    }
    return word;
  });
}

// ─────────────────────────────────────────────────────────────
//  CONTRACTION
// ─────────────────────────────────────────────────────────────
function contractFormal(text) {
  return text
    .replace(/\bdo not\b/gi, "don't")
    .replace(/\bcannot\b/gi, "can't")
    .replace(/\bwill not\b/gi, "won't")
    .replace(/\bshould not\b/gi, "shouldn't")
    .replace(/\bwould not\b/gi, "wouldn't")
    .replace(/\bcould not\b/gi, "couldn't")
    .replace(/\bare not\b/gi, "aren't")
    .replace(/\bwas not\b/gi, "wasn't")
    .replace(/\bwere not\b/gi, "weren't")
    .replace(/\bhas not\b/gi, "hasn't")
    .replace(/\bhave not\b/gi, "haven't")
    .replace(/\bdid not\b/gi, "didn't")
    .replace(/\bI am\b/g, "I'm")
    .replace(/\bI will\b/g, "I'll")
    .replace(/\bI have\b/g, "I've")
    .replace(/\bI would\b/g, "I'd")
    .replace(/\bthey are\b/gi, "they're")
    .replace(/\bwe are\b/gi, "we're")
    .replace(/\byou are\b/gi, "you're")
    .replace(/\bit is\b/gi, "it's")
    .replace(/\bthat is\b/gi, "that's")
    .replace(/\bwhat is\b/gi, "what's")
    .replace(/\bthere is\b/gi, "there's")
    .replace(/\bhere is\b/gi, "here's");
}

// ─────────────────────────────────────────────────────────────
//  SOFT (LIGHT) optimizations
// ─────────────────────────────────────────────────────────────
function applySoftOptimizations(text) {
  let t = text;

  // Phrase shortenings (safe, meaning-preserving)
  const phrasePairs = [
    [/\bin order to\b/gi, 'to'],
    [/\bdue to the fact that\b/gi, 'because'],
    [/\bfor the purpose of\b/gi, 'for'],
    [/\bin the event that\b/gi, 'if'],
    [/\bwith regard to\b/gi, 'about'],
    [/\bwith respect to\b/gi, 'about'],
    [/\bin terms of\b/gi, 'for'],
    [/\ba large number of\b/gi, 'many'],
    [/\bthe majority of\b/gi, 'most'],
    [/\bis able to\b/gi, 'can'],
    [/\bhas the ability to\b/gi, 'can'],
    [/\bat this point in time\b/gi, 'now'],
    [/\bat the present time\b/gi, 'now'],
    [/\bprior to\b/gi, 'before'],
    [/\bsubsequent to\b/gi, 'after'],
    [/\bin the near future\b/gi, 'soon'],
    [/\bas well as\b/gi, 'and'],
    [/\bin addition to\b/gi, 'and'],
    [/\bon the other hand\b/gi, 'but'],
    [/\bin spite of\b/gi, 'despite'],
    [/\btake into (?:account|consideration)\b/gi, 'consider'],
    [/\bmake a decision\b/gi, 'decide'],
    [/\bgive an explanation\b/gi, 'explain'],
    [/\bas soon as possible\b/gi, 'ASAP'],
    [/\ba variety of\b/gi, 'various'],
    [/\ba wide range of\b/gi, 'various'],
    [/\bthe fact that\b/gi, 'that'],
    [/\bin the process of\b/gi, 'while'],
    [/\bat the same time\b/gi, 'simultaneously'],
    [/\bfor the most part\b/gi, 'mostly'],
    [/\bin light of\b/gi, 'given'],
    [/\bwith the exception of\b/gi, 'except'],
    [/\bin the case of\b/gi, 'for'],
    [/\bby means of\b/gi, 'via'],
  ];
  for (const [re, rep] of phrasePairs) t = t.replace(re, rep);

  // Remove redundant "that" after common verbs
  t = t.replace(/\b(think|believe|know|said|feel|found|noticed|realized|understand|assume|hope|sure|guess|suppose|figured|thought|heard|read|saw|meant) that\b/gi, '$1');

  // Remove safe filler
  t = t.replace(/\b(just|basically|actually|literally|really|simply|obviously|clearly|of course|naturally|honestly|frankly|definitely|certainly)\b\s*/gi, '');

  // Remove greeting at start
  t = t.replace(/^(hi|hello|hey)\s*(there|assistant|AI|Claude|GPT|ChatGPT)?[,!.]?\s*/im, '');

  // Remove closing thanks
  t = t.replace(/\b(thanks in advance|thank you in advance|thanks so much|thank you so much)\b[^.!?\n]*[.!?]?\s*$/gim, '');
  t = t.replace(/\b(thanks!?|thank you!?)\s*[.!]?\s*$/gim, '');

  // Remove fluff like "I hope you're doing well"
  t = t.replace(/\bI hope you(?:'re| are) doing well\s*\w*\s*[.!]?\s*/gi, '');

  // Wordy filler phrases
  t = t.replace(/\b(as a matter of fact|at the end of the day|for what it's worth|the thing is|to be honest|in my opinion|when it comes to)[,]?\s*/gi, '');

  // Remove "I think/I believe" hedges at sentence start
  t = t.replace(/(^|[.!?]\s+)(I think|I believe|I feel like|I feel that|it seems like|it seems that)\s*/gim, '$1');

  return t;
}

// ─────────────────────────────────────────────────────────────
//  NORMAL (BALANCED) optimizations
// ─────────────────────────────────────────────────────────────
function applyNormalOptimizations(text) {
  let t = text;

  // Remove politeness tokens
  t = t.replace(/^(Dear|Hi|Hello|Hey|Good morning|Good afternoon|Good evening)[^,\n]*[,.]?\s*/gim, '');
  t = t.replace(/\b(please|kindly|if you don't mind|if possible|if it's not too much trouble)[,]?\s*/gi, '');
  t = t.replace(/\b(I was wondering if|Would you be able to|Could you please|Would you mind)\s*/gi, '');

  // Question → imperative
  t = t.replace(/\bCan you (please\s+)?([a-z])/gi, (_, _p, c) => c.toUpperCase());
  t = t.replace(/\bCould you (please\s+)?([a-z])/gi, (_, _p, c) => c.toUpperCase());
  t = t.replace(/\bWould you (please\s+)?([a-z])/gi, (_, _p, c) => c.toUpperCase());
  // "you could explain" → "Explain" when at start of sentence
  t = t.replace(/(^|(?<=[.!?]\s+))you could (?:please\s+)?([a-z])/gi, (_, _pre, c) => c.toUpperCase());
  t = t.replace(/\bI(?:'d| would) like (?:you )?to\s+/gi, '');
  t = t.replace(/\bI want you to\s+/gi, '');
  t = t.replace(/\bI need you to\s+/gi, '');

  // Hedging removal
  t = t.replace(/\b(I think|I believe|I feel|I guess|I suppose|I assume|I'm not sure but|maybe|perhaps|possibly|probably|likely)\s*/gi, '');
  t = t.replace(/\b(it might|it may|it could|it seems|it appears|it looks like)\s+/gi, '');
  t = t.replace(/\b(sort of|kind of|somewhat|rather|fairly|quite|pretty much|more or less)\s*/gi, '');

  // Meta-language removal
  t = t.replace(/\b(Please note that|Note that|Keep in mind that|Remember that|Bear in mind that|It's worth noting that|It's important to note that)\s*/gi, '');
  t = t.replace(/\b(As I mentioned|As stated above|As discussed|As noted earlier|As previously mentioned)\s*/gi, '');
  t = t.replace(/\b(In summary|To summarize|In conclusion|To conclude|In short|In brief|To put it simply|Simply put)\s*[,:]?\s*/gi, '');
  t = t.replace(/\bIn order to\b/gi, 'To');

  // Phrase shortenings (extended set for normal mode)
  const normalPairs = [
    [/\bimplementation\b/gi, 'impl'],
    [/\bapplication\b/gi, 'app'],
    [/\bconfiguration\b/gi, 'config'],
    [/\bdocumentation\b/gi, 'docs'],
    [/\benvironment\b/gi, 'env'],
    [/\bdirectory\b/gi, 'dir'],
    [/\brepository\b/gi, 'repo'],
    [/\bparameters\b/gi, 'params'],
    [/\bfunctionality\b/gi, 'feature'],
    [/\butilize\b/gi, 'use'],
    [/\butilization\b/gi, 'usage'],
    [/\bprovide\b/gi, 'give'],
    [/\bpurchase\b/gi, 'buy'],
    [/\bcommence\b/gi, 'start'],
    [/\bterminate\b/gi, 'stop'],
    [/\bdemonstrate\b/gi, 'show'],
    [/\bidentify\b/gi, 'find'],
    [/\bassist\b/gi, 'help'],
    [/\brequire\b/gi, 'need'],
    [/\battempt to\b/gi, 'try to'],
    [/\bensure that\b/gi, 'ensure'],
    [/\bmake sure that\b/gi, 'ensure'],
    [/\bin the following\b/gi, 'below'],
    [/\bthe following\b/gi, 'these'],
    [/\bthe aforementioned\b/gi, 'the'],
    [/\bsubsequently\b/gi, 'then'],
    [/\badditionally\b/gi, 'also'],
    [/\bfurthermore\b/gi, 'also'],
    [/\bmoreover\b/gi, 'also'],
    [/\bhowever\b/gi, 'but'],
    [/\bnevertheless\b/gi, 'but'],
    [/\bnotwithstanding\b/gi, 'despite'],
    [/\baccordingly\b/gi, 'so'],
    [/\bconsequently\b/gi, 'so'],
    [/\btherefore\b/gi, 'so'],
    [/\bwith respect to\b/gi, 'about'],
    [/\bregarding\b/gi, 'about'],
    [/\bconcerning\b/gi, 'about'],
    [/\bpertaining to\b/gi, 'about'],
  ];
  for (const [re, rep] of normalPairs) t = t.replace(re, rep);

  // Remove redundant modifiers
  t = t.replace(/\b(very|extremely|highly|incredibly|enormously|tremendously|utterly|absolutely|completely|totally)\s+(important|necessary|critical|essential|crucial|key|vital)\b/gi, '$2');
  t = t.replace(/\b(completely|totally|entirely|fully|wholly)\s+(clear|complete|done|finished|ready)\b/gi, '$2');

  // Remove leftover sentence fragments from hedging/meta removal
  t = t.replace(/\bto do this[,]?\s*/gi, '');
  t = t.replace(/\bin order to do this[,]?\s*/gi, '');
  t = t.replace(/\bit would be (?:very |extremely |really )?helpful(?: to| if you could)?/gi, '');

  // Passive indicators
  t = t.replace(/\bit should be noted that\b/gi, '');
  t = t.replace(/\bit is worth noting that\b/gi, '');
  t = t.replace(/\bit can be seen that\b/gi, '');
  t = t.replace(/\bit has been observed that\b/gi, '');

  // Relative clause compression
  t = t.replace(/\bthat (are|is|was|were)\b/gi, '');
  t = t.replace(/\bwhich (are|is|was|were)\b/gi, '');
  t = t.replace(/\bwho (are|is|was|were)\b/gi, '');

  // Dedup adjacent sentences (exact match)
  const sentences = t.split(/(?<=[.!?])\s+/);
  const seen = new Set();
  const deduped = sentences.filter(s => {
    const norm = s.toLowerCase().trim();
    if (!norm || seen.has(norm)) return false;
    seen.add(norm);
    return true;
  });
  t = deduped.join(' ');

  // Numeralize written numbers
  const NUM_MAP = {
    'zero':'0','one':'1','two':'2','three':'3','four':'4','five':'5',
    'six':'6','seven':'7','eight':'8','nine':'9','ten':'10',
    'eleven':'11','twelve':'12','twenty':'20','hundred':'100','thousand':'1000',
  };
  t = t.replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|hundred|thousand)\b/gi, m => NUM_MAP[m.toLowerCase()] || m);

  return t;
}

// ─────────────────────────────────────────────────────────────
//  AGGRESSIVE optimizations
// ─────────────────────────────────────────────────────────────
function applyAggressiveOptimizations(text) {
  let t = text;

  // Abbreviations
  const abbrevPairs = [
    [/\bwith\b/g, 'w/'],
    [/\bwithout\b/g, 'w/o'],
    [/\bbecause\b/gi, 'bc'],
    [/\bbetween\b/gi, 'btwn'],
    [/\bthrough\b/gi, 'thru'],
    [/\bdevelopment\b/gi, 'dev'],
    [/\bproduction\b/gi, 'prod'],
    [/\bdatabase\b/gi, 'db'],
    [/\bfunction\b/gi, 'fn'],
    [/\bfunctions\b/gi, 'fns'],
    [/\bvariable\b/gi, 'var'],
    [/\bvariables\b/gi, 'vars'],
    [/\btechnology\b/gi, 'tech'],
    [/\btechnologies\b/gi, 'techs'],
    [/\bapplication\b/gi, 'app'],
    [/\bapplications\b/gi, 'apps'],
    [/\binformation\b/gi, 'info'],
    [/\bmaximum\b/gi, 'max'],
    [/\bminimum\b/gi, 'min'],
    [/\bnumber\b/gi, 'num'],
    [/\bmessage\b/gi, 'msg'],
    [/\bmessages\b/gi, 'msgs'],
    [/\bsecond\b/gi, 'sec'],
    [/\bseconds\b/gi, 'secs'],
    [/\bversus\b/gi, 'vs'],
    [/\bthat is\b/gi, 'i.e.'],
    [/\bfor example\b/gi, 'e.g.'],
    [/\band so on\b/gi, 'etc.'],
    [/\bapproximately\b/gi, '~'],
    [/\bgreater than\b/gi, '>'],
    [/\bless than\b/gi, '<'],
    [/\bequal to\b/gi, '='],
    [/\bplus or minus\b/gi, '±'],
    [/\bparagraph\b/gi, 'para'],
    [/\bimage\b/gi, 'img'],
    [/\breference\b/gi, 'ref'],
    [/\breferences\b/gi, 'refs'],
  ];
  for (const [re, rep] of abbrevPairs) t = t.replace(re, rep);

  // Strip markdown noise (headers, bold, italic, horizontal rules)
  t = t.replace(/^#{1,6}\s+/gm, '');
  t = t.replace(/\*\*(.+?)\*\*/g, '$1');
  t = t.replace(/\*(.+?)\*/g, '$1');
  t = t.replace(/_{1,2}(.+?)_{1,2}/g, '$1');
  t = t.replace(/^---+$/gm, '');
  t = t.replace(/^===+$/gm, '');

  // Remove articles in instruction context
  t = t.replace(/\bthe (?=(following|above|below|same|other|next|previous|first|second|last|result|output|input|code|file|data|text|list|table|function|method|class|object|array|string|number|value|key|response|request|error|user|system|server|client|page|app|application|api|database|query|model)\b)/gi, '');
  t = t.replace(/\b(a|an) (?=(list|set|series|collection|group|number|pair|type|kind|sort|form|way|method|approach|solution|example|instance|function|script|program|tool|feature|option|version|copy|summary|overview|description|explanation|comparison|review|analysis|report|guide|tutorial|demo|test|plan|draft)\b)/gi, '');

  // Telegraph compression: remove low-info sentence openers
  t = t.replace(/^(So|Now|Well|OK|Okay|Right|Alright|Sure|Of course|Absolutely)[,.]?\s*/gim, '');

  // Drop low-info filler sentences (< 5 words that add no instruction value)
  t = t.replace(/^(Got it|Understood|Sure thing|No problem|Sounds good|That makes sense|Makes sense|I see|I understand)[.!]?\s*$/gim, '');

  return t;
}

// ─────────────────────────────────────────────────────────────
//  MAIN OPTIMIZE FUNCTION
// ─────────────────────────────────────────────────────────────
function optimize(text, mode = 'normal') {
  if (!text || typeof text !== 'string') return { optimized: '', tokens_original: 0, tokens_optimized: 0, tokens_saved: 0, reduction_pct: 0 };

  const wordCount = text.trim().split(/\s+/).length;
  if (wordCount < 3) {
    return {
      optimized: text.trim(),
      tokens_original: estimateTokens(text),
      tokens_optimized: estimateTokens(text.trim()),
      tokens_saved: 0,
      reduction_pct: 0,
      techniques: [],
    };
  }

  const tokensOriginal = estimateTokens(text);
  let t = text;
  const applied = [];

  // 0. Typo correction (all modes)
  const beforeTypo = t;
  t = correctTypos(t);
  if (t !== beforeTypo) applied.push('corrected_typos');

  // 1. Whitespace compression (all modes)
  const beforeWs = t;
  t = t.replace(/\n{3,}/g, '\n\n');
  t = t.replace(/[ \t]{2,}/g, ' ');
  t = t.replace(/^\s+$/gm, '');
  if (t !== beforeWs) applied.push('compressed_whitespace');

  // 2. Protect code blocks
  const { text: noCode, blocks } = protectCode(t);
  t = noCode;

  // 3. Apply mode-specific transformations
  if (mode === 'soft') {
    const before = t;
    t = applySoftOptimizations(t);
    const after = contractFormal(t);
    if (before !== t || t !== after) applied.push('phrase_optimization');
    t = after;
  } else if (mode === 'normal') {
    // normal includes everything soft does, plus more
    const before = t;
    t = applySoftOptimizations(t);
    t = applyNormalOptimizations(t);
    t = contractFormal(t);
    if (before !== t) applied.push('phrase_optimization', 'filler_removal', 'hedging_removal');
  } else if (mode === 'aggressive') {
    const before = t;
    t = applySoftOptimizations(t);
    t = applyNormalOptimizations(t);
    t = applyAggressiveOptimizations(t);
    t = contractFormal(t);
    if (before !== t) applied.push('phrase_optimization', 'filler_removal', 'hedging_removal', 'abbreviations', 'markdown_strip');
  }

  // 4. Re-capitalize sentence starts and clean up artifacts
  t = t.replace(/([.!?]\s+)([a-z])/g, (_, punct, c) => punct + c.toUpperCase());
  if (t.length > 0 && /^[a-z]/.test(t)) {
    t = t[0].toUpperCase() + t.slice(1);
  }
  // Clean up orphaned punctuation artifacts
  t = t.replace(/\?\s*\?/g, '?');
  t = t.replace(/\.\s*\./g, '.');
  t = t.replace(/\s+([.!?,])/g, '$1');

  // 5. Trim extra whitespace again after all transforms
  t = t.replace(/[ \t]{2,}/g, ' ').trim();
  t = t.replace(/\n{3,}/g, '\n\n');

  // 6. Restore code blocks
  t = restoreCode(t, blocks);

  const tokensOptimized = estimateTokens(t);
  const saved = Math.max(0, tokensOriginal - tokensOptimized);

  return {
    optimized: t,
    tokens_original: tokensOriginal,
    tokens_optimized: tokensOptimized,
    tokens_saved: saved,
    reduction_pct: tokensOriginal > 0 ? Math.round((saved / tokensOriginal) * 100) : 0,
    techniques: applied,
  };
}

module.exports = { optimize, estimateTokens };
