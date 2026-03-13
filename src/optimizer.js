/**
 * Terse Prompt Optimizer
 * Comprehensive token reduction engine with nspell (Hunspell) spell correction.
 */

const nspell = require('nspell');
// Lazy-load heavy NLP modules to reduce startup memory (~30MB saved)
let _nlp = null;
function nlp(text) {
  if (!_nlp) _nlp = require('compromise');
  return _nlp(text);
}
const { franc } = require('franc-min');
const { removeStopwords, eng, fra, deu, spa, por, ita, rus, jpn, zho } = require('stopword');
const { spellCorrect, deduplicateClauses, compressRepeatedPhrases } = require('./spellfix');

// ── Multilingual spellcheck via nspell (Hunspell) ──
const spellers = {}; // lang code → { speller, ready }
const TECH_WORDS = [
  'api','apis','json','html','css','javascript','typescript','nodejs','npm',
  'webpack','react','vue','svelte','nextjs','docker','kubernetes','redis',
  'postgresql','mongodb','graphql','restful','oauth','jwt','websocket',
  'async','await','middleware','frontend','backend','fullstack','devops',
  'microservice','microservices','blockchain','crypto','cryptocurrency',
  'nft','defi','llm','gpt','chatgpt','claude','openai','anthropic',
  'tensorflow','pytorch','sklearn','pandas','numpy','jupyter',
  'reinforcement','transformer','embeddings','tokenizer','finetune',
  'config','configs','repo','repos','env','dev','prod','auth','params',
  'args','func','funcs','init','impl','utils','lib','libs','src','dist',
  'todo','todos','readme','changelog','dockerfile','yaml','yml','toml',
  'aws','gcp','azure','vercel','netlify','heroku','nginx','cicd','vpc','iam','s3','ec2','ecs','eks','rds','sqs','sns','lambda',
];

// Dictionary package names per language
// Only load English dictionary — others loaded on demand to save ~50MB RAM
const DICT_PACKAGES = {
  en: 'dictionary-en',
};

async function getSpeller(lang) {
  const code = lang || 'en';
  if (spellers[code]?.ready) return spellers[code].speller;
  if (spellers[code]?.loading) return null; // already loading
  if (!DICT_PACKAGES[code]) return getSpeller('en'); // fallback to English

  spellers[code] = { speller: null, ready: false, loading: true };
  try {
    const dict = await import(DICT_PACKAGES[code]);
    const data = dict.default || dict;
    const s = nspell(data);
    for (const w of TECH_WORDS) s.add(w);
    spellers[code] = { speller: s, ready: true, loading: false };
    return s;
  } catch (e) {
    console.error(`nspell init for ${code} failed:`, e.message);
    spellers[code] = { speller: null, ready: false, loading: false };
    return null;
  }
}

// Pre-load English on startup
getSpeller('en');

// ── Language detection ──
// franc returns ISO 639-3 codes; map to our 2-letter codes
const FRANC_TO_LANG = {
  eng: 'en', spa: 'es', fra: 'fr', deu: 'de', por: 'pt',
  ita: 'it', rus: 'ru', jpn: 'ja', cmn: 'zh', zho: 'zh',
  kor: 'ko', ara: 'ar', hin: 'hi', nld: 'nl', pol: 'pl',
  tur: 'tr', vie: 'vi', tha: 'th', ind: 'id', ukr: 'uk',
  bul: 'ru', srp: 'ru', bel: 'ru', mkd: 'ru', // Cyrillic fallback to Russian
};

// Stopword lists per language
const STOPWORD_LISTS = {
  en: eng, fr: fra, de: deu, es: spa, pt: por, it: ita, ru: rus, ja: jpn, zh: zho,
};

