import http from 'node:http';

import { pollOnce, processPullRequest } from './engine.js';
import { getConfig, repoMatchesTarget, verifySignature } from './lib.js';

const config = getConfig();

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
