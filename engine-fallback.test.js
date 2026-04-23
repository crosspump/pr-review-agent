import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GITHUB_REPO = process.env.GITHUB_REPO || 'cryptosunshine/dapp-builder';

const { shouldFallbackToIssueComment, isPostingPermissionError } = await import('./src/engine.js');

test('shouldFallbackToIssueComment detects PAT permission denial on review API', () => {
  const error = new Error('GitHub API 403 Forbidden: {"message":"Resource not accessible by personal access token"}');
  assert.equal(shouldFallbackToIssueComment(error), true);
});

test('shouldFallbackToIssueComment ignores non-permission errors', () => {
  const error = new Error('GitHub API 422 Unprocessable Entity');
  assert.equal(shouldFallbackToIssueComment(error), false);
});

test('shouldFallbackToIssueComment detects pending review conflict', () => {
  const error = new Error('GitHub API 422 Unprocessable Entity: {"errors":["User can only have one pending review per pull request"]}');
  assert.equal(shouldFallbackToIssueComment(error), true);
});

test('isPostingPermissionError detects comment/review permission denial', () => {
  const error = new Error('GitHub API 403 Forbidden: {"message":"Resource not accessible by personal access token"}');
  assert.equal(isPostingPermissionError(error), true);
});
