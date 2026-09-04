/* 3D 自由视角。
   最重要的一条仍旧是**否定式**的:从没开过这个功能的人,画面必须逐位和以前一样。
   壁纸是常驻在几万台机器桌面上的东西,这里出一点偏差,就是每一个现有用户都看得见
   的回归 —— 所以"关着的时候等于不存在"是拿数值断言钉死的,不是靠读代码相信的。

   第二条是闸门的方向:预览对所有人开放(那就是卖点本身),写进桌面才要 Pro。
   这条在 wallpaper-gate.test.mjs 里已经为滑块和风格立过,这里替 3D 再立一次。 */
import { readFileSync } from 'node:fs';
import {
  sanitizeView, orbitPosition, shortestArc,
  VIEW_DEFAULT, VIEW_EL_MAX, VIEW_DIST_MIN, VIEW_DIST_MAX,
} from './wallpaper-view3d.js';

const R = new URL('./', import.meta.url).pathname;
const eng = readFileSync(R + 'mineradio-wallpaper.js', 'utf8');
const sh = readFileSync(R + 'mineradio-shaders.js', 'utf8');
const ctl = readFileSync(R + 'wallpaper-control.html', 'utf8');
const page = readFileSync(R + 'wallpaper.html', 'utf8');

let pass = 0; const fails = [];
const ok = (l, c) => (c ? pass++ : fails.push(l));
const eq = (l, g, w) => (JSON.stringify(g) === JSON.stringify(w) ? pass++ : fails.push(`${l}: got ${JSON.stringify(g)}, want ${JSON.stringify(w)}`));

// ── 1. 关着 = 从来没有过 ───────────────────────────────────────────────────
{
  const p = orbitPosition(12, VIEW_DEFAULT.az, VIEW_DEFAULT.el);
  // 精确相等,不是 |x| < 1e-9:相机位置差一点点,透视投影出来的每个粒子都差一点点。
  eq('正对机位精确落在 (0,0,camZ)', p, { x: 0, y: 0, z: 12 });
  eq('另一层也一样', orbitPosition(62, 0, 0), { x: 0, y: 0, z: 62 });
  eq('默认机位是关着的', sanitizeView(null, true), { on: false, az: 0, el: 0, dist: 1, dim: false });
  // 默认**不压黑**:底下那张是用户自己选的桌面壁纸,不该由这个功能替他决定。
  ok('默认不把真壁纸压黑', sanitizeView({ on: true }, true).dim === false);
  ok('打开了就压', sanitizeView({ on: true, dim: true }, true).dim === true);
  eq('配置里缺这一段也一样', sanitizeView(undefined, true).on, false);
}

// ── 2. 授权:免费一律停在正对机位 ─────────────────────────────────────────
{
  const v = { on: true, az: 1.2, el: 0.4, dist: 2 };
  ok('Pro 可以开', sanitizeView(v, true).on === true);
  ok('免费开不了', sanitizeView(v, false).on === false);
  // 角度照样留着:掉出 Pro 再回来,应该还是原来那个机位,而不是被抹平。
  ok('免费也不丢角度', sanitizeView(v, false).az === 1.2);
  ok('手改 wallpaper.json 也开不了', sanitizeView({ on: 1 }, false).on === false);
}

// ── 3. 夹范围:自由不等于能转到没有内容的地方 ─────────────────────────────
{
  ok('仰角上不封顶会看到一张纸的侧面', sanitizeView({ el: 9 }, true).el === VIEW_EL_MAX);
  ok('往下也一样', sanitizeView({ el: -9 }, true).el === -VIEW_EL_MAX);
  ok('推近有底', sanitizeView({ dist: 0.001 }, true).dist === VIEW_DIST_MIN);
  ok('拉远有顶', sanitizeView({ dist: 99 }, true).dist === VIEW_DIST_MAX);
  ok('NaN 退回默认', sanitizeView({ az: NaN, el: 'x', dist: null }, true).dist === 1);
  const wrapped = sanitizeView({ az: Math.PI * 2 + 0.5 }, true).az;
  ok('转过一整圈会收回来', Math.abs(wrapped - 0.5) < 1e-9);
  ok('归一后仍在 (−π, π]', Math.abs(sanitizeView({ az: 400 }, true).az) <= Math.PI);
}

