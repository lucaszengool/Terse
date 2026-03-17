#!/usr/bin/env node
/**
 * terse-compress — Standalone CLI tool output compressor for LLM context.
 * Zero external dependencies. Mirrors RTK's structural compression approach.
 *
 * Usage:
 *   git status | node terse-compress.js
 *   npm test 2>&1 | node terse-compress.js
 *   cat large-file.json | node terse-compress.js
 *
 * Compression techniques (inspired by github.com/rtk-ai/rtk):
 *   1. Deduplication — collapse repeated/similar lines with counts
 *   2. Noise removal — strip ANSI, progress bars, blank lines, timestamps
 *   3. Truncation — cap very large outputs, keep head+tail
 *   4. Structure compression — collapse JSON, condense file listings
 *   5. Git-aware — compress diff/status/log output
 *   6. Test-aware — keep only failures + summary
 *   7. Build-aware — keep only errors + warnings
 */

const MAX_OUTPUT_LINES = 200;
const MAX_LINE_LENGTH = 500;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  if (!input.trim()) { process.exit(0); return; }
  const compressed = compress(input);
  process.stdout.write(compressed);
  // Stats to stderr
  const origTok = estimateTokens(input);
  const compTok = estimateTokens(compressed);
  const saved = origTok > 0 ? Math.round((1 - compTok / origTok) * 100) : 0;
  if (saved > 5) {
    process.stderr.write(`[terse] ${origTok}→${compTok} tokens (${saved}% saved)\n`);
  }
  // Track for agent panel
  try {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    fs.appendFileSync(path.join(os.tmpdir(), 'terse-compress-stats.jsonl'),
      JSON.stringify({ ts: Date.now(), originalTokens: origTok, optimizedTokens: compTok, saved: origTok - compTok }) + '\n');
  } catch(e) {}
});

function estimateTokens(text) {
  return Math.ceil(text.split(/\s+/).length * 1.3);
}

