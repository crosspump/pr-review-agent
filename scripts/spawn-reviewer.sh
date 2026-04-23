#!/usr/bin/env bash
# Helper script to spawn an OpenClaw subagent for PR review
# Usage: spawn-reviewer.sh <prompt-file> <result-file>

set -euo pipefail

PROMPT_FILE="$1"
RESULT_FILE="$2"

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo '{"summary":"Prompt file not found","issues":[]}' > "$RESULT_FILE"
  exit 1
fi

PROMPT=$(cat "$PROMPT_FILE")

# Use openclaw CLI to spawn a subagent session
# The subagent will analyze the PR and return JSON
openclaw session spawn \
  --mode run \
  --runtime subagent \
  --timeout 120 \
  --json \
  --task "$PROMPT" \
  > "$RESULT_FILE.raw" 2>&1

# Extract the reply from the JSON response
if [[ -f "$RESULT_FILE.raw" ]]; then
  # Try to parse the reply field from openclaw's JSON output
  REPLY=$(jq -r '.reply // .message // .output // .text // ""' "$RESULT_FILE.raw" 2>/dev/null || echo "")
  
  if [[ -z "$REPLY" ]]; then
    echo '{"summary":"Agent returned empty reply","issues":[]}' > "$RESULT_FILE"
    exit 0
  fi
  
  # Extract JSON from reply (might have markdown fences)
  echo "$REPLY" | sed -n '/```json/,/```/p' | sed '1d;$d' > "$RESULT_FILE.tmp" 2>/dev/null || true
  
  if [[ ! -s "$RESULT_FILE.tmp" ]]; then
    # No markdown fences, try to extract raw JSON object
    echo "$REPLY" | grep -o '{.*}' > "$RESULT_FILE.tmp" 2>/dev/null || echo "$REPLY" > "$RESULT_FILE.tmp"
  fi
  
  # Validate JSON
  if jq empty "$RESULT_FILE.tmp" 2>/dev/null; then
    mv "$RESULT_FILE.tmp" "$RESULT_FILE"
  else
    echo '{"summary":"Could not parse agent reply as JSON","issues":[]}' > "$RESULT_FILE"
  fi
  
  rm -f "$RESULT_FILE.raw" "$RESULT_FILE.tmp"
else
  echo '{"summary":"Agent spawn failed","issues":[]}' > "$RESULT_FILE"
fi
