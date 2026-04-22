import path from 'node:path';

import {
  fetchPullRequestFiles,
  fetchRepository,
  listOpenPullRequests,
  postIssueComment,
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
  const shouldPost = review.issues.length > 0 || config.postNoIssue;

  if (shouldPost && !config.dryRun) {
    const body = buildCommentBody(review);
    await postIssueComment(config, repository.full_name, pr.number, body);
  }

  processed.keys[dedupeKey] = {
    at: new Date().toISOString(),
    pr: pr.number,
    sha: pr.head?.sha,
    issues: review.issues.length,
    posted: shouldPost && !config.dryRun,
    summary: review.summary,
  };
  await writeJson(stateFile, processed);

  console.log(`processed PR #${pr.number} sha=${pr.head?.sha} issues=${review.issues.length} posted=${shouldPost && !config.dryRun}`);

  return {
    ok: true,
    posted: shouldPost && !config.dryRun,
    issues: review.issues.length,
    summary: review.summary,
  };
}
