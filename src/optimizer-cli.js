#!/usr/bin/env node
/**
 * terse-compress — CLI tool for piping command output through Terse's optimizer.
 *
 * Usage:
 *   echo "verbose output" | node optimizer-cli.js
 *   git status | node optimizer-cli.js --mode aggressive
 *   cat large-file.json | node optimizer-cli.js --mode balanced
 *
 * Inspired by rtk-ai/rtk's approach of compressing shell output before
 * it reaches LLM context. This is the Node.js equivalent that uses
 * Terse's full optimization engine.
 *
 * Modes:
 *   light      — typo fix + whitespace only (safe, preserves meaning)
 *   balanced   — full optimization (default)
 *   aggressive — maximum compression (may lose nuance)
 *
 * Exit codes:
 *   0 — success (compressed output on stdout)
 *   1 — error (original input passed through on stdout)
 */

const { PromptOptimizer } = require('./optimizer');

const args = process.argv.slice(2);
let mode = 'balanced';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--mode' && args[i + 1]) {
    mode = args[i + 1];
    i++;
  } else if (args[i] === '--light') {
    mode = 'light';
  } else if (args[i] === '--aggressive') {
    mode = 'aggressive';
  } else if (args[i] === '--stats') {
    // Will print stats to stderr
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.error(`terse-compress — Compress command output for LLM context

Usage: command | node optimizer-cli.js [options]

Options:
  --mode <light|balanced|aggressive>  Optimization level (default: balanced)
  --light                             Shorthand for --mode light
  --aggressive                        Shorthand for --mode aggressive
  --stats                             Print compression stats to stderr
  --help, -h                          Show this help

Examples:
  git status | node optimizer-cli.js
  npm test 2>&1 | node optimizer-cli.js --aggressive
  cat config.json | node optimizer-cli.js --stats`);
    process.exit(0);
  }
}

const showStats = args.includes('--stats');

// Read all stdin
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  if (!input.trim()) {
    process.exit(0);
    return;
  }

  try {
    const optimizer = new PromptOptimizer();
    optimizer.updateSettings({ aggressiveness: mode });

    const result = optimizer.optimize(input);

    // Output compressed text
    process.stdout.write(result.optimized);

    // Stats to stderr (won't pollute command output)
    if (showStats) {
      const stats = result.stats;
      process.stderr.write(`\n[terse] ${stats.originalTokens} → ${stats.optimizedTokens} tokens`);
      process.stderr.write(` (${stats.percentSaved}% saved)`);
      if (stats.techniquesApplied.length > 0) {
        process.stderr.write(` | ${stats.techniquesApplied.join(', ')}`);
      }
      process.stderr.write('\n');
    }

    // Track savings for agent panel (write to temp file)
    try {
      const os = require('os');
      const fs = require('fs');
      const path = require('path');
      const statsFile = path.join(os.tmpdir(), 'terse-compress-stats.jsonl');
      const entry = JSON.stringify({
        timestamp: new Date().toISOString(),
        originalTokens: result.stats.originalTokens,
        optimizedTokens: result.stats.optimizedTokens,
        saved: result.stats.tokensSaved,
        percent: result.stats.percentSaved,
        techniques: result.stats.techniquesApplied,
      });
      fs.appendFileSync(statsFile, entry + '\n');
    } catch (e) {
      // Don't fail on tracking errors
    }
  } catch (e) {
    // On any error, pass through original input
    process.stdout.write(input);
    process.stderr.write(`[terse] compression error: ${e.message}\n`);
    process.exit(1);
  }
});
