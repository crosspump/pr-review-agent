# PR Review Agent

Poll-driven GitHub PR review agent for `cryptosunshine/dapp-builder`.

## What it does

- Polls GitHub for open pull requests on a fixed interval
- Detects new PR heads by `repo#pr@headSha`
- Pulls changed files from GitHub
- Calls an OpenAI-compatible reviewer API directly (first configured provider: DeepSeek)
- Requires AI review success; there is no hardcoded heuristic fallback
- Normalizes the result to strict JSON
- Posts the JSON result back to the PR as a GitHub PR review
- Deduplicates processed PR heads in `.state/processed-events.json`

## Output contract

The reviewer API must return JSON in this exact shape:

```json
{
  "summary": "一句话总结",
  "issues": [
    {
      "file": "文件路径",
      "severity": "low|medium|high|critical",
      "title": "问题标题",
      "reason": "问题原因",
      "suggestion": "修改建议"
    }
  ]
}
```

If there is no obvious issue, the expected result is:

```json
{
  "summary": "no_issue",
  "issues": []
}
```

## Requirements

- Node.js 20+ (Node 22 recommended)
- A GitHub token with permission to read PRs and create PR reviews/comments
- A reviewer API key (for DeepSeek: `DEEPSEEK_API_KEY`)

## Setup

```bash
cp .env.example .env
```

Fill in:

- `GITHUB_TOKEN`
- `DEEPSEEK_API_KEY` (or `REVIEWER_API_KEY` for another compatible provider)

Default reviewer settings:

```env
REVIEWER_PROVIDER=deepseek
REVIEWER_BASE_URL=https://api.deepseek.com
REVIEWER_MODEL=deepseek-v4-flash
DEEPSEEK_API_KEY=replace_me
REVIEWER_THINKING=true
REVIEWER_REASONING_EFFORT=high
```

## Run

```bash
set -a
source .env
set +a
npm start
```

Health check:

```bash
curl http://127.0.0.1:8787/healthz
```

## Poll behavior

Default interval is 5 minutes:

```env
POLL_INTERVAL_MS=300000
```

Each loop:

- lists open PRs
- skips drafts
- checks whether the current PR head SHA has already been reviewed
- reviews only unseen heads
- posts review JSON only when issues are found, unless `POST_NO_ISSUE=true`
- does not mark a head SHA as processed if AI review fails, so the next poll can retry

## Notes

- `GITHUB_TOKEN` is required even for a public repo, because posting PR reviews/comments needs authentication.
- By default the agent does not post `no_issue` comments. Set `POST_NO_ISSUE=true` if you want those posted too.
- The review language is `auto` by default and should follow the dominant language inferred from the diff/context.
- Webhook support is still present in code and can be re-enabled later by setting `MODE=webhook` and configuring a public callback URL.
- Reviewer APIs are intentionally isolated behind `REVIEWER_PROVIDER`, `REVIEWER_BASE_URL`, `REVIEWER_MODEL`, and `REVIEWER_API_KEY` so more providers can be added later.
