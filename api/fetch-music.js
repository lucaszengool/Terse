#!/usr/bin/env node
/**
 * fetch-music.js — 抓一批**真实的、可以直接下载的**配乐,放进 landing/audio/。
 *
 *   node api/fetch-music.js
 *
 * ⚠ 之前那版是当场合成的。合成的好处是没有文件、没有版权问题、和粒子天生同步 ——
 * 但它听起来就是合成的:几个振荡器加一个包络,当背景音可以,当"配乐"不行。
 *
 * ⚠ 那时候我说"要收音频得先有对象存储"。那句话是错的,或者说答错了题:用户上传
 * 才需要桶,而一个**固定的曲库**根本就是 app 的静态资源 —— 和图标、字体一样跟着
 * 仓库走,Express 那个 static 挂载已经在服务它们了。我把"用户上传音乐"和
 * "app 自带几首曲子"当成了同一件事。
 *
 * 只要 **CC0 / 公有领域**。CC BY 也能用,但要在界面上挂一行署名,而署名一旦漏了
 * 就是违规 —— 一个刷视频的界面上没有稳妥的地方放那行字。不要署名的东西才敢用。
 *
 * 每首**裁成 30 秒并且做成可循环的**:一段 BGM 循环起来听不出接缝就够了,而完整
 * 曲子一首三四兆,十二首就是四十兆的仓库。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const UA = 'terse-plaza-seed/1.0 (https://www.terseai.org)';
const OUTDIR = path.join(__dirname, '..', 'landing', 'audio');
const MANIFEST = path.join(OUTDIR, 'tracks.json');
const WANT = 12;
const SECONDS = 30;

/* 找什么。都是"能当视频背景音"的东西:成段的 loop、氛围、电子。
   ⚠ 古典录音不要 —— 公有领域的古典在 Commons 上很多,但它不是短视频的配乐。 */
const QUERIES = [
  'loop music filetype:audio',
  'electronic music loop filetype:audio',
  'ambient electronic filetype:audio',
  'drum loop filetype:audio',
  'chiptune filetype:audio',
  'synth loop filetype:audio',
  'background music filetype:audio',
  'techno loop filetype:audio',
  /* ⚠ 头八个词只筛出七首。CC0 的音乐在 Commons 上本来就少 —— 大部分是 CC BY,
     而 CC BY 要署名,署名一旦漏了就是违规。所以不是放宽许可,是**多找几个词**:
     模块音乐(mod/tracker)、游戏配乐、电子乐派别,这几类里 CC0 的比例高得多。 */
  'module music filetype:audio',
  'tracker music filetype:audio',
  'video game music filetype:audio',
  'synthwave filetype:audio',
  'downtempo filetype:audio',
  'instrumental music filetype:audio',
  'demoscene music filetype:audio',
  'drum and bass filetype:audio',
  'house music filetype:audio',
  'piano improvisation filetype:audio',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function search(q) {
  const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json'
    + '&generator=search&gsrnamespace=6&gsrlimit=25&gsrsearch=' + encodeURIComponent(q)
    + '&prop=imageinfo&iiprop=url|extmetadata|size|mime';
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return [];
  const pages = ((await res.json()).query || {}).pages || {};
  const out = [];
  for (const p of Object.values(pages)) {
    const ii = (p.imageinfo || [])[0];
    if (!ii || !ii.url) continue;
    const lic = (((ii.extmetadata || {}).LicenseShortName || {}).value || '').toLowerCase();
    // 只要不用署名的。
    if (!/^cc0|public domain/.test(lic)) continue;
    if (!/^audio\//.test(ii.mime || '')) continue;
    // 太小的多半是音效不是音乐;太大的下起来慢。
    if ((ii.size || 0) < 60 * 1024 || (ii.size || 0) > 30 * 1024 * 1024) continue;
    const artist = (((ii.extmetadata || {}).Artist || {}).value || '')
      .replace(/<[^>]*>/g, '').trim().slice(0, 60);
    out.push({
      url: ii.url,
      title: p.title.replace(/^File:/, ''),
      license: lic,
      artist,
      bytes: ii.size || 0,
    });
  }
  return out;
}

/** 一个能循环的 30 秒片段。
 *  ⚠ 从 8 秒开始截,不从 0 —— 很多曲子开头是渐入或者一段前奏,循环起来每半分钟
 *  静一下。两端各加一个很短的淡入淡出,接缝就听不出来了。 */
function transcode(src, dest) {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', '8', '-t', String(SECONDS), '-i', src,
    '-af', `afade=t=in:st=0:d=0.35,afade=t=out:st=${SECONDS - 0.45}:d=0.45,loudnorm=I=-18:TP=-2`,
    '-ac', '1', '-ar', '44100', '-b:a', '80k',
    // MP3:Safari 从来都支持,而 Commons 上一半是 ogg —— iPhone 上放不出来的
    // 格式,选得再好听也没用。
    '-codec:a', 'libmp3lame', dest,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
}

async function main() {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const seen = new Map();
  for (const q of QUERIES) {
    for (const hit of await search(q)) if (!seen.has(hit.url)) seen.set(hit.url, hit);
    await sleep(400);
    console.log(q.slice(0, 30).padEnd(32), '→', seen.size, 'candidates');
  }

  const cands = [...seen.values()].sort((a, b) => a.bytes - b.bytes);
  const tmp = path.join(OUTDIR, '_tmp');
  const tracks = [];
  for (const c of cands) {
    if (tracks.length >= WANT) break;
    try {
      const res = await fetch(c.url, { headers: { 'User-Agent': UA } });
      if (!res.ok) continue;
      fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
      const id = 't' + String(tracks.length + 1).padStart(2, '0');
      const dest = path.join(OUTDIR, id + '.mp3');
      transcode(tmp, dest);
      const kb = Math.round(fs.statSync(dest).size / 1024);
      // 转出来太小说明那一段基本是静音的。
      if (kb < 60) { fs.unlinkSync(dest); continue; }
      tracks.push({
        id,
        file: '/audio/' + id + '.mp3',
        name: c.title.replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ').slice(0, 28),
        license: c.license,
        artist: c.artist,
        source: 'https://commons.wikimedia.org/wiki/File:' + encodeURIComponent(c.title),
      });
      console.log(String(tracks.length).padStart(2), kb + 'KB', c.license.padEnd(14), c.title.slice(0, 44));
    } catch (e) { /* 下不动或者转不了就跳过,不值得为一首停下来 */ }
    await sleep(250);
  }
  try { fs.unlinkSync(tmp); } catch (e) {}

  fs.writeFileSync(MANIFEST, JSON.stringify(tracks, null, 2));
  const total = tracks.reduce((a, t) => a + fs.statSync(path.join(OUTDIR, t.id + '.mp3')).size, 0);
  console.log('\nwrote', tracks.length, 'tracks —', Math.round(total / 1024) + 'KB total, all CC0/public domain');
}

main().catch((e) => { console.error(e); process.exit(1); });
