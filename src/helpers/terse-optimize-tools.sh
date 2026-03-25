#!/bin/bash
# terse-optimize-tools.sh — PreToolUse hook for Read, Grep, Glob
# Caps input parameters to prevent excessive token consumption.
# Unlike RTK which can only compress Bash output, this reduces tokens
# from Read/Grep/Glob which typically consume 80%+ of context.
#
# Strategy: modify tool INPUT before execution (output cannot be modified)
# - Read: cap line limit, skip known large/binary files
# - Grep: cap head_limit, reduce context lines
# - Glob: cap result count

set -euo pipefail

# Exit immediately if Terse is not running
if ! pgrep -xiq "Terse"; then
  exit 0
fi

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)

if [ -z "$TOOL_NAME" ]; then
  exit 0
fi

TOOL_INPUT=$(echo "$INPUT" | jq -r '.tool_input // empty' 2>/dev/null)

# ── Stats tracking ──
STATS_FILE="${TMPDIR:-/tmp}/terse-tool-optimize-stats.jsonl"
track_save() {
  local tool="$1" original="$2" optimized="$3"
  local saved=$((original - optimized))
  if [ "$saved" -gt 0 ]; then
    echo "{\"tool\":\"$tool\",\"original\":$original,\"optimized\":$optimized,\"saved\":$saved,\"ts\":$(date +%s)}" >> "$STATS_FILE" 2>/dev/null
  fi
}

# ══════════════════════════════════════════════════════
# READ — cap line limit to prevent huge file reads
# Default limit is 2000 lines. Most files need far less.
# ══════════════════════════════════════════════════════
if [ "$TOOL_NAME" = "Read" ]; then
  FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // empty' 2>/dev/null)
  LIMIT=$(echo "$TOOL_INPUT" | jq -r '.limit // empty' 2>/dev/null)
  OFFSET=$(echo "$TOOL_INPUT" | jq -r '.offset // empty' 2>/dev/null)

  # Skip if file doesn't exist or is empty
  if [ -z "$FILE_PATH" ]; then
    exit 0
  fi

  # Skip binary/generated files entirely
  case "$FILE_PATH" in
    *.lock|*.min.js|*.min.css|*.map|*.wasm|*.dylib|*.so|*.a|*.o)
      # These are often huge and rarely useful in full
      # Cap to 100 lines to show structure only
      UPDATED=$(echo "$TOOL_INPUT" | jq '. + {limit: 100}')
      jq -n --argjson input "$UPDATED" '{
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: $input,
          additionalContext: "Terse: capped to 100 lines (generated/binary file)"
        }
      }'
      track_save "Read" 2000 100
      exit 0
      ;;
  esac

  # If agent didn't specify a limit, check file size and cap smartly
  if [ -z "$LIMIT" ] || [ "$LIMIT" = "null" ]; then
    if [ -f "$FILE_PATH" ]; then
      LINE_COUNT=$(wc -l < "$FILE_PATH" 2>/dev/null | tr -d ' ')
      if [ "$LINE_COUNT" -gt 500 ]; then
        # Large file: cap to 500 lines, agent can use offset to read more
        UPDATED=$(echo "$TOOL_INPUT" | jq '. + {limit: 500}')
        jq -n --argjson input "$UPDATED" '{
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            updatedInput: $input,
            additionalContext: ("Terse: file has " + ($input.limit | tostring) + "/" + "'$LINE_COUNT'" + " lines shown. Use offset+limit to read specific sections.")
          }
        }'
        track_save "Read" "$LINE_COUNT" 500
        exit 0
      fi
    fi
  fi

  # If agent explicitly set a very high limit, cap it
  if [ -n "$LIMIT" ] && [ "$LIMIT" != "null" ] && [ "$LIMIT" -gt 1000 ] 2>/dev/null; then
    UPDATED=$(echo "$TOOL_INPUT" | jq '. + {limit: 1000}')
    jq -n --argjson input "$UPDATED" '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: $input,
        additionalContext: "Terse: capped Read limit to 1000 lines"
      }
    }'
    track_save "Read" "$LIMIT" 1000
    exit 0
  fi

  exit 0
