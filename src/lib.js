import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_MAX_PATCH_CHARS = 120000;
const DEFAULT_MAX_FILES = 30;
const DEFAULT_POLL_INTERVAL_MS = 300000;
const REVIEW_PROMPT_VERSION = 'v1';

export function getConfig() {
  const config = {
    port: Number(process.env.PORT || 8787),
    mode: process.env.MODE || 'poll',
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET || '',
    githubToken: process.env.GITHUB_TOKEN || '',
    githubApiBase: process.env.GITHUB_API_BASE || 'https://api.github.com',
    repoFullName: process.env.GITHUB_REPO || '',
    reviewLanguage: process.env.REVIEW_LANGUAGE || 'auto',
    ...getReviewerConfig(),
    maxPatchChars: Number(process.env.MAX_PATCH_CHARS || DEFAULT_MAX_PATCH_CHARS),
    maxFiles: Number(process.env.MAX_FILES || DEFAULT_MAX_FILES),
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || DEFAULT_POLL_INTERVAL_MS),
    stateDir: process.env.STATE_DIR || path.resolve(process.cwd(), '.state'),
    postNoIssue: (process.env.POST_NO_ISSUE || 'false').toLowerCase() === 'true',
    dryRun: (process.env.DRY_RUN || 'false').toLowerCase() === 'true',
  };

  if (!config.repoFullName) {
    throw new Error('Missing GITHUB_REPO, expected owner/repo');
  }

  return config;
}

export function getReviewerConfig() {
  return {
    reviewerProvider: process.env.REVIEWER_PROVIDER || 'deepseek',
    reviewerBaseUrl: process.env.REVIEWER_BASE_URL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    reviewerModel: process.env.REVIEWER_MODEL || 'deepseek-v4-flash',
    reviewerApiKey: process.env.REVIEWER_API_KEY || process.env.DEEPSEEK_API_KEY || '',
    reviewerThinking: (process.env.REVIEWER_THINKING || 'true').toLowerCase() === 'true',
    reviewerReasoningEffort: process.env.REVIEWER_REASONING_EFFORT || 'high',
  };
}

export function verifySignature({ bodyBuffer, signatureHeader, secret }) {
  if (!secret) {
    return true;
  }

  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(bodyBuffer)
    .digest('hex');

  const actual = signatureHeader.slice('sha256='.length);
  const expectedBuffer = Buffer.from(expected, 'hex');
  const actualBuffer = Buffer.from(actual, 'hex');

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

export async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function repoMatchesTarget(payloadRepoFullName, targetRepoFullName) {
  return String(payloadRepoFullName || '').toLowerCase() === String(targetRepoFullName || '').toLowerCase();
}

export function normalizeReviewResult(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return {
      summary: 'Invalid review payload',
      issues: [],
    };
  }

  const summary = typeof parsed.summary === 'string' && parsed.summary.trim()
    ? parsed.summary.trim()
    : 'No summary provided';

  const issues = Array.isArray(parsed.issues)
    ? parsed.issues
        .filter((issue) => issue && typeof issue === 'object')
        .map((issue) => ({
          file: typeof issue.file === 'string' ? issue.file : 'unknown',
          severity: normalizeSeverity(issue.severity),
          title: typeof issue.title === 'string' ? issue.title : 'Untitled issue',
          reason: typeof issue.reason === 'string' ? issue.reason : 'No reason provided',
          suggestion: typeof issue.suggestion === 'string' ? issue.suggestion : 'No suggestion provided',
        }))
    : [];

  const reportMarkdown = typeof parsed.reportMarkdown === 'string' ? parsed.reportMarkdown : '';
  const reportPath = typeof parsed.reportPath === 'string' ? parsed.reportPath : '';
  const backend = typeof parsed.backend === 'string' ? parsed.backend : '';
  const chunksReviewed = Number.isFinite(Number(parsed.chunksReviewed)) ? Number(parsed.chunksReviewed) : 0;

  const recommendations = Array.isArray(parsed.recommendations)
    ? parsed.recommendations
      .filter((item) => typeof item === 'string' && item.trim())
      .map((item) => item.trim())
    : [];

  return {
    summary,
    issues,
    reportMarkdown,
    reportPath,
    recommendations,
    backend,
    chunksReviewed,
  };
}

function normalizeSeverity(value) {
  const severity = String(value || '').toLowerCase();
  if (['low', 'medium', 'high', 'critical'].includes(severity)) {
    return severity;
  }
  return 'medium';
}

