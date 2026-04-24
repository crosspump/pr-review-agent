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

test('runReviewWithAgent calls DeepSeek-compatible chat completions API and parses JSON review', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  const calls = [];

  process.env.REVIEWER_PROVIDER = 'deepseek';
  process.env.REVIEWER_BASE_URL = 'https://api.deepseek.com';
  process.env.REVIEWER_MODEL = 'deepseek-v4-flash';
  process.env.DEEPSEEK_API_KEY = 'test-key';
  process.env.REVIEWER_THINKING = 'true';
  process.env.REVIEWER_REASONING_EFFORT = 'high';

  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: '发现 1 个问题，包含高危风险',
            issues: [{
              file: 'src/app.js',
              severity: 'high',
              title: 'Unsafe transaction handling',
              reason: 'Missing transaction error handling',
              suggestion: 'Add explicit error handling and user feedback',
            }],
          }),
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const result = await runReviewWithAgent({ prompt: 'diff --git a/src/app.js b/src/app.js\n+sendTransaction()' });

    assert.equal(result.summary, '发现 1 个问题，包含高危风险');
    assert.equal(result.issues[0].file, 'src/app.js');
    assert.equal(result.backend, 'deepseek/deepseek-v4-flash');
    assert.equal(typeof result.reportMarkdown, 'string');
    assert.match(result.reportMarkdown, /PR Deep Review Report/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer test-key');

    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.model, 'deepseek-v4-flash');
    assert.deepEqual(body.thinking, { type: 'enabled' });
    assert.equal(body.reasoning_effort, 'high');
    assert.equal(body.stream, false);
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages[1].role, 'user');
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test('runReviewWithAgent reports API failure without heuristic fallback', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  process.env.REVIEWER_PROVIDER = 'deepseek';
  process.env.REVIEWER_BASE_URL = 'https://api.deepseek.com';
  process.env.REVIEWER_MODEL = 'deepseek-v4-flash';
  process.env.DEEPSEEK_API_KEY = 'test-key';

  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), {
    status: 429,
    statusText: 'Too Many Requests',
    headers: { 'content-type': 'application/json' },
  });

  try {
    const result = await runReviewWithAgent({ prompt: 'diff --git a/app.js b/app.js\n+const addr = "0xDEADBEEF";' });

    assert.match(result.summary, /^Review failed: reviewer_api_error:429/);
    assert.deepEqual(result.issues, []);
    assert.equal(result.reportMarkdown, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test('analyzeChunkDeep catches secret-like literal for report signals', () => {
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
    backend: 'deepseek/deepseek-v4-flash',
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

test('resolveReviewerBackend returns configured provider', () => {
  const old = process.env.REVIEWER_PROVIDER;

  process.env.REVIEWER_PROVIDER = 'deepseek';
  assert.equal(resolveReviewerBackend(), 'deepseek');

  if (old === undefined) delete process.env.REVIEWER_PROVIDER;
  else process.env.REVIEWER_PROVIDER = old;
});
