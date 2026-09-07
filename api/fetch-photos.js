#!/usr/bin/env node
/**
 * fetch-photos.js — 给每条帖子抓一张**真实照片**,存进 api/photos.json。
 *
 *   node api/fetch-photos.js
 *
 * ⚠ 版权这条线画在哪里,先说清楚。这些帖子是**假的**,署的是别人的名字。往里面塞
 * 一张随手搜来的图,等于把别人的作品挂在一个虚构的人名下发出去 —— 那不是"配图",
 * 那是拿别人的东西冒名顶替。所以只用两个来源,而且都不需要署名:
 *
 *   · Wikimedia Commons,**只要 Public domain / CC0 的**。搜索按每条帖子自己的
 *     内容给词,拿得到就用 —— 这是"相关的真实照片"。
 *   · Lorem Picsum(Unsplash 许可:可商用、无需署名)。Commons 找不到合适的
 *     就用它,按帖子的 id 当种子,所以同一条帖子永远是同一张图。
 *
 * ⚠ **不用 Giphy 那类**。那上面绝大多数是电影和综艺的片段,是有主的东西。
 *
 * ⚠ 也不做动图。做 Ken Burns 那种推拉需要把 JPEG 解出来再裁,而这里没有解码器;
 * 而且真人发的图文帖本来就大多是静图。要动的那些帖子继续用画出来的动画 ——
 * 构建在跑、柱子在长,本来也没有哪张库存照片拍得到。
 */
const fs = require('fs');
const path = require('path');

const UA = 'terse-plaza-seed/1.0 (https://www.terseai.org; photos for a demo feed)';
const OUT = path.join(__dirname, 'photos.json');

/* 每条帖子搜什么。词是按它讲的事挑的 —— 讲桌子的搜桌子,讲账单的搜计算器。
   ⚠ Commons 上没有 "AI 结对编程" 这种照片,所以词要往**实物**上靠:终端、键盘、
   笔记本、机房。搜不到就退回 Picsum,不硬凑。 */
const QUERIES = {
  chat: ['person typing laptop', 'smartphone messaging', 'conversation desk'],
  editor: ['computer source code screen', 'programmer monitor', 'text editor screen'],
  terminal: ['computer terminal screen', 'command line console', 'server error screen'],
  diff: ['printed source code', 'code listing paper', 'programming book page'],
  chart: ['bar chart printed', 'statistics graph paper', 'calculator receipt'],
  app: ['smartphone in hand app', 'mobile phone screen', 'tablet application'],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function commons(query) {
  const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json'
    + '&generator=search&gsrnamespace=6&gsrlimit=12'
    + '&gsrsearch=' + encodeURIComponent(query + ' filetype:bitmap')
    + '&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=300';
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return null;
  const pages = ((await res.json()).query || {}).pages || {};
  const ok = [];
  for (const p of Object.values(pages)) {
    const ii = (p.imageinfo || [])[0];
    if (!ii || !ii.thumburl) continue;
    const lic = (((ii.extmetadata || {}).LicenseShortName || {}).value || '').toLowerCase();
    // 只要不需要署名的。CC BY / BY-SA 一律不要 —— 胶囊里放不下一行出处。
    if (!/public domain|cc0|pd-/.test(lic)) continue;
    /* ⚠ 后缀要在**去掉查询串之后**判断。Commons 的缩略图地址后面挂着
       `?utm_source=commons.wikimedia.org`,于是 `.jpg$` 一个都匹配不上 ——
       五十条全退回了 Picsum,而我一开始以为是"Commons 上没有公有领域的图"。 */
    if (!/\.(jpe?g|png)$/i.test(String(ii.thumburl).split('?')[0])) continue;
    ok.push({ url: ii.thumburl, title: p.title.replace(/^File:/, ''), license: lic });
  }
  return ok;
}

async function grab(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok) return null;
  const type = res.headers.get('content-type') || '';
  if (!/image\/(jpeg|png)/.test(type)) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  // 太大的不要:一颗胶囊总共 160KB,而 base64 还要再涨三分之一。
  if (buf.length > 90 * 1024 || buf.length < 800) return null;
  return 'data:' + (type.includes('png') ? 'image/png' : 'image/jpeg')
       + ';base64,' + buf.toString('base64');
}

async function main() {
  const { POSTS } = require('./seed-posts.js');
  const out = {};
  let fromCommons = 0, fromPicsum = 0;

  for (let i = 0; i < POSTS.length; i++) {
    const [title, , scene] = POSTS[i];
    let got = null, source = null, credit = null, frames = null;

    const terms = QUERIES[scene] || QUERIES.editor;
    for (const q of terms) {
      let hits = null;
      try { hits = await commons(q); } catch (e) { hits = null; }
      await sleep(140);
      if (!hits || !hits.length) continue;
      // 同一个场景的几十条帖子不能都拿到同一张 —— 按下标错开。
      const pickd = hits[i % hits.length];
      try { got = await grab(pickd.url); } catch (e) { got = null; }
      await sleep(140);
      if (!got) continue;
      source = 'commons'; credit = pickd.title + ' (' + pickd.license + ')';

      /* 三分之一的帖子要**动**。没有解码器就裁不了图,但 Commons 自己会按任意
         宽度出缩略图 —— 取三个相邻的宽度轮着放,就是一次很轻的推近。这是真照片
         在动,不是画出来的东西在动。
         只做三帧:一帧二十来 KB,而一颗胶囊总共 160KB。 */
      if (i % 3 === 0) {
        const zoom = [];
        /* ⚠ 宽度往**小**里取,不是往大里取。grab() 挡住 90KB 以上的图,而 360px
           的缩略图经常就超了 —— 于是三帧凑不齐,一条动图都没生成出来。
           推近看的是相对变化,240→300 和 300→360 是一样的效果,但前者进得去。 */
        for (const w of [240, 270, 300]) {
          const u2 = pickd.url.replace(/\/(\d+)px-/, '/' + w + 'px-');
          let f = null;
          try { f = await grab(u2); } catch (e) { f = null; }
          await sleep(120);
          if (f) zoom.push(f);
        }
        if (zoom.length === 3) frames = zoom;
      }
      break;
    }

    if (!got) {
      // 退回 Picsum。按 id 当种子 —— 同一条帖子永远拿到同一张。
      try {
        got = await grab('https://picsum.photos/seed/terse' + i + '/420/315');
      } catch (e) { got = null; }
      await sleep(140);
      if (got) { source = 'picsum'; credit = 'Lorem Picsum (Unsplash licence)'; }
    }

    if (got) {
      out[i] = { cover: got, source, credit };
      if (frames) { out[i].frames = frames; out[i].fps = 3; }
      source === 'commons' ? fromCommons++ : fromPicsum++;
      console.log(String(i).padStart(2), source.padEnd(8), Math.round(got.length / 1024) + 'KB', (frames ? 'zoom ' : '     ') + title.slice(0, 22));
    } else {
      console.log(String(i).padStart(2), 'FAILED  ', '', title.slice(0, 22));
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(out));
  const kb = Math.round(fs.statSync(OUT).size / 1024);
  console.log('\nwrote', Object.keys(out).length, 'photos —',
              fromCommons, 'from Commons (public domain),', fromPicsum, 'from Picsum —', kb + 'KB');
}

main().catch((e) => { console.error(e); process.exit(1); });
