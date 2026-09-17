/* 会话栏(2026-09 全粒子版)—— 屏幕左边一条状态珠轨;碰到边缘就展开成"只放在跑的会话"
 * 的卡片列表,按"需要你"排序;停在一张卡上,右边铺开那段对话。窗口本身 100% 透明。
 *
 * **所有的字、图、按钮都是粒子**(pdock-engine.js):停下时一颗 = 一个物理像素,和系统字一样清楚;
 * 动起来的时候粒子承担的是**有信息的**动效 ——
 *   · 珠子 ↔ 卡片:展开时每颗珠子炸开成它那张卡,收起时卡片被吸回珠子(知道谁是谁)
 *   · 允许:命令的粒子被吸进这条会话的状态点;拒绝:碎开落下
 *   · 改动预览:删掉的行碎成红色粒子,新增的行由绿色粒子聚成
 *   · 新消息:按阅读顺序一粒粒落进预览
 *   · 燃料条:每个在烧 token 的会话往"5 小时窗口"里流粒子,流量 = 它最近 10 分钟的用量
 *   · 上下文水位:卡片底部一条粒子线;压缩发生时这条线被吸成一点(早先的细节只剩摘要)
 *   · 离开期间:回来时每张卡落下一行"你离开 23 分钟,它改了 6 个文件、跑了 14 条命令"
 *   · 卡住:连续失败 / 重复同一条命令 / 工具挂着不动(可能在 Claude 里等你允许)
 *
 * 这些都是 Claude Desktop 自己的侧栏做不到的:它只有一个总的 5 小时圆环、看不出哪个会话在烧,
 * 看不到每个会话的上下文水位,等批准的会话要一个个点进去看。
 *
 * 数据:
 *   · sd_active —— Desktop 侧栏里此刻有进程在跑的会话 + 从记录尾巴读出来的状态和事件
 *   · sd_usage —— 5 小时窗口的用量,按会话拆开
 *   · permission-request —— Terse 权限中继(permission.rs)转来的"等你批准"
 *
 * ⚠ 鼠标:这个窗口永远不是焦点窗口,WKWebView 在非焦点窗口里收不到 hover。展开/收起和
 * "指着哪儿"由 Rust 轮询全局光标算好,以 sd-state / sd-mouse 事件发过来。点击和滚轮能直接收到。 */
import { ParticleField, raster } from './pdock-engine.js';
import { listenGestures } from './gesture-core.js';

const T = window.__TAURI__;
const invoke = (c, a) => (T?.core?.invoke ? T.core.invoke(c, a) : Promise.reject('no tauri'));
const listen = T?.event?.listen || (async () => () => {});
const emit = (n, p) => { try { return T?.event?.emit?.(n, p); } catch (e) { return null; } };
/* 真窗口里没有 devtools:出错和关键状态都打到 terse 的 stderr([dock] 开头) */
const dlog = (msg) => invoke('debug_log', { msg: '[dock] ' + msg }).catch(() => {});
window.addEventListener('error', (e) => dlog('error ' + e.message + ' @' + e.lineno));
window.addEventListener('unhandledrejection', (e) => dlog('rejection ' + String(e.reason).slice(0, 200)));

/* ── 字体、颜色 ─────────────────────────────────────────────────────────── */
const SANS = '-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",sans-serif';
const MONO = '"SF Mono",Menlo,ui-monospace,monospace';
const F = (px, w = 600, mono) => `${w} ${px}px ${mono ? MONO : SANS}`;
/* 用户能在粒子页改的颜色(键名和旧版一致,粒子页不用改)。透明窗口上次要文字默认亮一档。 */
const DEF = { title: '#FFFFFF', list: '#F4F6FA', sub: '#AEB5C2', user: '#DCE8FF', assistant: '#EEF1F6', tool: '#A8F5D0' };
function colors() {
  try { return Object.assign({}, DEF, JSON.parse(localStorage.getItem('terse-dock-colors') || '{}')); }
  catch (e) { return Object.assign({}, DEF); }
}
let C = colors();
const K = { lime: '#C9F03D', amber: '#FFC24B', blue: '#7FB2FF', red: '#FF6B6B', add: '#7EE2A8', del: '#FF8E8E', t2: '#D6DBE4', white: '#FFFFFF' };
const rgb = (hex) => [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];
window.addEventListener('storage', (e) => { if (e.key === 'terse-dock-colors') { C = colors(); rebuild(); } });
window.__dockColors = (c) => { C = Object.assign({}, DEF, c || {}); rebuild(); };

/* ── 版面 ───────────────────────────────────────────────────────────────── */
const TOP = 14, CX = 14, CW = 372, LIST_W = 400, PV_X = 400, PV_W = 560;
// top 74 → 104:标题下面多了一行「打开这个会话 / 继续 / 停下 / 压缩」和改动统计
// top 104 → 170:回复框(112)和"这次会怎么送"那一行(150)挪到了标题下面,消息从它们下面开始
const PV = { x: PV_X + 22, top: 170, maxW: PV_W - 48 };

const f = new ParticleField(document.getElementById('gl'));
addEventListener('resize', () => { f.resize(); if (mode !== 'strip') { render({ instant: true }); if (pv) syncPv(false); } });

/* ── 状态 ───────────────────────────────────────────────────────────────── */
let mode = 'strip';
let active = [];                 // sd_active 的结果
let usage = null;                // sd_usage 的结果
const perms = new Map();         // sessionId → 权限请求(来自中继)
const overrides = new Map();     // sessionId → { st, until }:刚答完的那几秒,记录还没跟上,先按答案显示
const pendingEnter = new Map();  // sessionId → { enter, until }:刚答完的卡下一次出场用什么动效
const diffPlayed = new Set();    // 哪些权限请求的改动动画已经播过
const seenCompact = new Map();   // sessionId → 已经见过的最近一次压缩时间
const compactFlash = new Map();  // sessionId → 发现"刚压缩过"的时刻(提示留 60 秒)
let digests = new Map();         // sessionId → "你离开期间"的一行(展开时算,收起时清)
let placed = new Map();          // 版面上的 item key → item
let hits = [];
let hoverKey = null, hoverT = 0;
let listScroll = 0, showIdle = false;
let fuelAt = null;               // 燃料条"火头"的位置(粒子流的终点)
let pv = null;                   // 预览 { sid, tab, groups, L, scrollTop, shown, open, hits, ... }
const gitInfo = new Map();       // sessionId → sd_git:{ branch, add, del, files }(只算它自己改过的文件)
let gitSig = '';
/* 直控(dock_hook.rs):钩子拦住的提问 / 计划在这里直接答;给在跑的会话发话 / 叫停走排队,不切到 Claude */
const liveAsks = new Map();      // sessionId → { id, tool, input, qi, answers, picks }(钩子正拦着、等你答)
let direct = { enabled: false, seen: {} };   // seen:钩子来过的会话(= 这段会话能直控)
const queued = new Map();        // sessionId → [{ id, kind, text }](还没送到的话 / 叫停)
let directNote = 0;              // 刚打开直控的时刻(列表顶上提示 12 秒)
const canDirect = (s) => direct.enabled && !!(direct.seen && direct.seen[s.id]);
function liveAskModel(la) {
  if (la.tool === 'ExitPlanMode') return { kind: 'plan', text: String(la.input.plan || '') };
  const qs = la.input.questions || [], q = qs[la.qi] || {};
  return { kind: 'question', text: q.question || '', options: (q.options || []).map((o) => o.label), count: qs.length, qi: la.qi, multi: !!q.multiSelect };
}
/* 已读:每条会话你最后一次看它的预览是什么时候。它在那之后又写了回答(而且这一轮已经停了)
   = 有你没看过的结果(AgentsRoom 的"未读"那一套)。第一次见到的会话不算未读。 */
let readAt = {};
try { readAt = JSON.parse(localStorage.getItem('terse-dock-read') || '{}'); } catch (e) {}
function saveRead() { try { localStorage.setItem('terse-dock-read', JSON.stringify(readAt)); } catch (e) {} }
function markRead(sid) { readAt[sid] = Date.now(); saveRead(); }

const basename = (p) => String(p || '').split('/').filter(Boolean).pop() || '';
const ORDER = { need: 0, ask: 0.3, maybe: 0.5, tool: 1, work: 1, think: 1, done: 2, idle: 3 };
const beadColor = (st) => st === 'need' || st === 'maybe' || st === 'ask' ? K.amber : st === 'think' ? K.blue : st === 'done' ? K.white : st === 'idle' ? '#5A606C' : K.lime;
const isRun = (st) => st === 'tool' || st === 'work' || st === 'think';
/** 在等你:批准(need)、回答提问 / 看计划(ask)、可能在 Claude 里等允许(maybe) */
const isWaiting = (st) => st === 'need' || st === 'ask' || st === 'maybe';
const isUnread = (s) => (s.st === 'done' || s.st === 'idle') && (s.lastTextTs || 0) > (readAt[s.id] || 0) && !(pv && pv.sid === s.id);
/* 这几种工具在 Desktop 里通常要人点"允许"。挂着 25 秒没有结果、中继又没转来请求 →
   **可能**在 Claude 里等你(只是可能 —— 也可能是命令本身跑得久,所以照实写"可能") */
const WAITY = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch']);

function loadSeen() { try { return JSON.parse(localStorage.getItem('terse-dock-seen') || '{}'); } catch (e) { return {}; } }
function saveSeen(o) { try { localStorage.setItem('terse-dock-seen', JSON.stringify(o)); } catch (e) {} }

