#!/bin/bash
# terse-tool-optimizer-codex.sh — Codex CLI PreToolUse hook for file read/search tools
# Caps input parameters to prevent excessive token consumption.
# Codex protocol: stdin JSON → stdout JSON { decision, updatedInput }
#
# Install: .codex/hooks.json or config.toml → pre_tool_use matcher "read_file|search"

set -euo pipefail

if ! pgrep -xiq "Terse"; then
  exit 0
fi

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
TOOL_INPUT=$(echo "$INPUT" | jq '.tool_input // {}' 2>/dev/null)

if [ -z "$TOOL_NAME" ]; then
  echo '{"decision":"Proceed"}'
  exit 0
fi

STATS_FILE="${TMPDIR:-/tmp}/terse-tool-optimize-stats.jsonl"
track_save() {
  local tool="$1" original="$2" optimized="$3"
  local saved=$((original - optimized))
  [ "$saved" -gt 0 ] && echo "{\"tool\":\"$tool\",\"original\":$original,\"optimized\":$optimized,\"saved\":$saved,\"ts\":$(date +%s)}" >> "$STATS_FILE" 2>/dev/null
}

# ── File reads ──
if [ "$TOOL_NAME" = "read_file" ] || [ "$TOOL_NAME" = "view" ]; then
  FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // .path // empty' 2>/dev/null)
  LIMIT=$(echo "$TOOL_INPUT" | jq -r '.limit // .max_lines // empty' 2>/dev/null)

  [ -z "$FILE_PATH" ] && { echo '{"decision":"Proceed"}'; exit 0; }

  case "$FILE_PATH" in
    *.lock|*.min.js|*.min.css|*.map|*.wasm|*.dylib|*.so)
      UPDATED=$(echo "$TOOL_INPUT" | jq '. + {limit: 100}')
      jq -n --argjson input "$UPDATED" '{"decision":"Modify","updatedInput":$input,"reason":"Terse: capped generated/binary file to 100 lines"}'
      track_save "read_file" 2000 100
      exit 0 ;;
  esac

  if [ -z "$LIMIT" ] || [ "$LIMIT" = "null" ]; then
    if [ -f "$FILE_PATH" ]; then
      LINE_COUNT=$(wc -l < "$FILE_PATH" 2>/dev/null | tr -d ' ')
      if [ "$LINE_COUNT" -gt 500 ]; then
        UPDATED=$(echo "$TOOL_INPUT" | jq '. + {limit: 500}')
        jq -n --argjson input "$UPDATED" '{"decision":"Modify","updatedInput":$input,"reason":"Terse: capped large file to 500 lines"}'
        track_save "read_file" "$LINE_COUNT" 500
        exit 0
      fi
    fi
  fi

  if [ -n "$LIMIT" ] && [ "$LIMIT" != "null" ] && [ "$LIMIT" -gt 1000 ] 2>/dev/null; then
    UPDATED=$(echo "$TOOL_INPUT" | jq '. + {limit: 1000}')
    jq -n --argjson input "$UPDATED" '{"decision":"Modify","updatedInput":$input,"reason":"Terse: capped to 1000 lines"}'
    track_save "read_file" "$LIMIT" 1000
    exit 0
  fi

  echo '{"decision":"Proceed"}'
  exit 0
fi

# ── Search/grep ──
if [ "$TOOL_NAME" = "search" ] || [ "$TOOL_NAME" = "grep" ]; then
  MAX=$(echo "$TOOL_INPUT" | jq -r '.max_results // .limit // 0' 2>/dev/null)
  if [ "$MAX" -eq 0 ] || [ "$MAX" -gt 100 ] 2>/dev/null; then
    UPDATED=$(echo "$TOOL_INPUT" | jq '. + {max_results: 100, limit: 100}')
    jq -n --argjson input "$UPDATED" '{"decision":"Modify","updatedInput":$input,"reason":"Terse: capped search to 100 results"}'
    track_save "search" 500 100
    exit 0
  fi

  echo '{"decision":"Proceed"}'
  exit 0
fi

echo '{"decision":"Proceed"}'
exit 0
