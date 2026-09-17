/**
 * lang-colors.js — 一门语言一个颜色,**全 app 只有这一份**。
 *
 * 这张表原本抄在项目列表的语言条里。代码城市要给每座塔上色,用的必须是同一个
 * 颜色 —— 界面上是绿色的 shell,壁纸上不能变成蓝色,不然两处说的就不是同一件事了。
 * 复制一份最省事,然后它们会各自漂移;这种表一漂,人不会报 bug,只会觉得这个
 * 产品有点糊。
 *
 * 颜色沿用 GitHub Linguist 那一套 —— 用惯 GitHub 的人不需要看图例。
 */
export const LANG_COLOR = {
  rust: '#dea584', ts: '#3178c6', js: '#f1e05a', python: '#3572A5', go: '#00ADD8',
  swift: '#F05138', kotlin: '#A97BFF', java: '#b07219', c: '#555555', 'c++': '#f34b7d',
  ruby: '#701516', php: '#4F5D95', 'c#': '#178600', html: '#e34c26', css: '#563d7c',
  shell: '#89e051', sql: '#e38c00',
};

/** 没认出来的语言。灰的 —— 它得存在,但不该跟真正的语言抢眼睛。 */
export const LANG_FALLBACK = '#8A8A90';

/** '#dea584' → [0.87, 0.65, 0.52]。粒子的颜色是 0–1 的浮点,不是 CSS 字符串。 */
export function langRgb(lang) {
  const hex = LANG_COLOR[lang] || LANG_FALLBACK;
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