function view() {
  const now = Date.now(), out = [];
  for (const a of active) {
    const req = perms.get(a.id), ov = overrides.get(a.id);
    let st = a.state || 'idle';
    if (ov && ov.until > now) st = ov.st;
    const la = liveAsks.get(a.id);
    if (req) st = 'need';
    else if (la) st = 'ask';
    else if (a.agent === 'codex' && a.waiting) st = 'maybe';   // Codex 的批准请求是记录里明写的,不用猜
    else if (a.agent !== 'codex' && st === 'tool' && WAITY.has(a.tool) && (a.age || 0) > 25) st = 'maybe';
    out.push({ ...a, st, req, live: la || null, ask: la ? liveAskModel(la) : a.ask });
  }
  // 钩子拦住的提问可能来自不在 Desktop 侧栏里的会话(终端里的 claude)—— 也要能答
  for (const [sid, la] of liveAsks) if (!active.some((a) => a.id === sid) && !perms.has(sid)) out.push({ id: sid, title: basename(la.cwd) || 'Claude Code', project: '', st: 'ask', live: la, ask: liveAskModel(la), ctx: 0, age: 0 });
  // 中继转来的请求可能来自不在 Desktop 侧栏里的会话(终端里的 claude)—— 也要能批
  for (const [sid, req] of perms) if (!active.some((a) => a.id === sid)) out.push({ id: sid, title: basename(req.cwd) || 'Claude Code', project: '', st: 'need', req, ctx: 0 });
  return out.sort((a, b) => ORDER[a.st] - ORDER[b.st] || (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
}

/* ── 画元素 ─────────────────────────────────────────────────────────────── */
function rr(g, x, y, w, h, r) { g.beginPath(); g.roundRect(x, y, w, h, r); }
const mctx = document.createElement('canvas').getContext('2d');
function ell(g, s, maxW) { s = String(s || ''); if (g.measureText(s).width <= maxW) return s; let t = s; while (t.length > 1 && g.measureText(t + '…').width > maxW) t = t.slice(0, -1); return t + '…'; }
function wrap(g, s, maxW) {
  const out = [];
  for (const para of String(s || '').split('\n')) {
    if (!para) { out.push(''); continue; }
    let line = '';
    for (const ch of para.match(/[　-鿿＀-￯]|[^\s　-鿿＀-￯]+\s*|\s+/g) || []) {
      if (g.measureText(line + ch).width > maxW && line) { out.push(line.trimEnd()); line = ch.trimStart(); } else line += ch;
    }
    out.push(line.trimEnd());
  }
  return out;
}
/** canvas 上画不了混排粗体,markdown 只去掉记号,留下能读的字 */
function plain(md) {
  return String(md || '').split('\n').map((l) => l
    .replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^#{1,6}\s+/, '').replace(/^\s*[-*]\s+/, '• ')).join('\n');
}
function ago(sec) {
  if (sec == null) return '';
  if (sec < 60) return Math.floor(sec) + 's'; if (sec < 3600) return Math.floor(sec / 60) + ':' + String(Math.floor(sec % 60)).padStart(2, '0');
  return Math.floor(sec / 3600) + ' 小时';
}
const fmtTok = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n || 0);
const ctxMax = (s) => s.ctxMax || (/\[1m\]/i.test(s.model || '') ? 1e6 : 2e5);
const isCodex = (sid) => String(sid || '').startsWith('codex:');

/** 权限请求 → 卡片里要显示的东西 */
function reqModel(req) {
  const ti = req.toolInput || {}, tool = req.toolName || 'Tool';
  const lines = (s, n) => String(s || '').split('\n').filter((l) => l.trim()).slice(0, n).map((l) => l.length > 58 ? l.slice(0, 57) + '…' : l);
  if (tool === 'Edit' || tool === 'MultiEdit') {
    const e = tool === 'MultiEdit' ? (ti.edits || [])[0] || {} : ti;
    return { tool, file: ti.file_path || '', del: lines(e.old_string, 3).map((l) => '- ' + l), add: lines(e.new_string, 3).map((l) => '+ ' + l) };
  }
  if (tool === 'Write') return { tool, file: ti.file_path || '', del: [], add: lines(ti.content, 3).map((l) => '+ ' + l) };
  mctx.font = F(12.5, 600, true);
  const cmd = ti.command || ti.url || ti.query || ti.prompt || ti.file_path || JSON.stringify(ti);
  return { tool, cmd: wrap(mctx, cmd, CW - 90).slice(0, 3), why: String(req.task || req.context || '').replace(/\s+/g, ' ').slice(0, 80) };
}
/** 卡片底下追加的几行"它现在的处境"(每行 20 高) */
function extras(s) {
  const out = [], now = Date.now();
  if (s.st === 'need' || s.st === 'ask') return out;
  if (s.error) out.push({ t: '⚠ Claude 里这段会话报错了', c: K.red });
  const qn = (queued.get(s.id) || []), qs = qn.some((x) => x.kind === 'stop');
  if (qn.length) out.push({ t: qs ? '已排队叫停 · 它下一次调用工具时停下' : `已排队 ${qn.length} 条话 · 它下一次调用工具时读到`, c: K.blue });
  const dg = digests.get(s.id); if (dg) out.push({ t: dg, c: K.lime });
  // 任务清单(Claude 的 TodoWrite):Desktop 侧栏看不到,这里一行就知道做到哪了
  if (s.todos && s.todos.total) out.push({ t: `✓ ${s.todos.done}/${s.todos.total}${s.todos.active ? ' · 正在:' + s.todos.active : ''}`, c: K.lime });
  const cf = compactFlash.get(s.id); if (cf && now - cf < 60000) out.push({ t: '刚压缩过上下文 · 更早的细节只剩摘要', c: K.amber });
  if (s.st === 'maybe') out.push(s.agent === 'codex'
    ? { t: `在 Codex 里等你批准 · 已等 ${ago(s.age)}`, c: K.amber, btn: '打开 Codex ↗' }
    : { t: `可能在 Claude 里等你允许 · 已等 ${ago(s.age)}`, c: K.amber, btn: '打开这个会话 ↗' });
  if ((s.errStreak || 0) >= 3) out.push({ t: `同一步连续失败 ${s.errStreak} 次 · 可能卡住了`, c: K.red });
  else if (s.repeat) out.push({ t: '在重复同一条命令', c: K.red });
  const k = (s.ctx || 0) / ctxMax(s);
  if (k > 0.85 && s.st !== 'idle') out.push({ t: `上下文 ${Math.round(k * 100)}% · 快要自动压缩了`, c: K.amber });
  return out;
}
/** 在问你 / 等你看计划(还没回答的 AskUserQuestion / ExitPlanMode):问题原文 + 选项 */
function askModel(s) {
  const a = s.ask || {}; mctx.font = F(12.5, 500);
  const lines = wrap(mctx, plain(a.text || ''), CW - 30).filter((l) => l.trim()).slice(0, a.kind === 'plan' ? 4 : 3);
  // 钩子没拦住它(这段会话开在直控之前):照实说,重开一次就能在这里答
  const hint = !s.live && direct.enabled && a.kind ? '这段会话开在直控之前 · 重开一次就能在这里直接答' : '';
  return { kind: a.kind, lines, opts: a.kind === 'plan' ? [] : (a.options || []).slice(0, 4), more: Math.max(0, (a.count || 1) - 1 - (a.qi || 0)), multi: !!a.multi, hint };
}
/** 选项:钩子拦着时是能点的按钮(点了就是答案);没拦着只是给你看 */
function askChips(s) {
  const am = askModel(s); if (!am.opts.length && !am.more) return [];
  mctx.font = F(11.5, 650);
  const oy = 36 + am.lines.length * 19 + 6, out = [];
  const list = am.opts.map((o, i) => ({ t: `${i + 1} ${o}`, idx: i })); if (am.more) list.push({ t: `+${am.more} 个问题`, extra: true });
  let x = 15;
  for (const c of list) {
    const w = mctx.measureText(c.t).width + 14; if (x + w > CW - 13) break;
    out.push({ ...c, x, y: oy, w, h: 22, sel: !!(s.live && s.live.picks && s.live.picks.has(c.idx)) }); x += w + 6;
  }
  return out;
}
/** 卡片底部那一排按钮 */
function askBtns(s) {
  const y = cardH(s) - 40, am = askModel(s), plan = am.kind === 'plan';
  let bs;
  if (!s.live) bs = [{ act: 'openClaude', label: plan ? '去 Claude 里看计划 ↗' : '去 Claude 里回答 ↗', primary: true }];
  else if (plan) bs = [{ act: 'planOk', label: '批准计划', primary: true }, { act: 'planNo', label: '打回…' }, { act: 'askPass', label: '在 Claude 里看 ↗' }];
  else if (am.multi) { const n = s.live.picks ? s.live.picks.size : 0; bs = [{ act: 'askSubmit', label: n ? `确定 · 已选 ${n}` : '先点选几项', primary: n > 0 }, { act: 'askPass', label: '在 Claude 里答 ↗' }]; }
  else bs = [{ act: 'askType', label: '打字回答…' }, { act: 'askPass', label: '在 Claude 里答 ↗' }];
  const w = (CW - 26 - 6 * (bs.length - 1)) / bs.length;
  return bs.map((b, i) => ({ ...b, x: 13 + i * (w + 6), y, w, h: 30 }));
}
function base0(s) {
  if (s.st === 'need') {
    const m = reqModel(s.req);
    if (m.cmd) return 36 + m.cmd.length * 19 + 16 + (m.why ? 22 : 0) + 42;
    return 36 + 26 + (m.del.length + m.add.length) * 19 + 12 + 42;
  }
  if (s.st === 'ask') { const m = askModel(s); return 36 + m.lines.length * 19 + (m.opts.length || m.more ? 30 : 0) + (m.hint ? 18 : 0) + 8 + 42; }
  // 没看过的新回答:空闲了也把那两行结果露出来(不然只剩一个标题,还得点进去)
  if (s.st === 'done' || (s.st === 'idle' && isUnread(s))) return s.summary ? 84 : 50;
  if (s.st === 'idle') return 40;
  return 64;
}
/** 卡片上一行小字(Conductor / agent view 那一类都有):分支 · **它自己**的未提交改动 · PR · 本轮用时 ·
 *  子代理 · 这个 5 小时窗口里它烧了多少。带 act 的能点(改动 → 预览的"改动"页,PR → 浏览器) */
function infoChips(s) {
  if (s.st === 'need' || s.st === 'ask') return [];
  const out = [], gi = gitInfo.get(s.id) || {}, u = usage && usage.active && usage.perSession ? usage.perSession[s.id] || 0 : 0;
  if (s.agent === 'codex') out.push({ t: s.liveGuess ? 'Codex · 按最近写入判断' : 'Codex', c: K.blue });
  if (gi.branch && gi.branch !== 'HEAD') out.push({ t: '⎇ ' + gi.branch, c: C.sub, max: 120 });
  if (gi.add || gi.del) {
    out.push({ t: `+${gi.add}`, c: K.add, act: 'diff' });
    out.push({ t: `−${gi.del}`, c: K.del, act: 'diff', tight: true });
    out.push({ t: `${(gi.files || []).length} 个文件`, c: C.sub, act: 'diff', tight: true });
  }
  const pr = (s.prs || []).slice(-1)[0]; if (pr) out.push({ t: '#' + pr.split('/').pop(), c: K.blue, act: 'pr', url: pr });
  if (isRun(s.st) && s.turnStart) { const m = Math.floor((Date.now() - s.turnStart) / 60000); out.push({ t: m < 1 ? '本轮 <1 分' : `本轮 ${m} 分`, c: C.sub }); }
  if (s.subagents) out.push({ t: `${s.subagents} 个子代理`, c: K.blue });
  if (u) out.push({ t: fmtTok(u) + ' tok', c: C.sub });
  // 排版:圆点隔开,放不下的从后往前丢
  mctx.font = F(11, 600);
  const row = [], dot = mctx.measureText(' · ').width;
  let x = 15;
  for (const ch of out) {
    const sep = row.length ? (ch.tight ? 5 : dot) : 0, t = ch.max ? ell(mctx, ch.t, ch.max) : ch.t, w = mctx.measureText(t).width;
    if (x + sep + w > CW - 13) break;
    row.push({ ...ch, t, x: x + sep, w, dotX: row.length && !ch.tight ? x : null });
    x += sep + w;
  }
  return row;
}
const infoY = (s) => base0(s) - 12;
const baseH = (s) => base0(s) + (infoChips(s).length ? 18 : 0);
/** 只影响"画成什么样"、不影响高度的东西:变了就原地重画,不换卡(不重新聚合) */
const paintSig = (s) => infoChips(s).map((c) => c.t).join('|') + '|' + (isUnread(s) ? 'u' : '') + '|' + (s.live && s.live.picks ? [...s.live.picks].join(',') : '');
const cardH = (s) => baseH(s) + extras(s).length * 20;
const hasBand = (s) => s.st !== 'need' && s.st !== 'ask' && s.st !== 'idle';
function btnRects(s) {
  const h = cardH(s), y = h - 40, w = (CW - 26 - 12) / 3;
  return [{ act: 'allow', x: 13, y, w, h: 30, label: '允许' }, { act: 'always', x: 13 + w + 6, y, w, h: 30, label: '总是允许' }, { act: 'deny', x: 13 + (w + 6) * 2, y, w, h: 30, label: '拒绝' }];
}
function extraBtnRect(s) {
  const ex = extras(s), i = ex.findIndex((e) => e.btn); if (i < 0) return null;
  mctx.font = F(11, 700); const w = mctx.measureText(ex[i].btn).width + 16;
  return { x: CW - 13 - w, y: baseH(s) - 12 + i * 20, w, h: 18, label: ex[i].btn };
}
function metaText(s) {
  if (s.st === 'need') return '等你批准';
  if (s.st === 'ask') {
    const a = s.ask || {};
    if (s.live) return a.kind === 'plan' ? '等你批准计划' : a.count > 1 ? `在问你 · 第 ${a.qi + 1}/${a.count} 问` : '在问你 · 直接点选项';
    return (a.kind === 'plan' ? '等你看计划 · ' : '在问你 · ') + ago(s.age);
  }
  if (s.st === 'maybe') return s.agent === 'codex' ? '等你批准' : '可能在等你';
  if (s.st === 'done') return '刚完成';
  if (s.st === 'idle') return ago(s.age) + ' 前';
  return ago(s.age);
}
/** 一张卡两层:'fill' = 大块底色(2×2 一颗)、'ink' = 字/边框/点(一颗一个物理像素,带光晕) */
function cardBmp(s, hover, layer) {
  const h = cardH(s), need = s.st === 'need', ask = s.st === 'ask', unread = isUnread(s);
  const m = need ? reqModel(s.req) : null;
  if (layer === 'fill') return raster(CW, h, (g) => {
    // 窗口是 100% 透明的:卡片自己带一层很淡的暗底,字才有东西托着
    // (46%:压在浅色窗口上 30% 不够 —— 实测灰色次要字发虚。窗口本身仍是 0,只有卡片带底)
    // 未读 = 底色带一点绿(AgentsRoom 的 green-tinted unread row)
    g.fillStyle = hover ? 'rgba(18,22,14,.50)' : unread ? 'rgba(14,26,10,.50)' : 'rgba(10,12,18,.46)'; rr(g, 1, 1, CW - 2, h - 2, 12); g.fill();
    if (ask) {
      const grd = g.createLinearGradient(0, 0, 0, h); grd.addColorStop(0, 'rgba(255,194,75,.20)'); grd.addColorStop(1, 'rgba(255,194,75,.06)');
      g.fillStyle = grd; rr(g, 1, 1, CW - 2, h - 2, 12); g.fill();
      for (const b of askBtns(s)) {
        g.fillStyle = b.primary ? (hover === b.act ? '#FFD27A' : 'rgba(255,194,75,.92)') : (hover === b.act ? 'rgba(255,255,255,.18)' : 'rgba(255,255,255,.10)');
        rr(g, b.x, b.y, b.w, b.h, 9); g.fill();
      }
      return;
    }
    // 按钮底色要实:深色字压在 22% 的淡琥珀上几乎看不见(实测)
    if (!need) { const eb = extraBtnRect(s); if (eb) { g.fillStyle = hover === 'openClaude' ? '#FFD27A' : 'rgba(255,194,75,.92)'; rr(g, eb.x, eb.y, eb.w, eb.h, 7); g.fill(); } return; }
    const grd = g.createLinearGradient(0, 0, 0, h); grd.addColorStop(0, 'rgba(255,194,75,.20)'); grd.addColorStop(1, 'rgba(255,194,75,.06)');
    g.fillStyle = grd; rr(g, 1, 1, CW - 2, h - 2, 12); g.fill();
    const boxH = m.cmd ? 12 + m.cmd.length * 19 : 26 + (m.del.length + m.add.length) * 19;
    g.fillStyle = 'rgba(0,0,0,.42)'; rr(g, 13, 34, CW - 26, boxH, 9); g.fill();
    for (const b of btnRects(s)) {
      const hov = hover === b.act;
      g.fillStyle = b.act === 'allow' ? (hov ? '#D7F866' : K.lime) : b.act === 'always' ? (hov ? 'rgba(201,240,61,.30)' : 'rgba(201,240,61,.18)') : (hov ? 'rgba(255,255,255,.18)' : 'rgba(255,255,255,.10)');
      rr(g, b.x, b.y, b.w, b.h, 9); g.fill();
    }
  }, { halo: false });
  return raster(CW, h, (g) => {
    g.lineWidth = 1;
    g.strokeStyle = need || ask || s.st === 'maybe' ? 'rgba(255,194,75,.55)' : hover ? 'rgba(201,240,61,.6)' : unread ? 'rgba(201,240,61,.34)' : 'rgba(255,255,255,.14)';
    rr(g, 0.5, 0.5, CW - 1, h - 1, 13); g.stroke();
    const dc = beadColor(s.st);
    if (s.st === 'maybe') { g.strokeStyle = dc; g.lineWidth = 1.6; g.beginPath(); g.arc(19, 20, 3.6, 0, 7); g.stroke(); g.lineWidth = 1; }
    else { g.fillStyle = dc; g.beginPath(); g.arc(19, 20, 4, 0, 7); g.fill(); }
    if (ask) { g.font = F(9, 800); g.fillStyle = '#1a1300'; g.textAlign = 'center'; g.fillText(s.ask && s.ask.kind === 'plan' ? '≡' : '?', 19, 15.5); g.textAlign = 'left'; }
    g.font = F(13.5, 650); g.fillStyle = C.list; g.fillText(ell(g, s.title, CW - 110), 32, 12);
    if (unread) {
      // 右上角:「新回答」小药丸代替时间 —— 它做完了、说了话,你还没看
      g.font = F(10.5, 800); const w = g.measureText('新回答').width + 12;
      g.fillStyle = K.lime; rr(g, CW - 13 - w, 11, w, 17, 6); g.fill(); g.fillStyle = '#101400'; g.fillText('新回答', CW - 13 - w + 6, 13.5);
    } else { g.font = F(11, 600); g.fillStyle = s.st === 'maybe' || ask ? K.amber : C.sub; g.textAlign = 'right'; g.fillText(metaText(s), CW - 13, 14); g.textAlign = 'left'; }
    if (ask) {
      const am = askModel(s);
      g.font = F(12.5, 500); g.fillStyle = '#EEF1F6'; am.lines.forEach((l, i) => g.fillText(l, 15, 36 + i * 19));
      const chips = askChips(s);
      g.font = F(11.5, 650);
      for (const c of chips) {
        if (c.sel) { g.fillStyle = K.amber; rr(g, c.x, c.y, c.w, 22, 7); g.fill(); }
        else if (s.live && !c.extra) { g.fillStyle = hover === 'opt' + c.idx ? 'rgba(255,194,75,.36)' : 'rgba(255,194,75,.16)'; rr(g, c.x, c.y, c.w, 22, 7); g.fill(); }
        g.strokeStyle = c.extra ? 'rgba(255,255,255,.25)' : 'rgba(255,194,75,.5)'; rr(g, c.x + 0.5, c.y + 0.5, c.w - 1, 21, 7); g.stroke();
        g.fillStyle = c.sel ? '#1a1300' : c.extra ? C.sub : K.amber; g.fillText(c.t, c.x + 7, c.y + 4);
      }
      if (am.hint) { g.font = F(11, 600); g.fillStyle = C.sub; g.fillText(ell(g, am.hint, CW - 30), 15, 36 + am.lines.length * 19 + (chips.length ? 30 : 0) + 2); }
      for (const b of askBtns(s)) { g.font = F(12, 700); g.fillStyle = b.primary ? '#1a1300' : K.t2; g.textAlign = 'center'; g.fillText(ell(g, b.label, b.w - 10), b.x + b.w / 2, b.y + 8); g.textAlign = 'left'; }
    }
    // 信息行:分支 · 改动 · PR · 本轮 · 用量
    const iy = infoY(s) + 3;
    for (const ch of infoChips(s)) {
      g.font = F(11, 600);
      if (ch.dotX != null) { g.fillStyle = 'rgba(174,181,194,.55)'; g.fillText(' · ', ch.dotX, iy); }
      g.fillStyle = ch.c; g.fillText(ch.t, ch.x, iy);
      if (hover === ch.act && ch.act) { g.fillStyle = ch.c; g.fillRect(ch.x, iy + 14, ch.w, 1); }
    }
    if (s.st === 'tool' || s.st === 'work' || s.st === 'maybe') {
      g.lineWidth = 1.6; g.strokeStyle = s.st === 'maybe' ? K.amber : K.lime; g.beginPath(); g.arc(19, 44, 5, 0.2, 4.6); g.stroke();
      g.font = F(12, 700, true); g.fillStyle = s.st === 'maybe' ? K.amber : K.lime; const tl = s.tool || '输出中'; g.fillText(tl, 32, 37);
      g.font = F(12, 600, true); g.fillStyle = K.t2; g.fillText(ell(g, s.arg || '', CW - 60 - g.measureText(tl).width), 32 + g.measureText(tl).width + 8, 37);
    } else if (s.st === 'think') {
      g.fillStyle = K.blue; for (let i = 0; i < 3; i++) { g.beginPath(); g.arc(17 + i * 6, 44, 2, 0, 7); g.fill(); }
      g.font = F(12, 600); g.fillText('在思考…', 38, 37);
    } else if ((s.st === 'done' || (s.st === 'idle' && unread)) && s.summary) {
      g.font = F(12.5, 500); g.fillStyle = K.t2;
      wrap(g, s.summary, CW - 30).slice(0, 2).forEach((l, i) => g.fillText(i === 1 ? ell(g, l, CW - 30) : l, 15, 36 + i * 19));
    } else if (need) {
      if (m.cmd) { if (m.why) { g.font = F(11.5, 500); g.fillStyle = K.t2; g.fillText(ell(g, m.why, CW - 30), 14, 34 + 12 + m.cmd.length * 19 + 8); } }
      else { g.font = F(12, 700, true); g.fillStyle = K.amber; g.fillText(m.tool, 24, 42); g.fillStyle = '#E9EDF5'; g.font = F(12, 600, true); g.fillText(ell(g, basename(m.file), CW - 110), 24 + g.measureText(m.tool).width + 10, 42); }
      for (const b of btnRects(s)) {
        g.font = F(12, 700); g.fillStyle = b.act === 'allow' ? '#101400' : b.act === 'always' ? K.lime : K.t2; g.textAlign = 'center';
        g.fillText(b.label, b.x + b.w / 2, b.y + 8); g.textAlign = 'left';
      }
    }
    // 追加的几行:离开期间 / 刚压缩 / 可能在等你 / 卡住 / 上下文快满
    const ex = extras(s), eb = extraBtnRect(s);
    ex.forEach((e, i) => {
      const y = baseH(s) - 12 + i * 20;
      g.font = F(11.5, 600); g.fillStyle = e.c; g.fillText(ell(g, e.t, CW - 30 - (e.btn && eb ? eb.w + 8 : 0)), 15, y + 3);
      if (e.btn && eb) { g.font = F(11, 700); g.fillStyle = '#1a1300'; g.fillText(eb.label, eb.x + 8, eb.y + 3); }
    });
  }, { halo: layer !== 'nohalo' });
}
/** 上下文水位:卡片底部一条线,长度 = 上下文用了多少(压缩发生时它被吸成一点) */
function bandBmp(s) {
  const k = Math.min(1, (s.ctx || 0) / ctxMax(s)), w = CW - 26;
  return raster(CW, 6, (g) => {
    g.fillStyle = 'rgba(255,255,255,.10)'; rr(g, 13, 1.5, w, 3, 1.5); g.fill();
    if (k > 0) { g.fillStyle = k > 0.85 ? K.red : k > 0.65 ? K.amber : K.lime; rr(g, 13, 1.5, Math.max(3, w * k), 3, 1.5); g.fill(); }
  }, { halo: false });
}
function cmdBmp(m) {
  return raster(CW - 50, m.cmd.length * 19 + 2, (g) => {
    m.cmd.forEach((l, i) => {
      g.font = F(12.5, 600, true); let x = 0;
      if (i === 0) { g.fillStyle = K.amber; g.font = F(12.5, 700, true); g.fillText(m.tool, 0, 2); x = g.measureText(m.tool + ' ').width + 6; g.font = F(12.5, 600, true); }
      g.fillStyle = '#EEF1F6'; g.fillText(l, i === 0 ? x : 12, 2 + i * 19);
    });
  });
}
function diffLine(txt, kind) { return raster(CW - 50, 18, (g) => { g.font = F(12, 600, true); g.fillStyle = kind === 'del' ? K.del : K.add; g.fillText(txt, 0, 2); }); }
function header(v) {
  const need = v.filter((s) => s.st === 'need' || s.st === 'ask').length, maybe = v.filter((s) => s.st === 'maybe').length, run = v.filter((s) => isRun(s.st)).length;
  const unread = v.filter(isUnread).length;
  return raster(CW, 34, (g) => {
    g.font = F(15, 700); g.fillStyle = C.title; g.fillText('在跑', 4, 8);
    let x = 46;
    const dp = directPill();
    const pill = (txt, bg, fg) => { g.font = F(11, 700); const w = g.measureText(txt).width + 16; if (x + w > dp.x - 6) return; g.fillStyle = bg; rr(g, x, 7, w, 20, 10); g.fill(); g.fillStyle = fg; g.fillText(txt, x + 8, 11); x += w + 6; };
    // 「直控」开关:开着 = 提问 / 计划在这里直接答,发话 / 叫停不切到 Claude
    g.font = F(11, 700); g.strokeStyle = direct.enabled ? 'rgba(201,240,61,.55)' : 'rgba(255,255,255,.22)'; rr(g, dp.x + 0.5, 7.5, dp.w - 1, 19, 10); g.stroke();
    g.fillStyle = direct.enabled ? K.lime : C.sub; g.fillText(dp.t, dp.x + 8, 11);
    if (need) pill(`${need} 等你`, K.amber, '#1a1300');
    if (maybe) pill(`${maybe} 可能在等`, 'rgba(255,194,75,.22)', K.amber);
    pill(`${run} 在跑`, 'rgba(201,240,61,.20)', K.lime);
    if (unread) pill(`${unread} 条新回答`, 'rgba(255,255,255,.12)', C.list);
    // 提示音 / 通知开关(点一下静音)
    g.font = F(13, 600); g.fillStyle = muted ? C.sub : K.lime; g.textAlign = 'right'; g.fillText(muted ? '🔕' : '🔔', CW - 6, 9); g.textAlign = 'left';
  });
}
function directPill() { mctx.font = F(11, 700); const t = direct.enabled ? '⚡ 直控' : '直控 · 关', w = mctx.measureText(t).width + 16; return { t, w, x: CW - 30 - w }; }
function directNoteText() {
  if (!direct.enabled) return '';
  if (Date.now() - directNote < 12000 || !Object.keys(direct.seen || {}).length) return '直控已开 · 新开或重开的会话可以在这里直接回答提问、批准计划、发话、叫停';
  return '';
}
function noteBmp(t) {
  return raster(CW, 42, (g) => {
    g.fillStyle = 'rgba(201,240,61,.10)'; rr(g, 0.5, 0.5, CW - 1, 41, 10); g.fill(); g.strokeStyle = 'rgba(201,240,61,.35)'; rr(g, 0.5, 0.5, CW - 1, 41, 10); g.stroke();
    g.font = F(11.5, 600); g.fillStyle = K.lime; wrap(g, t, CW - 24).slice(0, 2).forEach((l, i) => g.fillText(l, 12, 6 + i * 16));
  });
}
/** 5 小时窗口燃料条:时间过去了多少(条的长度)、用了多少、最近的速度、多久后重置 */
function fuelBmp() {
  const u = usage, now = Date.now();
  const frac = u && u.active ? Math.min(1, (now - u.start) / (u.resetAt - u.start)) : 0;
  const left = u && u.active ? Math.max(0, (u.resetAt - now) / 1000) : 0;
  return raster(CW, 44, (g) => {
    g.font = F(11, 700); g.fillStyle = C.sub; g.fillText('5 小时窗口', 6, 2);
    g.textAlign = 'right'; g.fillText(u && u.active ? `${Math.floor(left / 3600)}:${String(Math.floor(left % 3600 / 60)).padStart(2, '0')} 后重置` : '这个窗口还没开始', CW - 6, 2); g.textAlign = 'left';
    const w = CW - 12;
    g.fillStyle = 'rgba(255,255,255,.12)'; rr(g, 6, 19, w, 6, 3); g.fill();
    if (frac > 0) { const grd = g.createLinearGradient(6, 0, 6 + w, 0); grd.addColorStop(0, K.lime); grd.addColorStop(1, K.amber); g.fillStyle = grd; rr(g, 6, 19, Math.max(6, w * frac), 6, 3); g.fill(); }
    g.font = F(12, 600, true); g.fillStyle = K.t2;
    g.fillText(u && u.active ? `已用 ${fmtTok(u.total)} tok · 最近 ${fmtTok(u.ratePerMin)}/分钟` : '—', 6, 30);
  });
}
function secLabel(txt, action) {
  return raster(CW, 30, (g) => {
    g.font = F(11, 700); g.fillStyle = C.sub; g.fillText(txt, 6, 10);
    if (action) { g.font = F(11.5, 700); const w = g.measureText(action).width + 18; g.fillStyle = K.amber; rr(g, CW - w, 2, w, 24, 8); g.fill(); g.fillStyle = '#1a1300'; g.fillText(action, CW - w + 9, 8); }
  });
}
function idleFold(n, open) {
  return raster(CW, 36, (g) => { g.setLineDash([3, 4]); g.strokeStyle = 'rgba(255,255,255,.22)'; rr(g, 0.5, 0.5, CW - 1, 35, 11); g.stroke(); g.font = F(12, 600); g.fillStyle = C.sub; g.fillText(open ? `－ 收起 ${n} 条空闲的` : `＋ ${n} 条开着但空闲`, 14, 11); });
}
function emptyNote() { return raster(CW, 60, (g) => { g.font = F(12.5, 600); g.fillStyle = C.sub; g.fillText('没有在跑的会话', 8, 8); g.font = F(11.5, 500); g.fillText('Claude / Codex 里开着的会话会出现在这里', 8, 30); }); }
function bead(st, unread) {
  return raster(20, 20, (g) => {
    const col = beadColor(st);
    if (st === 'maybe') { g.strokeStyle = col; g.lineWidth = 1.6; g.beginPath(); g.arc(10, 10, 3.4, 0, 7); g.stroke(); return; }
    const grd = g.createRadialGradient(10, 10, 0, 10, 10, 10);
    grd.addColorStop(0, col); grd.addColorStop(0.35, col); grd.addColorStop(0.36, col + '66'); grd.addColorStop(1, col + '00');
    g.fillStyle = grd; g.fillRect(0, 0, 20, 20);
    if (unread) { g.strokeStyle = K.lime; g.lineWidth = 1.4; g.beginPath(); g.arc(10, 10, 6.2, 0, 7); g.stroke(); }
  }, { halo: false });
}
function idleBead(unread) { return raster(20, 12, (g) => { g.fillStyle = unread ? K.lime : 'rgba(255,255,255,.32)'; g.beginPath(); g.arc(10, 6, unread ? 3 : 2.4, 0, 7); g.fill(); }, { halo: false }); }
function countBadge(n) { return raster(20, 16, (g) => { g.fillStyle = K.amber; rr(g, 2, 1, 16, 14, 5); g.fill(); g.fillStyle = '#1a1300'; g.font = F(10, 800); g.textAlign = 'center'; g.fillText(String(n), 10, 3); }, { halo: false }); }
/** 一股粒子流的"颗粒"(流动模式下位置由着色器算,这里只决定有多少颗、什么颜色) */
function flowDots(n, col) {
  return raster(20, 20, (g) => { g.fillStyle = col; for (let i = 0; i < n; i++) { const a = (i * 97.3) % 20, b = (i * 57.1 + 3) % 20; g.fillRect(Math.floor(a), Math.floor(b), 1, 1); } }, { halo: false });
}

/* ── 列表版面:算出每个 item 在哪;和上一次比 —— 新的入场、没了的退场、动了的平移 ── */
function cardKey(s) {
  // 状态、正在做的事、请求 id、追加的提示变了,就是"换了一张卡"(旧的风化、新的聚成)
  const ex = extras(s).map((e) => e.t.slice(0, 6)).join(',');
  // 信息行有没有(影响高度)算"换卡";信息行里的字变了只原地重画(paintSig)
  const ask = s.st === 'ask' && s.ask ? (s.ask.text || '').slice(0, 24) + (s.ask.options || []).length + (s.live ? 'L' + s.live.qi : '') + (askModel(s).hint ? 'h' : '') : '';
  return `card|${s.id}|${s.st}|${s.req ? s.req.id : ''}|${isRun(s.st) || s.st === 'maybe' ? (s.tool || '') + ':' + (s.arg || '') : ''}|${s.st === 'done' ? (s.summary || '').slice(0, 20) : ''}|${ex}|${ask}|${infoChips(s).length ? 'i' : ''}|${s.st === 'idle' && isUnread(s) ? 'u' : ''}`;
}
function listLayout(v) {
  const items = [];
  let y = TOP + 4;
  const nNeed = v.filter((s) => s.st === 'need' || s.st === 'ask').length;
  items.push({ key: `hdr|${nNeed}|${v.filter((s) => s.st === 'maybe').length}|${v.filter((s) => isRun(s.st)).length}|${v.filter(isUnread).length}|${muted}|${direct.enabled}`, kind: 'hdr', y, h: 34, draw: () => header(v) }); y += 38;
  const dn = directNoteText(); if (dn) { items.push({ key: 'dnote|' + dn, kind: 'note', y, h: 42, draw: () => noteBmp(dn) }); y += 48; }
  items.push({ key: 'fuel', kind: 'fuel', y, h: 44, draw: fuelBmp }); y += 50;
  const groups = [['need', '需要你'], ['run', '在跑'], ['done', '刚完成']];
  for (const [g, label] of groups) {
    const ss = v.filter((s) => g === 'run' ? isRun(s.st) : g === 'need' ? isWaiting(s.st) : s.st === g);
    if (!ss.length) continue;
    const nreq = ss.filter((s) => s.st === 'need').length;
    const act = g === 'need' && nreq > 1 ? `全部允许一次 · ${nreq}` : null;
    items.push({ key: `sec|${g}|${act || ''}`, kind: 'sec', y, h: 30, draw: () => secLabel(label, act), allowAll: !!act }); y += 30;
    for (const s of ss) { items.push({ key: cardKey(s), kind: 'card', s, y, h: cardH(s), paint: paintSig(s) }); y += cardH(s) + 8; }
  }
  // 空闲的里面有没看过的新回答:不折叠,排在折叠条前面(做完了的结果不该藏起来)
  const idleAll = v.filter((s) => s.st === 'idle'), fresh = idleAll.filter(isUnread), idle = idleAll.filter((s) => !isUnread(s));
  if (!v.some((s) => s.st !== 'idle')) { items.push({ key: 'empty', kind: 'note', y, h: 60, draw: emptyNote }); y += 64; }
  if (fresh.length) {
    items.push({ key: 'sec|fresh', kind: 'sec', y, h: 30, draw: () => secLabel('有新回答 · 你还没看') }); y += 30;
    for (const s of fresh) { items.push({ key: cardKey(s), kind: 'card', s, y, h: cardH(s), paint: paintSig(s) }); y += cardH(s) + 8; }
  }
  if (idle.length) {
    items.push({ key: `idle|${idle.length}|${showIdle}`, kind: 'fold', y: y + 4, h: 36, draw: () => idleFold(idle.length, showIdle) }); y += 48;
    if (showIdle) for (const s of idle) { items.push({ key: cardKey(s), kind: 'card', s, y, h: cardH(s), paint: paintSig(s) }); y += cardH(s) + 6; }
  }
  return { items, height: y };
}
let listHeight = 0;
function elsOf(it) { return it.els || []; }
function placeItem(it, enter) {
  const y = it.y - listScroll, els = [];
  const put = (id, bmp, ox, oy, o = {}) => { f.set(id, bmp, { x: CX + ox, y: y + oy, z: o.z ?? 2, density: o.density, enter: o.noEnter ? null : enter, shimmer: o.shimmer }); els.push({ id, ox, oy }); };
  if (it.kind !== 'card') put(it.key, it.draw(), 0, 0);
  else {
    const s = it.s, k = it.key;
    put('f|' + k, cardBmp(s, null, 'fill'), 0, 0, { z: 1, density: 0.25 });
    put('c|' + k, cardBmp(s, null, 'ink'), 0, 0, { shimmer: isRun(s.st) ? { speed: 0.35, width: 70, strength: 0.3 } : null });
    if (hasBand(s)) put('band|' + k, bandBmp(s), 0, cardH(s) - 8, { z: 3 });
    if (s.st === 'need') {
      const m = reqModel(s.req);
      if (m.cmd) put('cmd|' + k, cmdBmp(m), 24, 42, { z: 3 });
      else {
        const played = diffPlayed.has(s.req.id);
        m.del.forEach((l, i) => put(`d|${k}|${i}`, diffLine(l, 'del'), 24, 60 + i * 19, { z: 3 }));
        if (played) m.add.forEach((l, i) => put(`a|${k}|${i}`, diffLine(l, 'add'), 24, 60 + (m.del.length + i) * 19, { z: 3 }));
      }
    }
  }
  it.els = els;
  clipItem(it);
}
/** 滚到表头底下的 item 不画(粒子没有裁剪,按整个 item 隐藏) */
function clipItem(it) {
  const y = it.y - listScroll;
  // 也不画到底部输入栏下面(只在列表状态有那一栏)
  const hide = it.kind !== 'hdr' && (y < TOP + 36 || (mode === 'list' && y + (it.h || 0) > innerHeight - BAR_H));
  for (const e of elsOf(it)) f.style(e.id, { alpha: hide ? 0 : 1 });
}
function render(opt = {}) {
  if (mode === 'strip') { syncBars(); return renderRail(opt); }
  const v = view();
  const { items, height } = listLayout(v);
  listHeight = height;
  const maxScroll = Math.max(0, height - (innerHeight - 20 - (mode === 'list' ? BAR_H : 0)));
  if (listScroll > maxScroll) listScroll = maxScroll;
  const next = new Map(); hits = [];
  for (const it of items) {
    const was = placed.get(it.key);
    // 刚答完的那张卡:不管是谁触发了这次重排,都要从状态点那一点炸开
    const pe = it.s && pendingEnter.get(it.s.id);
    const peEnter = pe && pe.until > Date.now() ? pe.enter : null;
    if (!was) placeItem(it, opt.instant ? null : (peEnter ?? opt.enterFor?.(it) ?? { mode: it.kind === 'card' && (it.s.st === 'need' || it.s.st === 'maybe') ? 'assemble' : 'scatter', dur: 0.55, sweep: 0.22, tint: it.s ? rgb(beadColor(it.s.st)) : [1, 1, 1] }));
    else {
      it.els = was.els;
      if (was.y !== it.y || opt.instant || opt.scrolled) for (const e of it.els) f.move(e.id, CX + e.ox, it.y - listScroll + e.oy, opt.scrolled || opt.instant ? 0 : 0.42);
      // 信息行 / 未读变了:原地重画这张卡(粒子不重新聚合 —— 这种小变化不值得一场动画)
      if (it.kind === 'card' && was.paint !== it.paint) { const hv = hoverKey && hoverKey.startsWith(it.key + '#') ? hoverKey.split('#')[1] : null; repaintCard(it.key, hv, it); }
      clipItem(it);
    }
    next.set(it.key, it);
    const y = it.y - listScroll;
    if (it.kind === 'card') {
      if (it.s.st === 'need' && !it.s.req._answered) btnRects(it.s).forEach((b) => hits.push({ act: b.act, x: CX + b.x, y: y + b.y, w: b.w, h: b.h, sid: it.s.id, key: it.key }));
      const eb = extraBtnRect(it.s); if (eb) hits.push({ act: 'openClaude', x: CX + eb.x, y: y + eb.y, w: eb.w, h: eb.h, sid: it.s.id, key: it.key });
      if (it.s.st === 'ask') {
        for (const b of askBtns(it.s)) hits.push({ act: b.act, x: CX + b.x, y: y + b.y, w: b.w, h: b.h, sid: it.s.id, key: it.key });
        if (it.s.live) for (const c of askChips(it.s)) if (!c.extra) hits.push({ act: 'opt' + c.idx, x: CX + c.x, y: y + c.y, w: c.w, h: c.h, sid: it.s.id, key: it.key });
      }
      const iy = infoY(it.s);
      for (const ch of infoChips(it.s)) if (ch.act) hits.push({ act: ch.act, url: ch.url, x: CX + ch.x - 3, y: y + iy, w: ch.w + 6, h: 18, sid: it.s.id, key: it.key });
      hits.push({ act: 'card', x: CX, y, w: CW, h: it.h, sid: it.s.id, key: it.key, card: true });
    }
    if (it.kind === 'hdr') { hits.push({ act: 'mute', x: CX + CW - 34, y, w: 34, h: 30 }); const dp = directPill(); hits.push({ act: 'direct', x: CX + dp.x, y: y + 5, w: dp.w, h: 24 }); }
    if (it.kind === 'fuel') fuelAt = [CX + 6 + (CW - 12) * (usage && usage.active ? Math.min(1, (Date.now() - usage.start) / (usage.resetAt - usage.start)) : 0), y + 22];
    if (it.allowAll) hits.push({ act: 'allowAll', x: CX + CW - 150, y, w: 150, h: 26 });
    if (it.kind === 'fold') hits.push({ act: 'fold', x: CX, y, w: CW, h: 36 });
  }
  for (const [k, it] of placed) if (!next.has(k)) for (const e of elsOf(it)) if (f.has(e.id)) {
    // 压缩刚发生:这张卡的水位线被吸成一点(左端),其它部分照常风化
    const cz = it.s && compactFlash.get(it.s.id) && Date.now() - compactFlash.get(it.s.id) < 3000;
    f.exit(e.id, cz && e.id.startsWith('band|') ? { mode: 'absorb', to: [CX + 13, it.y - listScroll + e.oy + 3], dur: 0.7, tint: rgb(K.amber) } : (opt.exitFor?.(it) || { mode: 'dust', dur: 0.5 }));
  }
  placed = next;
  renderFlows();
  syncBars();
  // 第一次出现的 Edit 请求:自动播一次"删掉的碎落、新增的聚成"
  for (const it of items) if (it.kind === 'card' && it.s.st === 'need' && !reqModel(it.s.req).cmd && !diffPlayed.has(it.s.req.id)) {
    diffPlayed.add(it.s.req.id); setTimeout(() => playDiff(it.key), 700);
  }
}
/** 燃料流:每个最近 10 分钟在烧 token 的会话,从它的卡片往燃料条的火头流粒子 */
function renderFlows() {
  const want = new Map();
  if (mode !== 'strip' && usage && usage.active && fuelAt) {
    const rec = usage.recentPerSession || {};
    for (const it of placed.values()) {
      if (it.kind !== 'card') continue;
      const r = rec[it.s.id] || 0, y = it.y - listScroll;
      if (r <= 0 || y < TOP + 36 || y > innerHeight) continue;
      const n = Math.max(8, Math.min(90, Math.round(r / 1500)));
      want.set('flow|' + it.s.id, { n, from: [CX + CW - 24, y + 20], speed: 0.22 + Math.min(0.9, Math.log10(r) / 7), col: beadColor(it.s.st) });
    }
  }
  for (const id of [...f.els.keys()]) if (id.startsWith('flow|') && !want.has(id)) f.remove(id);
  for (const [id, w] of want) f.set(id, flowDots(w.n, w.col), { z: 0, flow: { from: w.from, to: fuelAt, speed: w.speed, bow: 26 } });
}
function rebuild() { for (const it of placed.values()) for (const e of elsOf(it)) f.remove(e.id); placed = new Map(); render({ instant: true }); if (pv) { for (const ids of pv.shown.values()) ids.forEach((e) => f.remove(e.id)); pv.shown.clear(); pvHeader(); syncPv(false); } }

/* ── 收起:状态珠轨 ─────────────────────────────────────────────────────── */
const beadY = (i) => TOP + 32 + i * 18;
let railSig = '';
function renderRail(opt = {}) {
  const v = view(), live = v.filter((s) => s.st !== 'idle'), idle = v.filter((s) => s.st === 'idle');
  const sig = live.map((s) => s.id + s.st + (isUnread(s) ? 'u' : '')).join(',') + '|' + idle.map((s) => (isUnread(s) ? 'u' : '.')).join('');
  if (sig === railSig && !opt.force) return;
  railSig = sig;
  for (const id of [...f.els.keys()]) if (id.startsWith('bead|') || id.startsWith('ibead|') || id.startsWith('badge|')) f.remove(id);
  const need = live.filter((s) => s.st === 'need' || s.st === 'ask').length;
  const en = opt.instant ? null : { mode: 'scatter', dur: 0.45, sweep: 0 };
  if (need) f.set('badge|' + need, countBadge(need), { x: -3, y: TOP + 6, z: 3, enter: en });
  // "等你"的珠子呼吸(亮带扫过);收起时只有它在动,12fps 足够,其它时候循环停着
  live.forEach((s, i) => f.set('bead|' + s.id, bead(s.st, isUnread(s)), { x: -3, y: beadY(i) - 10, z: 3, enter: en, shimmer: s.st === 'need' || s.st === 'ask' ? { speed: 0.9, width: 12, strength: 0.7 } : null }));
  // 空闲的:有没看过的新回答就是一颗绿点,不然是灰点 —— 收起时也知道"有结果等你看"
  idle.slice(0, 12).forEach((s, i) => f.set('ibead|' + i, idleBead(isUnread(s)), { x: -3, y: beadY(live.length + i) - 6, z: 3, enter: en }));
  f.ambientFps = 12;
}
function clearRail() { for (const id of [...f.els.keys()]) if (id.startsWith('bead|') || id.startsWith('ibead|') || id.startsWith('badge|')) f.remove(id); railSig = ''; }

/* ── "你离开期间":展开时按每条会话上次被看到的时间,数它这段时间干了什么 ── */
function computeDigests() {
  const seen = loadSeen(), now = Date.now(), out = new Map();
  for (const s of active) {
    const last = seen[s.id];
    if (!last || now - last < 3 * 60000 || !Array.isArray(s.events)) continue;
    const ev = s.events.filter((e) => e.t > last);
    if (!ev.length) continue;
    const files = new Set(ev.filter((e) => e.k === 'edit').map((e) => e.v)).size;
    const cmds = ev.filter((e) => e.k === 'cmd').length, errs = ev.filter((e) => e.k === 'err').length, comp = ev.some((e) => e.k === 'compact');
    const bits = [files && `改了 ${files} 个文件`, cmds && `${cmds} 条命令`, errs && `${errs} 次失败`, comp && '压缩过'].filter(Boolean);
    if (bits.length) out.set(s.id, `离开 ${Math.round((now - last) / 60000)} 分钟:` + bits.join(' · '));
  }
  return out;
}
function markSeen() { const seen = loadSeen(), now = Date.now(); for (const s of active) seen[s.id] = now; saveSeen(seen); }

/* ── 动效 1:珠子 → 卡片 / 卡片 → 珠子 ───────────────────────────────────── */
function expand() {
  if (mode !== 'strip') return;
  const live = view().filter((s) => s.st !== 'idle');
  const at = new Map(live.map((s, i) => [s.id, [7, beadY(i)]]));
  clearRail(); f.ambientFps = 30;
  digests = computeDigests();
  mode = 'list'; listScroll = 0;
  render({ enterFor: (it) => it.s && at.has(it.s.id)
      ? { mode: 'point', from: at.get(it.s.id), dur: 0.7, sweep: 0.28, delay: 0.04 * live.findIndex((x) => x.id === it.s.id), tint: rgb(beadColor(it.s.st)) }
      : { mode: 'point', from: [7, TOP + 14], dur: 0.6, sweep: 0.3 } });
  loadActive(); loadUsage(); lastGit = Date.now(); loadGit();
}
function collapse() {
  if (mode === 'strip') return;
  closePreview(true);
  markSeen(); digests = new Map();
  const live = view().filter((s) => s.st !== 'idle');
  for (const id of [...f.els.keys()]) if (id.startsWith('flow|')) f.remove(id);
  for (const it of placed.values()) {
    const i = it.s ? live.findIndex((x) => x.id === it.s.id) : -1, to = [7, i >= 0 ? beadY(i) : TOP + 14];
    for (const e of elsOf(it)) if (f.has(e.id)) f.exit(e.id, { mode: 'absorb', to, dur: 0.5, tint: rgb(it.s ? beadColor(it.s.st) : K.t2) });
  }
  placed = new Map(); hits = []; hoverKey = null;
  mode = 'strip';
  syncBars();
  // Rust 已经把窗口缩成 14 宽;卡片被吸进珠子的那一下在窗口外看不到全程,所以珠子稍后再出来
  setTimeout(() => { if (mode === 'strip') renderRail({ force: true }); }, 380);
}

/* ── 动效 2:允许 → 吸入;拒绝 → 碎落 ──────────────────────────────────── */
function answer(sid, act) {
  const req = perms.get(sid); if (!req || req._answered) return;
  const it = [...placed.values()].find((x) => x.s && x.s.id === sid && x.s.st === 'need');
  // 先只标记"已答":卡片在原位多留一会儿,等命令被吸完/碎完再从列表里拿掉 ——
  // 立刻拿掉的话下面的卡马上往上补位,正好压在正在飞的命令上,画面一团乱
  req._answered = true;
  setTimeout(() => { if (perms.get(sid) === req) perms.delete(sid); render(); }, act === 'deny' ? 800 : 700);
  invoke('permission_respond', { id: req.id, decision: act }).catch((e) => dlog('respond failed ' + e));
  emit('permission-answered', req.id);   // 岛屿上同一张卡跟着收起
  overrides.set(sid, { st: act === 'deny' ? 'think' : 'tool', until: Date.now() + 5000 });
  if (!it) return;
  const y = it.y - listScroll, dot = [CX + 19, y + 20];
  const cmdIds = it.els.filter((e) => /^(cmd|d|a)\|/.test(e.id)).map((e) => e.id);
  for (const id of cmdIds) f.exit(id, act === 'deny' ? { mode: 'shatter', dur: 1.0, tint: rgb(K.red) } : { mode: 'absorb', to: dot, dur: 0.6, tint: rgb(K.lime) });
  it.els = it.els.filter((e) => !cmdIds.includes(e.id));
  const a = active.find((x) => x.id === sid);
  if (a && act !== 'deny') { a.state = 'tool'; a.tool = req.toolName; a.arg = reqModel(req).cmd?.join(' ') || basename(req.toolInput?.file_path); a.age = 0; }
  pendingEnter.set(sid, { enter: { mode: 'point', from: dot, dur: 0.6, sweep: 0.2, delay: 0.1, tint: rgb(act === 'deny' ? K.blue : K.lime) }, until: Date.now() + 2200 });
}
function allowAll() { [...perms.keys()].forEach((sid, i) => setTimeout(() => answer(sid, 'allow'), i * 160)); }

/* ── 动效 3:改动 —— 删掉的行碎落、新增的行聚成 ─────────────────────────── */
function playDiff(key) {
  const it = placed.get(key); if (!it || !it.s || !it.s.req) return;
  const m = reqModel(it.s.req), y = it.y - listScroll;
  for (const e of [...it.els]) if (e.id.startsWith('a|')) { f.remove(e.id); it.els = it.els.filter((x) => x !== e); }
  m.del.forEach((_, i) => { const id = `d|${key}|${i}`; if (f.has(id)) f.exit(id, { mode: 'shatter', dur: 1.1, tint: rgb(K.red), delay: i * 0.12 }); });
  m.add.forEach((l, i) => { const id = `a|${key}|${i}`, oy = 60 + (m.del.length + i) * 19;
    f.set(id, diffLine(l, 'add'), { x: CX + 24, y: y + oy, z: 3, enter: { mode: 'assemble', dur: 0.75, sweep: 0.35, delay: 0.35 + i * 0.18, tint: rgb(K.add) } });
    it.els.push({ id, ox: 24, oy }); });
  // 碎完之后把"删掉的"以淡红留在上面 —— 批准前能对照改了什么
  setTimeout(() => { const cur = placed.get(key); if (!cur) return; m.del.forEach((l, i) => { const id = `d|${key}|${i}`;
    f.set(id, diffLine(l, 'del'), { x: CX + 24, y: cur.y - listScroll + 60 + i * 19, z: 3, alpha: 0.5, enter: { mode: 'scatter', dur: 0.5, sweep: 0.1 } });
    if (!cur.els.some((e) => e.id === id)) cur.els.push({ id, ox: 24, oy: 60 + i * 19 }); }); }, 1500);
}

/* ── 预览 + 动效 4:新消息按阅读顺序落下;长回答默认折起 ─────────────── */
const imgs = new Map();
function buildGroups(entries) {
  const groups = [];
  for (const m of entries) {
    const last = groups[groups.length - 1];
    if (m.kind === 'tool' && last && last.tools) last.tools.push(m.text);
    else if (m.kind === 'tool') groups.push({ tools: [m.text] });
    else groups.push(m);
  }
  return groups;
}
const FOLD_AT = 8, FOLD_SHOW = 4;
/** 只量高度(不画)—— 画只画看得见的那几组 */
function measure(g, i) {
  g._more = 0;
  if (g.kind === 'divider') return 30;
  if (g.kind === 'dfile') return 34;
  if (g.kind === 'dlines') return g.lines.length * 17 + 4;
  if (g.tools) return 34;
  if (g.kind === 'image') { const im = imgs.get(pv.sid + '|' + g.text); return (im && im.naturalWidth ? Math.min(260, 340 * im.naturalHeight / im.naturalWidth) : 60) + 14; }
  mctx.font = F(13.5, g.role === 'user' ? 600 : 500);
  const lines = wrap(mctx, g.role === 'user' ? g.text : plain(g.text), g.role === 'user' ? PV.maxW * 0.82 - 26 : PV.maxW);
  // 长回答:先只露前几行,点"展开"粒子才流出全文 —— 一眼扫完所有消息,想看细节再展开
  if (g.role !== 'user' && lines.length > FOLD_AT && !pv.open.has(i)) { g._lines = lines.slice(0, FOLD_SHOW); g._more = lines.length - FOLD_SHOW; }
  else { g._lines = lines.slice(0, 60); if (lines.length > 60) g._lines.push('…(还有 ' + (lines.length - 60) + ' 行)'); }
  if (g.role === 'user') return g._lines.length * 21 + 18 + 14;
  return g._lines.length * 22 + (g._more ? 24 : 0) + 14;
}
function groupEls(g, i) {
  const k = `g|${pv.sid}|${pv.tab}|${i}|${pv.open.has(i) ? 'o' : 'c'}`;
  if (g.kind === 'divider') return [{ id: k, ox: 0, bmp: raster(PV.maxW, 22, (c) => { c.font = F(11, 600); c.fillStyle = C.sub; c.textAlign = 'center'; c.fillText('— ' + g.text + ' —', PV.maxW / 2, 4); }) }];
  /* "改动"页:文件头(路径 + 新文件 / +N −M)和 diff 行(新增绿底、删除红底、@@ 换成 ⋯ 接函数名) */
  if (g.kind === 'dfile') return [
    { id: k + '|f', ox: 0, density: 0.25, z: 1, bmp: raster(PV.maxW, 26, (c) => { c.fillStyle = 'rgba(255,255,255,.08)'; rr(c, 0, 1, PV.maxW, 24, 7); c.fill(); }, { halo: false }) },
    { id: k, ox: 0, bmp: raster(PV.maxW, 26, (c) => {
      c.font = F(11.5, 700, true); c.textAlign = 'right'; let x = PV.maxW - 10;
      c.fillStyle = K.del; c.fillText(`−${g.del}`, x, 7); x -= c.measureText(`−${g.del}  `).width;
      c.fillStyle = K.add; c.fillText(`+${g.add}`, x, 7); x -= c.measureText(`+${g.add}  `).width;
      if (g.isNew) { c.fillStyle = K.lime; c.fillText('新文件', x, 7); x -= c.measureText('新文件  ').width; }
      c.textAlign = 'left'; c.font = F(12.5, 700, true); c.fillStyle = C.title; c.fillText(ell(c, g.path, x - 16), 10, 6);
    }) },
  ];
  if (g.kind === 'dlines') {
    const h = g.lines.length * 17 + 2;
    return [
      { id: k + '|f', ox: 0, density: 0.25, z: 1, bmp: raster(PV.maxW, h, (c) => { g.lines.forEach((l, j) => { if (l[0] === '+' || l[0] === '-') { c.fillStyle = l[0] === '+' ? 'rgba(126,226,168,.13)' : 'rgba(255,142,142,.13)'; c.fillRect(0, j * 17, PV.maxW, 17); } }); }, { halo: false }) },
      { id: k, ox: 0, bmp: raster(PV.maxW, h, (c) => { c.font = F(11.5, 600, true); g.lines.forEach((l, j) => {
        const hunk = l.startsWith('@@');
        c.fillStyle = l[0] === '+' ? K.add : l[0] === '-' ? K.del : hunk ? K.blue : K.t2;
        c.fillText(ell(c, hunk ? l.replace(/^@@[^@]*@@\s?/, '⋯ ') : l, PV.maxW - 10), 6, 2 + j * 17); }); }) },
    ];
  }
  if (g.tools) {
    const counts = {}; for (const t of g.tools) { const n = t.split(/\s+/)[0] || 'tool'; counts[n] = (counts[n] || 0) + 1; }
    const list = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([n, c]) => c > 1 ? `${n} ×${c}` : n);
    return [{ id: k, ox: 0, bmp: raster(PV.maxW, 26, (c) => { let x = 0; c.font = F(11, 650, true);
      for (const t of list) { const w = c.measureText(t).width + 14; if (x + w > PV.maxW) break; c.fillStyle = 'rgba(12,30,22,.55)'; rr(c, x, 2, w, 21, 7); c.fill(); c.strokeStyle = 'rgba(168,245,208,.32)'; c.stroke(); c.fillStyle = C.tool; c.fillText(t, x + 7, 6); x += w + 6; } }) }];
  }
  if (g.kind === 'image') {
    const key = pv.sid + '|' + g.text, im = imgs.get(key);
    if (im === undefined) loadImage(key);
    if (!im || !im.naturalWidth) return [{ id: k, ox: 0, bmp: raster(200, 22, (c) => { c.font = F(11, 600); c.fillStyle = C.sub; c.fillText('[图片 加载中…]', 0, 4); }) }];
    const w = Math.min(340, im.naturalWidth), h = Math.min(260, w * im.naturalHeight / im.naturalWidth);
    // 图片 = 彩色粒子,2×2 一颗(停下时就是原图的样子)
    return [{ id: k + '|img', ox: g.role === 'user' ? PV.maxW - w : 0, density: 0.25, bmp: raster(w, h, (c) => { c.save(); rr(c, 0, 0, w, h, 10); c.clip(); c.drawImage(im, 0, 0, w, h); c.restore(); c.strokeStyle = 'rgba(255,255,255,.2)'; rr(c, 0.5, 0.5, w - 1, h - 1, 10); c.stroke(); }, { halo: false }) }];
  }
  if (g.role === 'user') {
    const W = PV.maxW * 0.82, lines = g._lines, h = lines.length * 21 + 18;
    return [
      { id: k + '|f', ox: PV.maxW - W, density: 0.25, z: 1, bmp: raster(W, h + 2, (c) => { c.fillStyle = 'rgba(40,70,130,.42)'; rr(c, 0.5, 0.5, W - 1, h, 13); c.fill(); }, { halo: false }) },
      { id: k, ox: PV.maxW - W, bmp: raster(W, h + 2, (c) => { c.strokeStyle = 'rgba(127,178,255,.38)'; rr(c, 0.5, 0.5, W - 1, h, 13); c.stroke(); c.font = F(13.5, 600); c.fillStyle = C.user; lines.forEach((l, j) => c.fillText(l, 13, 10 + j * 21)); }) },
    ];
  }
  return [{ id: k, ox: 0, bmp: raster(PV.maxW, g._lines.length * 22 + (g._more ? 24 : 0) + 4, (c) => {
    c.font = F(13.5, 500); c.fillStyle = C.assistant; g._lines.forEach((l, j) => c.fillText(l, 0, 2 + j * 22));
    if (g._more) { c.font = F(12, 700); c.fillStyle = K.lime; c.fillText(`▾ 展开全部 · 还有 ${g._more} 行`, 0, 4 + g._lines.length * 22); }
  }) }];
}
async function loadImage(key) {
  imgs.set(key, null);
  const [id, ref] = key.split('|');
  let url = null;
  try { url = await invoke('sd_image', { id, n: Number(ref.split(':')[1]) }); } catch (e) { url = (window.__DOCK_SAMPLE?.images || {})[key] || null; }
  if (!url) return;
  const im = new Image();
  im.onload = () => { imgs.set(key, im); if (pv && pv.sid === id) { relayoutPv(); const i = pv.groups.findIndex((g) => g.kind === 'image' && id + '|' + g.text === key); const ids = pv.shown.get(i); if (ids) { ids.forEach((e) => f.remove(e.id)); pv.shown.delete(i); } syncPv(false, new Set([i]), 'scatter'); } };
  im.src = url;
}
function relayoutPv() { let y = 0; pv.L = pv.groups.map((g, i) => { const h = measure(g, i); const r = { y, h }; y += h; return r; }); pv.height = y; }
const viewH = () => innerHeight - PV.top - 16;   // 回复框已经在上面了,底部不用再留
/** 只让视野里(上下各多留一小段)的消息变成粒子;滚出去的删掉 */
function syncPv(animate, fresh, freshMode = 'rain') {
  if (!pv) return;
  const top = PV.top - pv.scrollTop;
  pv.hits = [];
  for (let i = 0; i < pv.groups.length; i++) {
    const r = pv.L[i], y = top + r.y, vis = y + r.h > PV.top - 120 && y < innerHeight + 120;
    const shown = pv.shown.get(i);
    if (vis && !shown) {
      const isFresh = fresh && fresh.has(i), els = groupEls(pv.groups[i], i), len = (pv.groups[i].text || '').length;
      for (const e of els) f.set(e.id, e.bmp, { x: PV.x + e.ox, y, z: e.z ?? 2, density: e.density,
        enter: isFresh ? (freshMode === 'rain' ? { mode: 'rain', dur: 0.55, sweep: Math.min(2.2, 0.25 + len / 120), drop: 26, tint: rgb(K.lime) } : { mode: 'scatter', dur: 0.8, sweep: 0.5 })
          : animate === true ? { mode: 'point', from: pv.from, dur: 0.65, sweep: 0.3 } : null });
      pv.shown.set(i, els.map((e) => ({ id: e.id, ox: e.ox })));
    } else if (vis && shown) {
      for (const e of shown) f.move(e.id, PV.x + e.ox, y, animate === 'move' ? 0.35 : 0);
    } else if (!vis && shown) { shown.forEach((e) => f.remove(e.id)); pv.shown.delete(i); }
    const s2 = pv.shown.get(i); if (s2) for (const e of s2) f.style(e.id, { alpha: y < PV.top - 2 ? 0 : 1 });
    const g = pv.groups[i];
    if (vis && g._more) pv.hits.push({ gi: i, x: PV.x, y: y + g._lines.length * 22 + 2, w: 240, h: 22 });
  }
}
function pvHeader() {
  if (!pv) return;
  const s = view().find((x) => x.id === pv.sid) || { title: pv.title };
  f.set('pvh|' + pv.sid, raster(PV_W - 40, 46, (g) => {
    g.font = F(16, 700); g.fillStyle = C.title; g.fillText(ell(g, s.title, PV_W - 60), 0, 2);
    g.font = F(11.5, 600); g.fillStyle = C.sub;
    const k = s.ctx ? Math.round(s.ctx / ctxMax(s) * 100) : 0;
    const bits = [s.project, s.model, s.turns ? s.turns + ' 轮' : '', k ? `上下文 ${k}%` : ''].filter(Boolean).join(' · ');
    g.fillText(bits, 0, 26);
    const st = s.st === 'need' ? '● 等你批准' : s.st === 'maybe' ? (s.agent === 'codex' ? '● 在 Codex 里等你批准' : '○ 可能在等你') : isRun(s.st) ? '● 正在跑 ' + (s.tool || '') : s.st === 'done' ? '● 刚完成' : '';
    if (st) { g.fillStyle = s.st === 'need' || s.st === 'maybe' ? K.amber : K.lime; g.fillText(st, g.measureText(bits + '   ').width, 26); }
    if (pv.newCount) { const x = PV_W - 110; g.fillStyle = K.lime; rr(g, x, 22, 62, 18, 6); g.fill(); g.fillStyle = '#101400'; g.font = F(10.5, 800); g.fillText(`新 +${pv.newCount}`, x + 10, 25); }
  }), { x: PV.x, y: TOP + 4, z: 2, enter: pv.hdrShown ? null : { mode: 'point', from: pv.from, dur: 0.6, sweep: 0.3 } });
  /* 标题下面一行:直接对这一段会话动手(Vibe Island / Omnara 那一类的核心 —— 不用切到 Claude 去找它),
     再下面一行:它改了哪些文件、跑了几条命令、失败几次、任务做到哪(或者刚才那个动作的结果) */
  // 「改动」:在对话和它自己的未提交 diff 之间切(Conductor 的 diff 视图;只算它改过的文件)
  const gi = gitInfo.get(pv.sid) || {};
  const diffLabel = pv.tab === 'diff' ? '← 回到对话' : (gi.add || gi.del ? `改动 +${gi.add} −${gi.del}` : '改动');
  // Codex 会话只看 + 跳过去(没有能送话的钩子);Claude 会话才有继续 / 停下 / 压缩
  const acts = isCodex(pv.sid) ? [['jump', '↗ 在 Codex 里打开'], ['diff', diffLabel]]
    : [['jump', '↗ 打开这个会话'], ['diff', diffLabel], ['continue', '继续'], ['stop', '停下'], ['compact', '压缩上下文']];
  const ev = Array.isArray(s.events) ? s.events : [];
  const files = [...new Set(ev.filter((x) => x.k === 'edit').map((x) => x.v))];
  const cmds = ev.filter((x) => x.k === 'cmd').length, errs = ev.filter((x) => x.k === 'err').length;
  const stat = [files.length && `改了 ${files.length} 个文件:${files.slice(0, 3).join('、')}${files.length > 3 ? '…' : ''}`,
    cmds && `${cmds} 条命令`, errs && `${errs} 次失败`, s.todos && s.todos.total ? `✓ ${s.todos.done}/${s.todos.total}` : ''].filter(Boolean).join(' · ');
  mctx.font = F(11.5, 700); let cx = 0; pv.actHits = [];
  for (const [act, label] of acts) { const w = mctx.measureText(label).width + 18; pv.actHits.push({ act, x: PV.x + cx, y: TOP + 52, w, h: 22, label }); cx += w + 6; }
  f.set('pva|' + pv.sid, raster(PV_W - 40, 48, (g) => {
    for (const h of pv.actHits) {
      const x = h.x - PV.x, hot = pv.flash === h.act;
      g.fillStyle = hot ? K.lime : 'rgba(201,240,61,.16)'; rr(g, x, 0, h.w, 22, 7); g.fill();
      g.strokeStyle = 'rgba(201,240,61,.45)'; rr(g, x + 0.5, 0.5, h.w - 1, 21, 7); g.stroke();
      g.font = F(11.5, 700); g.fillStyle = hot ? '#101400' : K.lime; g.fillText(h.label, x + 9, 4);
    }
    // 开在直控之前的会话:照实说"重开一次才能在这里直接发话 / 叫停"(现在只能走辅助功能,会闪一下 Claude)
    const old = direct.enabled && s.id && !canDirect(s) && s.st !== 'idle';
    const line = pv.msg || (old ? (stat ? stat + ' · ' : '') + '重开这段会话后能在这里直接发话 / 叫停' : stat);
    g.font = F(11, 600); g.fillStyle = pv.msg ? (pv.msgBad ? K.amber : K.lime) : C.sub; g.fillText(ell(g, line, PV_W - 60), 0, 30);
  }), { x: PV.x, y: TOP + 52, z: 2 });
  pv.hdrShown = true;
  // 回复框说清楚回车会干什么
  const re = document.getElementById('reply');
  if (re) {
    const la = liveAsks.get(pv.sid), q = la && la.tool !== 'ExitPlanMode' ? (la.input.questions || [])[la.qi] : null;
    re.placeholder = la ? (q ? `回车直接回答:${q.question}` : '写修改意见,回车打回计划(空着回车也行)')
      : (isRun(s.st) || s.st === 'maybe') && canDirect(s) ? '回车发给它 · 它下一次调用工具时读到,不切到 Claude' : '回复这一段会话… 回车发送';
  }
  syncBars();
}
/** 预览头上那四个动作。辅助功能在 Claude Desktop 的侧栏里按标题找到这一段会话;
 *  找不到就不发(发进别的会话比不发糟得多)—— 结果写在按钮下面那一行 */
async function pvAction(act) {
  if (!pv) return;
  if (act === 'diff') { setTab(pv.tab === 'diff' ? 'chat' : 'diff'); return; }
  const sid = pv.sid, s = view().find((x) => x.id === sid) || { title: pv.title };
  if (isCodex(sid)) {
    let r; try { r = await invoke('sd_codex_open', { id: sid }); } catch (e) { r = { ok: false, error: String(e) }; }
    pv.msgBad = !(r && r.ok); pv.msg = r && r.ok ? '已在 Codex 里打开这一段 ✓' : '没能直接跳到这一段,只打开了 Codex'; pvHeader(); return;
  }
  // 在跑、装着直控钩子:叫停走排队(它下一次调用工具时停),不切到 Claude
  if (act === 'stop' && (isRun(s.st) || s.st === 'maybe') && canDirect(s)) {
    const r = await directQueue(s, 'stop', '');
    if (!pv || pv.sid !== sid) return;
    pv.msgBad = !r.ok; pv.msg = r.ok ? '已排队:它下一次调用工具时停下(不切到 Claude)' : '没排上:' + r.error; pvHeader(); return;
  }
  pv.flash = act; pv.msg = act === 'jump' ? '正在打开…' : act === 'stop' ? '正在叫它停下…' : '正在发送…'; pv.msgBad = false; pvHeader();
  let r;
  try {
    if (act === 'jump') r = await invoke('sd_jump', { title: s.title });
    else if (act === 'stop') r = await invoke('sd_stop', { title: s.title });
    else r = await invoke('sd_send', { title: s.title, text: act === 'compact' ? '/compact' : '继续' });
  } catch (e) { r = { ok: false, error: String(e) }; }
  dlog(`action ${act} "${s.title}" -> ${JSON.stringify(r)}`);
  if (!pv || pv.sid !== sid) return;
  const err = r && r.error;
  pv.flash = null; pv.msgBad = !(r && r.ok);
  pv.msg = r && r.ok ? (act === 'jump' ? '已在 Claude 里打开这一段 ✓' : (act === 'stop' ? '已叫它停下 ✓' : '已发送 ✓') + (r.restored ? ' 已切回你原来的窗口' : ''))
    : err === 'not_trusted' ? '需要给 Terse 开「辅助功能」权限(系统设置 → 隐私与安全性)'
    : err === 'session_not_found' ? '在 Claude 侧栏里没找到这一段(只把 Claude 调到了前面)'
    : err === 'claude_not_running' ? 'Claude 没在运行' : '没成功:' + err;
  pvHeader();
  setTimeout(() => { if (pv && pv.sid === sid) { pv.msg = ''; pvHeader(); } }, 5000);
}
/* 回复框:打一句话回车,发进这一段会话 */
const replyEl = document.getElementById('reply');
const replyHint = document.getElementById('replyHint');
function showReply(v) {
  if (replyEl) replyEl.style.display = v ? 'block' : 'none';
  if (replyHint) replyHint.style.display = v ? 'block' : 'none';
  syncBars();
}
/** 这次回车会怎么送 —— 写在输入框旁边,发之前就知道(直接送进去,还是在 Claude 里替你打字) */
function routeHint(s) {
  if (!s) return '';
  if (isCodex(s.id)) return 'Codex 会话不能从这里发 · 点「在 Codex 里打开」';
  const la = liveAsks.get(s.id);
  if (la) return la.tool === 'ExitPlanMode' ? '回车 = 带着意见打回计划 · 直接送进去(不切窗口)' : '回车 = 直接回答它的提问 · 不切窗口';
  if ((isRun(s.st) || s.st === 'maybe') && canDirect(s)) return '直接送进去 · 它下一次调用工具时读到(不切窗口)';
  return '会在 Claude 里替你打字发送 · Claude 闪一下,马上切回你原来的窗口';
}
/** 发给一段会话:在等你答 → 回答 / 打回;在跑且装着钩子 → 排队直送;其它 → 在 Claude 里替你打字(发完切回) */
async function sendTo(sid, text) {
  const s = view().find((x) => x.id === sid) || { id: sid, st: 'idle', title: pv && pv.sid === sid ? pv.title : '' };
  if (isCodex(sid)) return { ok: false, keep: true, msg: 'Codex 会话不能从这里发' };
  const la = liveAsks.get(sid);
  if (la) {
    if (la.tool === 'ExitPlanMode') { answerAsk(sid, { reject: text }); return { ok: true, msg: '已打回,它会按你的意见改 ✓' }; }
    if (!text) return { ok: false, keep: true, msg: '' };
    const q = (la.input.questions || [])[la.qi]; if (q) la.answers[q.question] = text;
    nextQuestion(sid);
    const more = liveAsks.has(sid);
    return { ok: true, more, msg: more ? '已答这一问 · 还有下一问' : '已回答 ✓' };
  }
  if (!text) return { ok: false, keep: true, msg: '' };
  if ((isRun(s.st) || s.st === 'maybe') && canDirect(s)) {
    const r = await directQueue(s, 'msg', text);
    return r.ok ? { ok: true, msg: '已排队:它下一次调用工具时读到(停下时也会送到)' } : { ok: false, keep: true, msg: '没排上:' + r.error };
  }
  let r; try { r = await invoke('sd_send', { title: s.title, text }); } catch (er) { r = { ok: false, error: String(er) }; }
  dlog(`send "${s.title}" -> ${JSON.stringify(r)}`);
  if (r && r.ok) return { ok: true, msg: r.restored ? '已在 Claude 里发送 ✓ 已切回你原来的窗口' : '已在 Claude 里发送 ✓' };
  const e = r && r.error;
  return { ok: false, keep: true, msg: e === 'session_not_found' ? '在 Claude 侧栏里没找到这一段,没有发送'
    : e === 'not_trusted' ? '需要给 Terse 开「辅助功能」权限(系统设置 → 隐私与安全性)' : '没发出去:' + e };
}
const planPending = (sid) => { const la = liveAsks.get(sid); return !!(la && la.tool === 'ExitPlanMode'); };
if (replyEl) {
  // 会话栏平时从不抢焦点;要打字的时候才临时成为焦点窗口(Rust 那边顺手记住你原来在用哪个 app)
  replyEl.addEventListener('mousedown', () => { invoke('sd_focus_input').catch(() => {}); });
  replyEl.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') { replyEl.blur(); return; }
    if (e.key !== 'Enter' || e.isComposing || !pv) return;
    const sid = pv.sid, text = replyEl.value.trim();
    if (!text && !planPending(sid)) return;
    replyEl.value = '';
    pv.msg = '正在发送…'; pv.msgBad = false; pvHeader();
    const r = await sendTo(sid, text);
    if (!r.more) replyEl.blur();
    if (!r.ok && r.keep) replyEl.value = text;   // 没发出去:字还给用户
    if (!pv || pv.sid !== sid) return;
    pv.msg = r.msg; pv.msgBad = !r.ok; pvHeader();
    setTimeout(() => { if (pv && pv.sid === sid) { pv.msg = ''; pvHeader(); } }, 5000);
  });
}
/* 列表底部常驻输入栏:不用先打开预览 —— 发给你最后指过的那张卡;没指过就是排在最上面的那张 */
const qbar = document.getElementById('qbar'), qhint = document.getElementById('qhint');
const BAR_H = 76;               // 输入栏 + 提示那一行占的高度:列表的卡片不画到它下面
let lastPointed = null, qflash = '', qflashUntil = 0;
function qTarget() {
  const v = view();
  return (lastPointed && v.find((s) => s.id === lastPointed)) || v.find((s) => s.st !== 'idle' && !isCodex(s.id)) || v[0] || null;
}
function syncBars() {
  const listOn = mode === 'list';
  if (qbar) qbar.style.display = listOn ? 'block' : 'none';
  if (qhint) qhint.style.display = listOn ? 'block' : 'none';
  if (listOn) {
    const t = qTarget();
    if (qbar) { qbar.placeholder = t ? `回复「${t.title}」… 回车发送` : '没有在跑的会话'; qbar.disabled = !t; }
    if (qhint) qhint.textContent = qflash && Date.now() < qflashUntil ? qflash : t ? `→ ${t.title} · ${routeHint(t)}` : '';
  }
  if (replyHint && pv) replyHint.textContent = routeHint(view().find((x) => x.id === pv.sid) || { id: pv.sid, st: 'idle' });
}
if (qbar) {
  qbar.addEventListener('mousedown', () => { invoke('sd_focus_input').catch(() => {}); });
  qbar.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') { qbar.blur(); return; }
    if (e.key !== 'Enter' || e.isComposing) return;
    const t = qTarget(); if (!t) return;
    const text = qbar.value.trim();
    if (!text && !planPending(t.id)) return;
    qbar.value = ''; qflash = `正在发给「${t.title}」…`; qflashUntil = Date.now() + 20000; syncBars();
    const r = await sendTo(t.id, text);
    if (!r.more) qbar.blur();
    if (!r.ok && r.keep) qbar.value = text;
    qflash = r.msg ? `${r.msg} · 「${t.title}」` : ''; qflashUntil = Date.now() + 5000; syncBars();
    setTimeout(syncBars, 5100);
  });
}
async function openPreview(sid, tab = 'chat') {
  if (pv && pv.sid === sid) { if (pv.tab !== tab) setTab(tab); return; }
  const it = [...placed.values()].find((x) => x.s && x.s.id === sid); if (!it) return;
  closePreview(true);
  const s = it.s;
  pv = { sid, tab, title: s.title, groups: [], L: [], height: 0, scrollTop: 0, shown: new Map(), open: new Set(), hits: [], sig: '', from: [CX + CW, it.y - listScroll + 20], hdrShown: false, newCount: 0 };
  if (mode !== 'preview') { mode = 'preview'; invoke('sd_dock', { mode: 'preview' }).catch(() => {}); }
  // 看过了 = 已读(卡片上的「新回答」和绿底跟着消失)
  markRead(sid); render();
  pvHeader();
  showReply(!isCodex(sid));   // Codex 会话没法从这里送话,不放一个发不出去的输入框
  await loadConv(true);
}
/** 预览在「对话」和「改动」之间切:整页换掉,改动页从顶上看起 */
function setTab(tab) {
  if (!pv || pv.tab === tab) return;
  for (const ids of pv.shown.values()) ids.forEach((e) => f.exit(e.id, { mode: 'dust', dur: 0.3 }));
  Object.assign(pv, { tab, groups: [], L: [], height: 0, scrollTop: 0, sig: '', open: new Set(), newCount: 0 });
  pv.shown.clear();
  pvHeader();
  loadConv(true);
}
let lastDiffAt = 0;
async function loadDiff(first) {
  const now = Date.now(); if (!first && now - lastDiffAt < 5000) return; lastDiffAt = now;
  const sid = pv.sid, s = active.find((x) => x.id === sid) || {};
  let d;
  try { d = await invoke('sd_diff', { cwd: s.cwd || '', paths: s.editPaths || [] }); } catch (e) { d = (window.__DOCK_SAMPLE?.diffs || {})[sid] || { files: [] }; }
  if (!pv || pv.sid !== sid || pv.tab !== 'diff') return;
  const files = d && Array.isArray(d.files) ? d.files : [];
  const sig = JSON.stringify(files.map((x) => [x.path, x.add, x.del, (x.lines || []).length]));
  if (sig === pv.sig) return;
  pv.sig = sig;
  const groups = [];
  if (!files.length) groups.push({ kind: 'divider', text: (s.editPaths || []).length ? '它改过的文件都已经提交了' : '这段会话还没改过文件' });
  for (const fl of files) {
    groups.push({ kind: 'dfile', path: fl.path, add: fl.add, del: fl.del, isNew: !!fl.new });
    const ls = fl.lines || [];
    for (let i = 0; i < ls.length; i += 14) groups.push({ kind: 'dlines', lines: ls.slice(i, i + 14) });
  }
  // 改动是整页换(不是往下追加):旧的直接拿掉再铺
  for (const ids of pv.shown.values()) ids.forEach((e) => f.remove(e.id));
  pv.shown.clear();
  pv.groups = groups; relayoutPv();
  pv.scrollTop = Math.min(pv.scrollTop, Math.max(0, pv.height - viewH()));
  syncPv(first ? true : false);
}
function closePreview(instant) {
  if (!pv) return;
  for (const id of [...f.els.keys()]) if (id.startsWith('g|' + pv.sid) || id.startsWith('pvh|') || id.startsWith('pva|')) f.exit(id, { mode: instant ? 'dust' : 'absorb', to: [PV_X, TOP + 200], dur: 0.4 });
  markRead(pv.sid);
  pv = null;
  showReply(false);
  if (mode === 'preview') mode = 'list';
}
function toggleGroup(gi) {
  if (!pv) return;
  if (pv.open.has(gi)) pv.open.delete(gi); else pv.open.add(gi);
  const ids = pv.shown.get(gi); if (ids) { ids.forEach((e) => f.exit(e.id, { mode: 'dust', dur: 0.3 })); pv.shown.delete(gi); }
  relayoutPv();
  syncPv('move', new Set([gi]), 'rain');
}
async function loadConv(first) {
  if (!pv) return;
  if (pv.tab === 'diff') return loadDiff(first);
  const sid = pv.sid;
  if (!first) readAt[sid] = Date.now();   // 正开着看 = 一直是已读(这里不写盘;关预览时 closePreview 写)
  let m;
  try { m = await invoke('sd_transcript', { id: sid, limit: 160 }); } catch (e) { m = (window.__DOCK_SAMPLE?.transcripts || {})[sid] || []; }
  if (!pv || pv.sid !== sid) return;
  const sig = m.length + '|' + (m[m.length - 1]?.text || '').slice(-40);
  if (sig === pv.sig) return;
  pv.sig = sig;
  const before = pv.groups.length, wasBottom = first || pv.scrollTop >= pv.height - viewH() - 30;
  pv.groups = buildGroups(m);
  relayoutPv();
  const fresh = new Set();
  if (!first && pv.groups.length > before) { for (let i = before; i < pv.groups.length; i++) fresh.add(i); pv.newCount = pv.groups.length - before; pvHeader(); setTimeout(() => { if (pv) { pv.newCount = 0; pvHeader(); } }, 4000); }
  // 最后一组如果还在变长(同一组追加了文字),把它当新的重新落一遍
  if (!first && pv.groups.length === before && before) { const i = before - 1, ids = pv.shown.get(i); if (ids) { ids.forEach((e) => f.remove(e.id)); pv.shown.delete(i); } fresh.add(i); }
  if (wasBottom) pv.scrollTop = Math.max(0, pv.height - viewH());
  syncPv(first ? true : 'move', fresh);
}

