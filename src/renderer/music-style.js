/**
 * music-style.js —— 歌词粒子的可调项(一张表,页面和壁纸共用)。
 *
 * 项目是照 Mineradio 的「视觉控制台 → 歌词外观」挑的(字间距/字重、歌词大小、
 * 水平/垂直位置、歌词颜色/高亮颜色、歌词溢光、鼓点溢光、歌词光粒、边缘渐隐、歌词动画),
 * 只留下在**壁纸**这个场景里真正有意义的那些 —— 它那套还有"景深位置/上下角度/左右角度",
 * 那是给它自己的 3D 舞台用的;我们这一层是贴着壁纸画的,加了也没地方可去。
 *
 * ⚠ 控件由这张表**生成**,不是手写的。手写一个十几项的面板,迟早会漏掉一项,
 *   而漏掉的那一项没人会发现(壁纸的自定义面板就是这个教训,见 wallpaper-styles.js)。
 */

export const MUSIC_DEFAULTS = {
  density: 1.0,      // 粒子密度(1 = 和 agent 粒子字同一档:每句 6 万颗)
  size: 1.0,         // 歌词大小
  dot: 1.0,          // 粒子大小
  x: 0.0,            // 水平位置(屏宽的比例,0 = 居中)
  y: 0.72,           // 垂直位置(屏高的比例)
  color: '#E8F4FF',  // 歌词颜色(还没唱到的那半截)
  highlight: '#C9F03D', // 高亮颜色(已经唱过的)
  glow: 0.8,         // 歌词溢光
  beatGlow: 0.9,     // 鼓点溢光(每句出现时鼓一下)
  stars: 420,        // 歌词光粒(绕着字流的那条星河;Mineradio 原值 420)
  flow: 1.0,         // 光粒流速
  weight: 800,       // 字重
  tracking: 0.0,     // 字间距
  fade: 0.05,        // 边缘渐隐(按**字的实际范围**算,所以 0.12 会把头尾两个字吃掉)
  breath: 1.0,       // 歌词动画(聚拢后的呼吸幅度)
};

/** 面板按这个顺序生成;`g` 是分组标题。 */
export const MUSIC_SCHEMA = [
  { key: 'density',   g: '粒子',   label: '粒子密度',  type: 'range', min: 0.2, max: 1.6, step: 0.05,
    hint: '1 = 和壁纸上 agent 粒子字同一档(每句约 6 万颗)。调低省电,调高更实。' },
  { key: 'dot',       g: '粒子',   label: '粒子大小',  type: 'range', min: 0.5, max: 2.2, step: 0.05,
    hint: '每颗多大。密度高 + 点小 = 细腻;密度低 + 点大 = 颗粒感强。' },
  { key: 'glow',      g: '粒子',   label: '歌词溢光',  type: 'range', min: 0, max: 1.6, step: 0.05,
    hint: '字周围那层光晕。加性叠的,太高会把字糊成一团。' },
  { key: 'beatGlow',  g: '粒子',   label: '鼓点溢光',  type: 'range', min: 0, max: 1.6, step: 0.05,
    hint: '每句词出现时鼓的那一下有多亮。' },
  { key: 'stars',     g: '粒子',   label: '歌词光粒',  type: 'range', min: 0, max: 1200, step: 20,
    hint: '绕着字横着流过去的那条星河有多少颗。0 = 关掉。' },
  { key: 'flow',      g: '粒子',   label: '光粒流速',  type: 'range', min: 0.2, max: 2.5, step: 0.05 },
  { key: 'size',      g: '文字',   label: '歌词大小',  type: 'range', min: 0.5, max: 2.0, step: 0.05 },
  { key: 'weight',    g: '文字',   label: '字重',      type: 'enum',  options: { 常规: 500, 中: 600, 粗: 700, 特粗: 800, 黑: 900 } },
  { key: 'tracking',  g: '文字',   label: '字间距',    type: 'range', min: -0.02, max: 0.3, step: 0.01 },
  { key: 'x',         g: '位置',   label: '水平位置',  type: 'range', min: -0.4, max: 0.4, step: 0.01 },
  { key: 'y',         g: '位置',   label: '垂直位置',  type: 'range', min: 0.15, max: 0.95, step: 0.01 },
  { key: 'fade',      g: '位置',   label: '边缘渐隐',  type: 'range', min: 0, max: 0.4, step: 0.01,
    hint: '两头淡出多宽 —— 长句顶到屏幕边上时不至于硬切。' },
  { key: 'breath',    g: '动画',   label: '歌词动画',  type: 'range', min: 0, max: 2.5, step: 0.05,
    hint: '聚拢之后每颗还在目标点附近呼吸的幅度。0 = 完全静止。' },
  { key: 'color',     g: '颜色',   label: '歌词颜色',  type: 'color' },
  { key: 'highlight', g: '颜色',   label: '高亮颜色',  type: 'color',
    hint: '已经唱过的那半截用这个色 —— 那道光会跟着句子从左往右走。' },
];

/** 用户的差量 + 默认值 = 真正生效的值。差量里没有的项跟着默认走(以后改默认它会跟着变)。 */
export function resolveMusicStyle(custom) {
  const out = { ...MUSIC_DEFAULTS };
  if (custom && typeof custom === 'object') {
    for (const k of Object.keys(MUSIC_DEFAULTS)) {
      if (custom[k] !== undefined && custom[k] !== null) out[k] = custom[k];
    }
  }
  return out;
}
