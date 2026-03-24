/**
 * terse-hook-openclaw.ts — OpenClaw Gateway plugin for Terse token compression.
 *
 * OpenClaw uses TypeScript-based hooks loaded by the Gateway at runtime.
 * This hook intercepts shell tool calls and pipes output through terse-compress.
 *
 * Install: Copy to ~/.openclaw/hooks/ or the project's hooks directory.
 * OpenClaw auto-discovers .ts files in the hooks directory.
 *
 * Alternative: Register via OpenClaw plugin API:
 *   import terseHook from '~/.terse/hooks/terse-hook-openclaw';
 *   gateway.registerHook('tool.execute.before', terseHook);
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const SKIP_PREFIXES = [
  'cd ', 'echo ', 'export ', 'mkdir ', 'chmod ', 'mv ', 'cp ', 'rm ',
  'touch ', 'which ', 'pwd', 'kill ', 'pkill ', 'open ', 'ssh ', 'vim ', 'nano ',
];

const COMPRESS_PREFIXES = [
  'git status', 'git diff', 'git log', 'git show', 'git branch', 'git stash',
  'git push', 'git pull', 'git fetch', 'git remote', 'git blame',
  'ls ', 'ls -', 'find ', 'tree', 'du ', 'df ',
  'npm test', 'npx ', 'jest', 'vitest', 'pytest', 'cargo test', 'go test', 'mocha', 'ava',
  'npm run', 'pnpm ', 'yarn ', 'bun ',
  'npm install', 'npm ci', 'pnpm install', 'yarn install',
  'eslint', 'tsc ', 'tsc --', 'biome', 'prettier', 'ruff', 'clippy', 'golint',
  'docker ps', 'docker images', 'docker logs', 'docker compose',
  'kubectl ', 'helm ',
  'cargo build', 'cargo clippy', 'cargo check', 'go build', 'go vet', 'make',
  'pip list', 'pip show', 'pip install', 'pip freeze',
  'cat ', 'head ', 'tail ', 'wc ',
  'env', 'printenv', 'set',
  'ps ', 'ps aux', 'top -', 'htop',
  'curl ', 'wget ',
  'grep ', 'rg ', 'ag ', 'ack ',
  'brew ', 'apt ', 'dnf ', 'pacman ',
];

function findTerseCompress(): string | null {
  const candidates = [
    join(__dirname, '..', 'terse-compress.js'),
    join(__dirname, 'terse-compress.js'),
    join(homedir(), '.terse', 'terse-compress.js'),
    '/Applications/Terse.app/Contents/Resources/terse-compress.js',
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function shouldCompress(command: string): boolean {
  if (command.includes('terse-compress') || command.includes('terse-hook')) return false;
  if (command.includes('<<EOF') || command.includes("<<'")) return false;

  for (const prefix of SKIP_PREFIXES) {
    if (command.startsWith(prefix)) return false;
  }

  // Normalize git -C <path> commands
  let normalized = command;
  if (command.startsWith('git -')) {
    normalized = 'git ' + command.replace(/^git [^ ]* [^ ]* /, '');
  }

  for (const pattern of COMPRESS_PREFIXES) {
    if (command.startsWith(pattern) || normalized.startsWith(pattern) ||
        command.includes(`| ${pattern}`) || command.includes(`&& ${pattern}`)) {
      return true;
    }
  }

  // Long piped commands
  if (command.includes(' | ') && command.length > 50) return true;

  return false;
}

// OpenClaw hook export — compatible with both hook and plugin registration
export default function tersePreToolUse(event: {
  toolName: string;
  toolInput: { command?: string; [key: string]: any };
}) {
  const { toolName, toolInput } = event;

  // Only intercept shell/bash tool calls
  if (toolName !== 'shell' && toolName !== 'bash' && toolName !== 'Bash' &&
      toolName !== 'execute_command' && toolName !== 'run') {
    return { action: 'proceed' };
  }

  const command = toolInput.command;
  if (!command) return { action: 'proceed' };

  if (!shouldCompress(command)) return { action: 'proceed' };

  const compressor = findTerseCompress();
  if (!compressor) return { action: 'proceed' };

  return {
    action: 'modify',
    updatedInput: {
      ...toolInput,
      command: `(${command}) 2>&1 | node ${compressor}`,
    },
    context: 'Output compressed by Terse to reduce token usage',
  };
}

// Also export as named for OpenClaw plugin registration
export const hookName = 'terse-compress';
export const hookEvent = 'tool.execute.before';
export const handler = tersePreToolUse;