// ── 4. 最短弧:从 +179° 拖到 −179° 是 2°,不是 358° ───────────────────────
{
  const d = shortestArc(Math.PI - 0.02, -Math.PI + 0.02);
  ok('跨过背面走近路', Math.abs(d) < 0.09 && d > 0);
  ok('原地不动就是 0', shortestArc(1.1, 1.1) === 0);
}

// ── 5. 半径:每层用自己的 camZ,两层的取景关系不能散架 ────────────────────
{
  const a = orbitPosition(12, 0.7, 0.3), b = orbitPosition(62, 0.7, 0.3);
  const len = (p) => Math.hypot(p.x, p.y, p.z);
  ok('SILK 保持自己的距离', Math.abs(len(a) - 12) < 1e-9);
  ok('PULSE 保持自己的距离', Math.abs(len(b) - 62) < 1e-9);
  // 同一个方向、不同的半径 —— 两层看的是同一个方位,只是各自的尺度。
  ok('方向一致', Math.abs(a.x / 12 - b.x / 62) < 1e-9 && Math.abs(a.y / 12 - b.y / 62) < 1e-9);
}

// ── 6. 引擎:关着的时候一分钱不花,开着的时候字还看得懂 ──────────────────
{
  ok('机位数学只有一份(引擎不自己再算一遍)', !/const VIEW_EL_MAX/.test(eng));
  ok('相机位置走 orbitPosition', /orbitPosition\(L\.camZ \* C\.dist/.test(eng));
  ok('没许可就挂不上轨道控制器', /if \(!target \|\| !this\._proView\) return false;/.test(eng));
  // 3D 是按**许可**卖的,不是按"选了哪台引擎" —— 付了钱却把引擎留在默认 mineradio
  // 的人,面板上打开 3D、预览也在转,桌面却一动不动,而且不报错。
  ok('视角授权和引擎选择是两件事', /this\._proView = \(opts && opts\.proView !== undefined\)/.test(eng));
  ok('壁纸页按许可传 proView', /proView: proOK !== false/.test(page));
  ok('桌面上两指一滑就是推拉(不必先按一下)', /wheelAlways: true/.test(page) && /wheelAlways = !!\(opts && opts\.wheelAlways\)/.test(eng));
  ok('字整组朝相机转,但留一点倾斜', /slerp\(cam\.quaternion, 0\.85 \* C\.amt\)/.test(eng));
  ok('命中框改用真正的投影', /_V3\.project\(cam\)/.test(eng));
  ok('命中框不再按 fov 反算', !/Math\.tan\(cam\.fov \* Math\.PI \/ 360\) \* cam\.position\.z/.test(eng));
  ok('字的取景用到原点的距离,不是 position.z', /const camDist = cam\.position\.length\(\);/.test(eng));
  ok('改窗口大小之后机位要重新摆', /this\._applyView\(\);\s*\/\/ 新相机/.test(eng));
  ok('引擎销毁时摘掉监听', /this\.detachOrbit\(\);\s*\n\s*window\.removeEventListener/.test(eng));
  ok('关着的时候每帧直接返回', /if \(!V\.on && C\.amt === 0 && C\.az === 0 && C\.el === 0 && C\.dist === 1\) return;/.test(eng));
  ok('底图压暗用 background 叠色,不是 filter', /host\.style\.background = `linear-gradient/.test(eng) && !/style\.filter/.test(eng));
  ok('没开"全黑"就一档都不压', /this\._view\.dim \? Math\.round\(amt \* 20\) \/ 20 : 0/.test(eng));
}

// ── 7. Shader:uSpace 为 0 时整段短路 ─────────────────────────────────────
{
  ok('浮雕挂在 uSpace 上', /if \(uSpace > 0\.001\) \{/.test(sh));
  ok('uSpace 声明了(少一个 uniform 就是编译失败)', /uniform float uSpace;/.test(sh));
  ok('没有深度图也有起伏', /float swell\s+= snoise/.test(sh));
  ok('辉光孪生层是派生的,自动跟着改', /export const MR_BLOOM_VS = MR_VS/.test(sh));
}

// ── 8. 闸门:拖给所有人看,存盘才要 Pro ───────────────────────────────────
{
  ok('PRO 预览挂了轨道控制器', /prevPro\.attachOrbit\(\$\('#prevPro'\), view3dChanged\)/.test(ctl));
  ok('免费预览没有挂', !/prev\.attachOrbit/.test(ctl.replace(/prevPro\.attachOrbit/g, '')));
  const changed = ctl.slice(ctl.indexOf('function view3dChanged'), ctl.indexOf('function wireView3D'));
  ok('拖动先进预览', changed.indexOf('proApply') > changed.indexOf('view3dRead'));
  ok('写盘在闸门后面', /if \(!proApply\('view3d'\)\) return;\s*\n\s*cfg\.view3d/.test(changed));
  ok('拖动不弹升级窗', !/requestUpgrade/.test(changed));
  ok('还按着就不写盘', /isOrbiting\(\)\) \{ view3dChanged\(v\); return; \}/.test(changed));
  const toggle = ctl.slice(ctl.indexOf("sw.addEventListener('change'"), ctl.indexOf("const rs = $('#wp3dReset')"));
  ok('开关也是先预览后闸门', toggle.indexOf('setView3D') < toggle.indexOf('proApply'));
  ok('闸门之前不碰 cfg', toggle.indexOf('cfg.view3d =') > toggle.indexOf('proApply'));
}

// ── 9. 桌面上那一段必须有头有尾 ───────────────────────────────────────────
{
  ok('会话自己会过期', /orbitTimer = setTimeout\(function \(\) \{ setOrbit\(false\); \}, ORBIT_SECS\)/.test(page));
  ok('Esc 结束', /if \(orbitOn\) setOrbit\(false\); else setArmed\(false\);/.test(page));
  ok('转的时候不许把鼠标还回去', /if \(!on && orbitOn\) return;/.test(page));
  ok('松手补的那一下 click 不算散场', /Date\.now\(\) - dragGuard < 350/.test(page));
  ok('结束时把机位落盘', /saveView\(\);\s*\n\s*setArmed\(false\);/.test(page));
  ok('别人推来的机位不覆盖手上正在拖的', /!\(wp\.isOrbiting && wp\.isOrbiting\(\)\)/.test(page));
}

// ── 10. 在桌面上拖:只有调节态才抬窗口,而且绝不抬到置顶那一层 ────────────
{
  const rs = readFileSync(new URL('../../src-tauri/src/lib.rs', import.meta.url).pathname, 'utf8');
  const adj = rs.slice(rs.indexOf('fn wallpaper_set_adjust'), rs.indexOf('fn wallpaper_set_adjust') + 2400);
  const m3d = rs.slice(rs.indexOf('fn wallpaper_set_3d_mode'), rs.indexOf('fn wallpaper_set_3d_mode') + 1600);
  // 开着 3D **不能**改变窗口层级:抬上去桌面图标全被盖住(用户报的"开了 3D 桌面上
  // 只剩壁纸"),而且它就变成了「始终置顶」—— 那是另一个开关,两者必须独立。
  ok('开 3D 不动层级', !/setLevel/.test(m3d));
  ok('开 3D 不动透明度', !/setOpaque/.test(m3d));
  ok('调节态才抬窗口', /setLevel: WP_LEVEL_ABOVE_ICONS/.test(adj));
  ok('抬起来就必须同时变透明', /setOpaque: NO/.test(adj) && /clearColor/.test(adj));
  ok('退出时原样落回桌面层', /pin_wallpaper_window\(&win2, false\)/.test(adj));
  ok('调节态**不是**置顶:绝不抬到屏保层', !/WP_LEVEL_OVERLAY/.test(adj));
  ok('层级只由置顶和调节态决定', /if overlay_on \{ WP_LEVEL_OVERLAY \}\s*\n\s*else if adjusting \{ WP_LEVEL_ABOVE_ICONS \}/.test(rs));
  ok('页面收到 wallpaper-lift 才撤掉自己的底色', /listen\('wallpaper-lift'/.test(page));
  ok('页面自己也切一次画法(不赌事件到得及时)', /applyOverlay\(on \|\| overlayOK\(\)\);/.test(page));
  ok('抬窗口的授权问引擎,不问配置文件', /wp\.getView3D && wp\.getView3D\(\)\.on/.test(page));
  ok('抬窗口的许可在 Rust 查', /if on && !license::License::load\(\)\.is_pro\(\) \{\s*\n\s*return false;/.test(rs));
}

// ── 11. 灵动岛旁边那颗圆钮:一条**一定按得动**的路 ───────────────────────
{
  const rs = readFileSync(new URL('../../src-tauri/src/lib.rs', import.meta.url).pathname, 'utf8');
  const btn = readFileSync(R + 'wp3d.html', 'utf8');
  const caps = readFileSync(new URL('../../src-tauri/capabilities/default.json', import.meta.url).pathname, 'utf8');
  ok('按钮窗口建出来了', /WebviewWindowBuilder::new\(app, "wp3d"/.test(rs));
  ok('它也要 accept_first_mouse(否则第一下只用来激活)', /"wp3d"[\s\S]{0,900}accept_first_mouse\(true\)/.test(rs));
  ok('按钮窗口进了 capabilities(否则它连 invoke 都发不出去)', /"wp3d"/.test(caps));
  ok('只在 3D 开着时出现', /get_webview_window\("wp3d"\)[\s\S]{0,160}if on \{ btn\.show\(\) \} else \{ btn\.hide\(\) \}/.test(rs));
  ok('调节态也是 Pro', /fn wallpaper_set_adjust[\s\S]{0,400}is_pro\(\)/.test(rs));
  ok('调节态自己抬窗口,再接管鼠标',
     /setLevel: WP_LEVEL_ABOVE_ICONS[\s\S]{0,600}let took = wallpaper_set_interactive/.test(rs));
  // 调节态是用户明确进来的,所以整块屏幕都归壁纸 —— 不需要读图标,也就没有前置条件。
  ok('调节态里不再按位置判归属', /if \(adjustOn\) return;/.test(page));
  ok('壁纸和按钮听同一个事件,状态不会分叉', /listen\('wallpaper-adjust'/.test(page) && /listen\('wallpaper-adjust'/.test(btn));
  ok('退出时把机位定住', /saveView\(\);\s*\n\s*setArmed\(false\);/.test(page));
  ok('开着的时候一眼看得出来', /body\.on #btn/.test(btn) && /@keyframes pulse/.test(btn));
  ok('壁纸关着就不该冒出一颗按钮', /if \(cfg\.enabled === false\) return false;/.test(page));
  // 置顶演示卡:三块预览都得是同一台引擎,否则一眼就看出这张卡是示意图
  ok('置顶演示用的是真引擎', /tdWp = new E3\(tdCv/.test(ctl));
  ok('不再有手画的圆点动画', !/tdParts = Array\.from/.test(ctl));
  ok('窗口里放的是真 app 图标', /appIcon\(pid, 64\)/.test(ctl));
  // 「3D 时全黑」是独立选项,而且只在没开置顶时才有意义 —— 置顶模式下这一层是透明的,
  // 底下那张壁纸是系统在画,压不压黑无从谈起。默认关着:那是用户自己选的图。
  ok('全黑是个开关,不是写死的', /id="wp3dDim"/.test(ctl));
  ok('开了置顶就把这一行藏起来', /drow\.style\.display = cfg\.overlay \? 'none' : ''/.test(ctl));
  ok('全黑也是先预览后闸门', /prevPro\.setView3D\(\{ dim \}\);\s*\n\s*if \(!proApply\('view3d'\)\) return;/.test(ctl));
}

console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.join('\n')); process.exit(1); }