/* ── 数据 ───────────────────────────────────────────────────────────────── */
let activeSig = '', firstLoad = true;
/* 提示音 + 系统通知:状态**变了**才响(需要你 / 做完了 / 连续失败)。人不盯着屏幕的时候,
   是声音把人叫回来的(Vibe Island 每个事件都有声音)。标题行的 🔔 点一下静音。第一次加载不响。 */
let muted = false;
try { muted = localStorage.getItem('terse-dock-mute') === '1'; } catch (e) {}
const prevSt = new Map(), prevErr = new Map();
function alertTransitions() {
  for (const s of view()) {
    const was = prevSt.get(s.id), wasErr = prevErr.get(s.id) || 0;
    prevSt.set(s.id, s.st); prevErr.set(s.id, s.errStreak || 0);
    if (was === undefined || muted) continue;
    const needNow = isWaiting(s.st), needWas = isWaiting(was);
    let kind = null;
    if (needNow && !needWas) kind = 'need';
    else if (s.st === 'done' && isRun(was)) kind = 'done';
    else if ((s.errStreak || 0) >= 3 && wasErr < 3) kind = 'error';
    if (!kind) continue;
    const body = kind === 'need' ? (s.req ? `${s.req.toolName} 等你批准` : s.agent === 'codex' ? `Codex 在等你批准:${String(s.arg || '').slice(0, 100)}` : s.st === 'ask' ? (s.ask && s.ask.kind === 'plan' ? '计划写好了,等你看' : '在问你:' + String(s.ask && s.ask.text || '').slice(0, 120)) : '可能在 Claude 里等你允许')
      : kind === 'done' ? String(s.summary || '做完了').slice(0, 140) : `同一步连续失败 ${s.errStreak} 次,可能卡住了`;
    invoke('sd_alert', { kind, title: s.title || 'Claude', body }).catch(() => {});
  }
}
async function loadActive() {
  let a;
  try { a = await invoke('sd_active'); } catch (e) { a = window.__DOCK_SAMPLE?.active || []; }
  active = Array.isArray(a) ? a : [];
  // 压缩检测:这次看到的最近一次压缩比上次记下的新 → "刚压缩过"
  for (const s of active) {
    const c = s.compactTs || 0, was = seenCompact.get(s.id);
    if (!firstLoad && was !== undefined && c > was) compactFlash.set(s.id, Date.now());
    seenCompact.set(s.id, c);
  }
  firstLoad = false;
  // 第一次见到的会话:当作已经看过(不然一装上所有空闲会话都是"新回答")
  let dirty = false;
  for (const s of active) if (readAt[s.id] === undefined) { readAt[s.id] = s.lastTextTs || Date.now(); dirty = true; }
  if (dirty) saveRead();
  alertTransitions();
  const sig = JSON.stringify(active.map((x) => [x.id, x.state, x.tool, x.arg, x.title, (x.summary || '').slice(0, 20), Math.round((x.ctx || 0) / 5000), x.errStreak, x.repeat, (x.age || 0) > 25,
    x.todos ? x.todos.done + '/' + x.todos.total : '', x.ask ? (x.ask.text || '').slice(0, 30) : '', x.lastTextTs, (x.prs || []).join(), x.subagents, x.error,
    x.turnStart ? Math.floor((Date.now() - x.turnStart) / 60000) : 0]));
  if (sig !== activeSig) { activeSig = sig; render(); if (pv) pvHeader(); }
  else if (mode === 'strip') renderRail();
}
/** 每条在跑的会话:分支 + 它自己改过的文件里还没提交的 +/−(Rust 端缓存 8 秒) */
async function loadGit() {
  await Promise.all(active.filter((s) => s.cwd).map(async (s) => {
    let g;
    try { g = await invoke('sd_git', { cwd: s.cwd, paths: s.editPaths || [] }); } catch (e) { g = (window.__DOCK_SAMPLE?.git || {})[s.id] || null; }
    if (g && typeof g === 'object') gitInfo.set(s.id, g);
  }));
  const sig = JSON.stringify([...gitInfo].map(([k, g]) => [k, g.branch, g.add, g.del, (g.files || []).length]));
  if (sig !== gitSig) { gitSig = sig; if (mode !== 'strip') { render(); if (pv) pvHeader(); } }
}
async function loadUsage() {
  let u;
  try { u = await invoke('sd_usage'); } catch (e) { u = window.__DOCK_SAMPLE?.usage || null; }
  usage = u;
  if (mode === 'strip') return;
  const it = placed.get('fuel');
  if (it) { const e = it.els[0]; if (e) f.set(e.id, fuelBmp(), { x: CX, y: it.y - listScroll, z: 2 }); }
  render();
}
// 展开时 2.5 秒问一次,收起时 6 秒(收起只用来更新珠子);用量 20 秒一次,只在展开时
// git 10 秒一次,也只在展开时(收起时珠子用不到它)
let lastActive = 0, lastUsage = 0, lastGit = 0;
setInterval(() => {
  const now = Date.now(), gap = mode === 'strip' ? 6000 : 2500;
  if (now - lastActive >= gap - 100) { lastActive = now; loadActive(); }
  if (mode !== 'strip' && now - lastUsage >= 20000) { lastUsage = now; loadUsage(); }
  if (mode !== 'strip' && now - lastGit >= 10000) { lastGit = now; loadGit(); }
}, 1000);
setInterval(() => { if (pv) loadConv(false); }, 1500);

