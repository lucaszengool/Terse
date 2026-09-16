/**
 * room-styles.js — 八种风格各自的**设计单**:色板、灯光、天与雾、比例、窗。
 *
 * 两层依据:
 *   形与色(pal、窗、层高)照史料 —— 营造法式彩画、卡纳克多柱厅的埃及蓝、帕特农檐部彩绘、
 *     伯南帕克的赤铁矿红与玛雅蓝、伊斯法罕的钴蓝与绿松石、日本传统色……守 60/30/10:
 *     六成安静的底色,三成结构色,一成点睛色只用在边、带和小件上。
 *   光与空气(light、sky)学《光·遇》:光是主角;每个风格像光遇的一个地图,是一天里的某个
 *     时刻,颜色先定好天和雾,整间屋子跟着它走;暗部提亮、带颜色,永远不死黑;远处被雾吃掉;
 *     焦点(主案、窗里那道光)拿到最亮的光。数值是为这台点云渲染器调的,不是光遇的原数。
 *
 * 颜色都是显示空间(sRGB 0–1)。
 */

const hx = (h) => { const n = parseInt(h.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };

/** 色温 → RGB(0–1)。灯"是什么颜色的光"用色温说最准:宫灯 2200K,北欧冬日 7000K。 */
export function kelvin(K) {
  const t = K / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const c = (v) => Math.max(0, Math.min(255, v)) / 255;
  return [c(r), c(g), c(b)];
}

/*
 * pal:   field 墙面底色 · floor 地 · struct 结构(柱、主梁) · wood 次要木作 · accent/accent2 点睛两色
 *        gold 金 · ink 墨线 · ceil 顶的底色 · stone 石(柱础、台阶)
 * light: sunK 太阳色温 · sunI 强度 · sunEl/sunAz 露天时太阳的仰角/方位(度,方位 0 = 南)
 *        sunElIn 屋里的太阳仰角(压低:光斜着铺进来,像晨昏) · fill 天光补光(暗部提多亮)
 *        lampK/lampTint 夜里灯的颜色 · exposure [白天, 夜里] · grade 白天的冷暗暖亮分调
 *        dayGlow 纸窗、灯罩白天透光多少 · soot 烟熏 · skyNight 露天格局的夜空
 * sky:   realm 借光遇哪个地图的气氛 · zenith 天顶色(也是天光的色相) · fogSun 朝太阳那边的雾
 *        fogAway 背着太阳的雾(屋里的背景也是它) · fogNight 夜里的雾和背景 · fogA/fogB 雾的浓度与随高度变淡
 *        rim 逆光的边 · shadow 暗部的颜色 · mote 飘浮光尘 · moteDen 每平米几粒
 *        glitter [强度, 比例] 地面上的闪光 · detailFw 比这更细的纹理一律画平均色(米)
 * window 外墙开什么窗 · hall/room 层高(米),再按代码量上下浮动
 */
export const DESIGN = {
  tang: {
    pal: { field: hx('#E8E0CC'), floor: hx('#7C8088'), struct: hx('#A8321F'), wood: hx('#8A5230'), accent: hx('#1F4E7A'),
           accent2: hx('#2F7D68'), gold: hx('#C9A04A'), ink: hx('#2A2522'), ceil: hx('#2F7D68'), stone: hx('#8C9094') },
    light: { sunK: 3200, sunI: 2.4, sunEl: 30, sunElIn: 18, sunAz: 25, fill: 0.55, lampK: 2200, lampTint: [1, 0.62, 0.48], exposure: [0.98, 1.24],
             grade: { sh: [0.93, 0.97, 1.08], hi: [1.05, 1.01, 0.93], k: 0.6 }, dayGlow: 0.3, skyNight: hx('#2A3550') },
    sky: { realm: '霞谷 Valley of Triumph · 金色的黄昏', zenith: hx('#8FA3CF'), fogSun: hx('#F6C99A'), fogAway: hx('#C7B3CF'), fogNight: hx('#2B2A4A'),
           fogA: 0.028, fogB: 0.25, rim: hx('#FFD7A0'), shadow: hx('#6F6A9A'), mote: hx('#FFE2B0'), detailFw: 0.04 },
    window: 'lattice', hall: 6.8, room: 4.2,
  },
  edo: {
    pal: { field: hx('#8A8674'), floor: hx('#B9B07A'), struct: hx('#4A382E'), wood: hx('#8F6E4E'), accent: hx('#913225'),
           accent2: hx('#C9A24E'), gold: hx('#C9A24E'), ink: hx('#27221F'), ceil: hx('#A88B63'), stone: hx('#8A857A'), paper: hx('#F2E8DA') },
    light: { sunK: 6000, sunI: 0.9, sunEl: 34, sunElIn: 30, sunAz: 30, fill: 0.85, lampK: 2000, lampTint: [1, 0.8, 0.6], exposure: [1.0, 1.28],
             grade: { sh: [0.95, 0.99, 1.05], hi: [1.04, 1.01, 0.95], k: 0.5 }, dayGlow: 0.95, skyNight: hx('#1C2A33') },
    sky: { realm: '雨林 Hidden Forest · 纸窗透进来的雨天柔光', zenith: hx('#9FB3B0'), fogSun: hx('#EDE6D2'), fogAway: hx('#A9BDB6'), fogNight: hx('#1C2A33'),
           fogA: 0.04, fogB: 0.3, rim: hx('#E8F0E6'), shadow: hx('#4E6A6A'), mote: hx('#F4F0DC') },
    window: 'shoji', hall: 3.2, room: 2.7,
  },
  giza: {
    pal: { field: hx('#C9AE84'), floor: hx('#BFA67E'), struct: hx('#C9AE84'), wood: hx('#6E4E2E'), accent: hx('#3E6FB0'),
           accent2: hx('#3D8C6A'), gold: hx('#F0C24A'), ink: hx('#2A2018'), ceil: hx('#1F3A7A'), stone: hx('#B39A72'), relief: hx('#E8DFCB') },
    light: { sunK: 4200, sunI: 3.0, sunEl: 55, sunElIn: 24, sunAz: 20, fill: 0.42, lampK: 1800, lampTint: [1, 0.55, 0.28], exposure: [1.05, 1.32],
             grade: { sh: [0.92, 0.97, 1.1], hi: [1.06, 1.01, 0.92], k: 0.6 }, dayGlow: 0.3, skyNight: hx('#1E2346') },
    sky: { realm: '晨岛 Isle of Dawn · 黎明的沙漠', zenith: hx('#8C9AC8'), fogSun: hx('#F8D2B0'), fogAway: hx('#A9B5D6'), fogNight: hx('#1E2346'),
           fogA: 0.03, fogB: 0.2, rim: hx('#FFE2C0'), shadow: hx('#5E6C9E'), mote: hx('#FFD9A0'), glitter: [1.2, 0.04] },
    window: 'slats', hall: 7.6, room: 4.6,
  },
  hellas: {
    pal: { field: hx('#E9E2D3'), floor: hx('#DCD2BF'), struct: hx('#E9E2D3'), wood: hx('#6E5A34'), accent: hx('#1E3F8A'),
           accent2: hx('#A83A2A'), gold: hx('#D8AE4E'), ink: hx('#2A2622'), ceil: hx('#1E3F8A'), stone: hx('#CFC3AC'), blue2: hx('#4C7FC0') },
    light: { sunK: 5800, sunI: 2.6, sunEl: 64, sunElIn: 62, sunAz: 22, fill: 0.5, lampK: 1900, lampTint: [1, 0.62, 0.34], exposure: [0.93, 1.24],
             grade: { sh: [0.94, 0.98, 1.07], hi: [1.04, 1.01, 0.95], k: 0.5 }, dayGlow: 0.3, skyNight: hx('#1A2340') },
    sky: { realm: '云野 Daylight Prairie · 蓝白的正午', zenith: hx('#7FA6D8'), fogSun: hx('#FFF3DC'), fogAway: hx('#BFD6EE'), fogNight: hx('#1D2748'),
           fogA: 0.02, fogB: 0.2, rim: hx('#F4F8FF'), shadow: hx('#7C95C4'), mote: hx('#F0F6FF'), glitter: [0.3, 0.02], detailFw: 0.06 },
    window: 'slats', hall: 7.0, room: 4.4,
  },
  maya: {
    pal: { field: hx('#A8483A'), floor: hx('#B8AE92'), struct: hx('#E6DECB'), wood: hx('#5E3E26'), accent: hx('#4F9FB4'),
           accent2: hx('#4E8A5E'), gold: hx('#C99A3C'), ink: hx('#221E1C'), ceil: hx('#E6DECB'), stone: hx('#B8AE92') },
    light: { sunK: 3800, sunI: 3.2, sunEl: 40, sunElIn: 26, sunAz: 15, fill: 0.38, lampK: 1900, lampTint: [1, 0.55, 0.3], exposure: [1.05, 1.32],
             grade: { sh: [0.92, 0.98, 1.08], hi: [1.07, 1.0, 0.9], k: 0.6 }, dayGlow: 0.3, skyNight: hx('#1A1F2E') },
    sky: { realm: '暮土 Golden Wasteland(柔化)· 琥珀色的雾', zenith: hx('#C98A6A'), fogSun: hx('#F2B26E'), fogAway: hx('#6E5A78'), fogNight: hx('#231C33'),
           fogA: 0.045, fogB: 0.22, rim: hx('#FFB36B'), shadow: hx('#3E4F6A'), mote: hx('#FFB070') },
    window: 'slots', hall: 7.6, room: 5.0,
  },
  persia: {
    pal: { field: hx('#2A5298'), floor: hx('#C8A77A'), struct: hx('#C8A77A'), wood: hx('#7A5436'), accent: hx('#2A5298'),
           accent2: hx('#2FA3A8'), gold: hx('#D4AF52'), ink: hx('#16285C'), ceil: hx('#2FA3A8'), stone: hx('#EFE9DA'), red: hx('#9C3326') },
    light: { sunK: 5600, sunI: 2.0, sunEl: 38, sunElIn: 28, sunAz: 30, fill: 0.65, lampK: 2400, lampTint: [1, 0.75, 0.5], exposure: [0.93, 1.24],
             grade: { sh: [0.92, 0.98, 1.08], hi: [1.04, 1.0, 0.94], k: 0.55 }, dayGlow: 0.3, skyNight: hx('#141C3A') },
    sky: { realm: '禁阁 Vault of Knowledge · 钴蓝的静', zenith: hx('#6F9CC8'), fogSun: hx('#F3E6C8'), fogAway: hx('#7FA8C9'), fogNight: hx('#18204A'),
           fogA: 0.025, fogB: 0.25, rim: hx('#BFE8F0'), shadow: hx('#2E4A86'), mote: hx('#E6F2FF'), detailFw: 0.035 },
    window: 'jali', hall: 6.8, room: 4.4,
  },
  norse: {
    pal: { field: hx('#7E5E42'), floor: hx('#6E5A47'), struct: hx('#7E5E42'), wood: hx('#9A6E42'), accent: hx('#8E3A24'),
           accent2: hx('#3C5470'), gold: hx('#B8913F'), ink: hx('#2B211A'), ceil: hx('#3E3238'), stone: hx('#6F6A62'), wool: hx('#C8B89A') },
    light: { sunK: 7000, sunI: 1.6, sunEl: 30, sunElIn: 20, sunAz: 25, fill: 0.40, lampK: 1800, lampTint: [1, 0.55, 0.28], exposure: [1.12, 1.36],
             grade: { sh: [0.9, 0.96, 1.1], hi: [1.08, 1.0, 0.9], k: 0.65 }, dayGlow: 0.3, soot: true, skyNight: hx('#141A26') },
    sky: { realm: '伊甸 Eye of Eden · 外面风雪,屋里围着火', zenith: hx('#9AA8C0'), fogSun: hx('#E3ECF5'), fogAway: hx('#8E9DB4'), fogNight: hx('#1A2033'),
           fogA: 0.035, fogB: 0.18, rim: hx('#CFE3FF'), shadow: hx('#4A5370'), mote: hx('#F4F8FF'), detailFw: 0.07 },
    window: 'porthole', hall: 4.4, room: 3.4,
  },
  modern: {
    pal: { field: hx('#E7E1D6'), floor: hx('#D8CCB6'), struct: hx('#2E3033'), wood: hx('#5A3E2B'), accent: hx('#B8955A'),
           accent2: hx('#2E3033'), gold: hx('#B8955A'), ink: hx('#2E3033'), ceil: hx('#E7E1D6'), stone: hx('#D8CCB6') },
    light: { sunK: 5200, sunI: 2.0, sunEl: 34, sunElIn: 30, sunAz: 30, fill: 0.7, lampK: 2700, lampTint: [1, 0.82, 0.62], exposure: [0.92, 1.16],
             grade: { sh: [0.95, 0.99, 1.05], hi: [1.03, 1.0, 0.96], k: 0.45 }, dayGlow: 0.2, skyNight: hx('#141821') },
    sky: { realm: '家园 Home · 蓝调时刻', zenith: hx('#A9BCD6'), fogSun: hx('#FFF1E0'), fogAway: hx('#D6DCE6'), fogNight: hx('#1B2030'),
           fogA: 0.015, fogB: 0.3, rim: hx('#FFE6C8'), shadow: hx('#8A93AE'), mote: hx('#FFF0D0'), moteDen: 0.4, detailFw: 0.08 },
    window: 'glass', hall: 4.4, room: 3.5,
  },
};

export function designOf(id) { return DESIGN[id] || DESIGN.modern; }

/** 太阳方向(朝向太阳的单位向量)。露天:方位 0 表示太阳在南边(+z)。 */
export function sunDirOf(D, indoor, elOverride) {
  /* 屋里:太阳挪到主案那一边(北),压低 —— 光从高侧窗斜着穿过大殿正中,迎着进门的人,
     逆光的光柱衬在暗的顶下面。方位只偏一点点,光顺着中轴走,不斜着撞进柱林。
     古希腊穹顶开天眼,光要从头顶直下来,用它自己的仰角。露天的院子不动。
     elOverride:按看的人的钟算出来的仰角(黄昏压低、光柱拉长);方位仍是设计单定的。 */
  const elDesign = indoor ? (D.light.sunElIn != null ? D.light.sunElIn : Math.min(D.light.sunEl, 40)) : D.light.sunEl;
  const elD = elOverride != null && Number.isFinite(elOverride) ? elOverride : elDesign;
  const el = elD * Math.PI / 180, az = (indoor ? 180 + D.light.sunAz * 0.3 : D.light.sunAz) * Math.PI / 180;
  return [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
}

/** 层高:风格定基准,代码量上下浮动 ±15%(layoutOf 按字节算出来的高度折成 0..1)。 */
export function heightOf(D, r) {
  if (r.kind === 'wing' || r.kind === 'court' || r.kind === 'garden') return r.h;
  const t = r.isHall ? Math.max(0, Math.min(1, (r.h - 4.8) / 3.2)) : Math.max(0, Math.min(1, (r.h - 3.2) / 2));
  const base = r.isHall ? D.hall : D.room;
  return +(base * (0.88 + 0.24 * t)).toFixed(2);
}
