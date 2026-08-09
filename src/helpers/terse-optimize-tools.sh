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

# ── Compression constants ──
# These tune the meaning-preserving compression applied to large Read files.
# The PreToolUse hook can only rewrite tool INPUT, so we cap the raw read to a
# HEAD window (via limit) and deliver a compressed TAIL of the file plus repeat
# collapsing as additionalContext. This preserves file endings (exports, closing
# brackets, error tails) that a pure head-cap silently drops.
HEAD_KEEP=400        # first N lines shown as the raw Read output
TAIL_KEEP=100        # last M lines surfaced via additionalContext
BYTE_CAP=61440       # 60 KB hard backstop on the tail rendering (a single huge line can't blow the budget)

# collapse_runs — collapse runs of >=3 consecutive identical or whitespace-only
# lines to a single representative line + a marker. Meaning-preserving: a wall of
# identical/blank lines carries no extra information. Pure awk (coreutils only).
collapse_runs() {
  awk '
    function flush(   marker) {
      if (run >= 3) {
        # keep one representative line, then note how many were folded away
        print prev
        printf "… [terse: %d× repeated] …\n", run
      } else {
        # short run: emit verbatim to avoid altering meaning
        for (i = 0; i < run; i++) print prev
      }
    }
    {
      # normalize whitespace-only lines so blank runs collapse together too
      key = ($0 ~ /^[[:space:]]*$/) ? "" : $0
      if (NR > 1 && key == prevkey) {
        run++
      } else {
        if (NR > 1) flush()
        prev = $0; prevkey = key; run = 1
      }
    }
    END { if (NR > 0) flush() }
  '
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
        # Large file. Two things happen here:
        #   (A) HEAD keep — the raw Read output is capped to HEAD_KEEP lines via `limit`.
        #   (A) TAIL keep — we surface the last TAIL_KEEP lines as additionalContext so
        #       file endings (exports, closing brackets, error tails) survive the head-cap.
        #   (B) The tail is run-collapsed (repeated/blank lines folded).
        #   (C) The tail rendering is byte-capped at BYTE_CAP as a hard backstop.
        # Everything is fail-open: if any step fails we fall through to a plain cap.
        ELIDED=$(( LINE_COUNT - HEAD_KEEP - TAIL_KEEP ))
        TAIL_RENDER=""
        if [ "$ELIDED" -gt 0 ]; then
          # tail slice → collapse runs → byte-cap (head -c is a coreutils builtin)
          TAIL_RENDER=$(tail -n "$TAIL_KEEP" "$FILE_PATH" 2>/dev/null | collapse_runs | head -c "$BYTE_CAP" 2>/dev/null)
        fi

        if [ -n "$TAIL_RENDER" ]; then
          # HEAD kept via limit; TAIL delivered as context with an elided-middle marker.
          UPDATED=$(echo "$TOOL_INPUT" | jq --argjson h "$HEAD_KEEP" '. + {limit: $h}')
          CTX=$(printf 'Terse: %s lines total. Showing first %s lines above; last %s lines below (middle %s elided).\n… [terse: elided %s lines] …\n%s' \
            "$LINE_COUNT" "$HEAD_KEEP" "$TAIL_KEEP" "$ELIDED" "$ELIDED" "$TAIL_RENDER")
          jq -n --argjson input "$UPDATED" --arg ctx "$CTX" '{
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "allow",
              updatedInput: $input,
              additionalContext: $ctx
            }
          }'
          track_save "Read" "$LINE_COUNT" "$HEAD_KEEP"
          exit 0
        fi

        # Fallback (tail render unavailable, e.g. file barely over 500 lines):
        # keep the original plain 500-line cap byte-for-byte.
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
