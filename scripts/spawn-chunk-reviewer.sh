#!/usr/bin/env bash
# Helper script to spawn an OpenClaw subagent for PR chunk review
# Usage: spawn-chunk-reviewer.sh <prompt-file> <result-file>

set -euo pipefail

PROMPT_FILE="$1"
RESULT_FILE="$2"

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo '{"summary":"Prompt file not found","issues":[]}' > "$RESULT_FILE"
  exit 0
fi

PROMPT=$(cat "$PROMPT_FILE")

# Create a temp Node.js script with .mjs extension
SPAWN_SCRIPT=$(mktemp --suffix=.mjs)
cat > "$SPAWN_SCRIPT" << 'SPAWN_EOF'
import { spawn } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';

const promptFile = process.argv[2];
const resultFile = process.argv[3];

const prompt = readFileSync(promptFile, 'utf8');

// Use openclaw CLI to spawn subagent
const proc = spawn('openclaw', [
  'session', 'spawn',
  '--mode', 'run',
  '--runtime', 'subagent',
  '--timeout', '90',
  '--task', prompt
], {
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 100000
});

let stdout = '';
let stderr = '';

proc.stdout.on('data', (data) => {
  stdout += data.toString();
});

proc.stderr.on('data', (data) => {
  stderr += data.toString();
});

proc.on('close', (code) => {
  if (code !== 0) {
    writeFileSync(resultFile, JSON.stringify({
      summary: 'spawn_failed',
      issues: []
    }));
    process.exit(0);
  }

  // Parse the subagent output
  try {
    // The output should contain the JSON response
    const lines = stdout.split('\n');
    let jsonLine = null;
    
    // Look for JSON in the output
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('{') && trimmed.includes('summary')) {
        jsonLine = trimmed;
        break;
      }
    }
    
    if (!jsonLine) {
      // Try to extract from markdown fences
      const match = stdout.match(/```json\s*([\s\S]*?)\s*```/) || 
                   stdout.match(/```\s*([\s\S]*?)\s*```/);
      if (match) {
        jsonLine = match[1].trim();
      }
    }
    
    if (!jsonLine) {
      // Last resort: try to find any JSON object
      const objMatch = stdout.match(/\{[\s\S]*"summary"[\s\S]*\}/);
      if (objMatch) {
        jsonLine = objMatch[0];
      }
    }
    
    if (jsonLine) {
      const result = JSON.parse(jsonLine);
      writeFileSync(resultFile, JSON.stringify(result));
    } else {
      writeFileSync(resultFile, JSON.stringify({
        summary: 'no_json_found',
        issues: []
      }));
    }
  } catch (error) {
    writeFileSync(resultFile, JSON.stringify({
      summary: 'parse_error',
      issues: []
    }));
  }
});
SPAWN_EOF

chmod +x "$SPAWN_SCRIPT"
node "$SPAWN_SCRIPT" "$PROMPT_FILE" "$RESULT_FILE"
rm -f "$SPAWN_SCRIPT"
