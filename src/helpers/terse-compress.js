#!/usr/bin/env node
/**
 * terse-compress — Cache-safe CLI tool output compressor for LLM context.
 * Zero external dependencies.
 *
 * CACHE-SAFETY DESIGN:
 *   - 100% deterministic: same input bytes → same output bytes, always
 *   - No timestamps, no randomness, no variable-length truncation
 *   - Only compresses when savings exceed MINIMUM_SAVINGS_PCT (20%)
 *   - Small outputs (< MIN_LINES) pass through unchanged
 *   - Structured compressions (git, test, build) are deterministic by design
 *   - No metadata injection into output (stats go to stderr only)
 *
 * Usage:
 *   git status | node terse-compress.js
 *   npm test 2>&1 | node terse-compress.js
 *   cat large-file.json | node terse-compress.js
 *   node terse-compress.js --passthrough  # disable compression, just pass through
 *
 * Compression techniques:
 *   1. Deduplication — collapse repeated/similar lines with counts
 *   2. Noise removal — strip ANSI, progress bars, blank lines
 *   3. Deterministic truncation — fixed head/tail ratio, no variable splits
 *   4. Structure compression — collapse JSON, condense file listings
 *   5. Git-aware — compress diff/status/log output
 *   6. Test-aware — keep only failures + summary
 *   7. Build-aware — keep only errors + warnings
 */

// ── Configuration ──
const MAX_OUTPUT_LINES = 200;        // Hard cap on output lines
const MAX_LINE_LENGTH = 500;         // Truncate individual lines
const MIN_LINES_TO_COMPRESS = 10;    // Don't compress small outputs
const MINIMUM_SAVINGS_PCT = 20;      // Only emit compressed if savings >= 20%

// ── Passthrough mode (--passthrough flag) ──
const PASSTHROUGH = process.argv.includes('--passthrough');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  if (!input.trim()) { process.exit(0); return; }

  if (PASSTHROUGH) {
    process.stdout.write(input);
    process.exit(0);
    return;
  }

  const lines = input.split('\n');

  // Small outputs: pass through unchanged (cache-safe)
  if (lines.length < MIN_LINES_TO_COMPRESS) {
    process.stdout.write(input);
    process.exit(0);
    return;
  }

  const compressed = compress(input);

  // Only use compressed version if savings meet threshold
  const origTok = estimateTokens(input);
  const compTok = estimateTokens(compressed);
  const savedPct = origTok > 0 ? Math.round((1 - compTok / origTok) * 100) : 0;

  if (savedPct >= MINIMUM_SAVINGS_PCT) {
    process.stdout.write(compressed);
    // Stats to stderr only — never inject into output
    process.stderr.write(`[terse] ${origTok}→${compTok} tokens (${savedPct}% saved)\n`);
  } else {
    // Savings too small — pass through original to preserve cache
    process.stdout.write(input);
    if (savedPct > 0) {
      process.stderr.write(`[terse] skipped compression (${savedPct}% < ${MINIMUM_SAVINGS_PCT}% threshold)\n`);
    }
  }

  // Track for agent panel (always, even if skipped)
  try {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    fs.appendFileSync(path.join(os.tmpdir(), 'terse-compress-stats.jsonl'),
      JSON.stringify({ ts: Date.now(), originalTokens: origTok, optimizedTokens: compTok,
        saved: origTok - compTok, applied: savedPct >= MINIMUM_SAVINGS_PCT }) + '\n');
  } catch(e) {}
});

function estimateTokens(text) {
  if (!text) return 0;
  // Better estimation: ~4 chars per token for English, ~1.5 for CJK
  const cjk = (text.match(/[\u3040-\u9fff\uac00-\ud7af\u4e00-\u9fef]/g) || []).length;
  return Math.max(1, Math.ceil((text.length - cjk) / 4 + cjk * 0.7));
}