/* ── 直控(dock_hook.rs)──────────────────────────────────────────────────── */
function answerAsk(sid, reply) {
  const la = liveAsks.get(sid); if (!la) return;
  liveAsks.delete(sid);
  window.__dockLastAnswer = { id: la.id, reply };   // 测试页用
  invoke('sd_answer', { id: la.id, reply }).catch((e) => dlog('answer failed ' + e));
  if (!reply.pass) overrides.set(sid, { st: reply.reject !== undefined ? 'think' : 'tool', until: Date.now() + 5000 });
  render(); if (pv && pv.sid === sid) pvHeader();
}
function nextQuestion(sid) {
  const la = liveAsks.get(sid); if (!la) return;
  la.qi++; la.picks = new Set();
  if (la.qi >= (la.input.questions || []).length) answerAsk(sid, { answers: la.answers });
  else { render(); if (pv && pv.sid === sid) pvHeader(); }
}
function pickOpt(sid, idx) {
  const la = liveAsks.get(sid); if (!la) return;
  const q = (la.input.questions || [])[la.qi]; const o = q && (q.options || [])[idx]; if (!o) return;
  if (q.multiSelect) { if (la.picks.has(idx)) la.picks.delete(idx); else la.picks.add(idx); render(); return; }
  la.answers[q.question] = o.label;
  nextQuestion(sid);
}
function submitMulti(sid) {
  const la = liveAsks.get(sid); if (!la || !la.picks.size) return;
  const q = (la.input.questions || [])[la.qi];
  // 多选:几个选项的 label 用逗号连起来(Agent SDK 答多选题的格式)
  la.answers[q.question] = [...la.picks].sort((a, b) => a - b).map((i) => q.options[i].label).join(', ');
  nextQuestion(sid);
}
/** 打字回答 / 打回计划:打开这一段的预览,把光标放进回复框 */
async function replyFor(sid) {
  await openPreview(sid);
  if (!pv || pv.sid !== sid) return;
  pvHeader();
  invoke('sd_focus_input').catch(() => {});
  setTimeout(() => { const re = document.getElementById('reply'); if (re) re.focus(); }, 80);
}
async function directQueue(s, kind, text) {
  let r; try { r = await invoke('sd_queue', { sessionId: s.id, kind, text }); } catch (e) { r = { ok: false, error: String(e) }; }
  if (r && r.ok) {
    const q = (queued.get(s.id) || []).filter((x) => kind !== 'stop' || x.kind !== 'stop');
    q.push({ id: r.id, kind, text }); queued.set(s.id, q); render();
  }
  return r || { ok: false, error: 'no reply' };
}
async function toggleDirect() {
  const on = !direct.enabled;
  let r = null; try { r = await invoke('sd_direct_set', { on }); } catch (e) { dlog('direct_set failed ' + e); }
  direct.enabled = r ? !!r.enabled : on;
  if (r && r.seen) direct.seen = r.seen;
  if (direct.enabled) { directNote = Date.now(); setTimeout(() => render(), 12100); } else { liveAsks.clear(); queued.clear(); }
  render();
}
let directSig = '';
async function loadDirect() {
  let d; try { d = await invoke('sd_direct_status'); } catch (e) { d = window.__DOCK_SAMPLE?.direct || null; }
  if (!d) return;
  direct = { enabled: !!d.enabled, seen: d.seen || {} };
  // 会话栏重新加载时钩子可能正拦着:从 Rust 那边把还在等的提问补回来;已经不等了的拿掉
  if (Array.isArray(d.asks)) {
    for (const a of d.asks) if (!liveAsks.has(a.sessionId)) liveAsks.set(a.sessionId, { id: a.id, tool: a.tool, input: a.input || {}, cwd: a.cwd, qi: 0, answers: {}, picks: new Set() });
    for (const [sid, la] of liveAsks) if (!d.asks.some((a) => a.id === la.id)) liveAsks.delete(sid);
  }
  if (d.queued && typeof d.queued === 'object') { queued.clear(); for (const [k, q] of Object.entries(d.queued)) queued.set(k, q); }
  const sig = JSON.stringify([direct.enabled, Object.keys(direct.seen).length, [...liveAsks.values()].map((x) => x.id), [...queued].map(([k, q]) => k + q.length)]);
  if (sig !== directSig) { directSig = sig; render(); if (pv) pvHeader(); }
}
listen('dock-ask', (e) => {
  const p = e?.payload; if (!p || !p.id) return;
  liveAsks.set(p.sessionId, { id: p.id, tool: p.tool, input: p.input || {}, cwd: p.cwd, qi: 0, answers: {}, picks: new Set() });
  if (!direct.seen[p.sessionId]) direct.seen[p.sessionId] = Date.now();
  render(); alertTransitions();
  if (pv && pv.sid === p.sessionId) pvHeader();
});
listen('dock-ask-done', (e) => {
  const p = e?.payload || {}; const la = liveAsks.get(p.sessionId);
  if (la && la.id === p.id) { liveAsks.delete(p.sessionId); render(); if (pv && pv.sid === p.sessionId) pvHeader(); }
});
listen('dock-delivered', (e) => {
  const p = e?.payload || {}, ids = p.ids || [];
  const q = (queued.get(p.sessionId) || []).filter((x) => !ids.includes(x.id));
  if (q.length) queued.set(p.sessionId, q); else queued.delete(p.sessionId);
  if (pv && pv.sid === p.sessionId) {
    pv.msgBad = false; pv.msg = (p.kinds || []).includes('stop') ? '已叫停 ✓' : p.via === 'stop' ? '已送到 ✓ 它停下时读到了,正接着做' : '已送到 ✓ 它读到了你的话';
    pvHeader(); const sid = p.sessionId; setTimeout(() => { if (pv && pv.sid === sid) { pv.msg = ''; pvHeader(); } }, 5000);
  }
  render();
});
setInterval(() => { if (mode !== 'strip' || Date.now() % 15000 < 5000) loadDirect(); }, 5000);

