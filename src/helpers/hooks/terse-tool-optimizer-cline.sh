#!/bin/bash
# terse-tool-optimizer-cline.sh — Cline PreToolUse hook for read_file & list_files
# Cline can cancel + inject contextModification but cannot modify input directly.
# Strategy: cancel reads of very large/generated files, inject guidance context.
# Cline protocol: stdin JSON → stdout JSON { cancel, contextModification }
#
# Install: .clinerules/hooks/ or ~/Documents/Cline/Rules/Hooks/

set -euo pipefail

if ! pgrep -xiq "Terse"; then
  exit 0
fi

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.toolName // .tool_name // empty' 2>/dev/null)
PARAMS=$(echo "$INPUT" | jq '.parameters // .tool_input // {}' 2>/dev/null)

if [ -z "$TOOL_NAME" ]; then
  echo '{"cancel":false}'
  exit 0
fi

STATS_FILE="${TMPDIR:-/tmp}/terse-tool-optimize-stats.jsonl"
track_save() {
  local tool="$1" original="$2" optimized="$3"
  local saved=$((original - optimized))
  [ "$saved" -gt 0 ] && echo "{\"tool\":\"$tool\",\"original\":$original,\"optimized\":$optimized,\"saved\":$saved,\"ts\":$(date +%s)}" >> "$STATS_FILE" 2>/dev/null
}

# ── read_file: block wasteful reads, guide with context ──
if [ "$TOOL_NAME" = "read_file" ]; then
  FILE_PATH=$(echo "$PARAMS" | jq -r '.path // .file_path // empty' 2>/dev/null)

  [ -z "$FILE_PATH" ] && { echo '{"cancel":false}'; exit 0; }

  # Block binary/generated files
  case "$FILE_PATH" in
    *.lock|*.min.js|*.min.css|*.map|*.wasm|*.dylib|*.so|*.a|*.o)
      jq -n '{
        cancel: true,
        contextModification: "[Terse] Blocked read of generated/binary file. These files waste tokens. Use a targeted command to extract what you need instead."
      }'
      track_save "read_file" 2000 0
      exit 0 ;;
  esac

  # Warn on very large files
  if [ -f "$FILE_PATH" ]; then
    LINE_COUNT=$(wc -l < "$FILE_PATH" 2>/dev/null | tr -d ' ')
    if [ "$LINE_COUNT" -gt 500 ]; then
      jq -n --arg lc "$LINE_COUNT" '{
        cancel: false,
        contextModification: ("[Terse] This file has " + $lc + " lines. Consider reading specific line ranges to save tokens.")
      }'
      track_save "read_file" "$LINE_COUNT" "$LINE_COUNT"
      exit 0
    fi
  fi

  echo '{"cancel":false}'
  exit 0
fi

# ── list_files: warn on broad listings ──
if [ "$TOOL_NAME" = "list_files" ]; then
  RECURSIVE=$(echo "$PARAMS" | jq -r '.recursive // false' 2>/dev/null)
  if [ "$RECURSIVE" = "true" ]; then
    jq -n '{
      cancel: false,
      contextModification: "[Terse] Recursive directory listing can be very large. Consider using a more specific path or non-recursive listing."
    }'
    exit 0
  fi
  echo '{"cancel":false}'
  exit 0
fi

echo '{"cancel":false}'
exit 0