function compress(text) {
  let lines = text.split('\n');

  // 1. Strip ANSI escape codes
  lines = lines.map(l => l.replace(/\x1B\[[0-9;]*[A-Za-z]/g, ''));

  // 2. Detect output type and apply specialized compression
  const joined = lines.slice(0, 50).join('\n');

  if (isGitDiff(joined)) return compressGitDiff(lines);
  if (isGitStatus(joined)) return compressGitStatus(lines);
  if (isGitLog(joined)) return compressGitLog(lines);
  if (isTestOutput(joined)) return compressTestOutput(lines);
  if (isBuildOutput(joined)) return compressBuildOutput(lines);
  if (isJSON(joined)) return compressJSON(text);
  if (isFileListing(joined)) return compressFileListing(lines);

  // 3. Generic compression
  return compressGeneric(lines);
}

// ── Detection ──

function isGitDiff(text) {
  return /^diff --git/m.test(text) || /^@@\s/.test(text);
}
function isGitStatus(text) {
  return /On branch|Changes not staged|Changes to be committed|Untracked files|位于分支|尚未暂存|未跟踪/i.test(text);
}
function isGitLog(text) {
  return /^commit [0-9a-f]{40}/m.test(text) || /^[0-9a-f]{7,}\s/.test(text);
}
function isTestOutput(text) {
  return /PASS|FAIL|✓|✗|test result:|Tests:|passed|failed.*\d+\s*(test|spec)/i.test(text);
}
function isBuildOutput(text) {
  return /Compiling|warning\[|error\[|BUILD|Bundling|webpack|tsc.*error/i.test(text);
}
function isJSON(text) {
  const t = text.trimStart();
  return (t.startsWith('{') || t.startsWith('[')) && t.length > 200;
}
function isFileListing(text) {
  const lines = text.split('\n').slice(0, 20);
  const pathLines = lines.filter(l => /^[.\w\/\\-]/.test(l.trim()) && !l.includes('  '));
  return pathLines.length > lines.length * 0.6;
}

// ── Git Diff: keep file names + changed lines only, collapse large hunks ──

function compressGitDiff(lines) {
  const out = [];
  let fileCount = 0;
  let addCount = 0;
  let delCount = 0;
  let currentFile = '';
  let hunkLines = 0;
  const MAX_HUNK = 30;

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      fileCount++;
      currentFile = line.replace(/^diff --git a\//, '').replace(/ b\/.*/, '');
      out.push(`── ${currentFile} ──`);
      hunkLines = 0;
    } else if (line.startsWith('@@')) {
      out.push(line);
      hunkLines = 0;
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      addCount++;
      if (hunkLines < MAX_HUNK) out.push(line);
      hunkLines++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      delCount++;
      if (hunkLines < MAX_HUNK) out.push(line);
      hunkLines++;
    } else if (hunkLines === MAX_HUNK) {
      out.push(`  ... (${hunkLines}+ lines in hunk, truncated)`);
      hunkLines++;
    }
  }

  out.push(`\n${fileCount} files, +${addCount} -${delCount}`);
  return out.join('\n');
}

// ── Git Status: group by category, one line per file ──

function compressGitStatus(lines) {
  const out = [];
  let branch = '';
  const staged = [], modified = [], untracked = [];

  for (const line of lines) {
    if (/On branch|位于分支/.test(line)) branch = line.trim();
    else if (/^\s+(modified:|修改：)/.test(line)) modified.push(line.trim().replace(/modified:|修改：/, '').trim());
    else if (/^\s+(new file:|新文件：)/.test(line)) staged.push(line.trim().replace(/new file:|新文件：/, '').trim());
    else if (/^\s+(deleted:|删除：)/.test(line)) modified.push('(del) ' + line.trim().replace(/deleted:|删除：/, '').trim());
    else if (/^\t/.test(line) && line.trim() && !/使用|git /.test(line)) untracked.push(line.trim());
  }

  if (branch) out.push(branch);
  if (staged.length) out.push(`Staged: ${staged.join(', ')}`);
  if (modified.length) out.push(`Modified: ${modified.join(', ')}`);
  if (untracked.length) out.push(`Untracked: ${untracked.slice(0, 10).join(', ')}${untracked.length > 10 ? ` (+${untracked.length - 10} more)` : ''}`);
  if (!out.length) out.push('Clean working tree');

  return out.join('\n');
}

// ── Git Log: keep hash + first line of message ──

function compressGitLog(lines) {
  const out = [];
  let count = 0;
  for (let i = 0; i < lines.length && count < 20; i++) {
    const line = lines[i];
    if (/^commit [0-9a-f]{40}/.test(line)) {
      const hash = line.slice(7, 14);
      // Find subject line (skip Author, Date, blank)
      let subject = '';
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const s = lines[j].trim();
        if (s && !s.startsWith('Author:') && !s.startsWith('Date:') && !s.startsWith('Merge:')) {
          subject = s;
          break;
        }
      }
      out.push(`${hash} ${subject}`);
      count++;
    } else if (/^[0-9a-f]{7,12}\s/.test(line)) {
      // Already short format
      out.push(line.slice(0, MAX_LINE_LENGTH));
      count++;
    }
  }
  if (count >= 20) out.push(`... (truncated, showing first 20 commits)`);
  return out.join('\n');
}

// ── Test Output: failures only + summary ──

function compressTestOutput(lines) {
  const out = [];
  const failures = [];
  let summary = '';
  let inFailure = false;
  let failureBlock = [];

  for (const line of lines) {
    // Detect summary lines
    if (/Tests?:\s+\d|test result:|Test Suites:|passed|failed/i.test(line) && /\d/.test(line)) {
      summary = line.trim();
    }
    // Detect failure start
    if (/FAIL|✗|✕|FAILED|Error:|AssertionError|expect\(/.test(line)) {
      inFailure = true;
      failureBlock = [line];
    } else if (inFailure) {
      failureBlock.push(line);
      if (failureBlock.length > 15 || /^\s*$/.test(line)) {
        inFailure = false;
        failures.push(failureBlock.join('\n'));
      }
    }
  }

  if (failures.length > 0) {
    out.push(`── ${failures.length} failure(s) ──`);
    for (const f of failures.slice(0, 5)) {
      out.push(f);
    }
    if (failures.length > 5) out.push(`... (+${failures.length - 5} more failures)`);
  }

  if (summary) {
    out.push('\n' + summary);
  } else {
    // No failures found — probably all passing
    const total = lines.filter(l => /✓|PASS|passed/i.test(l)).length;
    out.push(`All ${total || 'tests'} passed`);
  }

  return out.join('\n') || 'Tests completed';
}

// ── Build Output: errors + warnings only ──

function compressBuildOutput(lines) {
  const errors = [];
  const warnings = [];
  let summary = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (/error[\[:\s]/i.test(trimmed) && !trimmed.startsWith('Compiling')) {
      errors.push(trimmed.slice(0, MAX_LINE_LENGTH));
    } else if (/warning[\[:\s]/i.test(trimmed)) {
      if (warnings.length < 10) warnings.push(trimmed.slice(0, MAX_LINE_LENGTH));
    } else if (/Finished|BUILD (SUCCESS|FAIL)|Compiled/i.test(trimmed)) {
      summary = trimmed;
    }
  }

  const out = [];
  if (errors.length) {
    out.push(`── ${errors.length} error(s) ──`);
    errors.slice(0, 10).forEach(e => out.push(e));
    if (errors.length > 10) out.push(`... (+${errors.length - 10} more errors)`);
  }
  if (warnings.length) {
    out.push(`── ${warnings.length} warning(s) ──`);
    warnings.forEach(w => out.push(w));
  }
  if (summary) out.push('\n' + summary);
  if (!out.length) out.push('Build completed successfully');

  return out.join('\n');
}

// ── JSON: structure-only (keys + types, no values) ──

function compressJSON(text) {
  try {
    const obj = JSON.parse(text.trim());
    const summary = summarizeJSON(obj, 0, 3);
    return summary;
  } catch {
    // Not valid JSON, truncate
    const lines = text.split('\n');
    if (lines.length > MAX_OUTPUT_LINES) {
      return lines.slice(0, 100).join('\n') + `\n... (${lines.length - 100} lines truncated)`;
    }
    return text;
  }
}

function summarizeJSON(obj, depth, maxDepth) {
  const indent = '  '.repeat(depth);
  if (depth > maxDepth) return indent + '...';

  if (Array.isArray(obj)) {
    if (obj.length === 0) return indent + '[]';
    if (obj.length <= 3) {
      const items = obj.map(i => summarizeJSON(i, depth + 1, maxDepth));
      return indent + '[\n' + items.join(',\n') + '\n' + indent + ']';
    }
    const first = summarizeJSON(obj[0], depth + 1, maxDepth);
    return indent + `[  // ${obj.length} items\n${first}\n${indent}  ... +${obj.length - 1} more\n${indent}]`;
  }

  if (obj && typeof obj === 'object') {
    const keys = Object.keys(obj);
    if (keys.length === 0) return indent + '{}';
    const lines = keys.slice(0, 15).map(k => {
      const v = obj[k];
      if (v === null) return indent + `  "${k}": null`;
      if (typeof v === 'string') return indent + `  "${k}": "${v.length > 50 ? v.slice(0, 50) + '...' : v}"`;
      if (typeof v === 'number' || typeof v === 'boolean') return indent + `  "${k}": ${v}`;
      if (Array.isArray(v)) return indent + `  "${k}": [${v.length} items]`;
      return indent + `  "${k}": {${Object.keys(v).length} keys}`;
    });
    let result = indent + '{\n' + lines.join(',\n');
    if (keys.length > 15) result += `\n${indent}  ... +${keys.length - 15} more keys`;
    return result + '\n' + indent + '}';
  }

  return indent + JSON.stringify(obj);
}

// ── File Listing: group by directory ──

function compressFileListing(lines) {
  const dirs = {};
  let fileCount = 0;

  for (const line of lines) {
    const path = line.trim();
    if (!path) continue;
    fileCount++;
    const parts = path.split('/');
    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
    if (!dirs[dir]) dirs[dir] = 0;
    dirs[dir]++;
  }

  const out = [];
  const sorted = Object.entries(dirs).sort((a, b) => b[1] - a[1]);
  for (const [dir, count] of sorted.slice(0, 20)) {
    out.push(`${dir}/ (${count} files)`);
  }
  if (sorted.length > 20) out.push(`... +${sorted.length - 20} more directories`);
  out.push(`\nTotal: ${fileCount} files`);

  return out.join('\n');
}

// ── Generic: dedup, strip noise, truncate ──

function compressGeneric(lines) {
  // Strip blank lines and trim
  lines = lines.filter(l => l.trim()).map(l => l.slice(0, MAX_LINE_LENGTH));

  // Dedup: collapse consecutive identical/similar lines
  const deduped = [];
  let lastLine = '';
  let dupCount = 0;

  for (const line of lines) {
    const normalized = line.trim().replace(/\d+/g, 'N');
    if (normalized === lastLine && dupCount < 100) {
      dupCount++;
    } else {
      if (dupCount > 1) {
        deduped.push(`  ... (repeated ${dupCount}x)`);
      }
      deduped.push(line);
      lastLine = normalized;
      dupCount = 1;
    }
  }
  if (dupCount > 1) deduped.push(`  ... (repeated ${dupCount}x)`);

  // Strip noise: progress bars, spinners, timestamps-only lines
  const cleaned = deduped.filter(l => {
    const t = l.trim();
    // Skip pure progress/spinner lines
    if (/^[|\\\/\-]{1,4}\s/.test(t)) return false;
    if (/^[\s░▒▓█]*$/.test(t)) return false;
    if (/^\d+%\s*[|█░]/.test(t)) return false;
    // Skip timestamp-only lines
    if (/^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(t) && t.length < 30) return false;
    return true;
  });

  // Truncate if still too long
  if (cleaned.length > MAX_OUTPUT_LINES) {
    const head = cleaned.slice(0, MAX_OUTPUT_LINES * 0.7 | 0);
    const tail = cleaned.slice(-MAX_OUTPUT_LINES * 0.3 | 0);
    return [...head, `\n... (${cleaned.length - head.length - tail.length} lines omitted)\n`, ...tail].join('\n');
  }

  return cleaned.join('\n');
}
