#!/bin/bash
# terse-rewrite.sh — RTK-style PreToolUse hook for Claude Code
# Intercepts Bash tool calls and pipes output through terse-compress
# for 60-90% token reduction on common dev commands.
#
# Inspired by github.com/rtk-ai/rtk
#
# Install: Add to ~/.claude/settings.json:
# {
#   "hooks": {
#     "PreToolUse": [
#       {
#         "matcher": "Bash",
#         "hooks": [
#           {
#             "type": "command",
#             "command": "~/.terse/terse-rewrite.sh"
#           }
#         ]
#       }
#     ]
#   }
# }

set -euo pipefail

# Read tool use event from stdin
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)

# Only process Bash tool calls
if [ "$TOOL_NAME" != "Bash" ]; then
  exit 0
fi

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
if [ -z "$COMMAND" ]; then
  exit 0
fi

# Skip commands that shouldn't be compressed:
# - Already piped through terse
# - Interactive commands (editors, ssh, etc.)
# - Heredocs / multi-line scripts
# - Commands that produce structured output needed verbatim
# - Short/simple commands
if [[ "$COMMAND" == *"terse-compress"* ]] || \
   [[ "$COMMAND" == *"terse-rewrite"* ]] || \
   [[ "$COMMAND" == *"<<EOF"* ]] || \
   [[ "$COMMAND" == *"<<'"* ]] || \
   [[ "$COMMAND" == *"heredoc"* ]] || \
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
  exit 0
fi

# Commands that benefit most from compression (RTK's target list)
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
  "strings " "file " "stat "
  "brew " "apt " "dnf " "pacman "
)

SHOULD_COMPRESS=false

# Normalize: strip leading flags like -C /path for matching
NORMALIZED_CMD="$COMMAND"
# Strip git -C <path> to match as git <subcommand>
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

# Also compress if output is likely to be large (chained commands, subshells)
if [ "$SHOULD_COMPRESS" = false ]; then
  # Compress if command contains pipes or is a subshell likely to produce output
  if [[ "$COMMAND" == *" | "* ]] && [[ ${#COMMAND} -gt 50 ]]; then
    SHOULD_COMPRESS=true
  fi
fi

if [ "$SHOULD_COMPRESS" = false ]; then
  exit 0
fi

# Find terse-compress
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TERSE_COMPRESS=""

# Check multiple locations
for candidate in \
  "$SCRIPT_DIR/terse-compress.js" \
  "$HOME/.terse/terse-compress.js" \
  "/Applications/Terse.app/Contents/Resources/terse-compress.js"; do
  if [ -f "$candidate" ]; then
    TERSE_COMPRESS="$candidate"
    break
  fi
done

if [ -z "$TERSE_COMPRESS" ]; then
  exit 0  # No compressor found, pass through
fi

# Rewrite: wrap command to pipe through terse-compress
# Use subshell + 2>&1 to capture both stdout and stderr
WRAPPED="($COMMAND) 2>&1 | node $TERSE_COMPRESS"

# Emit the modified tool input using Claude Code hook protocol
jq -n \
  --arg cmd "$WRAPPED" \
  '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: {
        command: $cmd
      },
      additionalContext: "Output compressed by Terse (RTK-style) to reduce token usage"
    }
  }'

exit 0
