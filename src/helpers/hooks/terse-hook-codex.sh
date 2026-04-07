#!/bin/bash
# terse-hook-codex.sh — OpenAI Codex CLI PreToolUse hook adapter
# Codex CLI hooks receive JSON on stdin and return JSON on stdout.
# Protocol: { tool_name, tool_input } → { decision: "Proceed"|"Block"|"Modify", updatedInput? }
#
# Install: Add to codex.toml:
# [[hooks.pre_tool_use]]
# matcher = "shell"
# command = "~/.terse/hooks/terse-hook-codex.sh"

set -euo pipefail

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // .type // empty' 2>/dev/null)

# Codex uses "shell" or "Shell" for command execution
if [ "$TOOL_NAME" != "shell" ] && [ "$TOOL_NAME" != "Shell" ] && [ "$TOOL_NAME" != "Bash" ]; then
  echo '{"decision":"Proceed"}'
  exit 0
fi

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // .input.command // .command // empty' 2>/dev/null)
if [ -z "$COMMAND" ]; then
  echo '{"decision":"Proceed"}'
  exit 0
fi

# ── Skip list ──
if [[ "$COMMAND" == *"terse-compress"* ]] || \
   [[ "$COMMAND" == *"terse-hook"* ]] || \
   [[ "$COMMAND" == *"<<EOF"* ]] || \
   [[ "$COMMAND" == *"<<'"* ]] || \
   [[ "$COMMAND" == "cd "* ]] || \
   [[ "$COMMAND" == "echo "* ]] || \
   [[ "$COMMAND" == "export "* ]] || \
   [[ "$COMMAND" == "mkdir "* ]] || \
   [[ "$COMMAND" == "chmod "* ]] || \
   [[ "$COMMAND" == "mv "* ]] || \
   [[ "$COMMAND" == "cp "* ]] || \
   [[ "$COMMAND" == "rm "* ]] || \
   [[ "$COMMAND" == "touch "* ]] || \
   [[ "$COMMAND" == "which "* ]] || \
   [[ "$COMMAND" == "pwd"* ]] || \
   [[ "$COMMAND" == "kill "* ]] || \
   [[ "$COMMAND" == "pkill "* ]] || \
   [[ "$COMMAND" == "open "* ]] || \
   [[ "$COMMAND" == "ssh "* ]] || \
   [[ "$COMMAND" == "vim "* ]] || \
   [[ "$COMMAND" == "nano "* ]]; then
  echo '{"decision":"Proceed"}'
  exit 0
fi

# ── Compress patterns ──
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SHOULD_COMPRESS=false

COMPRESS_PATTERNS=(
  "git status" "git diff" "git log" "git show" "git branch" "git stash"
  "git push" "git pull" "git fetch" "git remote" "git blame"
  "ls " "ls -" "find " "tree" "du " "df "
  "npm test" "npx " "jest" "vitest" "pytest" "cargo test" "go test" "mocha" "ava"
  "npm run" "pnpm " "yarn " "bun "
  "npm install" "npm ci" "pnpm install" "yarn install"
  "eslint" "tsc " "tsc --" "biome" "prettier" "ruff" "clippy" "golint"
  "docker ps" "docker images" "docker logs" "docker compose"
  "kubectl " "helm "
  "cargo build" "cargo clippy" "cargo check" "go build" "go vet" "make"
  "pip list" "pip show" "pip install" "pip freeze"
  "cat " "head " "tail " "wc "
  "env" "printenv" "set"
  "ps " "ps aux" "top -" "htop"
  "curl " "wget "
  "grep " "rg " "ag " "ack "
  "brew " "apt " "dnf " "pacman "
)

NORMALIZED_CMD="$COMMAND"
if [[ "$COMMAND" == "git -"* ]]; then
  NORMALIZED_CMD="git $(echo "$COMMAND" | sed 's/^git [^ ]* [^ ]* //')"
fi

for pattern in "${COMPRESS_PATTERNS[@]}"; do
  if [[ "$COMMAND" == "$pattern"* ]] || [[ "$NORMALIZED_CMD" == "$pattern"* ]] || \
     [[ "$COMMAND" == *"| $pattern"* ]] || [[ "$COMMAND" == *"&& $pattern"* ]]; then
    SHOULD_COMPRESS=true
    break
  fi
done

if [ "$SHOULD_COMPRESS" = false ]; then
  if [[ "$COMMAND" == *" | "* ]] && [[ ${#COMMAND} -gt 50 ]]; then
    SHOULD_COMPRESS=true
  fi
fi

if [ "$SHOULD_COMPRESS" = false ]; then
  echo '{"decision":"Proceed"}'
  exit 0
fi

# Find terse-compress
TERSE_COMPRESS=""
for candidate in \
  "$SCRIPT_DIR/../terse-compress.js" \
  "$SCRIPT_DIR/terse-compress.js" \
  "$HOME/.terse/terse-compress.js" \
  "/Applications/Terse.app/Contents/Resources/terse-compress.js"; do
  if [ -f "$candidate" ]; then
    TERSE_COMPRESS="$candidate"
    break
  fi
done

if [ -z "$TERSE_COMPRESS" ]; then
  echo '{"decision":"Proceed"}'
  exit 0
fi

WRAPPED="($COMMAND) 2>&1 | node $TERSE_COMPRESS"

# Codex uses Modify decision to rewrite the tool input
jq -n \
  --arg cmd "$WRAPPED" \
  '{
    decision: "Modify",
    updatedInput: {
      command: $cmd
    },
    reason: ""
  }'

exit 0
