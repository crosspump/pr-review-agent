import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  buildDedupeKey,
  normalizeReviewResult,
  summarizeFilesForPrompt,
  verifySignature,
} from './src/lib.js';

test('normalizeReviewResult sanitizes payload', () => {
  const result = normalizeReviewResult({
    summary: 'looks risky',
    issues: [{
      file: 'src/a.js',
      severity: 'HIGH',
      title: 'Unsafe call',
      reason: 'can revert',
      suggestion: 'check input',
    }],
  });

  assert.equal(result.summary, 'looks risky');
  assert.equal(result.issues[0].severity, 'high');
});

test('summarizeFilesForPrompt truncates large patches', () => {
  const { files, diffText } = summarizeFilesForPrompt([
    { filename: 'a.js', patch: 'x'.repeat(20) },
  ], 5);

  assert.equal(files[0].patch.length, 5);
  assert.equal(files[0].patch_truncated, true);
  assert.match(diffText, /diff --git a\/a.js b\/a.js/);
});

test('buildDedupeKey is stable', () => {
  assert.equal(buildDedupeKey({ repoFullName: 'a/b', prNumber: 7, headSha: 'abc' }), 'a/b#7@abc');
});

test('verifySignature accepts valid sha256 signature', () => {
  const body = Buffer.from('{"ok":true}');
  const secret = 'topsecret';
  const digest = crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(verifySignature({ bodyBuffer: body, signatureHeader: `sha256=${digest}`, secret }), true);
});
