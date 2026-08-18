// ── Farm localization (Chinese-first → English) ───────────────────────────────
// farm.html was written Chinese-first: its labels, toasts and tooltips are Chinese
// string literals, many assembled at runtime ('💧 一键浇水！+' + n + '块地'). The
// static DOM-walk in i18n.js only translates registered ENGLISH text, so it can't
// reach any of it — Farm stayed Chinese no matter the app language.
//
// This module is the inverse layer: when the app is NOT in Chinese, it rewrites
// Farm's text back to English.
//   • Replacement is by SUBSTRING, longest key first, because the visible text is
//     often a concatenation of a Chinese prefix, a number, and a Chinese suffix —
//     exact-match would miss every one of those.
//   • A MutationObserver re-runs it, since the board re-renders constantly.
// Unknown strings simply stay as they are, so a new label never renders blank.
(function () {
  'use strict';

  const ZH_EN = {
    // ── static markup: toolbar, dialogs, shop tabs ──
    // These live as element text in farm.html rather than string literals, so the
    // literal-scan that seeded this file missed every one of them.
    '一键收获': 'Harvest all', '一键浇水': 'Water all', '一键除虫': 'Clear pests',
    '一键收': 'Harvest', '一键水': 'Water',
    '收割': 'Harvest', '浇水': 'Water', '施肥': 'Fertilize', '铲除': 'Remove',
    '商店': 'Shop', '农场商店': 'Farm shop', '出售': 'Sell', '出售作物': 'Sell crops',
    '任务': 'Tasks', '每日任务': 'Daily tasks', '装饰': 'Decor', '地皮': 'Land',
    '选择种子': 'Choose a seed', '确认铲除': 'Confirm removal',
    '种子费用不退还': 'Seed cost is not refunded',
    '要开始钓鱼吗？': 'Start fishing?', '开钓！': 'Cast!', '发现鱼群！': 'Fish spotted!',
    '升级！': 'Level up!', '开垦': 'Clear land', '消灭': 'Clear',
    '黄金丰收！': 'Golden harvest!', '太棒了！': 'Nice!', '好的！': 'OK', '算了': 'Cancel',
    '取消': 'Cancel', '返回': 'Back', '次': '×',

    // ── chrome / nav ──
    '返回 · Back': 'Back',
    '点击清除所有害虫/杂草': 'Click to clear all pests / weeds',
    '点击展开农场': 'Click to expand the farm',
    '每日任务': 'Daily tasks',
    '缩小': 'Zoom out',

    // ── tile states ──
    '还未开垦！点击商店→土地解锁更多格子': 'Not cleared yet! Shop → Land to unlock more plots',
    '空地 — 先从顶部选种子': 'Empty plot — pick a seed up top first',
    '空水格 — 先从顶部拖拽水生作物种植': 'Empty water tile — drag an aquatic crop from the top',
    '空地无需清理': 'Nothing to clear on an empty plot',
    '已成熟，先收割！': 'Ripe — harvest it first!',
    '还没成熟！再等等': 'Not ripe yet — give it time',
    '已成熟不需施肥': 'Already ripe, no fertilizer needed',
    '此阶段已施过肥': 'Already fertilized at this stage',
    '枯萎了！用铲子清除后再种': 'Withered! Clear it with the shovel, then replant',
    '先用铲子清除枯萎': 'Clear the withered crop with the shovel first',
    '先收割！再清除': 'Harvest first, then clear',
    '已铲除作物': 'Crop removed',
    '确定铲除': 'Remove',
    '水生作物只能种在水池里': 'Aquatic crops can only go in water',
    '拖到水中格子': 'drag it onto a water tile',
    '此作物只能种在草地上': 'This crop can only go on grass',
    '水中种植': 'Plant in water',
    '已选：': 'Selected: ',
    '— 点击空地种植': '— click an empty plot to plant',
    '才能种植': ' to plant ',
    '需要 Lv.': 'Requires Lv.',
    '(需要 Lv.': '(requires Lv.',

    // ── status chips ──
    '💧 缺水': '💧 Needs water',
    '🐛 有害虫': '🐛 Pests',
    '🌿 有杂草': '🌿 Weeds',
    '💀 已枯萎': '💀 Withered',
    '✅ 已成熟！': '✅ Ripe!',
    '成熟✓': 'Ripe ✓',
    '可施肥': 'Can fertilize',
    '枯萎': 'Withered',
    '✓熟': '✓ripe',
    '缺水': 'Dry',
    '生命': 'Health',
    '剩余': 'Left',

    // ── actions / toasts ──
    '除虫成功！+': 'Pests cleared! +',
    '除草成功！+': 'Weeds cleared! +',
    '浇水成功 +': 'Watered +',
    '施肥加速！消耗': 'Fertilized! Cost ',
    '种植成功！+': 'Planted! +',
    '清除枯萎 +': 'Cleared withered +',
    '购买成功！': 'Purchased!',
    '土地升级！': 'Land upgraded!',
    '开垦成功！消耗': 'Cleared! Cost ',
    '请先点击空地块再来商店升级': 'Select an empty plot first, then upgrade in the shop',
    '丰收币不足！出售作物来赚取': 'Not enough harvest coins — sell crops to earn more',
    '卖出': 'Sell',
    '全部，+': 'all, +',
    '清除 +': 'Clear +',
    '浇水 +': 'Water +',

    // ── bulk actions ──
    '🎉 一键收获！共 +': '🎉 Harvest all! +',
    '💧 一键浇水！+': '💧 Water all! +',
    '🐛 已除虫除草！+': '🐛 Pests & weeds cleared! +',
    '🌾 一键收获(': '🌾 Harvest all (',
    '💧 一键浇水(': '💧 Water all (',
    '🐛 一键除虫(': '🐛 Clear pests (',
    '没有成熟的作物': 'No ripe crops',
    '没有缺水的作物': 'No thirsty crops',
    '没有虫害或杂草': 'No pests or weeds',

    // ── alerts ──
    '块地出现害虫！快用铲子处理': ' plots have pests — use the shovel',
    '块地长了杂草！快去除草': ' plots have weeds — clear them',
    '株作物已枯萎！用铲子清理再种': ' crops withered — clear and replant',
    '块作物成熟啦！快来收割': ' crops are ripe — harvest them',
    '🌟 黄金丰收！': '🌟 Golden harvest!',
    '🌱 新解锁作物：': '🌱 New crop unlocked: ',
    '继续努力，更多作物等你来解锁！': 'Keep going — more crops to unlock!',
    '🎉 升级！Lv.': '🎉 Level up! Lv.',
    '达成！': ' complete!',
    '🎣 升到 Lv.': '🎣 Reach Lv.',
    '即可在水中种植水生作物！': ' to plant aquatic crops in water!',

    // ── shop / economy ──
    '· 种费': ' · seed cost ',
    '· 水生（种在水池）': ' · aquatic (plant in water)',
    '🌾丰收币': '🌾 Harvest coins',
    '金币': 'Coins',
    'XP→升级': 'XP → level up',

    // ── weather ──
    '☀ 晴天': '☀ Clear', '☁ 多云': '☁ Cloudy', '🌧 下雨': '🌧 Rain',
    '⛈ 雷雨': '⛈ Storm', '💨 刮风': '💨 Windy', '🌫 起雾': '🌫 Fog',
    '❄ 下雪': '❄ Snow', '🌦 小雨': '🌦 Drizzle', '🌡 高温': '🌡 Heat',
    '🌅 日落': '🌅 Sunset',

    // ── fishing ──
    '🎣 钓鱼中...': '🎣 Fishing…',
    '🐟 鱼跑了！': '🐟 It got away!',
    '这次没钓到...': 'No catch this time…',
    '🎉 钓到了！': '🎉 Caught one! ',
    '草鱼': 'Grass carp', '鲫鱼': 'Crucian carp', '泥鳅': 'Loach', '鲢鱼': 'Silver carp',
    '鳊鱼': 'Bream', '罗非鱼': 'Tilapia', '金鱼': 'Goldfish', '黄鳝': 'Rice eel',
    '鲶鱼': 'Catfish', '黑鱼': 'Snakehead', '青鱼': 'Black carp', '锦鲤': 'Koi',
    '虹鳟': 'Rainbow trout', '鲈鱼': 'Bass', '大马哈鱼': 'Salmon', '河豚': 'Pufferfish',
    '鳜鱼': 'Mandarin fish', '龙鱼': 'Arowana', '金枪鱼': 'Tuna',
    '神仙锦鲤': 'Divine koi', '幽灵鱼': 'Ghost fish', '大乌龟': 'Giant turtle',
    '普通': 'Common', '稀有': 'Rare', '珍稀': 'Epic', '传说': 'Legendary',

    // ── daily tasks ──
    '收获作物 5 次': 'Harvest 5 times',
    '浇水 3 次': 'Water 3 times',
    '施肥 2 次': 'Fertilize twice',
    '种植 5 颗种子': 'Plant 5 seeds',
    '消灭 3 只害虫': 'Clear 3 pests',
    '钓到 1 条鱼': 'Catch 1 fish',
    '✓已领取': '✓ Claimed',
    '🎁 领取奖励！+': '🎁 Reward claimed! +',
    '🎁 领取': '🎁 Claim',

    // ── crops, land and decorations (emitted by src-tauri/src/farm_store.rs) ──
    // These arrive from Rust already in Chinese and land straight in the DOM, so the
    // text walker reaches them here — no Rust change needed.
    '万寿菊':'Marigold', '三色堇':'Pansy', '五彩花圃':'Flower bed', '兰花':'Orchid',
    '凤凰花':'Flame tree', '南瓜':'Pumpkin', '向日葵':'Sunflower', '哈密瓜':'Cantaloupe',
    '四季豆':'Green beans', '圆白菜':'Cabbage', '土豆':'Potato', '地涌金莲':'Golden lotus',
    '大蒜':'Garlic', '大蘑菇':'Giant mushroom', '小麦':'Wheat', '彩虹辣椒':'Rainbow chili',
    '星光甜瓜':'Starlight melon', '月亮莲':'Moon lotus', '杨桃':'Starfruit', '桂花树':'Osmanthus',
    '桃子':'Peach', '桃花树':'Peach blossom', '梅花树':'Plum blossom', '梨子':'Pear',
    '棉花':'Cotton', '椰子':'Coconut', '樱桃':'Cherry', '樱花树':'Cherry blossom',
    '橙子':'Orange', '水晶莓':'Crystal berry', '洋葱':'Onion', '火龙果':'Dragon fruit',
    '牡丹花':'Peony', '牵牛花':'Morning glory', '玉米':'Corn', '玫瑰花':'Rose',
    '生菜':'Lettuce', '白萝卜':'Daikon', '百合花':'Lily', '睡莲':'Water lily',
    '石榴':'Pomegranate', '空心菜':'Water spinach', '紫罗兰':'Violet', '红薯':'Sweet potato',
    '翠竹':'Bamboo', '胡萝卜':'Carrot', '芋头':'Taro', '芒果':'Mango', '芦笋':'Asparagus',
    '花椰菜':'Cauliflower', '花生':'Peanut', '苹果':'Apple', '茄子':'Eggplant',
    '草莓':'Strawberry', '荔枝':'Lychee', '荷花':'Lotus', '荸荠':'Water chestnut',
    '莲藕':'Lotus root', '菊花':'Chrysanthemum', '菠菜':'Spinach', '菠萝':'Pineapple',
    '葡萄':'Grapes', '蒲公英':'Dandelion', '蓝莓':'Blueberry', '薰衣草':'Lavender',
    '蘑菇':'Mushroom', '西兰花':'Broccoli', '西瓜':'Watermelon', '西红柿':'Tomato',
    '辣椒':'Chili', '郁金香':'Tulip', '雏菊':'Daisy', '韭菜':'Chives', '香瓜':'Muskmelon',
    '香蕉':'Banana', '魔法甜瓜':'Magic melon', '黄瓜':'Cucumber', '黄金番茄':'Golden tomato',
    '龙眼':'Longan', '松树':'Pine', '枫叶树':'Maple', '彩虹':'Rainbow',
    // land tiers
    '默认土地':'Default soil', '黄土地':'Loam', '红土地':'Red soil', '黑土地':'Black soil',
    '金土地':'Golden soil', '水晶土地':'Crystal soil', '紫晶土地':'Amethyst soil',
    '翡翠土地':'Jade soil', '仙灵土地':'Fae soil', '已达最大土地规模':'Already at max land tier',
    // decorations
    '稻草人':'Scarecrow', '木栅栏':'Wood fence', '爱心造型木栅栏':'Heart-shaped fence',
    '小木屋':'Cabin', '温馨的田园小屋':'Cosy country cottage', '小池塘':'Pond',
    '清澈的小鱼塘':'Clear fish pond', '古井':'Old well', '古朴的石砌水井':'Rustic stone well',
    '水车':'Water wheel', '古风转动水车':'Turning water wheel', '风车':'Windmill',
    '旋转的风车':'Spinning windmill', '谷仓':'Barn', '丰收的大谷仓':'Harvest barn',
    '凉亭':'Pavilion', '江南水乡风格凉亭':'Riverside pavilion', '小喷泉':'Fountain',
    '叮咚的小喷泉':'Trickling fountain', '石拱门':'Stone arch',
    '爬满藤蔓的石拱门':'Vine-covered stone arch', '梦幻彩虹拱门':'Rainbow arch',
    '玻璃温室':'Greenhouse', '高科技玻璃温室':'High-tech greenhouse',
    '蜂巢':'Beehive', '勤劳的蜜蜂':'Busy bees', '小狗窝':'Dog house',
    '可爱的狗狗小屋':'Cute dog house', '红灯笼':'Red lantern', '喜庆的红灯笼':'Festive lanterns',
    '热气球':'Hot-air balloon', '彩色热气球高空漫游':'Drifting hot-air balloon',
    '神奇的大蘑菇':'Magic mushroom', '秋日金红枫叶树':'Autumn maple',
    '驱鸟守护农场':'Scares birds away', '花坛':'Flower bed',
    // interpolated messages from Rust ({} placeholders survive replacement)
    '需要 {} 丰收币，当前 {}':'Needs {} harvest coins — you have {}',
    '需要 {} 级才能种植 {}':'Requires level {} to plant {}',
    '需要 {} 金币才能施肥':'Needs {} coins to fertilize',
    '先清除枯萎植物':'Clear the withered plant first',
    '先用铲子清除枯萎作物':'Clear the withered crop with the shovel first',
    '只能在水中种植水生作物':'Aquatic crops can only be planted in water',
    '还没成熟':'Not ripe yet',
    '产量翻倍！生长 -35%':'Double yield! Growth -35%',

    // ── units + bare terms (last: shortest keys, so longer phrases match first) ──
    // '产量'/'生长' carry interpolated percentages ("产量 +45%  生长 -20%"), so they
    // have to match as bare terms rather than whole phrases.
    '产量': 'Yield', '生长': 'Growth',
    '解锁': 'Unlock',
    '小时': 'h',
    '分钟': 'min',
    '块地': ' plots',
    '个': '',
  };

  // Longest key first so '💧 一键浇水！+' wins over '浇水 +', and '块地' never
  // eats the tail of a phrase that already matched.
  const KEYS = Object.keys(ZH_EN).sort((a, b) => b.length - a.length);
  const CJK = /[一-鿿]/;

  function toEnglish(s) {
    if (!s || !CJK.test(s)) return s;
    let out = s;
    for (const k of KEYS) {
      if (out.indexOf(k) !== -1) out = out.split(k).join(ZH_EN[k]);
    }
    return out;
  }

  function isChinese() {
    try {
      const l = window.i18n && window.i18n.getLang();
      if (l) return l === 'zh-Hans' || l === 'zh-Hant';
    } catch (e) {}
    return (navigator.language || '').toLowerCase().indexOf('zh') === 0;
  }

  let running = false;
  function apply() {
    if (running || isChinese()) return;     // Chinese is the source text — leave it
    running = true;                          // guard: our own writes retrigger the observer
    try {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const hits = [];
      let n;
      while ((n = walker.nextNode())) if (CJK.test(n.nodeValue)) hits.push(n);
      hits.forEach((t) => { const v = toEnglish(t.nodeValue); if (v !== t.nodeValue) t.nodeValue = v; });
      // Tooltips are attributes, not text nodes.
      document.querySelectorAll('[title]').forEach((el) => {
        const v = toEnglish(el.getAttribute('title'));
        if (v !== el.getAttribute('title')) el.setAttribute('title', v);
      });
    } finally { running = false; }
  }

  function start() {
    apply();
    new MutationObserver(() => { if (!running) apply(); })
      .observe(document.body, { childList: true, subtree: true, characterData: true });
    window.addEventListener('terse-lang-changed', apply);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.__farmI18n = { apply, toEnglish };   // exposed for tests
})();