function compress(text) {
  let lines = text.split('\n');

  // 1. Strip ANSI escape codes (deterministic — pure regex, no state)
  lines = lines.map(l => l.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
                          .replace(/\x1B\][^\x07]*\x07/g, '')
                          .replace(/\x1B[()][0-9A-B]/g, ''));

  // 2. Detect output type and apply specialized compression
  const sample = lines.slice(0, 50).join('\n');

  if (isGitDiff(sample)) return compressGitDiff(lines);
  if (isGitStatus(sample)) return compressGitStatus(lines);
  if (isGitLog(sample)) return compressGitLog(lines);
  if (isTestOutput(sample)) return compressTestOutput(lines);
  if (isBuildOutput(sample)) return compressBuildOutput(lines);
  if (isJSON(sample)) return compressJSON(text);
  if (isFileListing(sample)) return compressFileListing(lines);

  // 3. Generic compression
  return compressGeneric(lines);
}

// ── Detection (deterministic — pure regex) ──

function isGitDiff(text) {
  return /^diff --git/m.test(text) || (/^---\s+a\//m.test(text) && /^\+\+\+\s+b\//m.test(text));
}
function isGitStatus(text) {
  return /On branch|Changes not staged|Changes to be committed|Untracked files|位于分支|尚未暂存|未跟踪/i.test(text);
}
function isGitLog(text) {
  return /^commit [0-9a-f]{40}/m.test(text) || /^[0-9a-f]{7,12}\s/m.test(text);
}
function isTestOutput(text) {
  return /PASS|FAIL|✓|✗|test result:|Tests:|passed|failed.*\d+\s*(test|spec)/i.test(text);
}
function isBuildOutput(text) {
  return /Compiling|warning\[|error\[|BUILD|Bundling|webpack|tsc.*error/i.test(text);
}
function isJSON(text) {
  const t = text.trimStart();
  return (t.startsWith('{') || t.startsWith('[')) && t.length > 500;
}
function isFileListing(text) {
  const ls = text.split('\n').slice(0, 20);
  const pathLines = ls.filter(l => /^[.\w\/\\-]/.test(l.trim()) && !l.includes('  '));
  return pathLines.length > ls.length * 0.6 && ls.length >= 8;
}

// ── Git Diff: keep file names + changed lines, deterministic hunk limit ──

function compressGitDiff(lines) {
  const out = [];
  let fileCount = 0, addCount = 0, delCount = 0;
  let hunkLines = 0;
  const MAX_HUNK = 30;

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      fileCount++;
      const file = line.replace(/^diff --git a\//, '').replace(/ b\/.*/, '');
      out.push(`── ${file} ──`);
      hunkLines = 0;
    } else if (line.startsWith('@@')) {
      out.push(line);
      hunkLines = 0;
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      addCount++;
      if (hunkLines < MAX_HUNK) out.push(line);
      else if (hunkLines === MAX_HUNK) out.push(`  ... (hunk truncated at ${MAX_HUNK} lines)`);
      hunkLines++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      delCount++;
      if (hunkLines < MAX_HUNK) out.push(line);
      else if (hunkLines === MAX_HUNK) out.push(`  ... (hunk truncated at ${MAX_HUNK} lines)`);
      hunkLines++;
    }
  }

  out.push(`\n${fileCount} files, +${addCount} -${delCount}`);
  return out.join('\n');
}

// ── Git Status: deterministic grouping ──

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

// ── Git Log: deterministic hash + subject extraction ──

function compressGitLog(lines) {
  const out = [];
  let count = 0;
  const MAX_COMMITS = 20;

  for (let i = 0; i < lines.length && count < MAX_COMMITS; i++) {
    const line = lines[i];
    if (/^commit [0-9a-f]{40}/.test(line)) {
      const hash = line.slice(7, 14);
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
      out.push(line.slice(0, MAX_LINE_LENGTH));
      count++;
    }
  }
  if (count >= MAX_COMMITS) out.push(`... (showing first ${MAX_COMMITS} commits)`);
  return out.join('\n');
}

// ── Test Output: failures + summary only ──

function compressTestOutput(lines) {
  const out = [];
  const failures = [];
  let summary = '';
  let inFailure = false;
  let failureBlock = [];

  for (const line of lines) {
    if (/Tests?:\s+\d|test result:|Test Suites:|passed|failed/i.test(line) && /\d/.test(line)) {
      summary = line.trim();
    }
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
    // Deterministic: always show first 5
    for (const f of failures.slice(0, 5)) out.push(f);
    if (failures.length > 5) out.push(`... (+${failures.length - 5} more failures)`);
  }

  if (summary) {
    out.push('\n' + summary);
  } else {
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
    return summarizeJSON(obj, 0, 3);
  } catch {
    // Not valid JSON — deterministic truncation
    const lines = text.split('\n');
    if (lines.length > MAX_OUTPUT_LINES) {
      // Fixed split: always first 140 + last 60 = 200
      const head = lines.slice(0, 140);
      const tail = lines.slice(-60);
      return [...head, `\n... (${lines.length - 200} lines omitted)\n`, ...tail].join('\n');
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
    const entries = keys.slice(0, 15).map(k => {
      const v = obj[k];
      if (v === null) return indent + `  "${k}": null`;
      if (typeof v === 'string') return indent + `  "${k}": "${v.length > 50 ? v.slice(0, 50) + '...' : v}"`;
      if (typeof v === 'number' || typeof v === 'boolean') return indent + `  "${k}": ${v}`;
      if (Array.isArray(v)) return indent + `  "${k}": [${v.length} items]`;
      return indent + `  "${k}": {${Object.keys(v).length} keys}`;
    });
    let result = indent + '{\n' + entries.join(',\n');
    if (keys.length > 15) result += `\n${indent}  ... +${keys.length - 15} more keys`;
    return result + '\n' + indent + '}';
  }

  return indent + JSON.stringify(obj);
}

// ── File Listing: deterministic directory grouping ──

function compressFileListing(lines) {
  const dirs = {};
  let fileCount = 0;

  for (const line of lines) {
    const p = line.trim();
    if (!p) continue;
    fileCount++;
    const parts = p.split('/');
    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
    if (!dirs[dir]) dirs[dir] = 0;
    dirs[dir]++;
  }

  const out = [];
  // Sort alphabetically for determinism (not by count which could vary)
  const sorted = Object.entries(dirs).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [dir, count] of sorted.slice(0, 20)) {
    out.push(`${dir}/ (${count} files)`);
  }
  if (sorted.length > 20) out.push(`... +${sorted.length - 20} more directories`);
  out.push(`\nTotal: ${fileCount} files`);

  return out.join('\n');
}

// ── Generic: deterministic dedup, noise strip, fixed truncation ──

function compressGeneric(lines) {
  // Strip blank lines and trim
  lines = lines.filter(l => l.trim()).map(l => l.slice(0, MAX_LINE_LENGTH));

  // Dedup: collapse consecutive identical/similar lines (deterministic normalization)
  const deduped = [];
  let lastNorm = '';
  let dupCount = 0;

  for (const line of lines) {
    // Deterministic normalization: only replace digits, nothing else
    const normalized = line.trim().replace(/\d+/g, 'N');
    if (normalized === lastNorm && dupCount < 100) {
      dupCount++;
    } else {
      if (dupCount > 2) {
        deduped.push(`  ... (repeated ${dupCount}x)`);
      } else if (dupCount === 2) {
        // Don't collapse pairs — too small, and collapsing changes output for minor input changes
        deduped.push(deduped[deduped.length - 1] || '');
      }
      deduped.push(line);
      lastNorm = normalized;
      dupCount = 1;
    }
  }
  if (dupCount > 2) deduped.push(`  ... (repeated ${dupCount}x)`);

  // Strip noise: progress bars, spinners (deterministic patterns)
  const cleaned = deduped.filter(l => {
    const t = l.trim();
    if (/^[|\\\/\-]{1,4}\s/.test(t)) return false;
    if (/^[\s░▒▓█]*$/.test(t)) return false;
    if (/^\d+%\s*[|█░]/.test(t)) return false;
    // Remove timestamp-only lines (but NOT lines with timestamps + content)
    if (/^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(t) && t.length < 30) return false;
    return true;
  });

  // Deterministic truncation: always first 140 + last 60 = 200 lines
  if (cleaned.length > MAX_OUTPUT_LINES) {
    const HEAD = 140;
    const TAIL = 60;
    const head = cleaned.slice(0, HEAD);
    const tail = cleaned.slice(-TAIL);
    const omitted = cleaned.length - HEAD - TAIL;
    return [...head, `\n... (${omitted} lines omitted)\n`, ...tail].join('\n');
  }

  return cleaned.join('\n');
}
