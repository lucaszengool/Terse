#!/usr/bin/env node
/**
 * fetch-repos.js — 从 GitHub 上找**真实的开源项目**,用它自己的介绍和分享图做帖子。
 *
 *   node api/fetch-repos.js            → api/repos.json
 *
 * 这是比"配一张相关的照片"好得多的答案,因为它根本不用配:
 *
 *   · 图是 GitHub 给每个仓库**自动生成的分享图**(opengraph.githubassets.com):
 *     仓库名、作者头像、简介、星标数、语言,一张一千二百像素的卡片。它本来就是
 *     给人贴到社交平台上用的 —— 这正是这里要干的事。所以既不用担版权,也不用
 *     "找一张看起来像"的图:它就是那个项目本身。
 *   · 文案是仓库**自己的 description**,不是我编的。
 *   · 而且每一张天然不一样:不同的名字、不同的头像、不同的星标、不同的语言色条。
 *
 * ⚠ 没有 token 的话 GitHub 一小时给 60 次,而且分享图那台服务器会 429。所以每一步
 * 都限速,搜索一次拿一批,图一张一张慢慢取。
 */
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const OUT = path.join(__dirname, 'repos.json');
const WANT = 50;

/* 找什么样的项目。抖音上那批人做的就是这些:AI 工具、命令行小工具、浏览器插件、
   自动化脚本 —— 一个人一晚上能做出来、能拿出来给人看的东西。
   ⚠ 星标卡在 30–4000:太低的没有分享图也没人看过,太高的是大公司的项目,
   不是"一个人做的"。 */
const QUERIES = [
  'topic:ai-tools stars:30..4000 pushed:>2026-05-01',
  'topic:llm stars:50..4000 pushed:>2026-06-01',
  'topic:cli stars:40..3000 pushed:>2026-06-01',
  'topic:developer-tools stars:40..3000 pushed:>2026-05-01',
  'topic:chrome-extension stars:30..2000 pushed:>2026-04-01',
  'topic:tui stars:40..3000 pushed:>2026-04-01',
  'topic:automation stars:50..3000 pushed:>2026-05-01',
  'topic:productivity stars:40..3000 pushed:>2026-05-01',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gh = async (p) => {
  const res = await fetch('https://api.github.com' + p, {
    headers: Object.assign({ Accept: 'application/vnd.github+json', 'User-Agent': UA },
                           TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
  });
  if (!res.ok) return null;
  return res.json();
};

/** 那张分享图。会 429,所以要肯等。 */
async function ogImage(full) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch('https://opengraph.githubassets.com/1/' + full, {
      headers: { 'User-Agent': UA }, redirect: 'follow',
    });
    if (res.status === 429) { await sleep(2500 + attempt * 2500); continue; }
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    // 一颗胶囊 160KB,base64 还要再涨三分之一 —— 110KB 以上的不要。
    if (buf.length > 110 * 1024 || buf.length < 2000) return null;
    return 'data:image/png;base64,' + buf.toString('base64');
  }
  return null;
}

const TAGS = ['#vibecoding', '#开源', '#AI编程', '#独立开发', '#效率工具',
              '#github', '#程序员', '#每天一个开源项目'];

async function main() {
  const seen = new Map();
  for (const q of QUERIES) {
    if (seen.size >= WANT * 2) break;
    const d = await gh('/search/repositories?sort=stars&order=desc&per_page=20&q=' + encodeURIComponent(q));
    await sleep(2200);                       // 搜索接口一分钟只给十次
    for (const r of ((d && d.items) || [])) {
      if (!r.description || r.description.length < 20) continue;   // 没介绍就没有文案
      if (r.archived || r.fork) continue;
      if (!seen.has(r.full_name)) seen.set(r.full_name, r);
    }
    console.log(q.slice(0, 34).padEnd(36), '→', seen.size, 'candidates');
  }

  const list = [...seen.values()].sort((a, b) => b.pushed_at.localeCompare(a.pushed_at));
  const out = [];
  for (const r of list) {
    if (out.length >= WANT) break;
    const cover = await ogImage(r.full_name);
    await sleep(900);
    if (!cover) { continue; }
    out.push({
      full: r.full_name,
      name: r.name,
      owner: r.owner && r.owner.login,
      desc: r.description,
      stars: r.stargazers_count,
      lang: r.language || '',
      url: r.html_url,
      topics: (r.topics || []).slice(0, 4),
      cover,
    });
    console.log(String(out.length).padStart(2), Math.round(cover.length / 1024) + 'KB',
                r.full_name.slice(0, 34).padEnd(36), '★' + r.stargazers_count);
  }

  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('\nwrote', out.length, 'real repos —', Math.round(fs.statSync(OUT).size / 1024) + 'KB');
}

main().catch((e) => { console.error(e); process.exit(1); });
