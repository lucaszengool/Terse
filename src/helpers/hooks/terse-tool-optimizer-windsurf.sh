#!/bin/bash
# terse-tool-optimizer-windsurf.sh — Windsurf pre_tool_use hook for file reads
# Windsurf can block (exit 2) but cannot modify input.
# Strategy: block reads of generated/binary files that waste tokens.
# Windsurf protocol: stdin JSON, exit 0 (allow) or exit 2 (block, stderr = reason)
#
# Install: .windsurf/hooks.json → pre_tool_use

set -euo pipefail

if ! pgrep -xiq "Terse"; then
  exit 0
fi

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.actionType // .tool_name // empty' 2>/dev/null)

STATS_FILE="${TMPDIR:-/tmp}/terse-tool-optimize-stats.jsonl"
track_save() {
  local tool="$1" original="$2" optimized="$3"
  local saved=$((original - optimized))
  [ "$saved" -gt 0 ] && echo "{\"tool\":\"$tool\",\"original\":$original,\"optimized\":$optimized,\"saved\":$saved,\"ts\":$(date +%s)}" >> "$STATS_FILE" 2>/dev/null
}

# ── File reads: block wasteful ones ──
if [ "$TOOL_NAME" = "read_file" ] || [ "$TOOL_NAME" = "view_file" ]; then
  FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // .file_path // empty' 2>/dev/null)

  [ -z "$FILE_PATH" ] && exit 0

  # Block binary/generated files
  case "$FILE_PATH" in
    *.lock|*.min.js|*.min.css|*.map|*.wasm|*.dylib|*.so|*.a|*.o)
      echo "[Terse] Blocked read of generated/binary file ($FILE_PATH). Use a targeted command instead." >&2
      track_save "read_file" 2000 0
      exit 2 ;;
  esac

  # Block extremely large files (>2000 lines)
  if [ -f "$FILE_PATH" ]; then
    LINE_COUNT=$(wc -l < "$FILE_PATH" 2>/dev/null | tr -d ' ')
    if [ "$LINE_COUNT" -gt 2000 ]; then
      echo "[Terse] File has $LINE_COUNT lines — too large. Read specific sections or use grep instead." >&2
      track_save "read_file" "$LINE_COUNT" 0
      exit 2
    fi
  fi

  exit 0
fi

# ── Search: pass through (Windsurf can't modify input) ──
exit 0
