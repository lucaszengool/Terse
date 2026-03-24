#!/bin/bash
# terse-hook-windsurf.sh — Windsurf/Cascade pre-action hook adapter
# Windsurf Cascade hooks receive JSON on stdin with action details.
# Returns JSON to allow/deny/modify the action.
#
# Note: Cascade Hooks may require Windsurf Enterprise.
# Install: Configure in Windsurf settings → Cascade → Hooks → Pre-action
#
# Config example (windsurf settings):
# {
#   "cascade.hooks": {
#     "preAction": [{
#       "matcher": "shell",
#       "command": "~/.terse/hooks/terse-hook-windsurf.sh"
#     }]
#   }
# }

set -euo pipefail

INPUT=$(cat)
ACTION_TYPE=$(echo "$INPUT" | jq -r '.actionType // .tool_name // .type // empty' 2>/dev/null)

# Windsurf uses "shell", "terminal", or "command" for shell actions
if [ "$ACTION_TYPE" != "shell" ] && [ "$ACTION_TYPE" != "terminal" ] && \
   [ "$ACTION_TYPE" != "command" ] && [ "$ACTION_TYPE" != "Bash" ]; then
  echo '{"allow":true}'
  exit 0
fi

COMMAND=$(echo "$INPUT" | jq -r '.command // .tool_input.command // .input.command // empty' 2>/dev/null)
if [ -z "$COMMAND" ]; then
  echo '{"allow":true}'
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
  echo '{"allow":true}'
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
  echo '{"allow":true}'
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
  echo '{"allow":true}'
  exit 0
fi

WRAPPED="($COMMAND) 2>&1 | node $TERSE_COMPRESS"

# Windsurf hook response
jq -n \
  --arg cmd "$WRAPPED" \
  '{
    allow: true,
    modifiedCommand: $cmd,
    reason: "Output compressed by Terse to reduce token usage"
  }'

exit 0