/* ── 权限中继 ───────────────────────────────────────────────────────────── */
listen('permission-request', (e) => {
  const req = e?.payload; if (!req || !req.id) return;
  perms.set(req.sessionId || req.id, req);
  render();
  alertTransitions();   // 等批准:马上响,不等下一次轮询
  // 画出来了才回执(和岛屿一样:两帧之后,外加 300ms 兜底)
  let sent = false; const ack = () => { if (sent) return; sent = true; invoke('permission_ack', { id: req.id }).catch(() => {}); };
  requestAnimationFrame(() => requestAnimationFrame(ack)); setTimeout(ack, 300);
});
// 已经在这里答了的(_answered)不管:它自己会在吸入动画结束后拿掉 —— 我们广播的
// permission-answered 也会被自己收到,不跳过的话会把那段延迟整个抵消
const dropReq = (id) => { for (const [sid, r] of perms) if (r.id === id && !r._answered) { perms.delete(sid); render(); } };
listen('permission-timeout', (e) => dropReq(e?.payload));
listen('permission-answered', (e) => dropReq(e?.payload));   // 在岛屿上答了

/* ── Rust 发来的状态和光标 ─────────────────────────────────────────────── */
listen('sd-state', (ev) => {
  const m = (ev?.payload || {}).mode || 'strip';
  if (m === 'strip') collapse(); else if (mode === 'strip') expand();
  setTimeout(() => dlog(`mode=${m} ${JSON.stringify(f.stats())} active=${active.length} perms=${perms.size} usage=${usage && usage.active ? usage.total : '-'}`), 1200);
});
function hitAt(x, y) {
  for (let i = hits.length - 1; i >= 0; i--) { const h = hits[i]; if (!h.card && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return h; }
  return hits.find((h) => h.card && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) || null;
}
function repaintCard(key, hv, fresh) {
  const it = fresh || placed.get(key); if (!it || !it.s) return;
  const y = it.y - listScroll;
  f.set('c|' + key, cardBmp(it.s, hv, 'ink'), { x: CX, y, z: 2, shimmer: isRun(it.s.st) ? { speed: 0.35, width: 70, strength: 0.3 } : null });
  f.set('f|' + key, cardBmp(it.s, hv, 'fill'), { x: CX, y, z: 1, density: 0.25 });
}
function onMouse(p) {
  if (!p.inside || mode === 'strip') { if (hoverKey) { const [k] = hoverKey.split('#'); repaintCard(k, null); hoverKey = null; } return; }
  const h = p.x < LIST_W ? hitAt(p.x, p.y) : null;
  const key = h && h.key ? h.key + '#' + (h.card ? 'card' : h.act) : null;
  if (key === hoverKey) return;
  if (hoverKey) repaintCard(hoverKey.split('#')[0], null);
  hoverKey = key;
  if (h && h.key) repaintCard(h.key, h.card ? 'card' : h.act);
  clearTimeout(hoverT);
  // 停一下才算"要看这一条" —— 只是划过去的话,不该每经过一行就读一次文件
  // 指过的卡 = 底部输入栏的收件人(移到输入栏上时 hover 没了,收件人不跟着变)
  if (h && h.sid && h.sid !== lastPointed) { lastPointed = h.sid; syncBars(); }
  if (h && h.card && (!pv || pv.sid !== h.sid)) hoverT = setTimeout(() => openPreview(h.sid), 260);
}
listen('sd-mouse', (ev) => onMouse(ev?.payload || {}));
window.addEventListener('click', (e) => {
  if (e.target && e.target.tagName === 'INPUT') return;   // 点输入框不是点它背后的卡
  const inR = (h) => e.clientX >= h.x && e.clientX <= h.x + h.w && e.clientY >= h.y && e.clientY <= h.y + h.h;
  if (pv && e.clientX >= PV_X) {
    const ah = (pv.actHits || []).find(inR); if (ah) { pvAction(ah.act); return; }
    const ph = pv.hits.find(inR); if (ph) toggleGroup(ph.gi); return;
  }
  const h = hitAt(e.clientX, e.clientY); if (!h) return;
  if (['allow', 'always', 'deny'].includes(h.act)) answer(h.sid, h.act);
  else if (h.act === 'allowAll') allowAll();
  // 「可能在等你」:直接跳到 Claude 里**这一段**(找不到才退回只打开 Claude)
  else if (h.act === 'openClaude') {
    if (isCodex(h.sid)) invoke('sd_codex_open', { id: h.sid }).catch(() => {});
    else { const s = active.find((x) => x.id === h.sid); invoke('sd_jump', { title: s ? s.title : '' }).catch(() => {}); }
  }
  else if (h.act && h.act.startsWith('opt')) pickOpt(h.sid, Number(h.act.slice(3)));
  else if (h.act === 'askSubmit') submitMulti(h.sid);
  else if (h.act === 'askType' || h.act === 'planNo') replyFor(h.sid);
  else if (h.act === 'planOk') answerAsk(h.sid, { approve: true });
  // 「在 Claude 里答」:先放开钩子(不放开的话 Claude 那边的提问界面出不来),再跳过去
  else if (h.act === 'askPass') { const s = view().find((x) => x.id === h.sid); answerAsk(h.sid, { pass: true }); invoke('sd_jump', { title: s ? s.title : '' }).catch(() => {}); }
  else if (h.act === 'direct') toggleDirect();
  else if (h.act === 'pr') invoke('open_url', { url: h.url }).catch(() => {});
  else if (h.act === 'diff') openPreview(h.sid, 'diff');
  else if (h.act === 'mute') { muted = !muted; try { localStorage.setItem('terse-dock-mute', muted ? '1' : '0'); } catch (err) {} render(); }
  else if (h.act === 'fold') { showIdle = !showIdle; render(); }
  else if (h.act === 'card') openPreview(h.sid);
});
/* 滚轮:非焦点窗口也收得到(macOS 把滚轮送给光标底下的窗口)。平移是改 uniform,不重画。 */
window.addEventListener('wheel', (e) => {
  if (mode === 'strip') return;
  if (pv && e.clientX >= PV_X) {
    pv.scrollTop = Math.max(0, Math.min(Math.max(0, pv.height - viewH()), pv.scrollTop + e.deltaY));
    syncPv(false);
  } else {
    listScroll = Math.max(0, Math.min(Math.max(0, listHeight - (innerHeight - 20 - (mode === 'list' ? BAR_H : 0))), listScroll + e.deltaY));
    render({ scrolled: true });
  }
}, { passive: true });

/* ── 手势(Pro)─────────────────────────────────────────────────────────────
   只有打开了手势控制、terse-hands 在跑、而且摄像头里真有一只手时,下面这些才会被调用;
   否则一个事件都不来,会话栏和以前一模一样。手势 → 会话栏:
     手靠到屏幕最左边   → 展开          指着一张卡停 0.6 秒 → 打开它的预览
     捏一下            → 点击(允许 / 拒绝只认这个,不认"停留")
     捏住上下拖        → 滚动          指着预览里的字停住  → 放大镜放大那一处
     两只手捏住拉开     → 整体放大      张开手掌停住        → 定格 / 解除
     握拳拧手腕         → 粒子变速      张开手掌横挥        → 左:收起 / 右:打开第一张卡
     张开手掌移动       → 粒子被手推开(看得见手在哪,也好玩) */
const hand = { on: false, x: 0, y: 0, pose: '', hold: 0, holdKind: '', pinned: 0 };
function toLocal(x, y) { return [x - (window.screenX || 0), y - (window.screenY || 0)]; }
function cursorBmp() {
  return raster(44, 44, (g) => {
    const c = hand.pose === 'pinch' ? K.lime : hand.pose === 'open' ? K.blue : hand.pose === 'fist' ? K.amber : '#FFFFFF';
    g.strokeStyle = c; g.lineWidth = hand.pose === 'pinch' ? 3 : 1.6;
    g.beginPath(); g.arc(22, 22, hand.pose === 'pinch' ? 7 : 11, 0, 7); g.stroke();
    if (hand.hold > 0) { g.strokeStyle = hand.holdKind === 'freeze' ? K.blue : K.lime; g.lineWidth = 3; g.beginPath(); g.arc(22, 22, 17, -Math.PI / 2, -Math.PI / 2 + hand.hold * Math.PI * 2); g.stroke(); }
    if (f.frozen) { g.fillStyle = K.blue; g.fillRect(16, 16, 4, 12); g.fillRect(24, 16, 4, 12); }
  }, { halo: false });
}
let curSig = '';
/* 光标和粒子手现在由全屏光标层统一画(浮在会话栏上面)—— 这里再画一个就是两个光标。
   保留这个函数名是为了少动调用处;它只负责把旧的清掉。 */
function drawCursor() {
  if (f.has('hcur')) f.remove('hcur');
  curSig = '';
}
function handClick(x, y) {
  const [lx, ly] = snapHand(...toLocal(x, y));
  window.dispatchEvent(new MouseEvent('click', { clientX: lx, clientY: ly }));
}
/** 弱磁力吸附:点在某个可点区域 28px 以内 → 挪到那个区域里离它最近的点 */
function snapHand(lx, ly) {
  let best = null, bd = 28;
  for (const h of hits) {
    const d = Math.hypot(Math.max(h.x - lx, 0, lx - (h.x + h.w)), Math.max(h.y - ly, 0, ly - (h.y + h.h)));
    if (d < bd || (d === 0 && best && !best.card && h.card === false)) { bd = d; best = h; }
    if (d === 0 && !h.card) { best = h; bd = 0; break; }   // 已经在按钮上:按钮优先于卡片
  }
  if (!best) return [lx, ly];
  return [Math.min(Math.max(lx, best.x + 2), best.x + best.w - 2), Math.min(Math.max(ly, best.y + 2), best.y + best.h - 2)];
}
// 光标层算好的那一份手势(全屏同一个光标)—— 会话栏不再自己从原始帧算
listenGestures(listen, (e) => {
  const now = Date.now();
  switch (e.type) {
    case 'found': hand.on = true; break;
    case 'lost':
      hand.on = false; f.setHand(null); f.setLens(null); f.setZoom(null); if (f.has('hcur')) f.remove('hcur');
      if (mode !== 'strip') onMouse({ inside: false });
      break;
    case 'hand': {
      hand.x = e.x; hand.y = e.y; hand.pose = e.pose;
      const [lx, ly] = toLocal(e.x, e.y);
      // 手靠到屏幕最左边 → 展开(和鼠标碰边缘一样);手在栏里时隔几秒续一次"别收起"
      if (mode === 'strip') {
        // 收起时只有 14px 宽:光标和力场都看不见,不画(不然手在画面里时这条细线也 60fps 重绘)。
        // 只做一件事 —— 手靠到最左边就展开;展开请求限流,不必每一帧都发一次 IPC
        if (e.x < 36 && now - hand.pinned > 800) { hand.pinned = now; invoke('sd_dock_open').catch(() => {}); }
        if (f.hand) f.setHand(null);
        if (f.has('hcur')) f.remove('hcur');
        break;
      }
      if (mode !== 'strip' && lx < (pv ? PV_X + PV_W : LIST_W) && now - hand.pinned > 3000) { hand.pinned = now; invoke('sd_dock_open').catch(() => {}); }
      // 张开手掌:粒子被手推开;其它姿态不推(要看清字、要点按钮)
      f.setHand(e.pose === 'open' ? { x: lx, y: ly, r: 70, s: 0.9 } : null);
      // 手的光标吸附到 28px 内最近的卡片 / 按钮(手没鼠标准,擦边也算指中)
      const [sx, sy] = snapHand(lx, ly);
      hand.sx = sx; hand.sy = sy;
      if (mode !== 'strip') onMouse({ inside: lx >= 0 && lx <= (pv ? PV_X + PV_W : LIST_W), x: sx, y: sy });
      if (f.lens && Math.hypot(f.lens.x - lx, f.lens.y - ly) > 90) f.setLens(null);
      drawCursor();
      break;
    }
    case 'pinchend': if (e.tap) handClick(e.x, e.y); break;
    case 'drag': {
      const [lx] = toLocal(e.x, e.y);
      window.dispatchEvent(new WheelEvent('wheel', { clientX: lx, clientY: 0, deltaY: -e.dy * 1.6 }));
      break;
    }
    case 'dwell': {
      const [lx, ly] = toLocal(e.x, e.y);
      if (pv && lx >= PV_X) f.setLens({ x: lx, y: ly, r: 110, m: 2.2 });   // 指着预览里的字 → 放大镜
      else { const h = hitAt(lx, ly); if (h && h.card) openPreview(h.sid); }  // 指着卡片 → 打开预览(只"看",不改)
      break;
    }
    case 'hold': hand.hold = e.progress; hand.holdKind = e.kind; drawCursor(); break;
    case 'zoom': { const [cx, cy] = toLocal(e.cx, e.cy); f.setZoom({ s: Math.max(0.5, Math.min(2.5, e.scale)), x: cx, y: cy }); break; }
    case 'zoomend': f.setZoom(null); break;
    case 'freeze': f.setFrozen(e.frozen); drawCursor(); break;
    case 'speed': f.setRate(e.rate); break;
    case 'swipe':
      if (e.dir === 'left' && mode !== 'strip') invoke('sd_dock', { mode: 'strip' }).catch(() => collapse());
      if (e.dir === 'right') { if (mode === 'strip') invoke('sd_dock_open').catch(() => {}); else { const first = [...placed.values()].find((it) => it.kind === 'card'); if (first) openPreview(first.s.id); } }
      break;
  }
});

/* ── 启动 ───────────────────────────────────────────────────────────────── */
loadActive().then(() => renderRail({ force: true, instant: true }));
loadDirect();

/** 调试入口(浏览器里没有 Rust:用它们模拟 sd-state / sd-mouse / 权限请求) */
window.__dock = {
  expand, collapse, answer, playDiff: (sid) => { const it = [...placed.values()].find((x) => x.s && x.s.id === sid); if (it) playDiff(it.key); },
  mouse: onMouse, openPreview, loadActive, loadUsage, loadGit, setTab, loadConv: () => loadConv(false), toggleGroup,
  request: (req) => { perms.set(req.sessionId || req.id, req); render(); },
  seen: (o) => saveSeen(o),
  hits: () => hits.map((h) => ({ act: h.act, sid: h.sid, x: h.x, y: h.y, w: h.w, h: h.h })),
  // 浏览器里没有 Rust:模拟钩子拦住一个提问 / 送达一条排队的话
  ask: (p) => { liveAsks.set(p.sessionId, { id: p.id, tool: p.tool, input: p.input || {}, cwd: p.cwd, qi: 0, answers: {}, picks: new Set() }); render(); if (pv && pv.sid === p.sessionId) pvHeader(); },
  delivered: (sid) => { queued.delete(sid); render(); },
  loadDirect, lastAnswer: () => window.__dockLastAnswer, queued: () => Object.fromEntries(queued),
  state: () => ({ mode, active: active.length, perms: perms.size, placed: placed.size, usage: usage && usage.total, pv: pv && { sid: pv.sid, tab: pv.tab, groups: pv.groups.length, shown: pv.shown.size, scrollTop: pv.scrollTop, height: pv.height }, stats: f.stats() }),
};