function detectLanguage(text) {
  if (!text || text.length < 10) return 'en';

  // Fast CJK detection by character ranges (franc struggles with short CJK)
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const jpChars = (text.match(/[\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
  const koChars = (text.match(/[\uac00-\ud7af\u1100-\u11ff]/g) || []).length;
  const totalChars = text.replace(/\s/g, '').length;

  if (totalChars > 0) {
    if (jpChars / totalChars > 0.1) return 'ja';
    if (koChars / totalChars > 0.1) return 'ko';
    if (cjkChars / totalChars > 0.2) return 'zh';
  }

  const code = franc(text);
  return FRANC_TO_LANG[code] || 'en';
}

// Split-word typos: words accidentally split by a space (case-insensitive regex)
const SPLIT_TYPOS = [
  [/\bint he\b/gi, 'in the'],
  [/\bth e\b/gi, 'the'],
  [/\bwit h\b/gi, 'with'],
  [/\bfro m\b/gi, 'from'],
  [/\bsom e\b/gi, 'some'],
  [/\bhav e\b/gi, 'have'],
  [/\bwhe n\b/gi, 'when'],
  [/\bthe n\b/gi, 'then'],
  [/\bthe y\b/gi, 'they'],
  [/\bthe re\b/gi, 'there'],
  [/\bthe ir\b/gi, 'their'],
  [/\bwhe re\b/gi, 'where'],
  [/\bsho w\b/gi, 'show'],
  [/\bsho uld\b/gi, 'should'],
  [/\bcou ld\b/gi, 'could'],
  [/\bwou ld\b/gi, 'would'],
];

// Fast-path typo dictionary for the most common prompt/coding typos
// nspell handles general English; this catches domain-specific + very fast corrections
const TYPOS = {
  // --- the/that/this/then ---
  'teh':'the','hte':'the','thn':'then','thne':'then','thier':'their','theri':'their',
  'taht':'that','htat':'that','thta':'that','tath':'that','tha':'that','thsi':'this',
  'tihs':'this','htis':'this','thsoe':'those','thsee':'these',
  // --- and/are/was ---
  'adn':'and','nad':'and','anf':'and','andd':'and',
  'aer':'are','rae':'are','wsa':'was',
  // --- want/went/with/what/when/where/which/while ---
  'wwant':'want','wan':'want','wnat':'want','watn':'want','wnt':'want','wanr':'want','wantd':'wanted',
  'wnet':'went','wetn':'went',
  'wiht':'with','wtih':'with','iwth':'with','wih':'with','whit':'with','witht':'with',
  'waht':'what','whta':'what','wath':'what','hwat':'what',
  'wehn':'when','whne':'when','whn':'when',
  'wehre':'where','wheer':'where','wher':'where',
  'whcih':'which','wich':'which','whihc':'which','whch':'which',
  'whlei':'while','whiel':'while',
  // --- would/should/could ---
  'woudl':'would','wuold':'would','woud':'would','wouldd':'would',
  'shoudl':'should','shuold':'should','shoud':'should','shold':'should',
  'coudl':'could','cuold':'could','coud':'could','cld':'could',
  // --- have/has/had ---
  'hav':'have','ahve':'have','hvae':'have','haev':'have',
  'hsa':'has','ahs':'has',
  // --- build/built ---
  'buil':'build','biuld':'build','buidl':'build','bulid':'build','buld':'build',
  'bulit':'built','bilt':'built',
  // --- because ---
  'becuase':'because','becasue':'because','beacuse':'because',
  'becouse':'because','becuz':'because','becuse':'because','becaues':'because',
  // --- definitely ---
  'definately':'definitely','definatly':'definitely',
  'definetly':'definitely','defintely':'definitely','defintiely':'definitely',
  // --- receive/achieve ---
  'recieve':'receive','recevie':'receive','receiev':'receive',
  'acheive':'achieve','achive':'achieve','acheiv':'achieve',
  // --- occurred/occurrence ---
  'occured':'occurred','occurence':'occurrence','occurance':'occurrence',
  // --- separate ---
  'seperate':'separate','seperately':'separately','sepreate':'separate',
  // --- necessary ---
  'neccessary':'necessary','neccesary':'necessary','necessery':'necessary','necesary':'necessary',
  // --- common misspellings ---
  'accomodate':'accommodate','apparantly':'apparently','apparenly':'apparently',
  'calender':'calendar','commited':'committed','comitted':'committed',
  'concious':'conscious','enviroment':'environment','enviorment':'environment',
  'goverment':'government','governmnet':'government',
  'immediatly':'immediately','immediatlely':'immediately','immeadiately':'immediately',
  'independant':'independent','knowlege':'knowledge','knowledeg':'knowledge',
  'manualy':'manually','noticable':'noticeable','occassion':'occasion',
  'persistant':'persistent','postion':'position','positon':'position',
  'possibilty':'possibility','prefered':'preferred','privledge':'privilege',
  'proffesional':'professional','profesional':'professional','publically':'publicly',
  'recomend':'recommend','recomendation':'recommendation','recommed':'recommend',
  'refering':'referring','relevent':'relevant','relavant':'relevant',
  'reponse':'response','resposne':'response','responsne':'response','responce':'response',
  'succesful':'successful','successfull':'successful','sucess':'success','succes':'success',
  'suprise':'surprise','surprize':'surprise',
  'tecnology':'technology','technoogy':'technology',
  'tommorow':'tomorrow','tomorow':'tomorrow',
  'togehter':'together','togather':'together',
  'untill':'until','unitl':'until',
  'usally':'usually','ususally':'usually','usaully':'usually',
  'wierd':'weird','writting':'writing','writeing':'writing','wirte':'write','wrtie':'write',
  // --- common short words people mistype ---
  'pleae':'please','pleas':'please','plesae':'please','plese':'please','pelase':'please','pealse':'please',
  'anser':'answer','answr':'answer','anwser':'answer','awner':'answer',
  'abot':'about','abut':'about',
  'wuld':'would','wud':'would',
  'qick':'quick','quik':'quick','quck':'quick',
  'jmps':'jumps','jmup':'jump','jupm':'jump',
  'ovr':'over','ovre':'over',
  'lzy':'lazy','lzay':'lazy',
  'tyr':'try',
  'yuo':'you','yoru':'your','yuor':'your','yur':'your',
  'fo':'of','ot':'to','si':'is','ti':'it','ni':'in','os':'so',
  'nto':'not','ont':'not',
  'cna':'can','cane':'can',
  'jsut':'just','juts':'just','jst':'just',
  'liek':'like','lkie':'like','likee':'like',
  'knwo':'know','konw':'know','nkow':'know',
  'amke':'make','mkae':'make','maek':'make',
  'tkae':'take','teka':'take',
  'godo':'good','goood':'good',
  'nwe':'new','enw':'new',
  'owrk':'work','wokr':'work','wrk':'work',
  'tiem':'time','tmie':'time','itme':'time',
  'sued':'used','uesd':'used',
  'alos':'also','aslo':'also',
  'evne':'even','eevn':'even',
  'onyl':'only','olny':'only',
  'veyr':'very','vrey':'very',
  'somthing':'something','soemthing':'something','somethign':'something',
  'eveything':'everything','evreything':'everything','everythign':'everything',
  'anythign':'anything','anythin':'anything',
  'abuot':'about','abotu':'about','baout':'about',
  'agian':'again','agin':'again',
  'alraedy':'already','alredy':'already','alreayd':'already','alrayd':'already','alrady':'already',
  'alwyas':'always','alwasy':'always','alaways':'always',
  'befoer':'before','befroe':'before',
  'beign':'being','bieng':'being',
  'bewteen':'between','betwen':'between','betwene':'between',
  'chnage':'change','chnge':'change','cahnge':'change',
  'diffreent':'different','differnt':'different','diffrent':'different',
  'doestn':'doesn\'t','dosen\'t':'doesn\'t','dosent':'doesn\'t',
  'enoguh':'enough','enogh':'enough',
  'exapmle':'example','exmaple':'example','examle':'example',
  'firts':'first','fisrt':'first','frist':'first',
  'gerat':'great','graet':'great','graat':'great',
  'otehr':'other','ohter':'other','toher':'other',
  'poeple':'people','peopel':'people','peolpe':'people',
  'probelm':'problem','problme':'problem','porblem':'problem',
  'realy':'really','relaly':'really','relly':'really',
  'rigth':'right','rihgt':'right',
  'smae':'same','saem':'same',
  'strat':'start','satrt':'start','srart':'start',
  'sttil':'still','sitll':'still',
  'thnk':'think','thnik':'think','thiknk':'think',
  'thorugh':'through','throught':'through','trhough':'through',
  'todya':'today','toaday':'today',
  'udnerstand':'understand','undersatnd':'understand','understnad':'understand',
  'wrok':'work',
  'worls':'world','wrold':'world','wolrd':'world',
  // --- more common misspellings ---
  'aacgtually':'actually','acutally':'actually','actualy':'actually','actaully':'actually','acutlaly':'actually',
  'acruallt':'actually','acutally':'actually','actualyl':'actually',
  'conitnue':'continue','contniue':'continue','coninue':'continue','conintue':'continue','contineu':'continue',
  'shwos':'shows','hsows':'shows','sowhs':'shows','sows':'shows',
  'imrov':'improve','imrpov':'improve','improev':'improve','improv':'improve','imporve':'improve',
  'ptimier':'optimize','prespective':'perspective','prespectives':'perspectives','pespectves':'perspectives',
  'connectint':'connecting','conecting':'connecting','conencting':'connecting',
  'ehtm':'them','tehm':'them',
  // --- heavily mangled words from real usage ---
  'witht':'with','wiht':'with',
  'toeks':'tokens','tokesn':'tokens','toeknss':'tokens','toekns':'tokens',
  'agnet':'agent','agnet':'agent','agetn':'agent',
  'clayde':'claude','cluade':'claude','clade':'claude',
  'monitro':'monitor','moniotr':'monitor','monitr':'monitor',
  'otpixmiation':'optimization','optimziation':'optimization','optmization':'optimization','otpimization':'optimization',
  'liek':'like','leik':'like','lkie':'like',
  'wbut':'but',
  'agian':'again','aigan':'again',
  'alredy':'already',
  'coul':'could','cuold':'could','oul':'could',
  'hows':'shows','hsow':'show','shwo':'show','sohw':'show',
  'redce':'reduce','redcue':'reduce','reudce':'reduce',
  'suse':'use','ues':'use','sue':'use',
  'usr':'sure','srue':'sure','suer':'sure',
  'eit':'it',
  'didin':'didn','didint':'didn\'t','dind':'didn',
  'toeknss':'tokens','toesk':'tokens',
  'otehr':'other','ohter':'other',
  'reuslts':'results','resutls':'results',
  'nothign':'nothing','ntohing':'nothing',
  'soem':'some','smoe':'some',
  'htat':'that','taht':'that',
  'tring':'trying','tyring':'trying',
  'shoud':'should','hsould':'should',
  'wokring':'working','workign':'working',
  'runnign':'running','runing':'running',
  'somethign':'something',
  'anythign':'anything',
  'nothign':'nothing',
  'everythign':'everything',
  'clcik':'click','clikc':'click',
  'buttn':'button','buton':'button','butotn':'button',
  'mesage':'message','messgae':'message','messge':'message','mesages':'messages','mesagse':'messages',
  'widnow':'window','windwo':'window','winodw':'window','winow':'window',
  'popu':'popup','poppu':'popup',
  'sems':'seems','seesm':'seems','sesm':'seems',
  'worng':'wrong','wrogn':'wrong','wrnog':'wrong',
  'tyep':'type','tyep':'type','tpye':'type',
  'scrren':'screen','sreen':'screen',
  'dipslay':'display','dispaly':'display','displya':'display',
  // --- programming/tech typos ---
  'langauge':'language','languge':'language','lanague':'language',
  'fucntion':'function','funtion':'function','funciton':'function',
  'impelment':'implement','implment':'implement','impliment':'implement',
  'applicaiton':'application','applcation':'application','appliaction':'application',
  'databse':'database','datbase':'database','databaes':'database',
  'sevrer':'server','sever':'server','servr':'server',
  'clinet':'client','cleint':'client',
  'proejct':'project','porject':'project','projcet':'project',
  'accout':'account','acount':'account',
  'pasword':'password','passwrod':'password','passowrd':'password',
  'usernmae':'username','useranme':'username',
  'reuqest':'request','requst':'request','rquest':'request','requets':'request',
  'repsone':'response','repsonse':'response',
  'featrue':'feature','feautre':'feature','fetaure':'feature',
  'isssue':'issue','isseu':'issue',
  'soltuion':'solution','soluton':'solution','soltuin':'solution',
  'methdo':'method','metohd':'method',
  'varialbe':'variable','varibale':'variable','variabel':'variable',
  'paramter':'parameter','parmaeter':'parameter','parmeter':'parameter',
  'arguemnt':'argument','arugment':'argument','arguement':'argument',
  'reutrn':'return','retrun':'return','retrn':'return',
  'improt':'import','imoprt':'import',
  'exoprt':'export','exprot':'export',
  'moduels':'modules','moduel':'module',
  'packge':'package','packgae':'package',
  'depenedncy':'dependency','dependecy':'dependency','dependancy':'dependency',
  'conifg':'config','confgi':'config','ocnfig':'config',
  'compoennt':'component','comopnent':'component','componet':'component',
  'templtae':'template','tempalte':'template','templat':'template',
  'libary':'library','librayr':'library','lbirary':'library',
  'strign':'string','stirng':'string',
  'nubmer':'number','numbr':'number','numbre':'number',
  'integre':'integer','intger':'integer',
  'booelan':'boolean','bolean':'boolean',
  'arrary':'array','arary':'array','arrya':'array',
  'objcet':'object','obejct':'object','objetc':'object',
  'leanring':'learning','learnign':'learning',
  'machien':'machine','machin':'machine',
  'nueral':'neural','neruon':'neuron','nural':'neural',
  'algortihm':'algorithm','algorythm':'algorithm','algorthm':'algorithm',
  'traning':'training','tarining':'training','trainin':'training',
  'modle':'model','mdoel':'model','modl':'model',
  'anlaysis':'analysis','anlysis':'analysis','anaylsis':'analysis',
  'staitstics':'statistics','statistcs':'statistics',
  'incorpaote':'incorporate','incoroprate':'incorporate','incorportae':'incorporate',
  'sleect':'select','selcet':'select',
  'cretae':'create','craete':'create','creat':'create',
  'delte':'delete','deleet':'delete',
  'udpate':'update','updaet':'update','updte':'update',
  'inserrt':'insert','insret':'insert',
  'qurey':'query','queyr':'query',
  'deploey':'deploy','deplyo':'deploy',
  'intergrate':'integrate','integarte':'integrate',
  'initailize':'initialize','intiialize':'initialize','initialze':'initialize',
  'excute':'execute','exeucte':'execute',
  'deubg':'debug','debg':'debug','ebugging':'debugging','debuging':'debugging','deubgging':'debugging',
  'repsitory':'repository','repositoy':'repository','repostory':'repository',
  'fraemwork':'framework','framwork':'framework','framewrok':'framework',
  // --- reinforcement and AI/ML terms ---
  'reinforcment':'reinforcement','reinforcemnt':'reinforcement',
  'reienforcement':'reinforcement','reinformcement':'reinforcement',
  'reinfrocement':'reinforcement','reinfocrement':'reinforcement',
  'reinfocement':'reinforcement','reinforcemnet':'reinforcement',
  'nueralnetwork':'neural network','deeplearning':'deep learning',
  'optmization':'optimization','optimzation':'optimization','optimizaiton':'optimization',
  'classificaiton':'classification','clasification':'classification',
  'regresssion':'regression','regresion':'regression',
  'prediciton':'prediction','predicton':'prediction',
  'genrative':'generative','generatvie':'generative',
  'transfromer':'transformer','trasnformer':'transformer','transformr':'transformer',
  // --- crypto/trading terms ---
  'crytpo':'crypto','cyrpto':'crypto','cryto':'crypto',
  'tradign':'trading','tradig':'trading',
  'blokcchain':'blockchain','blockchian':'blockchain',
  'exchnage':'exchange','exchagne':'exchange',
  'portoflio':'portfolio','porfolio':'portfolio',
  // --- contractions ---
  'doesnt':'doesn\'t','dont':'don\'t','didnt':'didn\'t','cant':'can\'t','wont':'won\'t',
  'isnt':'isn\'t','wasnt':'wasn\'t','hasnt':'hasn\'t','havent':'haven\'t',
  'wouldnt':'wouldn\'t','shouldnt':'shouldn\'t','couldnt':'couldn\'t',
  'thats':'that\'s','whats':'what\'s','hows':'how\'s','whos':'who\'s',
  'youre':'you\'re','theyre':'they\'re','ive':'I\'ve',
  'im':'I\'m','id':'I\'d','youll':'you\'ll','theyll':'they\'ll',
  // --- compound words ---
  'alot':'a lot','aswell':'as well','infact':'in fact','incase':'in case',
  'eachother':'each other','noone':'no one','alright':'all right',
  // --- missing common typos from test ---
  'numbrs':'numbers','numbr':'number','lsit':'list','plase':'please','connectoin':'connection',
  'erorr':'error','serach':'search','usres':'users','loadign':'loading','shoudl':'should',
  'taht':'that','thats':'that\'s','plese':'please','correcignt':'correcting',
  'repalce':'replace','repalcing':'replacing','smooht':'smooth','experince':'experience',
  'correcitng':'correcting','correcting':'correcting','autocorrecitng':'autocorrecting',
  'reudce':'reduce','toeknss':'tokens','toekns':'tokens','tokes':'tokens',
  'tokesn':'tokens','toeks':'tokens','toesk':'tokens',
  'amoootha':'smooth','tuaocorretion':'autocorrection','coreretion':'correction',
  'corretion':'correction','correctoin':'correction',
  'endpoin':'endpoint','endpoitn':'endpoint','ednpoint':'endpoint',
  'tailwnd':'tailwind','typescrip':'typescript','typescipt':'typescript',
  'styilng':'styling','stlying':'styling','stylig':'styling',
  'compoenent':'component','componnet':'component','compnent':'component',
  'dispalys':'displays','displyas':'displays','dispays':'displays',
  'filteer':'filter','filtre':'filter','fitler':'filter',
  'handlign':'handling','handlin':'handling',
  'authetication':'authentication','authenticaiton':'authentication','auhtentication':'authentication',
  'incldue':'include','inlcude':'include','includ':'include',
  'expresss':'express',
  // --- number substitutions in casual text ---
  'wan2':'want to','want2':'want to','need2':'need to','got2':'got to',
  'b4':'before','2day':'today','2morrow':'tomorrow','4get':'forget',
  // --- heavily mangled / keyboard-adjacent typos ---
  'swaht':'what','swaht':'what','sawht':'what','whagt':'what',
  'soudl':'should','shoudl':'should','shuodl':'should','shoudld':'should','hsould':'should',
  'mw':'me','em':'me','nme':'me',
  'teh':'the','hte':'the','tge':'the','yhe':'the','rhe':'the',
  'fo':'of','ot':'to','si':'is','ti':'it','ni':'in','os':'so',
  'adn':'and','nad':'and','anf':'and','anbd':'and','abd':'and',
  'helo':'hello','hlep':'help','hepl':'help','hlp':'help','jelp':'help',
  'wnat':'want','wabt':'want','wantt':'want','wamt':'want','eant':'want',
  'wirh':'with','wuth':'with','eith':'with','woth':'with','wiyh':'with',
  'frim':'from','fron':'from','drom':'from','feom':'from','ftom':'from',
  'tgat':'that','rhat':'that','yhat':'that','tjat':'that',
  'nit':'not','bot':'not','noy':'not','nkt':'not',
  'byt':'but','bur':'but','vut':'but','gut':'but',
  'gor':'for','fir':'for','fpr':'for','foe':'for',
  'yiu':'you','tou':'you','yoy':'you','ypu':'you',
  'abd':'and','anr':'and','snd':'and',
  'habe':'have','hsve':'have','jave':'have','hace':'have',
  'thwy':'they','thet':'they','tjey':'they','rhey':'they',
  'wehn':'when','whem':'when','wheb':'when',
  'gere':'here','jere':'here','hete':'here',
  'noe':'now','niw':'now','nkw':'now',
  'baxk':'back','bavk':'back','bacm':'back',
  'sone':'some','soem':'some','somr':'some','sime':'some',
  'lile':'like','luke':'like','likr':'like','likw':'like',
  'wgat':'what','whst':'what','whay':'what','ehat':'what',
  'thid':'this','thks':'this','thia':'this','rhis':'this',
  'wirte':'write','wrie':'write','wtite':'write','wrtie':'write',
  'bbok':'book','booj':'book','boik':'book','vook':'book',
  'resarch':'research','reserch':'research','reasearch':'research','rsearch':'research',
  'aboit':'about','abour':'about','avout':'about','sbout':'about',
  'satrt':'start','stary':'start','staet':'start','dtart':'start',
  'finsh':'finish','finidh':'finish','finsih':'finish','finiah':'finish',
  'chaptar':'chapter','chpater':'chapter','chapte':'chapter',
  'shpuld':'should','shoild':'should','shouod':'should','shluld':'should',
  'coukd':'could','cpuld':'could','coyld':'could','couod':'could',
  'woukd':'would','wpuld':'would','woyld':'would','wouod':'would',
  'pleaae':'please','pleade':'please','pldase':'please','plwase':'please',
  'becsuse':'because','becaude':'because','becayse':'because',
  'diffetent':'different','differeny':'different','difgerent':'different',
  'importamt':'important','importanr':'important','importsnt':'important',
  'somwthing':'something','somethimg':'something','somethibg':'something',
  'evrrything':'everything','everythibg':'everything','everthing':'everything',
  'probanly':'probably','probablt':'probably','probsbly':'probably',
  'actuslly':'actually','actualy':'actually','sctually':'actually',
  'definirely':'definitely','definirly':'definitely','definutely':'definitely',
  // --- more missing common typos ---
  'undrestand':'understand','undrestad':'understand','understnad':'understand',
  'undrstnd':'understand','understanf':'understand','undertsand':'understand',
  'webiste':'website','websit':'website','webisite':'website','webstie':'website',
  'langague':'language','lnaguage':'language','langiage':'language',
  'teh':'the','hte':'the','tge':'the','yhe':'the','rhe':'the',
  'ahve':'have','hvae':'have','ahev':'have',
  'peple':'people','poeple':'people','pepole':'people',
  'beacuse':'because','becasue':'because','becuase':'because',
  'knwo':'know','konw':'know','nkow':'know','kow':'know',
  'dosn\'t':'doesn\'t','doen\'t':'doesn\'t','doens\'t':'doesn\'t',
  'don;t':'don\'t','dont':'don\'t','donr':'don\'t','dint':'don\'t',
  'won;t':'won\'t','wont':'won\'t',
  'can;t':'can\'t','cant':'can\'t','acn\'t':'can\'t',
  'isn;t':'isn\'t','isnt':'isn\'t',
  'wasn;t':'wasn\'t','wasnt':'wasn\'t',
  'didn;t':'didn\'t','didnt':'didn\'t',
  'wouldn;t':'wouldn\'t','wouldnt':'wouldn\'t',
  'shouldn;t':'shouldn\'t','shouldnt':'shouldn\'t',
  'couldn;t':'couldn\'t','couldnt':'couldn\'t',
  'haven;t':'haven\'t','havent':'haven\'t',
  'hasn;t':'hasn\'t','hasnt':'hasn\'t',
  'weren;t':'weren\'t','werent':'weren\'t',
  'aren;t':'aren\'t','arent':'aren\'t',
  // --- more keyboard-adjacent / phonetic typos ---
  'halp':'help','helo':'hello','plz':'please','pls':'please',
  'thx':'thanks','ty':'thank you','np':'no problem',
  'quikc':'quick','quikly':'quickly','qucik':'quick','qiuck':'quick',
  'lzy':'lazy','lzay':'lazy',
  'ovr':'over','ovre':'over',
  'recieve':'receive','recieves':'receives',
  'adress':'address','adres':'address',
  'becuase':'because','becuz':'because',
  'togehter':'together','togather':'together',
  'diffrent':'different','differnt':'different',
  'seperate':'separate','seperately':'separately',
  'occured':'occurred','occurence':'occurrence',
  'buidl':'build','biuld':'build','buikd':'build',
  'recat':'react','raect':'react',
  'noed':'node','ndoe':'node','nodd':'node',
  // --- more missing common typos ---
  'ned':'need','nee':'need','nedd':'need',
  'workign':'working','workin':'working','workng':'working',
  'codeing':'coding','codign':'coding',
  'runnign':'running','runnin':'running',
  'gettign':'getting','gettin':'getting',
  'makign':'making','makin':'making',
  'takign':'taking','takin':'taking',
  'havign':'having','havin':'having',
  'lookign':'looking','lookin':'looking',
  'tryign':'trying','tryin':'trying',
  'goign':'going','goin':'going',
  'comign':'coming','comin':'coming',
  'doign':'doing','doin':'doing',
  'usign':'using','usin':'using',
  'givign':'giving','givin':'giving',
  'livign':'living','livin':'living',
  'movign':'moving','movin':'moving',
  'liek':'like','lkie':'like',
  'thnig':'thing','thign':'thing','thng':'thing',
  'smth':'something','sth':'something',
  'bc':'because','cuz':'because','coz':'because',
  'rly':'really','rlly':'really',
  'ppl':'people','govt':'government',
  'diff':'different','prob':'problem','probs':'problems',
  'obv':'obviously','tbf':'to be fair',
  'ngl':'not gonna lie','imo':'in my opinion','imho':'in my humble opinion',
  'afaik':'as far as I know','afaict':'as far as I can tell',
  'w/':'with','w/o':'without','b/c':'because',
};

// ── nspell-based spell correction (language-aware) ──
function nspellCorrect(word, lang) {
  const code = lang || 'en';
  const entry = spellers[code];
  if (!entry?.ready || !entry.speller) return null;
  const s = entry.speller;
  const lower = word.toLowerCase();
  if (lower.length < 2) return null;
  if (s.correct(lower)) return null;
  const suggestions = s.suggest(lower);
  if (suggestions.length > 0) return suggestions[0];
  return null;
}

class PromptOptimizer {
  constructor() {
    this.settings = {
      removeFillerWords: true,
      compressWhitespace: true,
      useAbbreviations: true,
      removeRedundancy: true,
      simplifyInstructions: true,
      removePoliteness: true,
      compressExamples: true,
      deduplicateContent: true,
      shortenPhrases: true,
      removeMetaLanguage: true,
      compressCodeBlocks: true,
      useImplicitContext: true,
      removeHedging: true,
      compressLists: true,
      correctTypos: true,
      aggressiveness: 'balanced', // 'light', 'balanced', 'aggressive'
    };
  }

  getSettings() {
    return { ...this.settings };
  }

  updateSettings(newSettings) {
    Object.assign(this.settings, newSettings);
  }

  optimize(text) {
    const originalLength = text.length;
    const originalTokenEstimate = this.estimateTokens(text);
    const suggestions = [];
    let optimized = text;

    // Lower threshold: optimize anything with 3+ words (or 5+ chars for CJK)
    const hasCJK = /[\u3040-\u9fff\uac00-\ud7af]/.test(text);
    const wordCount = text.trim().split(/\s+/).length;
    if (wordCount < 3 && !hasCJK) {
      return {
        optimized: text.trim(),
        stats: {
          originalChars: originalLength,
          optimizedChars: text.trim().length,
          originalTokens: originalTokenEstimate,
          optimizedTokens: this.estimateTokens(text.trim()),
          tokensSaved: 0,
          percentSaved: 0,
          techniquesApplied: [],
          language: 'en',
        },
        suggestions: this.generateSuggestions(text, []),
      };
    }

    const applied = [];
    const level = this.settings.aggressiveness;

    // Detect language
    const lang = detectLanguage(text);
    const isEnglish = lang === 'en';

    // Ensure speller is loaded for detected language
    if (DICT_PACKAGES[lang]) getSpeller(lang);

    // 0. Correct typos (all modes) — runs BEFORE code protection (has its own protection)
    if (this.settings.correctTypos) {
      const before = optimized;
      optimized = this.correctTyposFn(optimized, lang);
      if (optimized !== before) applied.push('Corrected typos');
    }

    // 1. Compress excessive whitespace (all modes)
    if (this.settings.compressWhitespace) {
      const before = optimized;
      optimized = optimized.replace(/\n{3,}/g, '\n\n');
      optimized = optimized.replace(/[ \t]{2,}/g, ' ');
      optimized = optimized.replace(/^\s+$/gm, '');
      if (optimized !== before) applied.push('Compressed whitespace');
    }

    // Protect code blocks from all remaining transformations
    const { text: textNoCode, blocks: codeBlocks } = this._protectCode(optimized);
    optimized = textNoCode;

    // === LIGHT mode: safe token reductions that preserve meaning 100% ===
    if (level === 'light') {
      // Contract formal expansions ("do not" -> "don't", "I am" -> "I'm")
      {
        const before = optimized;
        optimized = this.contractFormal(optimized);
        if (optimized !== before) applied.push('Contracted');
      }
      // "in order to" -> "to"
      {
        const before = optimized;
        optimized = optimized.replace(/\bin order to\b/gi, 'to');
        if (optimized !== before) applied.push('Shortened phrases');
      }
      // Remove greeting at start ("Hi, " / "Hello! " / "Hey there, ")
      {
        const before = optimized;
        optimized = optimized.replace(/^(hi|hello|hey)\s*(there|assistant|AI|Claude|GPT|ChatGPT)?[,!.]?\s*/im, '');
        if (optimized !== before) applied.push('Removed greeting');
      }
      // Remove closing thanks at end
      {
        const before = optimized;
        optimized = optimized.replace(/\b(thanks in advance|thank you in advance|thanks so much|thank you so much)\b[^.!?\n]*[.!?]?\s*$/gim, '');
        optimized = optimized.replace(/\b(thanks!?|thank you!?)\s*[.!]?\s*$/gim, '');
        if (optimized !== before) applied.push('Removed closing thanks');
      }
      // Remove "I hope you are doing well" type fluff
      {
        const before = optimized;
        optimized = optimized.replace(/\bI hope you('re| are) doing well\s*(\w+)?\s*[.!]?\s*/gi, '');
        if (optimized !== before) applied.push('Removed fluff');
      }
      // Wordy filler phrases
      {
        const before = optimized;
        optimized = optimized.replace(/\b(as a matter of fact|at the end of the day|for what it's worth|at this point in time)\b[,]?\s*/gi, '');
        if (optimized !== before) applied.push('Removed filler phrases');
      }
      // Re-capitalize after removals
      if (optimized.length > 0 && /^[a-z]/.test(optimized)) {
        optimized = optimized[0].toUpperCase() + optimized.slice(1);
      }
    }

    // === BALANCED + AGGRESSIVE ===
    if (level !== 'light') {
      // English-specific pattern-based optimizations
      if (isEnglish) {
        // 1. Self-context FIRST (before politeness eats sentence boundaries)
        {
          const before = optimized;
          optimized = this.removeSelfContext(optimized);
          if (optimized !== before) applied.push('Removed self-context');
        }

        // 2. Greetings/closings/politeness
        if (this.settings.removePoliteness) {
          const before = optimized;
          optimized = this.removePolitenessTokens(optimized);
          if (optimized !== before) applied.push('Removed politeness');
        }

        // 3. Convert questions to commands ("Can you explain..." -> "Explain...")
        {
          const before = optimized;
          optimized = this.questionToImperative(optimized);
          if (optimized !== before) applied.push('Converted to imperative');
        }

        if (this.settings.removeFillerWords) {
          const before = optimized;
          optimized = this.removeFillers(optimized);
          if (optimized !== before) applied.push('Removed filler words');
        }
        if (this.settings.removeHedging) {
          const before = optimized;
          optimized = this.removeHedgingLanguage(optimized);
          if (optimized !== before) applied.push('Removed hedging');
        }
        if (this.settings.removeMetaLanguage) {
          const before = optimized;
          optimized = this.removeMetaLang(optimized);
          if (optimized !== before) applied.push('Removed meta-language');
        }
        if (this.settings.shortenPhrases) {
          const before = optimized;
          optimized = this.shortenCommonPhrases(optimized);
          if (optimized !== before) applied.push('Shortened phrases');
        }
        if (this.settings.simplifyInstructions) {
          const before = optimized;
          optimized = this.simplifyInstr(optimized);
          if (optimized !== before) applied.push('Simplified vocabulary');
        }

        // Compress relative clauses ("that are", "which is")
        {
          const before = optimized;
          optimized = this.compressRelativeClauses(optimized);
          if (optimized !== before) applied.push('Compressed clauses');
        }

        // Collapse redundant modifier pairs ("clear and concise" -> "concise")
        {
          const before = optimized;
          optimized = this.collapseModifierPairs(optimized);
          if (optimized !== before) applied.push('Collapsed modifiers');
        }

        // Remove passive voice indicators ("it should be noted that")
        {
          const before = optimized;
          optimized = this.removePassiveIndicators(optimized);
          if (optimized !== before) applied.push('Removed passive voice');
        }
      }

      // ── Multilingual optimizations (non-English) ──
      if (!isEnglish) {
        // Remove greetings/closings/politeness in detected language
        {
          const before = optimized;
          optimized = this.multilingualPoliteness(optimized, lang);
          if (optimized !== before) applied.push('Removed politeness (' + lang + ')');
        }

        // Stopword removal (aggressive only)
        if (level === 'aggressive') {
          const before = optimized;
          optimized = this.removeStopwordsForLang(optimized, lang);
          if (optimized !== before) applied.push('Removed stopwords (' + lang + ')');
        }
      }

      if (this.settings.removeRedundancy) {
        const before = optimized;
        optimized = this.removeRedundantContent(optimized);
        if (optimized !== before) applied.push('Removed redundancy');
      }
      if (this.settings.deduplicateContent) {
        const before = optimized;
        optimized = this.deduplicateSentences(optimized);
        if (optimized !== before) applied.push('Deduplicated');
      }
      // Semantic deduplication: merge clauses with high word overlap
      {
        const before = optimized;
        optimized = deduplicateClauses(optimized);
        if (optimized !== before) applied.push('Merged similar clauses');
      }
      // Compress repeated phrases (e.g., "what should I do" appearing 3 times)
      {
        const before = optimized;
        optimized = compressRepeatedPhrases(optimized);
        if (optimized !== before) applied.push('Removed repeated phrases');
      }
      if (this.settings.compressLists) {
        const before = optimized;
        optimized = this.compressListFormat(optimized);
        if (optimized !== before) applied.push('Compressed lists');
      }
      if (this.settings.compressCodeBlocks) {
        const before = optimized;
        optimized = this.compressCode(optimized);
        if (optimized !== before) applied.push('Compressed code');
      }

      // ── NLP-powered: POS-based optimization (compromise — English only) ──
      if (isEnglish) {
        const before = optimized;
        optimized = this.nlpOptimize(optimized, level);
        if (optimized !== before) applied.push('NLP optimized');
      }

      // Numerals
      {
        const before = optimized;
        optimized = this.numeralize(optimized);
        if (optimized !== before) applied.push('Numeralized');
      }

      // Structured format
      {
        const before = optimized;
        optimized = this.convertToStructured(optimized);
        if (optimized !== before) applied.push('Structured format');
      }

      // Contract formal expansions ("do not" -> "don't")
      {
        const before = optimized;
        optimized = this.contractFormal(optimized);
        if (optimized !== before) applied.push('Contracted');
      }
    }

    // === AGGRESSIVE only ===
    if (level === 'aggressive') {
      if (this.settings.useAbbreviations) {
        const before = optimized;
        optimized = this.applyAbbreviations(optimized);
        if (optimized !== before) applied.push('Abbreviated terms');
      }
      {
        const before = optimized;
        optimized = this.stripMarkdownNoise(optimized);
        if (optimized !== before) applied.push('Stripped formatting');
      }
      // Aggressive: remove articles in instruction context
      {
        const before = optimized;
        optimized = this.removeArticles(optimized);
        if (optimized !== before) applied.push('Removed articles');
      }
      // Aggressive: extra abbreviations
      {
        const before = optimized;
        optimized = this.aggressiveAbbreviations(optimized);
        if (optimized !== before) applied.push('Extra abbreviations');
      }
      // Aggressive: remove casual address terms / filler interjections
      {
        const before = optimized;
        optimized = this.removeCasualAddress(optimized);
        if (optimized !== before) applied.push('Removed casual filler');
      }
      // Aggressive: telegraph-style compression (drop pronouns, copula, low-info words)
      {
        const before = optimized;
        optimized = this.telegraphCompress(optimized);
        if (optimized !== before) applied.push('Telegraph compressed');
      }
      // Aggressive: consolidate repeated/similar questions into one
      {
        const before = optimized;
        optimized = this.consolidateQuestions(optimized);
        if (optimized !== before) applied.push('Consolidated questions');
      }
      // Aggressive: drop low-information filler sentences
      {
        const before = optimized;
        optimized = this.dropLowInfoSentences(optimized);
        if (optimized !== before) applied.push('Dropped low-info');
      }
    }

    // Restore code blocks before final cleanup
    optimized = this._restoreCode(optimized, codeBlocks);

    // Final cleanup
    optimized = optimized
      .replace(/\n{3,}/g, '\n\n')
      .replace(/ {2,}/g, ' ')
      .replace(/\.\s*\./g, '.')
      .replace(/^\s*[,.:]\s*/gm, '')
      .replace(/\s+([,.])/g, '$1')
      .replace(/^\s+/gm, (m) => m.includes('\n') ? m : ' ')
      .trim();

    // Capitalize first letter and after sentence boundaries
    if (optimized.length > 0 && /^[a-z]/.test(optimized)) {
      optimized = optimized[0].toUpperCase() + optimized.slice(1);
    }
    optimized = optimized.replace(/([.!?]\s+)([a-z])/g, (_, sep, c) => sep + c.toUpperCase());

    // Remove trailing dangling conjunctions/commas
    optimized = optimized.replace(/[,]\s*$/, '.').replace(/\b(and|also|but|or|additionally|furthermore|moreover)\s*[,.]?\s*$/i, '').trim();

    const optimizedTokenEstimate = this.estimateTokens(optimized);
    const saved = originalTokenEstimate - optimizedTokenEstimate;
    const percentage = originalTokenEstimate > 0
      ? Math.round((saved / originalTokenEstimate) * 100)
      : 0;

    suggestions.push(...this.generateSuggestions(text, applied));

    return {
      optimized,
      stats: {
        originalChars: originalLength,
        optimizedChars: optimized.length,
        originalTokens: originalTokenEstimate,
        optimizedTokens: optimizedTokenEstimate,
        tokensSaved: saved,
        percentSaved: percentage,
        techniquesApplied: applied,
        language: lang,
      },
      suggestions,
    };
  }

  estimateTokens(text) {
    const words = text.split(/\s+/).filter(Boolean).length;
    const punctuation = (text.match(/[^\w\s]/g) || []).length;
    // CJK characters are ~1-2 tokens each (not space-delimited)
    const cjkCount = (text.match(/[\u3040-\u9fff\uac00-\ud7af]/g) || []).length;
    if (cjkCount > 0) {
      return Math.ceil(cjkCount * 1.5 + words * 1.3 + punctuation * 0.5);
    }
    return Math.ceil(words * 1.3 + punctuation * 0.5);
  }

  // ── Protect code blocks, inline code, and URLs during transformations ──
  _protectCode(text) {
    const blocks = [];
    // 1. Triple-backtick code blocks
    let result = text.replace(/```[\s\S]*?```/g, (m) => {
      blocks.push(m);
      return `__CB_${blocks.length - 1}__`;
    });
    // 2. Inline code (single backticks)
    result = result.replace(/`[^`]+`/g, (m) => {
      blocks.push(m);
      return `__CB_${blocks.length - 1}__`;
    });
    // 3. URLs (http/https/ftp, bare domains like www.example.com)
    result = result.replace(/(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>\"')\]]+/gi, (m) => {
      blocks.push(m);
      return `__CB_${blocks.length - 1}__`;
    });
    return { text: result, blocks };
  }

  _restoreCode(text, blocks) {
    if (!blocks.length) return text;
    return text.replace(/__CB_(\d+)__/g, (m, i) => {
      const idx = parseInt(i);
      return idx < blocks.length ? blocks[idx] : m;
    });
  }

  correctTyposFn(text, lang) {
    const { text: safe, blocks } = this._protectCode(text);
    const isEn = (!lang || lang === 'en');

    // Get nspell instance for edit-distance candidate validation
    const entry = spellers[lang || 'en'];
    const nspellInst = (entry?.ready && entry.speller) ? entry.speller : null;

    // Fix split-word typos first (e.g. "int he" → "in the")
    let result = safe;
    for (const [bad, good] of SPLIT_TYPOS) {
      result = result.replace(bad, good);
    }

    // Always run TYPOS dictionary first (language-independent — catches common English typos)
    result = spellCorrect(result, TYPOS, isEn ? nspellInst : null);

    if (!isEn) {
      // Non-English: also run nspell for the detected language
      result = result.replace(/\b[a-zA-Z\u00C0-\u024F]+\b/g, (word) => {
        const lower = word.toLowerCase();
        const nsFix = nspellCorrect(lower, lang || 'en');
        if (nsFix) {
          if (word[0] === word[0].toUpperCase() && word.length > 1) {
            return nsFix[0].toUpperCase() + nsFix.slice(1);
          }
          return nsFix;
        }
        return word;
      });
    }

    return this._restoreCode(result, blocks);
  }

  // ── NEW: Remove self-referential context ──
  removeSelfContext(text) {
    const patterns = [
      // Full self-intro sentences: "I am a developer working on X."
      /\bI('m| am) (a |an )?[\w\s]*(developer|engineer|designer|student|researcher|writer|manager|analyst|consultant)\b[^.!?\n]*[.!?]\s*/gi,
      // "I'm working on a project." (full sentence)
      // "I'm currently working on a project." — only when followed by generic nouns, not specific technical content
      /\bI('m| am) (currently )?(working on|building|creating|developing|writing) (a |an |my |this |the )?(project|app|application|website|tool|thing|something|task)\b[^.!?\n]*[.!?]\s*/gi,
      // "I have a project where I need..." — strip preamble, keep the need
      /\bI have (a |an )?(project|task|problem|issue|question|situation)\b[^.!?\n]*?(where |that |and )(I need|I want|I('m| am))\s*/gi,
      // "My goal is to" -> ""
      /\b(my goal is to|my objective is to|what I'm trying to do is)\s*/gi,
      // "I'm looking for a way to" -> ""
      /\bI('m| am) looking for (a |an )?(way|method|approach|solution) to\s*/gi,
      // "I want to know how to X" → "how to X"
      /\bI (want|need|would like) to (know|understand|learn|find out) (how|what|where|when|why|if|whether)\b\s*/gi,
    ];

    let result = text;
    for (const p of patterns) {
      result = result.replace(p, '');
    }
    return result.replace(/ {2,}/g, ' ');
  }

  // ── NEW: Convert questions to imperative ──
  questionToImperative(text) {
    // These patterns work at start of text OR after sentence boundaries
    const patterns = [
      // "Can you please help me write..." -> "Write..."
      [/((?:^|[.!?]\s+))(Can|Could|Would|Will) you (please )?(help me )?(to )?/gi, '$1'],
      // "Can you explain how..." -> "Explain how..."
      [/((?:^|[.!?]\s+))(Can|Could|Would|Will) you (please )?(explain|describe|show|tell me|list|provide|create|write|generate|analyze|review|summarize|compare)/gi, '$1$4'],
      // "How do I..." -> "How to..."
      [/((?:^|[.!?]\s+))How (do|can|should|would) I\b/gi, '$1How to'],
      // "What is the best way to..." -> "Best way to..."
      [/((?:^|[.!?]\s+))What('s| is) the best (way|approach|method) to\b/gi, '$1Best $3 to'],
      // "Is it possible to..." -> ""
      [/((?:^|[.!?]\s+))Is it possible (to|for you to)\s*/gi, '$1'],
      // "Do you know how to..." -> "How to..."
      [/((?:^|[.!?]\s+))Do you know (how to|if|whether)\b/gi, '$1$2'],
      // "I was wondering if you could..." -> ""
      [/\bI was wondering if you could\s*/gi, ''],
      // "I would like you to..." -> ""
      [/\bI would like (you to|to ask you to)\s*/gi, ''],
      // "I need you to..." -> ""
      [/\bI need (you to|help with)\s*/gi, ''],
      // "I want you to..." -> ""
      [/\bI want you to\s*/gi, ''],
      // "What should I start with?" → "Where to start?"
      [/((?:^|[.!?]\s+))what should I (start|begin) with\??/gi, '$1Where to $2?'],
      // "What should I do next?" → "Next steps?"
      [/((?:^|[.!?]\s+))what should I do next\??/gi, '$1Next steps?'],
      // "What should I do to..." → "How to..."
      [/((?:^|[.!?]\s+))what should I do (to|about|for|with)\b/gi, '$1How $2'],
      // "What do I need to..." → "Need to..."
      [/((?:^|[.!?]\s+))what do I need to\b/gi, '$1'],
      // "How should I..." → "How to..."
      [/((?:^|[.!?]\s+))how should I\b/gi, '$1How to'],
    ];

    let result = text;
    for (const [p, r] of patterns) {
      result = result.replace(p, r);
    }
    return result.replace(/ {2,}/g, ' ');
  }

  removeFillers(text) {
    const fillers = [
      /\b(basically|essentially|actually|literally|really|very|quite|rather|somewhat|simply|obviously|clearly|of course|naturally|certainly|definitely|absolutely|totally|completely|entirely|perfectly|honestly|frankly|truthfully)\b\s*/gi,
      /\b(I think that|I believe that|I feel like|it seems like|it appears that|it looks like)\s*/gi,
      /\b(in order to)\b/gi,
      /\b(as a matter of fact)\s*/gi,
      /\b(at the end of the day)\s*/gi,
      /\b(the thing is)\s*/gi,
      /\b(for what it's worth)\s*/gi,
      /\b(at this point in time)\s*/gi,
      /\b(in my opinion)\s*/gi,
      /\b(as far as I'm concerned)\s*/gi,
      /\b(to be honest)\s*/gi,
      /\b(the fact of the matter is)\s*/gi,
      /\b(when it comes to)\s*/gi,
      /\b(as you (probably |may )?know)\s*/gi,
    ];

    let result = text;
    for (const pattern of fillers) {
      result = result.replace(pattern, (match) => {
        if (/in order to/i.test(match)) return 'to';
        return '';
      });
    }
    return result.replace(/ {2,}/g, ' ');
  }

  removePolitenessTokens(text) {
    const patterns = [
      // Greetings at start of text (full sentence)
      /^(hi|hello|hey|dear|greetings)\s*(there|assistant|AI|Claude|GPT|ChatGPT)?[,!.]?\s*/im,
      // "I hope you are doing well" / "I hope you're doing well today" — full phrase
      /\bI hope you('re| are) doing well\s*(\w+)?\s*[.!]?\s*/gi,
      // Standalone "please" at start of sentence or before verb — safe to remove
      /(?:^|\.\s+)please\s+/gim,
      // "kindly" is always filler
      /\bkindly\b\s*/gi,
      // Full standalone politeness phrases (won't break grammar)
      /\bif you don't mind[,.]?\s*/gi,
      /\bwould you mind\b\s*/gi,
      /\bif it's not too much trouble[,.]?\s*/gi,
      // "I'd appreciate..." / "I would be grateful..." — full clause
      /\bI('d| would) (\w+ )?(appreciate|be grateful)\b[^.!?\n]*[.!?]?\s*/gi,
      // Closings — thanks at end
      /\b(thanks in advance|thank you in advance|thanks so much|thank you so much)\b[^.!?\n]*[.!?]?\s*$/gim,
      /\b(thanks!?|thank you!?)\s*[.!]?\s*$/gim,
      // Apologies
      /\b(sorry to bother you|sorry for the long (prompt|message|question)|apologies for)\b[^.]*?[.]?\s*/gi,
      // Hope phrases at end
      /\b(I hope (this|that) makes sense|let me know if you have (any )?questions|I hope you can help)\s*[.!]?\s*/gi,
      // "If that's okay with you" / "if that's okay"
      /\b(if that'?s (okay|ok|fine))(\s+with you)?\s*[.!]?\s*/gi,
      // "if thats okay with you" (without apostrophe)
      /\bif thats (okay|ok|fine)(\s+with you)?\s*[.!]?\s*/gi,
    ];

    let result = text;
    for (const p of patterns) {
      result = result.replace(p, '');
    }
    return result.replace(/ {2,}/g, ' ').replace(/^\s*[,.:]\s*/gm, '');
  }

  removeHedgingLanguage(text) {
    const hedges = [
      // Only remove hedges that are standalone/don't break grammar
      /\b(perhaps|possibly|could potentially)\b\s*/gi,
      /\b(I'm not (entirely )?sure (but|if))\s*[,]?\s*/gi,
      /\b(sort of|kind of|more or less|to some extent|to some degree)\b\s*/gi,
      // "I was wondering if you could help me" → "Help me" (replace full phrase including verb)
      /\bI was (just )?wondering if you could\s*/gi,
      /\bI was (just )?wondering if it would be possible (for you )?to\s*/gi,
      /\bI was (just )?wondering if\s*/gi,
      /\b(I guess|I suppose|I imagine)\b\s*/gi,
      // "if possible" only at end of clause/sentence
      /[,]?\s*if possible\s*([.!?]|$)/gi,
      /[,]?\s*if that makes sense\s*([.!?]|$)/gi,
    ];

    let result = text;
    for (const p of hedges) {
      result = result.replace(p, (match, ...args) => {
        // Preserve sentence-ending punctuation
        const full = match;
        const puncMatch = full.match(/[.!?]\s*$/);
        return puncMatch ? puncMatch[0] : '';
      });
    }
    return result.replace(/ {2,}/g, ' ');
  }

  removeMetaLang(text) {
    const patterns = [
      /\b(I want you to|I need you to|I'd like you to)\b\s*/gi,
      /\b(I want to|I need to|I'd like to)\b\s*/gi,
      /\b(what I mean is|what I'm trying to say is|let me explain)\b\s*/gi,
      /\b(the following is|below is|here is|here are)\b\s*/gi,
      /\b(as I mentioned (earlier|before|above)|as stated above|as previously (noted|mentioned))\b\s*/gi,
      /\b(to clarify|to be more specific|to elaborate)\b[,]?\s*/gi,
      /\b(make sure (to|that)|be sure to|don't forget to|remember to)\b\s*/gi,
      /\b(I want to emphasize that|it's important to note that|it's worth noting that)\b\s*/gi,
      /\b(keep in mind that|bear in mind that|note that)\b\s*/gi,
      // Casual meta: "what should I do" / "tell me what to do" / "help me with"
      /\bwhat should I do\b\s*/gi,
      /\btell me (what|how) (to|I should)\b\s*/gi,
      /\bhelp me (with (it|this|that)|to)\b\s*/gi,
      /\bwhat (do|should|can|could) I do (to|about|with|next|first|here)\b\s*/gi,
      /\bI don't know (what|how|where) to\b\s*/gi,
    ];

    let result = text;
    for (const p of patterns) {
      result = result.replace(p, '');
    }
    return result.replace(/ {2,}/g, ' ');
  }

  shortenCommonPhrases(text) {
    const replacements = [
      [/\bin the event that\b/gi, 'if'],
      [/\bdue to the fact that\b/gi, 'because'],
      [/\bfor the purpose of\b/gi, 'for'],
      [/\bin the process of\b/gi, 'while'],
      [/\bwith regard to\b/gi, 'about'],
      [/\bwith respect to\b/gi, 'about'],
      [/\bin relation to\b/gi, 'about'],
      [/\bin terms of\b/gi, 'for'],
      [/\bon the other hand\b/gi, 'but'],
      [/\bin addition to\b/gi, 'and'],
      [/\bas well as\b/gi, 'and'],
      [/\ba large number of\b/gi, 'many'],
      [/\ba significant (amount|number) of\b/gi, 'much'],
      [/\bthe majority of\b/gi, 'most'],
      [/\bin spite of\b/gi, 'despite'],
      [/\btake into (account|consideration)\b/gi, 'consider'],
      [/\bmake a decision\b/gi, 'decide'],
      [/\bgive an explanation\b/gi, 'explain'],
      [/\bprovide a description\b/gi, 'describe'],
      [/\bhas the ability to\b/gi, 'can'],
      [/\bis able to\b/gi, 'can'],
      [/\bat this point in time\b/gi, 'now'],
      [/\bat the present time\b/gi, 'now'],
      [/\bprior to\b/gi, 'before'],
      [/\bsubsequent to\b/gi, 'after'],
      [/\bin the near future\b/gi, 'soon'],
      [/\bfor the reason that\b/gi, 'because'],
      [/\bin light of the fact that\b/gi, 'since'],
      [/\bregardless of the fact that\b/gi, 'although'],
      [/\bin a situation where\b/gi, 'when'],
      [/\bit is important to note that\b/gi, ''],
      [/\bit should be noted that\b/gi, ''],
      [/\bit is worth mentioning that\b/gi, ''],
      [/\bneedless to say\b/gi, ''],
      [/\bit goes without saying\b/gi, ''],
      // New high-impact additions
      [/\bon a (daily|regular|weekly|monthly) basis\b/gi, '$1'],
      [/\bin a timely manner\b/gi, 'quickly'],
      [/\ba wide range of\b/gi, 'various'],
      [/\ba variety of\b/gi, 'various'],
      [/\bin the context of\b/gi, 'in'],
      [/\bwith the exception of\b/gi, 'except'],
      [/\bin conjunction with\b/gi, 'with'],
      [/\bin close proximity to\b/gi, 'near'],
      [/\bin the absence of\b/gi, 'without'],
      [/\bin the amount of\b/gi, 'for'],
      [/\bin the case of\b/gi, 'for'],
      [/\bin such a way that\b/gi, 'so that'],
      [/\bby means of\b/gi, 'using'],
      [/\bon the basis of\b/gi, 'based on'],
      [/\bfor the sake of\b/gi, 'for'],
      [/\bin an effort to\b/gi, 'to'],
      [/\bwith the goal of\b/gi, 'to'],
      [/\bas a result of\b/gi, 'from'],
      [/\bat the same time\b/gi, 'while'],
      [/\beach and every\b/gi, 'every'],
      [/\bfirst and foremost\b/gi, 'first'],
      [/\bone and only\b/gi, 'only'],
      [/\bany and all\b/gi, 'all'],
      [/\bif and when\b/gi, 'if'],
      [/\bunless and until\b/gi, 'until'],
      [/\bin an attempt to\b/gi, 'to'],
      [/\bwith the intention of\b/gi, 'to'],
      [/\bfor the most part\b/gi, 'mostly'],
      [/\bup to this point\b/gi, 'so far'],
      [/\bat this moment in time\b/gi, 'now'],
      [/\bin the foreseeable future\b/gi, 'soon'],
      [/\bon a regular basis\b/gi, 'regularly'],
      [/\bmake an attempt\b/gi, 'try'],
      [/\breach a conclusion\b/gi, 'conclude'],
      [/\bcome to a decision\b/gi, 'decide'],
      [/\btake action\b/gi, 'act'],
      [/\bgive consideration to\b/gi, 'consider'],
      [/\bhave a preference for\b/gi, 'prefer'],
      [/\bmake an improvement\b/gi, 'improve'],
      [/\bperform a search\b/gi, 'search'],
      [/\bprovide assistance\b/gi, 'help'],
      [/\bmake a modification\b/gi, 'modify'],
      [/\bthe reason (why|that|for this) is\b/gi, 'because'],
      // Casual/conversational → concise
      [/\bI was hoping (you could|to)\b/gi, ''],
      [/\bI('m| am) trying to (figure out|understand|learn)\b/gi, ''],
      [/\bI('m| am) not sure (how|what|where|when|why|if|whether)\b/gi, '$2'],
      [/\bcan you walk me through\b/gi, 'explain'],
      [/\bcan you give me (a |an )?(quick |brief )?(overview|summary|rundown) of\b/gi, 'summarize'],
      [/\bwhat is the best way to\b/gi, 'best way to'],
      [/\bhow do I go about\b/gi, 'how to'],
      [/\bI have a question about\b/gi, 'about:'],
      [/\bthe thing (that |which )?I('m| am) (struggling|having trouble|having issues) with is\b/gi, ''],
      [/\bI('m| am) (looking|searching|trying) to find\b/gi, 'find'],
      [/\bwhat (exactly |)do(es)? .{0,5} mean\b/gi, 'define'],
      [/\bI('m| am) (a bit |somewhat |really )?(confused|lost|stuck) (about|on|with)\b/gi, ''],
      [/\bas quickly as possible\b/gi, 'fast'],
      [/\bas much as possible\b/gi, 'max'],
      [/\bas soon as possible\b/gi, 'ASAP'],
      [/\btake a look at\b/gi, 'check'],
      [/\bget rid of\b/gi, 'remove'],
      [/\bcome up with\b/gi, 'create'],
      [/\bfigure out\b/gi, 'determine'],
      [/\bput together\b/gi, 'assemble'],
      [/\bset up\b/gi, 'configure'],
      [/\bgo through\b/gi, 'review'],
      [/\bpoint out\b/gi, 'note'],
      [/\bbring up\b/gi, 'mention'],
      [/\bbreak down\b/gi, 'analyze'],
      [/\bnarrow down\b/gi, 'filter'],
    ];

    let result = text;
    for (const [pattern, replacement] of replacements) {
      result = result.replace(pattern, replacement);
    }
    return result.replace(/ {2,}/g, ' ');
  }

  simplifyInstr(text) {
    const replacements = [
      [/\bprovide me with\b/gi, 'give'],
      [/\bprovide a detailed\b/gi, 'give a detailed'],
      [/\bgenerate a comprehensive\b/gi, 'create a full'],
      [/\bwrite a detailed and comprehensive\b/gi, 'write a thorough'],
      [/\bperform an analysis of\b/gi, 'analyze'],
      [/\bconduct an analysis of\b/gi, 'analyze'],
      [/\bperform a review of\b/gi, 'review'],
      [/\bcarry out\b/gi, 'do'],
      [/\butilize\b/gi, 'use'],
      [/\bfacilitate\b/gi, 'help'],
      [/\bdemonstrate\b/gi, 'show'],
      [/\bindicate\b/gi, 'show'],
      [/\bnevertheless\b/gi, 'still'],
      [/\bfurthermore\b/gi, 'also'],
      [/\badditionally\b/gi, 'also'],
      [/\bmoreover\b/gi, 'also'],
      [/\bhowever\b/gi, 'but'],
      [/\btherefore\b/gi, 'so'],
      [/\bconsequently\b/gi, 'so'],
      [/\baccordingly\b/gi, 'so'],
      [/\bsubsequently\b/gi, 'then'],
      [/\bapproximate(ly)?\b/gi, 'about'],
      [/\bnumerous\b/gi, 'many'],
      [/\bsufficient\b/gi, 'enough'],
      [/\bcommence\b/gi, 'start'],
      [/\bterminate\b/gi, 'end'],
      [/\bascertain\b/gi, 'find out'],
      [/\bendeavor\b/gi, 'try'],
      // New additions
      [/\bimplement\b/gi, 'build'],
      [/\bdetermine\b/gi, 'find'],
      [/\bestablish\b/gi, 'set up'],
      [/\bcommunicate\b/gi, 'tell'],
      [/\bassistance\b/gi, 'help'],
      [/\brequirement(s)?\b/gi, 'need$1'],
      [/\bfunctionality\b/gi, 'feature'],
      [/\bmethodology\b/gi, 'method'],
      [/\bpurchase\b/gi, 'buy'],
      [/\binquire\b/gi, 'ask'],
      [/\bpossess\b/gi, 'have'],
      [/\bencounter\b/gi, 'find'],
      [/\bsignificant\b/gi, 'big'],
      [/\binsufficient\b/gi, 'not enough'],
      [/\bsubstantial\b/gi, 'large'],
      [/\binitiate\b/gi, 'start'],
      [/\bconclude\b/gi, 'end'],
      [/\boptimal\b/gi, 'best'],
      [/\bprimary\b/gi, 'main'],
    ];

    let result = text;
    for (const [pattern, replacement] of replacements) {
      result = result.replace(pattern, replacement);
    }
    return result;
  }

  // ── Multilingual politeness/greeting/closing removal ──
  multilingualPoliteness(text, lang) {
    const patterns = {
      fr: [
        /^(bonjour|salut|bonsoir|cher|chère)\s*[,!.]?\s*/im,
        /\b(s'il vous plaît|s il vous plaît|s'il te plaît|je vous prie)\b\s*/gi,
        /\b(je voudrais que vous|j'aimerais que vous|pourriez-vous|pouvez-vous)\s*/gi,
        /\b(merci d'avance|merci beaucoup|merci!?|cordialement)\s*[.!]?\s*$/gim,
        /\b(je vous serais reconnaissant|je vous remercie)\b[^.]*[.!]?\s*/gi,
      ],
      es: [
        /^(hola|buenos días|buenas tardes|buenas noches|estimado|estimada)\s*[,!.]?\s*/im,
        /\b(por favor|le agradecería|me gustaría que)\b\s*/gi,
        /\b(podrías|podría usted|sería tan amable de)\s*/gi,
        /\b(gracias de antemano|muchas gracias|gracias!?)\s*[.!]?\s*$/gim,
        /\b(le agradezco|agradezco su ayuda)\b[^.]*[.!]?\s*/gi,
      ],
      de: [
        /^(hallo|guten tag|guten morgen|guten abend|lieber|liebe|sehr geehrte[r]?)\s*[,!.]?\s*/im,
        /\b(bitte|könnten sie|würden sie|ich möchte sie bitten)\b\s*/gi,
        /\b(ich hätte gerne|ich würde gerne|ich möchte gerne)\b\s*/gi,
        /\b(vielen dank|danke im voraus|danke!?|mit freundlichen grüßen)\s*[.!]?\s*$/gim,
        /\b(ich wäre ihnen dankbar)\b[^.]*[.!]?\s*/gi,
      ],
      pt: [
        /^(olá|bom dia|boa tarde|boa noite|prezado|prezada)\s*[,!.]?\s*/im,
        /\b(por favor|eu gostaria que|poderia)\b\s*/gi,
        /\b(obrigado|obrigada|muito obrigado|agradeço)\s*[.!]?\s*$/gim,
      ],
      it: [
        /^(ciao|buongiorno|buonasera|gentile|egregio)\s*[,!.]?\s*/im,
        /\b(per favore|per cortesia|vorrei che|potrebbe)\b\s*/gi,
        /\b(grazie mille|grazie in anticipo|grazie!?|cordiali saluti)\s*[.!]?\s*$/gim,
      ],
      ru: [
        /^(здравствуйте|привет|добрый день|уважаемый|уважаемая)\s*[,!.]?\s*/im,
        /(пожалуйста|не могли бы вы|я хотел бы попросить)\s*/gi,
        /(заранее спасибо|спасибо!?|с уважением)\s*[.!]?\s*$/gim,
      ],
      zh: [
        /^(你好|您好)[，,。!]?\s*/m,
        /(请你?|麻烦你?|能否|可以帮我)/g,
        /(谢谢|非常感谢|多谢)[。！!]?\s*$/gm,
      ],
      ja: [
        /^(こんにちは|こんばんは|おはようございます)[、,。!]?\s*/m,
        /(お願いします|していただけますか)/g,
        /(ありがとうございます|よろしくお願いします)[。！!]?\s*$/gm,
      ],
      ko: [
        /^(안녕하세요|안녕)[,!.]?\s*/m,
        /(부탁드립니다|해주세요)/g,
        /(감사합니다)[.!]?\s*$/gm,
      ],
    };

    const langPatterns = patterns[lang];
    if (!langPatterns) return text;

    let result = text;
    for (const p of langPatterns) {
      result = result.replace(p, '');
    }
    return result.replace(/ {2,}/g, ' ').trim();
  }

  // ── Multilingual stopword removal ──
  removeStopwordsForLang(text, lang) {
    const list = STOPWORD_LISTS[lang];
    if (!list) return text;
    const words = text.split(/\s+/);
    const filtered = removeStopwords(words, list);
    // Don't remove too aggressively — keep at least 60% of words
    if (filtered.length < words.length * 0.6) return text;
    return filtered.join(' ');
  }

  // ── NLP-powered optimization using compromise ──
  nlpOptimize(text, level) {
    // Protect code blocks from NLP processing
    const { text: safe, blocks } = this._protectCode(text);

    try {
      const doc = nlp(safe);

      // BALANCED + AGGRESSIVE: Remove adverbs that don't add meaning
      // (compromise tags them as #Adverb)
      // Keep important adverbs: "not", "never", "always", "only", "also", negations
      const keepAdverbs = new Set([
        'not', 'never', 'always', 'only', 'also', 'still', 'already', 'yet',
        'here', 'there', 'where', 'when', 'how', 'why', 'then', 'now',
        'no', 'too', 'either', 'neither', 'instead', 'otherwise',
        'first', 'next', 'finally', 'again', 'once',
      ]);
      doc.adverbs().filter(a => {
        const word = a.text().toLowerCase().trim();
        return !keepAdverbs.has(word);
      }).remove();

      // BALANCED + AGGRESSIVE: Convert passive voice to active
      try { doc.verbs().toActive(); } catch(e) { /* some verbs may fail */ }

      // AGGRESSIVE: Remove determiners ("the", "a", "an") before common nouns in instruction context
      if (level === 'aggressive') {
        // Remove interjections ("oh", "wow", "well", etc.)
        doc.match('#Interjection').remove();
      }

      let result = doc.text();

      // Clean up artifacts from adverb removal
      result = result
        .replace(/\band\s+and\b/gi, 'and')        // "and and" -> "and"
        .replace(/\bshould\s+and\b/gi, 'should')   // "should and" -> "should"
        .replace(/\b(and|or)\s+while\b/gi, 'while') // "and while" -> "while"
        .replace(/\b(and|or)\s+(and|or)\b/gi, '$1') // "and or" -> "and"
        .replace(/\bmore\s+and\b/gi, 'and')         // "more and" -> "and"
        .replace(/ {2,}/g, ' ')
        .trim();

      return this._restoreCode(result, blocks);
    } catch (e) {
      // If NLP fails, return original text
      return text;
    }
  }

  // ── NEW: Compress relative clauses ──
  compressRelativeClauses(text) {
    const patterns = [
      // "files that are larger than" -> "files larger than"
      [/\bthat (is|are|was|were) /gi, ''],
      // "which is/are" (non-essential)
      [/,?\s*which (is|are|was|were) /gi, ' '],
      // "who is/are"
      [/\bwho (is|are) /gi, ''],
    ];

    const { text: safe, blocks } = this._protectCode(text);
    let result = safe;
    for (const [p, r] of patterns) {
      result = result.replace(p, r);
    }
    return this._restoreCode(result, blocks).replace(/ {2,}/g, ' ');
  }

  // ── NEW: Collapse redundant modifier pairs ──
  collapseModifierPairs(text) {
    const pairs = [
      [/\bclear and concise\b/gi, 'concise'],
      [/\bthorough and comprehensive\b/gi, 'thorough'],
      [/\baccurate and correct\b/gi, 'accurate'],
      [/\bbrief and succinct\b/gi, 'brief'],
      [/\bnew and innovative\b/gi, 'innovative'],
      [/\bbasic and fundamental\b/gi, 'fundamental'],
      [/\bfull and complete\b/gi, 'complete'],
      [/\bsimple and easy\b/gi, 'simple'],
      [/\bsimple and straightforward\b/gi, 'simple'],
      [/\bnull and void\b/gi, 'void'],
      [/\bplain and simple\b/gi, 'simple'],
      [/\beach and every\b/gi, 'every'],
      [/\bvarious different\b/gi, 'various'],
      [/\bcompletely (unique|different|new|separate)\b/gi, '$1'],
      [/\babsolutely (essential|necessary|certain|sure)\b/gi, '$1'],
      [/\bvery (unique|essential|necessary|complete|perfect|ideal)\b/gi, '$1'],
      [/\bhighly (recommend|suggest)\b/gi, '$1'],
      [/\bextremely (important|useful|helpful)\b/gi, '$1'],
    ];

    let result = text;
    for (const [p, r] of pairs) {
      result = result.replace(p, r);
    }
    return result;
  }

  // ── NEW: Remove passive voice indicators ──
  removePassiveIndicators(text) {
    const patterns = [
      /\bit (should|can|must|may) be (noted|seen|observed|stated|said|argued|mentioned) that\s*/gi,
      /\bit (has been|was) (determined|found|discovered|established|shown|proven|demonstrated) that\s*/gi,
      /\bit is (generally|widely|commonly|often|usually) (accepted|known|believed|understood|recognized) that\s*/gi,
      /\bit is (recommended|suggested|advised|important) (that you |to )/gi,
    ];

    let result = text;
    for (const p of patterns) {
      result = result.replace(p, '');
    }
    return result.replace(/ {2,}/g, ' ');
  }

  // ── NEW: Contract formal expansions ──
  contractFormal(text) {
    const { text: safe, blocks } = this._protectCode(text);
    const contractions = [
      [/\bdo not\b/gi, "don't"],
      [/\bdoes not\b/gi, "doesn't"],
      [/\bdid not\b/gi, "didn't"],
      [/\bwill not\b/gi, "won't"],
      [/\bcannot\b/gi, "can't"],
      [/\bcan not\b/gi, "can't"],
      [/\bwould not\b/gi, "wouldn't"],
      [/\bshould not\b/gi, "shouldn't"],
      [/\bcould not\b/gi, "couldn't"],
      [/\bis not\b/gi, "isn't"],
      [/\bare not\b/gi, "aren't"],
      [/\bwas not\b/gi, "wasn't"],
      [/\bwere not\b/gi, "weren't"],
      [/\bhas not\b/gi, "hasn't"],
      [/\bhave not\b/gi, "haven't"],
      [/\bhad not\b/gi, "hadn't"],
      [/\bI am\b/g, "I'm"],
      [/\bI have\b/g, "I've"],
      [/\bI will\b/g, "I'll"],
      [/\bI would\b/g, "I'd"],
      [/\byou are\b/gi, "you're"],
      [/\bthey are\b/gi, "they're"],
      [/\bit is\b/gi, "it's"],
      [/\bthat is\b/gi, "that's"],
      [/\bwhat is\b/gi, "what's"],
      [/\bwho is\b/gi, "who's"],
      [/\bthere is\b/gi, "there's"],
    ];

    let result = safe;
    for (const [p, r] of contractions) {
      result = result.replace(p, r);
    }
    return this._restoreCode(result, blocks);
  }

  // ── NEW: Remove articles in instruction context (aggressive only) ──
  removeArticles(text) {
    const { text: safe, blocks } = this._protectCode(text);
    // Only remove "the" before common nouns in instruction-like sentences
    // Be careful: don't remove from "the United States", "the only", etc.
    let result = safe;
    // Remove "the" before common words (not before proper nouns or special phrases)
    result = result.replace(/\bthe (?=(following|above|below|same|other|next|previous|first|second|third|last|result|output|input|code|file|data|text|list|table|function|method|class|object|array|string|number|value|key|response|request|error|user|system|server|client|page|app|application|api|database|query|model))/gi, '');
    // Remove "a/an" before common instruction nouns
    result = result.replace(/\b(a|an) (?=(list|set|series|collection|group|number|pair|type|kind|sort|form|way|method|approach|solution|example|instance|function|script|program|tool|feature|option|version|copy|summary|overview|description|explanation|comparison|review|analysis|report|guide|tutorial|demo|test|plan|draft))/gi, '');
    return this._restoreCode(result, blocks).replace(/ {2,}/g, ' ');
  }

  // ── NEW: Extra aggressive abbreviations ──
  aggressiveAbbreviations(text) {
    const { text: safe, blocks } = this._protectCode(text);
    const abbrevs = [
      [/\bfor example\b/gi, 'e.g.'],
      [/\bthat is to say\b/gi, 'i.e.'],
      [/\b(and so on|and so forth|et cetera)\b/gi, 'etc.'],
      [/\bas soon as possible\b/gi, 'ASAP'],
      [/\bwith reference to\b/gi, 're:'],
      [/\bversus\b/gi, 'vs.'],
      [/\bapproximately\b/gi, '~'],
      [/\bmaximum\b/gi, 'max'],
      [/\bminimum\b/gi, 'min'],
      [/\boriginal\b/gi, 'orig'],
      [/\bspecification(s)?\b/gi, 'spec$1'],
      [/\btemporary\b/gi, 'temp'],
      [/\bprevious\b/gi, 'prev'],
      [/\bcurrent\b/gi, 'curr'],
      [/\bsource\b/gi, 'src'],
      [/\bdestination\b/gi, 'dest'],
      [/\bmessage(s)?\b/gi, 'msg$1'],
      [/\bresponse(s)?\b/gi, 'resp$1'],
      [/\bcommand(s)?\b/gi, 'cmd$1'],
      [/\boperation(s)?\b/gi, 'op$1'],
      [/\bintroduction\b/gi, 'intro'],
      [/\bexplanation\b/gi, 'explain'],
      [/\bimplementation\b/gi, 'impl'],
      [/\bperformance\b/gi, 'perf'],
    ];

    let result = safe;
    for (const [p, r] of abbrevs) {
      result = result.replace(p, r);
    }
    return this._restoreCode(result, blocks);
  }

  // ── Remove casual address terms, interjections, filler ──
  removeCasualAddress(text) {
    const patterns = [
      // Casual address: "babe", "dude", "man", "bro", "buddy", "mate", "fam"
      /\b(babe|bro|dude|buddy|mate|fam|dawg|homie|bestie)\b[,!.]?\s*/gi,
      // Interjections: "hey", "oh", "wow", "well", "so", "like", "um", "uh"
      /\b(hey|oh|wow|huh|hmm|umm?|uhh?|ahh?|ooh|yay|nah|meh)\b[,!.]?\s*/gi,
      // Rambling connectors: "you know", "I mean", "like I said"
      /\b(you know|I mean|like I said|as I said|like)\b[,]?\s*/gi,
      // Trailing "right?" / "yeah?" / "ok?" / "you know?"
      /[,\s]+(right|yeah|ok|okay|you know)\s*\?\s*/gi,
      // "Hey help me with it" → "help me with it" (strip leading "hey")
      /^hey\s+/im,
    ];

    let result = text;
    for (const p of patterns) {
      result = result.replace(p, ' ');
    }
    return result.replace(/ {2,}/g, ' ').trim();
  }

  // ── Telegraph-style compression (aggressive) ──
  // Inspired by LLMLingua's approach of removing low-information tokens,
  // but implemented as rule-based patterns. Strips pronouns, copula verbs,
  // and filler structure words that LLMs can infer from context.
  telegraphCompress(text) {
    const { text: safe, blocks } = this._protectCode(text);
    let result = safe;

    // Remove subject pronouns before verbs (LLMs infer the speaker)
    // "I want" → "want", "I need" → "need", "I have" → "have"
    result = result.replace(/\bI (want|need|have|think|believe|know|see|feel|like|love|hate|hope|wish|expect|prefer|suggest|recommend|assume|understand|mean|guess|suppose|wonder|notice|remember|forget|realize|imagine|consider|tried?)\b/gi, '$1');

    // "It is/was" + adj → adj (copula drop)
    result = result.replace(/\bit (is|was|seems|appears|looks|feels) (like )?(a |an )?(very |really |quite )?([\w]+)/gi, '$5');
    // "There is/are" → drop
    result = result.replace(/\bthere (is|are|was|were) (a |an |some |many |several )?([\w]+)/gi, '$3');

    // "I am/was" → drop when followed by verb-ing
    result = result.replace(/\bI (am|was|'m) (\w+ing)\b/gi, '$2');

    // "You can/could/should" → verb directly
    result = result.replace(/\byou (can|could|should|might|may|will|would) (also )?(just )?(use|try|check|look|see|read|write|run|add|set|get|find|make|do|go|put|take|give|call|send|open|close|start|stop|move|create|build|install|update|change|remove|delete|test|debug|fix|deploy)\b/gi, '$4');

    // "We need to" / "You need to" → verb
    result = result.replace(/\b(we|you) (need|have|want) to\b/gi, '');

    // "In order to" → "to"
    result = result.replace(/\bin order to\b/gi, 'to');

    // "It would be good/nice/helpful to" → ""
    result = result.replace(/\bit (would|could) be (good|nice|great|helpful|useful|better|best|ideal) (to|if)\s*/gi, '');

    // "The way to do this is" → ""
    result = result.replace(/\bthe (way|trick|key|secret|solution|answer) (to do this |here |)(is|is to)\s*/gi, '');

    // "What you want to do is" → ""
    result = result.replace(/\bwhat (you|we|I) (want|need|have|should) to do is\s*/gi, '');

    // "As you can see" / "As mentioned" → drop
    result = result.replace(/\bas (you can see|I said|mentioned|noted|shown|stated|described|explained)\b[,]?\s*/gi, '');

    // "That being said" / "Having said that" → drop
    result = result.replace(/\b(that being said|having said that|with that being said|that said)\b[,]?\s*/gi, '');

    // "The thing is" / "The point is" → drop
    result = result.replace(/\bthe (thing|point|issue|problem|question|idea|concept|key|main thing) is (that )?\s*/gi, '');

    // "When it comes to" → "for"
    result = result.replace(/\bwhen it comes to\b/gi, 'for');

    // "In this case" / "In that case" → drop or shorten
    result = result.replace(/\bin (this|that|which|any) case[,]?\s*/gi, '');

    // "As a result" → "so"
    result = result.replace(/\bas a result\b/gi, 'so');

    // "On the other hand" → "but"
    result = result.replace(/\bon the other hand\b/gi, 'but');

    // "At the end of the day" → drop
    result = result.replace(/\bat the end of the day\b/gi, '');

    // "I've been [verb]ing for X time" → drop time reference
    result = result.replace(/\b(I've|I have) been \w+ing (for|since) [^,.!?]+[,.]?\s*/gi, '');

    // "I've tried everything" → "tried everything"
    result = result.replace(/\bI('ve| have) (tried|checked|looked|tested|verified|confirmed|attempted)\b/gi, '$2');

    // "I can't figure out" → "can't find"
    result = result.replace(/\bI? ?can't (figure out|understand|find|determine|tell)\b/gi, "can't find");

    // "nothing works" / "nothing helped" → keep (meaningful)
    // "OK so" / "So basically" / "Alright so" → drop
    result = result.replace(/\b(OK|okay|alright|right) so\b[,]?\s*/gi, '');
    result = result.replace(/\bso (basically|essentially|like)\b[,]?\s*/gi, '');

    // "for like a week/month/day" → drop vague time references
    result = result.replace(/\bfor (like |about |around )?(a |an )?(week|month|day|while|few days|few hours|long time|bit)\b/gi, '');

    // "I even tried" → "tried"
    result = result.replace(/\bI (even |also )?(tried|checked|tested|ran|used|added|removed|changed)\b/gi, '$2');

    // "everything I can think of" → "everything"
    result = result.replace(/\beverything I can think of\b/gi, 'everything');

    // "any advice you could give me" → "advice"
    result = result.replace(/\bany (advice|help|suggestions?|tips?|guidance|feedback) (you could|you can) (give|offer|provide)( me)?\b/gi, '$1');

    return this._restoreCode(result, blocks).replace(/ {2,}/g, ' ').trim();
  }

  // ── Consolidate similar questions ──
  // Detects multiple questions about the same topic and merges them.
  // "What should I do? How do I start? Where do I begin?" → "How to start?"
  consolidateQuestions(text) {
    // Extract all question segments
    const questionPattern = /[^.!?\n]*\?/g;
    const questions = text.match(questionPattern);
    if (!questions || questions.length < 2) return text;

    // Group questions by similarity (word overlap)
    const groups = [];
    const used = new Set();

    for (let i = 0; i < questions.length; i++) {
      if (used.has(i)) continue;
      const group = [i];
      const wordsI = new Set(questions[i].toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 2));

      for (let j = i + 1; j < questions.length; j++) {
        if (used.has(j)) continue;
        const wordsJ = new Set(questions[j].toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 2));
        const overlap = [...wordsI].filter(w => wordsJ.has(w)).length;
        const minSize = Math.min(wordsI.size, wordsJ.size);
        if (minSize > 0 && overlap / minSize >= 0.4) {
          group.push(j);
          used.add(j);
        }
      }
      used.add(i);
      groups.push(group);
    }

    // If no consolidation possible, return as-is
    if (groups.every(g => g.length === 1)) return text;

    // Replace duplicate question groups: keep shortest question from each group
    let result = text;
    for (const group of groups) {
      if (group.length < 2) continue;
      // Keep the shortest question (most concise)
      const sorted = group.map(i => questions[i]).sort((a, b) => a.length - b.length);
      const keep = sorted[0].trim();
      // Remove duplicates (all except shortest)
      for (let k = 1; k < sorted.length; k++) {
        result = result.replace(sorted[k], '');
      }
    }

    return result.replace(/ {2,}/g, ' ').replace(/[,;]\s*[,;]/g, ',').trim();
  }

  // ── Drop low-information sentences ──
  // Sentences that are mostly filler/meta without substantive content.
  // Uses a simple self-information heuristic: ratio of content words to total words.
  dropLowInfoSentences(text) {
    const FILLER_WORDS = new Set([
      'i','me','my','you','your','we','our','it','its','the','a','an',
      'is','am','are','was','were','be','been','being','do','does','did',
      'have','has','had','will','would','could','should','can','may','might',
      'to','of','in','for','on','with','at','by','from','up','out','so',
      'and','but','or','if','that','this','just','also','very','really',
      'much','well','still','too','here','there','then','now','want','need',
      'know','think','like','get','go','come','make','take','see','look',
      'give','tell','say','try','help','let','please','about','what','how',
      'when','where','who','why','which','not','no','any','some','all',
    ]);

    // Split into sentences
    const parts = text.split(/([.!?]+\s*)/);
    if (parts.length < 4) return text; // need at least 2 sentences

    const sentences = [];
    for (let i = 0; i < parts.length; i += 2) {
      sentences.push((parts[i] || '') + (parts[i + 1] || ''));
    }

    if (sentences.length < 3) return text; // need 3+ sentences to drop any

    // Score each sentence: ratio of content words (non-filler) to total
    const scored = sentences.map(s => {
      const words = s.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean);
      if (words.length === 0) return { s, score: 0, words: 0 };
      const contentWords = words.filter(w => !FILLER_WORDS.has(w) && w.length > 2);
      return { s, score: contentWords.length / words.length, words: words.length };
    });

    // Drop sentences with very low content ratio (< 0.15) and few words
    // But never drop the first sentence or sentences with proper nouns / technical terms
    const kept = scored.filter((item, idx) => {
      if (idx === 0) return true; // always keep first
      if (item.words < 3) return false; // tiny fragments after other processing
      if (item.score < 0.1 && item.words < 8) return false; // very low info, short
      return true;
    });

    if (kept.length === scored.length) return text;
    return kept.map(item => item.s).join(' ').replace(/ {2,}/g, ' ').trim();
  }

  removeRedundantContent(text) {
    const hasPeriods = /[.!?]/.test(text);
    const splitter = hasPeriods ? /(?<=[.!?])\s+/ : /,\s*/;
    const joiner = hasPeriods ? ' ' : ', ';
    const clauses = text.split(splitter);
    const seen = new Map();
    const filtered = [];

    for (const clause of clauses) {
      const normalized = clause.toLowerCase().replace(/[^\w\s]/g, '').trim();
      if (!normalized || normalized.split(/\s+/).length < 3) {
        filtered.push(clause);
        continue;
      }
      const words = new Set(normalized.split(/\s+/));

      let isDuplicate = false;
      for (const [, existingWords] of seen) {
        const overlap = [...words].filter(w => existingWords.has(w)).length;
        const similarity = overlap / Math.max(words.size, existingWords.size);
        if (similarity > 0.75) {
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate) {
        seen.set(normalized, words);
        filtered.push(clause);
      }
    }

    return filtered.join(joiner);
  }

  deduplicateSentences(text) {
    const { text: safe, blocks } = this._protectCode(text);
    const lines = safe.split('\n');
    const seen = new Set();
    const result = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !seen.has(trimmed.toLowerCase())) {
        if (trimmed) seen.add(trimmed.toLowerCase());
        result.push(line);
      }
    }

    return this._restoreCode(result.join('\n'), blocks);
  }

  compressListFormat(text) {
    return text
      .replace(/^\s*[-•]\s+/gm, '- ')
      .replace(/^\s*(\d+)\.\s+/gm, '$1. ');
  }

  compressCode(text) {
    return text.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
      let compressed = code
        .replace(/^\s*\/\/\s*.*$/gm, '')
        .replace(/^\s*#\s*.*$/gm, (line) => {
          if (/^#!/.test(line.trim())) return line;
          return '';
        })
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      return '```' + lang + '\n' + compressed + '\n```';
    });
  }

  applyAbbreviations(text) {
    const abbrevs = [
      [/\bfunction\b/g, 'fn'],
      [/\bapplication\b/gi, 'app'],
      [/\bconfiguration\b/gi, 'config'],
      [/\bdocumentation\b/gi, 'docs'],
      [/\brepository\b/gi, 'repo'],
      [/\bdirectory\b/gi, 'dir'],
      [/\bparameter(s)?\b/gi, 'param$1'],
      [/\bargument(s)?\b/gi, 'arg$1'],
      [/\binformation\b/gi, 'info'],
      [/\benvironment\b/gi, 'env'],
      [/\bdevelopment\b/gi, 'dev'],
      [/\bproduction\b/gi, 'prod'],
      [/\bauthentication\b/gi, 'auth'],
      [/\bauthorization\b/gi, 'authz'],
      [/\bdatabase\b/gi, 'DB'],
    ];

    const { text: safe, blocks } = this._protectCode(text);
    let result = safe;
    for (const [pattern, replacement] of abbrevs) {
      result = result.replace(pattern, replacement);
    }
    return this._restoreCode(result, blocks);
  }

  convertToStructured(text) {
    let result = text;
    result = result.replace(
      /\b[Tt]he (first|second|third|fourth|fifth) (?:thing|point|step|item) is\s+/g,
      (_, ordinal) => {
        const map = { first: '1', second: '2', third: '3', fourth: '4', fifth: '5' };
        return (map[ordinal] || '–') + '. ';
      }
    );
    return result;
  }

  stripMarkdownNoise(text) {
    const { text: safe, blocks } = this._protectCode(text);
    let result = safe;
    result = result.replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1');
    result = result.replace(/_{1,2}([^_]+)_{1,2}/g, '$1');
    result = result.replace(/^#{1,4}\s+/gm, '');
    return this._restoreCode(result, blocks);
  }

  numeralize(text) {
    const wordToNum = {
      'zero': '0', 'one': '1', 'two': '2', 'three': '3', 'four': '4',
      'five': '5', 'six': '6', 'seven': '7', 'eight': '8', 'nine': '9',
      'ten': '10', 'eleven': '11', 'twelve': '12', 'thirteen': '13',
      'fourteen': '14', 'fifteen': '15', 'sixteen': '16', 'seventeen': '17',
      'eighteen': '18', 'nineteen': '19', 'twenty': '20', 'thirty': '30',
      'forty': '40', 'fifty': '50', 'hundred': '100', 'thousand': '1000',
    };
    return text.replace(
      /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|hundred|thousand)\b/gi,
      (match) => wordToNum[match.toLowerCase()] || match
    );
  }

  generateSuggestions(originalText, applied) {
    const suggestions = [];

    if (originalText.length > 2000) {
      suggestions.push({
        type: 'structure',
        text: 'Consider breaking this into smaller, focused prompts for better results and lower cost.',
      });
    }

    if (/```[\s\S]{500,}```/.test(originalText)) {
      suggestions.push({
        type: 'code',
        text: 'Large code blocks detected. Include only the relevant snippet instead of the full file.',
      });
    }

    if ((originalText.match(/\b(make sure|ensure|remember|don\'t forget|important)\b/gi) || []).length > 3) {
      suggestions.push({
        type: 'redundancy',
        text: 'Multiple emphasis/reminder phrases detected. State each instruction once clearly.',
      });
    }

    if (/\b(you are|act as|pretend|your role is)\b/i.test(originalText) && originalText.length > 500) {
      suggestions.push({
        type: 'system',
        text: 'Move role/persona instructions to a system prompt to reuse across messages.',
      });
    }

    const exampleCount = (originalText.match(/\b(example|e\.g\.|for instance|such as)\b/gi) || []).length;
    if (exampleCount > 3) {
      suggestions.push({
        type: 'examples',
        text: `${exampleCount} example markers found. Reduce to 1-2 examples — LLMs generalize well from minimal demonstrations.`,
      });
    }

    if (/\b(User:|Human:|Assistant:|AI:)\b/g.test(originalText) && originalText.length > 1500) {
      suggestions.push({
        type: 'history',
        text: 'Conversation history detected. Summarize older turns instead of including full history.',
      });
    }

    if (originalText.length > 3000) {
      suggestions.push({
        type: 'caching',
        text: 'Long prompt — use API prompt caching (Anthropic/OpenAI) to save 90% on repeated prefixes.',
      });
    }

    if (originalText.length < 200 && !/\b(complex|analyze|reason|step.by.step)\b/i.test(originalText)) {
      suggestions.push({
        type: 'routing',
        text: 'Simple prompt — consider routing to a smaller model (Haiku/GPT-4o-mini) for lower cost.',
      });
    }

    if (applied.length === 0) {
      suggestions.push({
        type: 'info',
        text: 'Prompt is already concise. No significant optimizations found.',
      });
    }

    return suggestions;
  }
}

module.exports = { PromptOptimizer, TYPOS };
