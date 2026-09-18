/**
 * town-pet-look.mjs — agent 小伙伴长什么样:身份哈希 → 品种、毛色、名字。
 *
 *   纯函数,不碰 three:浏览器(town-pets.js)和服务器共用 —— 服务器以后要在消息里
 *   说"Mochi 替 Bob 递来一份文件",就得和每个人屏幕上那只叫同一个名字。
 *
 *   node src/renderer/town-pet-look.test.mjs
 */
/* 四种身子。用镇上已有的四份模板 —— 再捏四个新的只会多四份要维护的几何。 */
export const BREEDS = ['dog', 'cat', 'fox', 'rabbit'];

/* 毛色:12 种真动物身上有的颜色。随便取 hue 会出现荧光绿的狗。 */
export const COATS = [
  [0.58, 0.38, 0.22], [0.86, 0.66, 0.36], [0.94, 0.92, 0.88], [0.22, 0.19, 0.18],
  [0.52, 0.5, 0.48], [0.78, 0.42, 0.2], [0.42, 0.3, 0.24], [0.9, 0.84, 0.7],
  [0.3, 0.34, 0.4], [0.68, 0.58, 0.44], [0.16, 0.14, 0.16], [0.82, 0.74, 0.62],
];

/* 接的是哪个 agent → 头顶光点的颜色。没接的时候是暗灰的,一眼看出来"这只还没醒"。 */
export const AGENT_COLOURS = {
  'claude-code': [1.0, 0.55, 0.28],
  codex: [0.72, 0.82, 0.78],
  cursor: [0.42, 0.68, 1.0],
  openclaw: [0.85, 0.5, 0.95],
  gemini: [0.55, 0.78, 1.0],
  ollama: [0.5, 0.95, 0.72],
  none: [0.55, 0.57, 0.62],
};

/* 名字:24 个两音节的短名,哈希挑一个。狗得有名字才叫得动。 */
export const NAMES = ['Momo', 'Koko', 'Bao', 'Nori', 'Yuki', 'Pip', 'Tofu', 'Mochi', 'Suki', 'Bean', 'Juju', 'Taro',
  'Nana', 'Kiki', 'Puff', 'Miso', 'Lolo', 'Sora', 'Dumpling', 'Peanut', 'Ollie', 'Fig', 'Ash', 'Yuzu'];

/** 字符串 → 32 位整数(FNV-1a)。同一个身份在任何一台机器上都得到同一只。 */
export function hashId(s) {
  let h = 0x811c9dc5;
  const str = String(s == null ? '' : s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/** 身份 → 这只小伙伴长什么样。纯函数,前后端都能算。 */
export function petLook(id) {
  const h = hashId(id);
  return {
    breed: BREEDS[h % BREEDS.length],
    coat: COATS[(h >>> 4) % COATS.length],
    name: NAMES[(h >>> 9) % NAMES.length],
    seed: ((h >>> 15) % 1000) / 1000,
  };
}
