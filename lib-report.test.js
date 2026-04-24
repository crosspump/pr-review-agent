import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCommentBody, normalizeReviewResult } from './src/lib.js';

test('normalizeReviewResult preserves report and recommendation fields', () => {
  const out = normalizeReviewResult({
    summary: '发现问题',
    issues: [],
    reportMarkdown: '# report',
    reportPath: '/tmp/r.md',
    backend: 'heuristic',
    chunksReviewed: 3,
    recommendations: ['do A', 'do B'],
  });

  assert.equal(out.reportMarkdown, '# report');
  assert.equal(out.reportPath, '/tmp/r.md');
  assert.equal(out.backend, 'heuristic');
  assert.equal(out.chunksReviewed, 3);
  assert.equal(out.recommendations.length, 2);
});

test('buildCommentBody renders meta and recommendations', () => {
  const body = buildCommentBody({
    summary: '发现 1 个问题，包含高危风险',
    backend: 'heuristic',
    chunksReviewed: 3,
    reportPath: '/root/pr-review-agent/.state/reports/pr-2-abc.md',
    issues: [{
      file: 'src/a.ts',
      severity: 'high',
      title: '示例问题',
      reason: '原因',
      suggestion: '建议',
    }],
    recommendations: ['补充测试', '增加权限校验'],
  });

  assert.match(body, /Review Meta/);
  assert.match(body, /Backend: `heuristic`/);
  assert.match(body, /Recommended Next Actions/);
});

test('buildCommentBody makes no-issue approvals explicit', () => {
  const body = buildCommentBody({
    summary: 'no_issue',
    backend: 'deepseek/deepseek-v4-flash',
    chunksReviewed: 1,
    reportPath: '.state/reports/pr-4-abc.md',
    issues: [],
    recommendations: [],
  });

  assert.match(body, /Review Summary/);
  assert.match(body, /No blocking issues found/);
  assert.match(body, /Issues Found \(0\)/);
});
