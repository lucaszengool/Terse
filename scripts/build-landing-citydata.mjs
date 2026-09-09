/* Real per-directory stats for the landing city.
 *
 * The universe is `git ls-files`, not a disk walk. That is the honest
 * definition of "the repo" and it drops build artifacts, Pods, DerivedData and
 * the untracked remotion-* video scratch projects for free — a disk walk put
 * six never-committed video dirs in the skyline as dead black towers, which is
 * both wrong and dull. */
import { statSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const sh = (cmd, dflt='') => { try { return execSync(cmd, {encoding:'utf8', maxBuffer:64<<20, stdio:['ignore','pipe','ignore']}).trim(); } catch { return dflt; } };

const EXT_LANG = {
  '.js':'JavaScript','.mjs':'JavaScript','.cjs':'JavaScript','.jsx':'JavaScript',
  '.ts':'TypeScript','.tsx':'TypeScript','.rs':'Rust','.swift':'Swift','.kt':'Kotlin',
  '.java':'Java','.py':'Python','.go':'Go','.rb':'Ruby','.c':'C','.h':'C','.cpp':'C++',
  '.cs':'C#','.php':'PHP','.sh':'Shell','.html':'HTML','.css':'CSS','.scss':'CSS',
  '.md':'Markdown','.json':'JSON','.yml':'YAML','.yaml':'YAML','.toml':'TOML','.xml':'XML',
};
const ASSET = new Set(['.png','.jpg','.jpeg','.gif','.svg','.mp4','.mov','.webp','.ico','.ttf','.otf','.woff','.woff2','.mp3','.wav','.icns']);

const files = sh('git ls-files').split('\n').filter(Boolean);
const byDir = new Map();
for (const f of files) {
  const top = f.includes('/') ? f.split('/')[0] : '(root)';
  if (top === '(root)') continue;
  let a = byDir.get(top);
  if (!a) byDir.set(top, a = { files:0, bytes:0, assetFiles:0, langs:{} });
  let sz; try { sz = statSync(f).size; } catch { continue; }
  a.files++;
  const ext = path.extname(f).toLowerCase();
  if (ASSET.has(ext)) { a.assetFiles++; return_: ; a.bytes += 0; continue; }
  const lang = EXT_LANG[ext]; if (!lang) continue;
  a.bytes += sz; a.langs[lang] = (a.langs[lang]||0) + sz;
}

const KIND = (n, a) => {
  if (/^docs?$/.test(n)) return 'docs';
  if (/test|spec/i.test(n)) return 'test';
  if (/^(scripts|\.github|ci)$/.test(n)) return 'config';
  if (a.bytes < 20000 && a.assetFiles > a.files * 0.5) return 'assets';
  return 'source';
};

const rows = [];
for (const [name, a] of byDir) {
  if (!a.files) continue;
  const total = Object.values(a.langs).reduce((x,y)=>x+y,0);
  const langs = Object.entries(a.langs).sort((x,y)=>y[1]-x[1]).slice(0,4)
    .map(([l,v]) => [l, +(v/Math.max(1,total)).toFixed(3)]);
  const churn = +sh(`git log --since=1.year --oneline -- "${name}" | wc -l`, '0') || 0;
  const lastISO = sh(`git log -1 --format=%cI -- "${name}"`);
  const age_days = lastISO ? Math.max(0, Math.round((Date.now()-Date.parse(lastISO))/864e5)) : 999;
  rows.push({ name, kind:KIND(name,a), depth:1, files:a.files, bytes:a.bytes,
              lang: langs.length?langs[0][0]:'', langs, churn, age_days });
}
rows.sort((x,y) => Math.max(y.bytes, y.files*2000) - Math.max(x.bytes, x.files*2000));
const keep = rows.slice(0, 16);
writeFileSync('/private/tmp/claude-502/-Users-James-Desktop-Terse/baafc630-71ff-4339-8d38-9d9ed8001127/scratchpad/dirs.json', JSON.stringify(keep));
console.log(keep.map(d=>`${d.name.padEnd(17)} ${String(d.files).padStart(5)}f ${(d.bytes/1048576).toFixed(1).padStart(6)}MB ${d.lang.padEnd(11)} churn=${String(d.churn).padStart(4)} age=${String(d.age_days).padStart(3)}d ${d.kind}`).join('\n'));
