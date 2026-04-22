import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function runReviewWithAgent({ prompt, cwd }) {
  const wrapper = [
    'You are reviewing a GitHub pull request diff.',
    'Return valid JSON only.',
    'Use exactly this schema:',
    '{"summary":"一句话总结","issues":[{"file":"文件路径","severity":"low|medium|high|critical","title":"问题标题","reason":"问题原因","suggestion":"修改建议"}]}',
    'Only report meaningful issues involving bugs, security, Web3 risks, or missing tests around critical logic.',
    'Do not give style-only feedback.',
    'If no obvious problem exists, return {"summary":"no_issue","issues":[]}.',
    '',
    prompt,
  ].join('\n');

  const { stdout, stderr } = await execFileAsync('openclaw', [
    'run',
    '--model', 'openai/gpt-5.4',
    '--output-last-message',
    wrapper,
  ], {
    cwd,
    maxBuffer: 8 * 1024 * 1024,
    env: process.env,
  });

  const text = String(stdout || '').trim();
  if (!text) {
    throw new Error(`Agent review returned empty output${stderr ? `: ${stderr}` : ''}`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Agent review did not return valid JSON: ${text.slice(0, 500)}`);
  }
}