export function buildReviewPrompt({ repository, pr, files, diffText, reviewLanguage }) {
  return [
    'You are a senior GitHub Pull Request review agent.',
    'Review only for meaningful issues. Avoid style-only feedback and avoid noisy comments.',
    'Focus on: potential bugs, security, Web3 risks (chainId, contract call safety, approve/allowance, transaction logic), and missing tests around critical logic.',
    'If uncertain, say so using words equivalent to possible/uncertain in the chosen language.',
    'If there is no obvious issue, return summary=no_issue and issues=[].',
    'Output valid JSON only, with this exact schema:',
    '{"summary":"...","issues":[{"file":"...","severity":"low|medium|high|critical","title":"...","reason":"...","suggestion":"..."}]}',
    `Preferred response language: ${reviewLanguage}. If reviewLanguage=auto, infer from the diff/comments and use the dominant natural language.` ,
    `Prompt version: ${REVIEW_PROMPT_VERSION}`,
    '',
    'Repository:',
    JSON.stringify({
      full_name: repository.full_name,
      default_branch: repository.default_branch,
      language: repository.language,
    }, null, 2),
    '',
    'Pull Request:',
    JSON.stringify({
      number: pr.number,
      title: pr.title,
      body: pr.body,
      head: pr.head?.ref,
      base: pr.base?.ref,
      additions: pr.additions,
      deletions: pr.deletions,
      changed_files: pr.changed_files,
    }, null, 2),
    '',
    'Changed files:',
    JSON.stringify(files.map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      patch_truncated: Boolean(file.patch_truncated),
    })), null, 2),
    '',
    'Unified diff excerpt:',
    diffText,
  ].join('\n');
}

export function summarizeFilesForPrompt(files, maxPatchChars) {
  let consumed = 0;
  const picked = [];

  for (const file of files) {
    const patch = typeof file.patch === 'string' ? file.patch : '';
    const remaining = Math.max(0, maxPatchChars - consumed);
    if (remaining <= 0) {
      picked.push({ ...file, patch: '', patch_truncated: Boolean(patch) });
      continue;
    }

    const clippedPatch = patch.slice(0, remaining);
    consumed += clippedPatch.length;
    picked.push({
      ...file,
      patch: clippedPatch,
      patch_truncated: clippedPatch.length < patch.length,
    });
  }

  const diffText = picked
    .map((file) => {
      const header = `diff --git a/${file.filename} b/${file.filename}`;
      const patch = file.patch || '# patch unavailable';
      return `${header}\n${patch}`;
    })
    .join('\n\n');

  return { files: picked, diffText };
}

export function buildCommentBody(review) {
  const lines = [];

  // Summary section
  if (review.summary && review.summary !== 'no_issue') {
    lines.push('## 📋 Review Summary');
    lines.push('');
    lines.push(review.summary);
    lines.push('');
  }

  if (review.backend || review.chunksReviewed) {
    lines.push('## ⚙️ Review Meta');
    lines.push('');
    if (review.backend) {
      lines.push(`- Backend: \`${review.backend}\``);
    }
    if (review.chunksReviewed) {
      lines.push(`- Chunks reviewed: ${review.chunksReviewed}`);
    }
    if (review.reportPath) {
      lines.push(`- Deep report (local): \`${review.reportPath}\``);
    }
    lines.push('');
  }

  // Issues section
  if (review.issues && review.issues.length > 0) {
    lines.push(`## 🔍 Issues Found (${review.issues.length})`);
    lines.push('');

    // Group by severity
    const bySeverity = {
      critical: [],
      high: [],
      medium: [],
      low: [],
    };

    for (const issue of review.issues) {
      const severity = issue.severity || 'medium';
      if (bySeverity[severity]) {
        bySeverity[severity].push(issue);
      }
    }

    // Render by severity
    const severityOrder = ['critical', 'high', 'medium', 'low'];
    const severityEmoji = {
      critical: '🚨',
      high: '⚠️',
      medium: '💡',
      low: 'ℹ️',
    };

    for (const severity of severityOrder) {
      const issues = bySeverity[severity];
      if (issues.length === 0) continue;

      lines.push(`### ${severityEmoji[severity]} ${severity.toUpperCase()}`);
      lines.push('');

      for (const issue of issues) {
        lines.push(`**${issue.title}**`);
        lines.push(`- 📁 File: \`${issue.file}\``);
        lines.push(`- 📝 Reason: ${issue.reason}`);
        lines.push(`- 💡 Suggestion: ${issue.suggestion}`);
        lines.push('');
      }
    }
  }

  if (Array.isArray(review.recommendations) && review.recommendations.length > 0) {
    lines.push('## ✅ Recommended Next Actions');
    lines.push('');
    for (const rec of review.recommendations.slice(0, 8)) {
      lines.push(`- ${rec}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('_🤖 Automated deep review by PR Agent_');

  return lines.join('\n');
}

export function buildDedupeKey({ repoFullName, prNumber, headSha }) {
  return `${repoFullName}#${prNumber}@${headSha}`;
}