fi

# ══════════════════════════════════════════════════════
# GREP — cap results and context lines
# Without head_limit, Grep can return thousands of matches
# ══════════════════════════════════════════════════════
if [ "$TOOL_NAME" = "Grep" ]; then
  HEAD_LIMIT=$(echo "$TOOL_INPUT" | jq -r '.head_limit // 0' 2>/dev/null)
  CONTEXT_A=$(echo "$TOOL_INPUT" | jq -r '.["-A"] // 0' 2>/dev/null)
  CONTEXT_B=$(echo "$TOOL_INPUT" | jq -r '.["-B"] // 0' 2>/dev/null)
  CONTEXT_C=$(echo "$TOOL_INPUT" | jq -r '.["-C"] // .context // 0' 2>/dev/null)
  OUTPUT_MODE=$(echo "$TOOL_INPUT" | jq -r '.output_mode // "files_with_matches"' 2>/dev/null)

  MODIFIED=false
  UPDATED="$TOOL_INPUT"
  NOTES=""

  # Cap head_limit if not set or too high (for content mode)
  if [ "$OUTPUT_MODE" = "content" ]; then
    if [ "$HEAD_LIMIT" -eq 0 ] || [ "$HEAD_LIMIT" -gt 200 ] 2>/dev/null; then
      UPDATED=$(echo "$UPDATED" | jq '. + {head_limit: 200}')
      MODIFIED=true
      NOTES="capped to 200 lines"
    fi
  elif [ "$OUTPUT_MODE" = "files_with_matches" ]; then
    if [ "$HEAD_LIMIT" -eq 0 ] || [ "$HEAD_LIMIT" -gt 50 ] 2>/dev/null; then
      UPDATED=$(echo "$UPDATED" | jq '. + {head_limit: 50}')
      MODIFIED=true
      NOTES="capped to 50 files"
    fi
  fi

  # Cap context lines (each adds tokens per match)
  MAX_CTX=5
  if [ "$CONTEXT_A" -gt "$MAX_CTX" ] 2>/dev/null; then
    UPDATED=$(echo "$UPDATED" | jq --argjson m "$MAX_CTX" '. + {"-A": $m}')
    MODIFIED=true
    NOTES="${NOTES:+$NOTES, }context-after capped to $MAX_CTX"
  fi
  if [ "$CONTEXT_B" -gt "$MAX_CTX" ] 2>/dev/null; then
    UPDATED=$(echo "$UPDATED" | jq --argjson m "$MAX_CTX" '. + {"-B": $m}')
    MODIFIED=true
    NOTES="${NOTES:+$NOTES, }context-before capped to $MAX_CTX"
  fi
  if [ "$CONTEXT_C" -gt "$MAX_CTX" ] 2>/dev/null; then
    UPDATED=$(echo "$UPDATED" | jq --argjson m "$MAX_CTX" '. + {"-C": $m, context: $m}')
    MODIFIED=true
    NOTES="${NOTES:+$NOTES, }context capped to $MAX_CTX"
  fi

  if [ "$MODIFIED" = true ]; then
    jq -n --argjson input "$UPDATED" --arg notes "Terse: $NOTES" '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: $input,
        additionalContext: $notes
      }
    }'
    track_save "Grep" 500 200
    exit 0
  fi

  exit 0
fi

# ══════════════════════════════════════════════════════
# GLOB — no direct limit parameter, but we can add context
# Glob results are usually small (file paths), less impactful
# ══════════════════════════════════════════════════════
if [ "$TOOL_NAME" = "Glob" ]; then
  # Glob is generally efficient already, pass through
  exit 0
fi

exit 0
