import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeChunkDeep,
  extractReviewJson,
  generateDeepReviewReport,
  resolveReviewerBackend,
  runReviewWithAgent,
} from './src/reviewer.js';

test('extractReviewJson parses direct JSON', () => {
  const raw = '{"summary":"no_issue","issues":[]}';
  const out = extractReviewJson(raw);
  assert.equal(out.summary, 'no_issue');
  assert.deepEqual(out.issues, []);
});

test('extractReviewJson parses fenced JSON', () => {
  const raw = '```json\n{"summary":"ok","issues":[]}\n```';
  const out = extractReviewJson(raw);
  assert.equal(out.summary, 'ok');
});

test('extractReviewJson parses wrapper JSON from cli output', () => {
  const raw = JSON.stringify({
    output: '```json\n{"summary":"发现 1 个潜在问题","issues":[{"file":"src/a.js","severity":"high","title":"t","reason":"r","suggestion":"s"}]}\n```',
  });
  const out = extractReviewJson(raw);
  assert.equal(out.issues.length, 1);
  assert.equal(out.issues[0].severity, 'high');
});

test('extractReviewJson handles diagnostic preamble + outputs array', () => {
  const payload = {
    ok: true,
    outputs: [{ text: '{"summary":"no_issue","issues":[]}' }],
  };
  const raw = '[diagnostic] something\n' + JSON.stringify(payload, null, 2);
  const out = extractReviewJson(raw);
  assert.equal(out.summary, 'no_issue');
});

test('runReviewWithAgent in heuristic mode flags risky approve pattern without model key', async () => {
  const oldBackend = process.env.REVIEWER_BACKEND;
  delete process.env.OPENAI_API_KEY;
  process.env.REVIEWER_BACKEND = 'heuristic';

  const prompt = [
    'Repository:',
    '{"full_name":"cryptosunshine/dapp-builder"}',
    '',
    'Pull Request:',
    '{"number":2,"title":"test","head":"feature","base":"main"}',
    '',
    'Changed files:',
    '[]',
    '',
    'Unified diff excerpt:',
    'diff --git a/src/token.ts b/src/token.ts',
    '+await token.approve(spender, amount);',
  ].join('\n');

  const out = await runReviewWithAgent({ prompt, cwd: process.cwd() });

  if (oldBackend === undefined) {
    delete process.env.REVIEWER_BACKEND;
  } else {
    process.env.REVIEWER_BACKEND = oldBackend;
  }

  assert.ok(out.issues.length >= 1);
  assert.equal(out.issues[0].severity, 'high');
  assert.equal(typeof out.reportMarkdown, 'string');
  assert.match(out.reportMarkdown, /PR Deep Review Report/);
});

test('analyzeChunkDeep catches secret-like literal', () => {
  const chunk = [
    'diff --git a/src/config.ts b/src/config.ts',
    '+const PRIVATE_KEY = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";',
  ].join('\n');

  const out = analyzeChunkDeep(chunk);
  assert.ok(out.issues.some((i) => i.title.includes('硬编码密钥')));
});

test('generateDeepReviewReport renders recommendation section', () => {
  const report = generateDeepReviewReport({
    prompt: [
      'Repository:',
      '{"full_name":"cryptosunshine/dapp-builder"}',
      '',
      'Pull Request:',
      '{"number":5,"title":"abc","head":"feat","base":"main"}',
      '',
      'Changed files:',
      '[]',
      '',
      'Unified diff excerpt:',
      'diff --git a/a b/a',
    ].join('\n'),
    summary: '发现 1 个问题，包含高危风险',
    backend: 'heuristic',
    issues: [{
      file: 'src/a.ts',
      severity: 'high',
      title: 't',
      reason: 'r',
      suggestion: 's',
    }],
    analyses: [{
      hasCriticalLogicChange: true,
      hasTestChange: false,
      files: [{ file: 'src/a.ts', added: 10, removed: 2, flags: ['auth-sensitive'] }],
    }],
  });

  assert.match(report, /Recommended Next Actions/);
  assert.match(report, /Repository: cryptosunshine\/dapp-builder/);
});

test('resolveReviewerBackend supports hermes and auto->hermes', () => {
  const old = process.env.REVIEWER_BACKEND;
  const oldOpenai = process.env.OPENAI_API_KEY;
  const oldOpenrouter = process.env.OPENROUTER_API_KEY;

  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;

  process.env.REVIEWER_BACKEND = 'hermes';
  assert.equal(resolveReviewerBackend(), 'hermes');

  process.env.REVIEWER_BACKEND = 'auto';
  assert.equal(resolveReviewerBackend(), 'hermes');

  if (old === undefined) delete process.env.REVIEWER_BACKEND;
  else process.env.REVIEWER_BACKEND = old;

  if (oldOpenai === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = oldOpenai;

  if (oldOpenrouter === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = oldOpenrouter;
});
