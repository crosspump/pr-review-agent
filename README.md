# PR Review Agent

Poll-driven GitHub PR review agent for `cryptosunshine/dapp-builder`.

## What it does

- Polls GitHub for open pull requests on a fixed interval
- Detects new PR heads by `repo#pr@headSha`
- Pulls changed files from GitHub
- Sends a focused review prompt to the reviewer model
- Normalizes the result to strict JSON
- Posts the JSON result back to the PR as an issue comment
- Deduplicates processed PR heads in `.state/processed-events.json`

## Output contract

The agent asks the model to return JSON in this exact shape:

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

- Node.js 20+
- A GitHub token with permission to read PRs and create PR comments
- An OpenAI-compatible API key for the reviewer model

## Setup

```bash
cp .env.example .env
```

Fill in:

- `GITHUB_TOKEN`
- `OPENAI_API_KEY`

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

## Notes

- `GITHUB_TOKEN` is required even for a public repo, because posting PR comments needs authentication.
- By default the agent does not post `no_issue` comments. Set `POST_NO_ISSUE=true` if you want those posted too.
- The review language is `auto` by default and should follow the dominant language inferred from the diff/context.
- Webhook support is still present in code and can be re-enabled later by setting `MODE=webhook` and configuring a public callback URL.
