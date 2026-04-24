import path from 'node:path';
import { writeFile } from 'node:fs/promises';

import {
  fetchPullRequestFiles,
  fetchRepository,
  listOpenPullRequests,
  postIssueComment,
  postPullRequestReview,
} from './github.js';
import { runReviewWithAgent } from './reviewer.js';
import {
  buildCommentBody,
  buildDedupeKey,
  buildReviewPrompt,
  ensureDir,
  getConfig,
  normalizeReviewResult,
  readJson,
  summarizeFilesForPrompt,
  writeJson,
} from './lib.js';

const config = getConfig();
const stateFile = path.join(config.stateDir, 'processed-events.json');
await ensureDir(config.stateDir);

export async function pollOnce() {
  const repository = await fetchRepository(config, config.repoFullName);
  const pulls = await listOpenPullRequests(config, config.repoFullName);

  const results = [];
  for (const pr of pulls) {
    if (pr.draft) {
      continue;
    }

    results.push(await processPullRequest({ repository, pr }));
  }

  return results;
}

export function shouldFallbackToIssueComment(error) {
  const msg = String(error?.message || '');

  const isPermission403 = msg.includes('GitHub API 403')
    && msg.includes('Resource not accessible by personal access token');

  const hasPendingReview422 = msg.includes('GitHub API 422')
    && msg.includes('User can only have one pending review per pull request');

  return isPermission403 || hasPendingReview422;
}

export function isPostingPermissionError(error) {
  const msg = String(error?.message || '');
  return msg.includes('GitHub API 403')
    && msg.includes('Resource not accessible by personal access token');
}

export async function processPullRequest({ repository, pr }) {
  const processed = await readJson(stateFile, { keys: {} });
  const dedupeKey = buildDedupeKey({
    repoFullName: repository.full_name,
    prNumber: pr.number,
    headSha: pr.head?.sha,
  });

  if (processed.keys[dedupeKey]) {
    return { ok: true, ignored: true, reason: 'already_processed' };
  }

  const files = await fetchPullRequestFiles(config, repository.full_name, pr.number);
  const { files: promptFiles, diffText } = summarizeFilesForPrompt(files, config.maxPatchChars);
  const prompt = buildReviewPrompt({
    repository,
    pr,
    files: promptFiles,
    diffText,
    reviewLanguage: config.reviewLanguage,
  });

  const rawReview = await runReviewWithAgent({
    prompt,
    cwd: process.cwd(),
  });

  const review = normalizeReviewResult(rawReview);

  if (review.reportMarkdown) {
    const reportDir = path.join(config.stateDir, 'reports');
    await ensureDir(reportDir);
    const shortSha = String(pr.head?.sha || 'unknown').slice(0, 12);
    const reportPath = path.join(reportDir, `pr-${pr.number}-${shortSha}.md`);
    await writeFile(reportPath, `${review.reportMarkdown}\n`, 'utf8');
    review.reportPath = reportPath;
  }
  const isReviewFailed = review.summary.startsWith('Review failed:');
  if (isReviewFailed) {
    console.error(`AI deep review failed for PR #${pr.number} sha=${pr.head?.sha}: ${review.summary}`);
    return {
      ok: false,
      retriable: true,
      posted: false,
      issues: 0,
      summary: review.summary,
    };
  }

  const shouldPost = review.issues.length > 0 || config.postNoIssue;

  let didPost = false;

  if (shouldPost && !config.dryRun) {
    const body = buildCommentBody(review);

    // Determine review event based on severity
    let event = 'COMMENT';
    const hasCriticalOrHigh = review.issues.some((i) =>
      i.severity === 'critical' || i.severity === 'high'
    );

    if (hasCriticalOrHigh) {
      event = 'REQUEST_CHANGES';
    } else if (review.issues.length === 0) {
      event = 'APPROVE';
    }

    try {
      await postPullRequestReview(config, repository.full_name, pr.number, {
        body,
        event,
      });
      didPost = true;
    } catch (error) {
      if (!shouldFallbackToIssueComment(error)) {
        throw error;
      }

      console.warn(`review API rejected by token, fallback to issue comment on PR #${pr.number}`);
      try {
        await postIssueComment(config, repository.full_name, pr.number, body);
        didPost = true;
      } catch (commentError) {
        if (!isPostingPermissionError(commentError)) {
          throw commentError;
        }
        console.warn(`comment API also rejected by token on PR #${pr.number}; skip posting`);
      }
    }
  }

  processed.keys[dedupeKey] = {
    at: new Date().toISOString(),
    pr: pr.number,
    sha: pr.head?.sha,
    issues: review.issues.length,
    posted: didPost,
    summary: review.summary,
  };
  await writeJson(stateFile, processed);

  console.log(`processed PR #${pr.number} sha=${pr.head?.sha} issues=${review.issues.length} posted=${didPost}`);

  return {
    ok: true,
    posted: didPost,
    issues: review.issues.length,
    summary: review.summary,
  };
}
