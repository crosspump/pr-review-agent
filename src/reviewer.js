import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function runReviewWithAgent({ prompt, cwd }) {
  const wrapper = [
    'You are reviewing a GitHub pull request diff.',
    'Return valid JSON only, with no markdown fences or extra commentary.',
    'Use exactly this schema:',
    '{"summary":"一句话总结","issues":[{"file":"文件路径","severity":"low|medium|high|critical","title":"问题标题","reason":"问题原因","suggestion":"修改建议"}]}',
    'Only report meaningful issues involving bugs, security, Web3 risks, or missing tests around critical logic.',
    'Do not give style-only feedback.',
    'If no obvious problem exists, return {"summary":"no_issue","issues":[]}.',
    '',
    prompt,
  ].join('\n');

  const { stdout, stderr } = await execFileAsync('openclaw', [
    'agent',
    '--local',
    '--agent', 'main',
    '--session-id', 'pr-review-agent',
    '--json',
    '--thinking', 'off',
    '--message', wrapper,
  ], {
    cwd,
    maxBuffer: 8 * 1024 * 1024,
    env: process.env,
  });

  const raw = String(stdout || '').trim();
  if (!raw) {
    throw new Error(`Agent review returned empty output${stderr ? `: ${stderr}` : ''}`);
  }

  let parsedCli;
  try {
    parsedCli = JSON.parse(raw);
  } catch {
    throw new Error(`OpenClaw agent CLI returned non-JSON output: ${raw.slice(0, 500)}`);
  }

  const text = extractAgentText(parsedCli).trim();
  if (!text) {
    throw new Error(`Agent review returned no message text${stderr ? `: ${stderr}` : ''}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Agent review did not return valid JSON: ${text.slice(0, 500)}`);
  }
}

function extractAgentText(payload) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  if (typeof payload.reply === 'string' && payload.reply.trim()) {
    return payload.reply;
  }

  if (typeof payload.message === 'string' && payload.message.trim()) {
    return payload.message;
  }

  if (typeof payload.output === 'string' && payload.output.trim()) {
    return payload.output;
  }

  if (typeof payload.text === 'string' && payload.text.trim()) {
    return payload.text;
  }

  if (payload.result && typeof payload.result === 'object') {
    return extractAgentText(payload.result);
  }

  return '';
}
