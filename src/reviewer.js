import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';

const execFileAsync = promisify(execFile);

export async function runReviewWithAgent({ prompt, cwd }) {
  // Use openclaw agent CLI with a unique ephemeral session to avoid lock conflicts
  const sessionId = `pr-review-${randomBytes(8).toString('hex')}`;
  
  const reviewPrompt = [
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

  try {
    const { stdout, stderr } = await execFileAsync('openclaw', [
      'agent',
      '--session-id', sessionId,
      '--json',
      '--thinking', 'off',
      '--timeout', '120',
      '--message', reviewPrompt,
    ], {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      env: process.env,
      timeout: 130000,
    });

    const raw = String(stdout || '').trim();
    if (!raw) {
      throw new Error(`Agent returned empty output${stderr ? `: ${stderr}` : ''}`);
    }

    let parsedCli;
    try {
      parsedCli = JSON.parse(raw);
    } catch {
      throw new Error(`Agent CLI returned non-JSON: ${raw.slice(0, 500)}`);
    }

    const reply = parsedCli.reply || parsedCli.message || parsedCli.output || parsedCli.text || '';
    if (!reply) {
      throw new Error('Agent returned no reply text');
    }

    // Extract JSON from reply (might have markdown fences)
    const jsonMatch = reply.match(/```json\s*([\s\S]*?)\s*```/) || 
                     reply.match(/```\s*([\s\S]*?)\s*```/) ||
                     [null, reply];
    
    const jsonText = (jsonMatch[1] || reply).trim();
    
    try {
      return JSON.parse(jsonText);
    } catch {
      // Try to extract just the JSON object
      const objectMatch = jsonText.match(/\{[\s\S]*\}/);
      if (objectMatch) {
        return JSON.parse(objectMatch[0]);
      }
      throw new Error(`Could not parse JSON from reply: ${jsonText.slice(0, 500)}`);
    }
  } catch (error) {
    console.error('Agent review failed:', error);
    // Fallback to no_issue on error
    return {
      summary: `Review failed: ${error.message}`,
      issues: [],
    };
  }
}
