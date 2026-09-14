/**
 * room-field.test.js — 房间那条轮播的状态机。
 *
 * 这一层没有 DOM,也没有引擎:它决定的是**放谁、什么时候放、什么时候把画布还
 * 回去**。这几件事出错都不报错 —— 城要么不出现,要么出现在不该出现的那一屏上,
 * 而两种都只能靠眼睛发现。所以在这里钉住。
 *
 * 真正的引擎换成一个只记账的替身:这里要证的是"谁被交给了 showProject",
 * 不是引擎拿它画出了什么。
 */
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0; const fails = [];
const ok = (l, c) => c ? (pass++, console.log('  ✓ ' + l)) : (fails.push(l), console.error('  ✗ ' + l));

const src = fs.readFileSync(path.join(__dirname, 'room-field.js'), 'utf8');

/** 一个干净的 window,和一台只记账的引擎。每个用例都要一份新的 —— 模块自己带
 *  状态,共用一份的话,上一个用例的名单会漏进下一个。 */
function boot(opts) {
  opts = opts || {};
  const shown = [];
  const wp = {
    showProject: (cap, ms) => { shown.push({ cap, ms }); },
    hideProject: () => { shown.push({ hidden: true }); },
  };
  const win = {
    TerseRooms: { state: () => (opts.room === null ? null : (opts.room || { id: 'r1', key: 'k1' })) },
    // 胶囊的唯一入口。这里照搬它的契约:原样带过去,外加一个 title。
    TersePlazaField: {
      toCapsule: (p) => ({ title: (p.capsule && p.capsule.title) || p.title || '', cover: (p.capsule && p.capsule.cover) || '' }),
    },
  };
  const calls = [];
  global.fetch = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: opts.httpOk === false ? false : true,
      json: () => Promise.resolve({ ok: true, projects: opts.projects || [] }),
    });
  };
  new Function('window', src)(win);
  return { RF: win.TerseRoomField, wp, shown, calls };
}

const P = (id, name, status, title) => ({
  member_id: id, name, status,
  project: { id: 'p_' + id, title: title === undefined ? (name + "'s repo") : title, capsule: { title: title === undefined ? (name + "'s repo") : title, dirs: [] } },
});

console.log('\nRoom field\n');

(async () => {
  // ── 取名单 ──────────────────────────────────────────────────────────────
  {
    const { RF, wp, calls } = boot({ projects: [P('m1', 'Ada', 'online')] });
    const n = await RF.start(wp);
    ok('start() 取回名单并报出有几座城', n === 1 && RF.count() === 1);
    ok('打的是这个房间自己的那条路', /\/api\/cloud\/rooms\/r1\/projects$/.test(calls[0].url));
    ok('带着房间钥匙 —— 名单只有屋里的人能看',
       calls[0].init.headers['x-terse-room-key'] === 'k1');
    RF.stop(wp);
  }

  // ── 不在房间里 ──────────────────────────────────────────────────────────
  {
    const { RF, wp, calls } = boot({ room: null });
    const n = await RF.start(wp);
    ok('没有房间就根本不发请求,而不是发一条注定 401 的', n === 0 && calls.length === 0);
  }

  // ── 取不到 ──────────────────────────────────────────────────────────────
  {
    const { RF, wp } = boot({ httpOk: false, projects: [P('m1', 'Ada', 'online')] });
    const n = await RF.start(wp);
    ok('取不到 = 屋里没有城,不是崩掉', n === 0 && RF.count() === 0);
  }

  // ── 放 ──────────────────────────────────────────────────────────────────
  {
    const played = [];
    const { RF, wp, shown } = boot({ projects: [P('m1', 'Ada', 'online')] });
    await RF.start(wp, { onPlay: (e) => played.push(e.member_id) });
    ok('start() 之后立刻就在放,不是等第一个 20 秒过去', shown.length === 1);
    ok('onPlay 说得出正在放谁', played.length === 1 && played[0] === 'm1');
    ok('now() 也说得出', RF.now() && RF.now().member_id === 'm1');
    RF.stop(wp);
  }

  // ── 在线的人排前面 ──────────────────────────────────────────────────────
  {
    const { RF, wp } = boot({
      projects: [P('off1', 'Bob', 'offline'), P('off2', 'Cy', 'offline'), P('on1', 'Ada', 'online')],
    });
    await RF.start(wp);
    ok('先放在线的那个 —— 他此刻就在屋里,他的城被看见是有人会接话的',
       RF.now().member_id === 'on1');
    RF.stop(wp);
  }

  // ── 没东西可看的跳过 ────────────────────────────────────────────────────
  {
    const { RF, wp, shown } = boot({ projects: [P('m1', 'Ada', 'online', '')] });
    await RF.start(wp);
    ok('没有标题也没有封面 = 没有东西可看,跳过而不是空放二十秒', shown.length === 0);
    RF.stop(wp);
  }

  // ── 点名册里的某一个 ────────────────────────────────────────────────────
  {
    const { RF, wp, shown } = boot({
      projects: [P('m1', 'Ada', 'online'), P('m2', 'Bob', 'offline')],
    });
    await RF.start(wp);
    shown.length = 0;
    ok('has() 认得有城的人', RF.has('m2') === true && RF.has('nobody') === false);
    ok('点谁放谁', RF.playMember(wp, 'm2') === true && RF.now().member_id === 'm2');
    ok('点一个没有城的人,什么也不发生', RF.playMember(wp, 'nobody') === false);
    RF.stop(wp);
  }

  // ── 还画布 ──────────────────────────────────────────────────────────────
  {
    const { RF, wp, shown } = boot({ projects: [P('m1', 'Ada', 'online')] });
    await RF.start(wp);
    shown.length = 0;
    RF.stop(wp);
    ok('stop() 把画布还回去 —— 不还的话,城会留在壁纸那一屏上',
       shown.length === 1 && shown[0].hidden === true);
    ok('停了就没有"正在放谁"了', RF.now() === null);
    ok('但名单还在,再进这一屏不用重新取', RF.count() === 1);
  }

  // ── 离开房间 ────────────────────────────────────────────────────────────
  {
    const { RF, wp } = boot({ projects: [P('m1', 'Ada', 'online')] });
    await RF.start(wp);
    RF.clear(wp);
    ok('clear() 连名单一起扔掉 —— 否则下一个房间会先闪一下上一个房间的人',
       RF.count() === 0 && RF.now() === null);
  }

  // ── 名册变了 ────────────────────────────────────────────────────────────
  {
    const { RF, wp, shown } = boot({ projects: [P('m1', 'Ada', 'online')] });
    await RF.start(wp);
    const playingBefore = RF.now().member_id;
    shown.length = 0;
    await RF.refresh(wp);
    ok('refresh() 不打断正在放的那一座 —— 名册每有人上下线都会来一条',
       shown.length === 0 && RF.now().member_id === playingBefore);
    RF.stop(wp);
    const after = await RF.refresh(wp);
    ok('停了之后 refresh() 什么也不做', after === 0);
  }

  console.log(`\n${pass} passed, ${fails.length} failed\n`);
  if (fails.length) console.error('failing:\n  ' + fails.join('\n  ') + '\n');
  process.exit(fails.length ? 1 : 0);
})();
