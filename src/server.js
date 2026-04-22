import http from 'node:http';
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
  repoMatchesTarget,
  summarizeFilesForPrompt,
  verifySignature,
  writeJson,
} from './lib.js';

const config = getConfig();
const stateFile = path.join(config.stateDir, 'processed-events.json');
await ensureDir(config.stateDir);

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/healthz') {
      return json(res, 200, { ok: true, repo: config.repoFullName, mode: config.mode });
    }

    if (config.mode !== 'webhook') {
      return json(res, 404, { error: 'not_found' });
    }

    if (req.method !== 'POST' || req.url !== '/github/webhook') {
      return json(res, 404, { error: 'not_found' });
    }

    const bodyBuffer = await readBody(req);
    const signatureHeader = req.headers['x-hub-signature-256'];
    const event = req.headers['x-github-event'];

    if (!verifySignature({ bodyBuffer, signatureHeader, secret: config.webhookSecret })) {
      return json(res, 401, { error: 'invalid_signature' });
    }

    const payload = JSON.parse(bodyBuffer.toString('utf8'));
    const result = await processWebhookPayload(payload, event);
    return json(res, result.status, result.body);
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: error.message });
  }
});

server.listen(config.port, '0.0.0.0', () => {
  console.log(`pr-review-agent listening on :${config.port} mode=${config.mode}`);
});

if (config.mode === 'poll') {
  startPollLoop();
}

async function startPollLoop() {
  console.log(`poll loop started, interval=${config.pollIntervalMs}ms`);
  await pollOnce();
  setInterval(() => {
    pollOnce().catch((error) => {
      console.error('poll iteration failed', error);
    });
  }, config.pollIntervalMs);
}

async function pollOnce() {
  const repository = await fetchRepository(config, config.repoFullName);
  const pulls = await listOpenPullRequests(config, config.repoFullName);

  for (const pr of pulls) {
    if (pr.draft) {
      continue;
    }

    await processPullRequest({ repository, pr });
  }
}

async function processWebhookPayload(payload, event) {
  if (event !== 'pull_request') {
    return { status: 202, body: { ignored: true, reason: 'unsupported_event' } };
  }

  const action = payload.action;
  if (!['opened', 'reopened', 'synchronize', 'ready_for_review'].includes(action)) {
    return { status: 202, body: { ignored: true, reason: `ignored_action:${action}` } };
  }

  if (!repoMatchesTarget(payload.repository?.full_name, config.repoFullName)) {
    return { status: 202, body: { ignored: true, reason: 'repo_mismatch' } };
  }

  const pr = payload.pull_request;
  if (!pr || pr.draft) {
    return { status: 202, body: { ignored: true, reason: 'draft_or_missing_pr' } };
  }

  const outcome = await processPullRequest({ repository: payload.repository, pr });
  return { status: 200, body: outcome };
}

async function processPullRequest({ repository, pr }) {
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

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
