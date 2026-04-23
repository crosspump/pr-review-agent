import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const MAX_RECOMMENDATIONS = 8;

export async function runReviewWithAgent({ prompt, cwd }) {
  try {
    const chunks = splitIntoChunks(prompt, 10000);
    console.log(`Reviewing ${chunks.length} chunks (testing with first 3)...`);

    // Keep current behavior: review first 3 chunks only.
    const chunksToReview = chunks.slice(0, 3);
    const chunkResults = [];
    const backend = resolveReviewerBackend();

    for (let i = 0; i < chunksToReview.length; i++) {
      const chunk = chunksToReview[i];
      console.log(`Reviewing chunk ${i + 1}/${chunksToReview.length} backend=${backend}...`);

      const result = await reviewChunk({
        chunk,
        chunkNum: i + 1,
        totalChunks: chunksToReview.length,
        cwd,
        backend,
      });
      chunkResults.push(result);
    }

    const allIssues = chunkResults.flatMap((r) => r.issues || []);

    // Deduplicate issues by file+title
    const uniqueIssues = [];
    const seen = new Set();
    for (const issue of allIssues) {
      const key = `${issue.file}:${issue.title}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueIssues.push(issue);
      }
    }

    let summary;
    if (uniqueIssues.length === 0) {
      summary = 'no_issue';
    } else if (uniqueIssues.some((i) => i.severity === 'critical' || i.severity === 'high')) {
      summary = `发现 ${uniqueIssues.length} 个问题，包含高危风险`;
    } else {
      summary = `发现 ${uniqueIssues.length} 个潜在问题`;
    }

    const analyses = chunkResults.map((r) => r.analysis).filter(Boolean);
    const reportMarkdown = generateDeepReviewReport({
      prompt,
      summary,
      issues: uniqueIssues,
      analyses,
      backend,
    });

    const recommendations = buildRecommendations(analyses, uniqueIssues);

    return {
      summary,
      issues: uniqueIssues,
      reportMarkdown,
      recommendations,
      backend,
      chunksReviewed: chunksToReview.length,
    };
  } catch (error) {
    console.error('Chunked review failed:', error);
    return {
      summary: `Review failed: ${error.message}`,
      issues: [],
    };
  }
}

export function resolveReviewerBackend() {
  const configured = String(process.env.REVIEWER_BACKEND || 'hermes').toLowerCase();

  if (configured === 'auto') {
    if (process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY) {
      return 'openclaw';
    }
    return 'hermes';
  }

  if (configured === 'openclaw' || configured === 'heuristic' || configured === 'hermes') {
    return configured;
  }

  return 'hermes';
}

function splitIntoChunks(text, maxChunkSize) {
  const chunks = [];
  let currentChunk = '';

  const fileDiffs = text.split(/(?=diff --git)/);

  for (const fileDiff of fileDiffs) {
    if (currentChunk.length + fileDiff.length > maxChunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = fileDiff;
    } else {
      currentChunk += fileDiff;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

async function reviewChunk({ chunk, chunkNum, totalChunks, cwd, backend }) {
  if (backend === 'heuristic') {
    return reviewChunkHeuristic(chunk);
  }

  try {
    if (backend === 'hermes') {
      const hermesResult = await reviewChunkWithHermesAgent({ chunk, chunkNum, totalChunks, cwd });
      const analysis = analyzeChunkDeep(chunk);
      return {
        ...hermesResult,
        analysis,
      };
    }

    const aiResult = await reviewChunkWithOpenClawInfer({ chunk, chunkNum, totalChunks, cwd });
    const analysis = analyzeChunkDeep(chunk);
    return {
      ...aiResult,
      analysis,
    };
  } catch (error) {
    const shouldFallback = String(process.env.REVIEWER_FALLBACK_HEURISTIC || 'true').toLowerCase() !== 'false';
    if (shouldFallback) {
      console.warn(`${backend} review failed, fallback to heuristic: ${error.message}`);
      return reviewChunkHeuristic(chunk);
    }
    throw error;
  }
}

async function reviewChunkWithOpenClawInfer({ chunk, chunkNum, totalChunks, cwd }) {
  const reviewPrompt = [
    'You are reviewing a GitHub pull request diff chunk.',
    'Return valid JSON only, with no markdown fences or extra commentary.',
    'Use exactly this schema:',
    '{"summary":"一句话总结","issues":[{"file":"文件路径","severity":"low|medium|high|critical","title":"问题标题","reason":"问题原因","suggestion":"修改建议"}]}',
    'Only report meaningful issues involving bugs, security, Web3 risks, or missing tests around critical logic.',
    'Do not give style-only feedback.',
    'If no obvious problem exists, return {"summary":"no_issue","issues":[]}.',
    '',
    `Chunk ${chunkNum}/${totalChunks}:`,
    '',
    chunk,
  ].join('\n');

  const model = process.env.REVIEWER_MODEL || 'openai/gpt-5.4';
  const tmpDir = process.env.REVIEW_TMP_DIR || join(cwd || process.cwd(), '.state', 'tmp');
  await mkdir(tmpDir, { recursive: true });

  const { stdout } = await execFileAsync(
    'openclaw',
    [
      'infer',
      'model',
      'run',
      '--local',
      '--json',
      '--model',
      model,
      '--prompt',
      reviewPrompt,
    ],
    {
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        TMPDIR: tmpDir,
      },
    },
  );

  return extractReviewJson(stdout);
}

async function reviewChunkWithHermesAgent({ chunk, chunkNum, totalChunks, cwd }) {
  const reviewPrompt = [
    'You are reviewing a GitHub pull request diff chunk.',
    'Return valid JSON only, with no markdown fences or extra commentary.',
    'Use exactly this schema:',
    '{"summary":"一句话总结","issues":[{"file":"文件路径","severity":"low|medium|high|critical","title":"问题标题","reason":"问题原因","suggestion":"修改建议"}]}',
    'Only report meaningful issues involving bugs, security, Web3 risks, or missing tests around critical logic.',
    'Do not give style-only feedback.',
    'If no obvious problem exists, return {"summary":"no_issue","issues":[]}.',
    '',
    `Chunk ${chunkNum}/${totalChunks}:`,
    '',
    chunk,
  ].join('\n');

  const model = process.env.REVIEWER_MODEL || '';
  const hermesBin = process.env.REVIEWER_HERMES_BIN || 'hermes';
  const timeoutMs = Number(process.env.REVIEWER_HERMES_TIMEOUT_MS || 180000);

  const args = ['chat', '-q', reviewPrompt, '--quiet'];
  if (model) {
    args.push('--model', model);
  }

  const { stdout } = await execFileAsync(
    hermesBin,
    args,
    {
      cwd: cwd || process.cwd(),
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
      },
    },
  );

  return extractReviewJson(stdout);
}

export function reviewChunkHeuristic(chunk) {
  const analysis = analyzeChunkDeep(chunk);

  if (analysis.issues.length === 0) {
    return {
      summary: 'no_issue',
      issues: [],
      analysis,
    };
  }

  return {
    summary: `heuristic_review_found_${analysis.issues.length}_issues`,
    issues: analysis.issues,
    analysis,
  };
}

export function analyzeChunkDeep(chunk) {
  const issues = [];
  const seen = new Set();
  const files = [];

  const fileBlocks = String(chunk || '').split(/(?=diff --git a\/)/g).filter(Boolean);

  let hasCriticalLogicChange = false;
  let hasTestChange = false;

  for (const block of fileBlocks) {
    const file = extractFileFromBlock(block);
    const lowerFile = file.toLowerCase();

    const addedLines = extractAddedLinesArray(block);
    const removedLines = extractRemovedLinesArray(block);
    const addedText = addedLines.join('\n');
    const addedLower = addedText.toLowerCase();

    const fileFlags = [];

    if (isTestFile(lowerFile)) {
      hasTestChange = true;
      fileFlags.push('test-file');
    }

    if (/contract|sol|web3|wallet|chain|token|defi|swap|bridge|signer/.test(lowerFile)) {
      fileFlags.push('web3-sensitive');
    }

    if (/auth|permission|acl|role|guard|middleware|session|jwt/.test(lowerFile)) {
      fileFlags.push('auth-sensitive');
      hasCriticalLogicChange = true;
    }

    if (!addedLower.trim()) {
      files.push({ file, added: addedLines.length, removed: removedLines.length, flags: fileFlags });
      continue;
    }

    if (addedLower.includes('approve(') && !addedLower.includes('allowance')) {
      pushIssue(issues, seen, {
        file,
        severity: 'high',
        title: 'approve 调用缺少 allowance 防护',
        reason: '新增 approve 逻辑未看到 allowance 校验，可能导致授权风险。',
        suggestion: '先读取 allowance 并做条件判断，或采用更安全的授权更新策略。',
      });
      fileFlags.push('approve-no-allowance');
      hasCriticalLogicChange = true;
    }

    if (addedLower.includes('transfer(') && !addedLower.includes('safetransfer') && !addedLower.includes('require(')) {
      pushIssue(issues, seen, {
        file,
        severity: 'medium',
        title: 'transfer 调用返回值/结果未显式校验',
        reason: 'ERC20 transfer 在部分实现上可能返回 false，缺少检查会掩盖失败。',
        suggestion: '使用 SafeERC20 或对调用结果进行显式校验并处理失败分支。',
      });
      fileFlags.push('unchecked-transfer');
      hasCriticalLogicChange = true;
    }

    if (/(sendtransaction|eth_sendtransaction|signer\.send|wallet\.send|call\s*\{\s*value)/i.test(addedText)) {
      hasCriticalLogicChange = true;
      fileFlags.push('value-transfer');
    }

    if (!/chainid|chain_id|chain-id/.test(addedLower)
      && /(sendtransaction|wallet\.send|switchnetwork|switchchain|networkid|provider\.getnetwork)/i.test(addedText)) {
      pushIssue(issues, seen, {
        file,
        severity: 'medium',
        title: '交易逻辑缺少链路校验信号',
        reason: '新增链上交易相关逻辑但未明显看到 chainId/network 校验，存在误发链风险。',
        suggestion: '执行交易前显式校验 chainId 与预期网络一致，并在不一致时拒绝执行。',
      });
      fileFlags.push('chain-check-missing');
    }

    if (
      /(?:api[_-]?key|secret|private[_-]?key|mnemonic|bearer\s+[a-z0-9\-_.]+)/i.test(addedText)
      || /0x[a-f0-9]{64}/i.test(addedText)
    ) {
      pushIssue(issues, seen, {
        file,
        severity: 'critical',
        title: '疑似硬编码密钥/凭据',
        reason: '新增代码中出现疑似密钥或凭据特征，存在泄露风险。',
        suggestion: '改为环境变量或密钥管理服务，并旋转已暴露的凭据。',
      });
      fileFlags.push('secret-like-literal');
      hasCriticalLogicChange = true;
    }

    if (/(^|\W)(eval\(|new\s+Function\()/i.test(addedText)) {
      pushIssue(issues, seen, {
        file,
        severity: 'critical',
        title: '检测到动态执行代码',
        reason: 'eval/new Function 可能引入命令注入与 RCE 风险。',
        suggestion: '避免动态执行，改为显式映射与受控解析流程。',
      });
      fileFlags.push('dynamic-code-exec');
    }

    if (/(fetch\(|axios\.|got\(|request\()/i.test(addedText) && !/timeout|abortcontroller|signal/.test(addedLower)) {
      pushIssue(issues, seen, {
        file,
        severity: 'low',
        title: '外部请求缺少超时控制',
        reason: '新增网络请求未看到 timeout/abort 控制，可能导致阻塞与重试风暴。',
        suggestion: '设置合理 timeout，并在失败场景加入降级策略。',
      });
      fileFlags.push('request-timeout-missing');
    }

    if (/catch\s*\([^)]*\)\s*\{\s*\}/i.test(addedText)) {
      pushIssue(issues, seen, {
        file,
        severity: 'medium',
        title: '异常被静默吞掉',
        reason: '空 catch 块会掩盖真实错误，增加排障成本。',
        suggestion: '至少记录错误上下文，必要时向上抛出或返回显式失败状态。',
      });
      fileFlags.push('swallowed-error');
    }

    if (/math\.random\(/i.test(addedText) && /(nonce|token|secret|signature|salt|challenge)/i.test(addedText)) {
      pushIssue(issues, seen, {
        file,
        severity: 'high',
        title: '安全敏感值使用弱随机源',
        reason: 'Math.random 不适合生成安全敏感随机值。',
        suggestion: '使用 crypto.getRandomValues / crypto.randomBytes 等安全随机源。',
      });
      fileFlags.push('weak-randomness');
    }

    if (/(select\s+.*\+|insert\s+.*\+|update\s+.*\+|delete\s+.*\+)/i.test(addedText)) {
      pushIssue(issues, seen, {
        file,
        severity: 'high',
        title: '疑似字符串拼接 SQL',
        reason: 'SQL 字符串拼接可能带来注入风险。',
        suggestion: '改用参数化查询或 ORM 参数绑定接口。',
      });
      fileFlags.push('possible-sql-injection');
    }

    if (/(auth|permission|acl|role|guard|middleware|session|jwt)/.test(addedLower)) {
      hasCriticalLogicChange = true;
    }

    files.push({
      file,
      added: addedLines.length,
      removed: removedLines.length,
      flags: fileFlags,
    });
  }

  if (hasCriticalLogicChange && !hasTestChange) {
    pushIssue(issues, seen, {
      file: 'unknown',
      severity: 'medium',
      title: '关键逻辑变更缺少测试信号',
      reason: '检测到交易/授权/权限类关键逻辑变更，但未发现对应测试文件修改。',
      suggestion: '补充关键路径与异常路径的自动化测试（含回归用例）。',
    });
  }

  return {
    files,
    issues,
    hasCriticalLogicChange,
    hasTestChange,
  };
}

function isTestFile(lowerFile) {
  return /(^|\/)(test|tests|__tests__)\//.test(lowerFile)
    || /\.(test|spec)\./.test(lowerFile);
}

function pushIssue(issues, seen, issue) {
  const key = `${issue.file}:${issue.title}`;
  if (!seen.has(key)) {
    seen.add(key);
    issues.push(issue);
  }
}

function extractFileFromBlock(block) {
  const match = block.match(/diff --git a\/(.*?) b\/(.*?)\n/);
  if (!match) {
    return 'unknown';
  }
  return match[2] || match[1] || 'unknown';
}

function extractAddedLinesArray(block) {
  return String(block || '')
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1));
}

function extractRemovedLinesArray(block) {
  return String(block || '')
    .split('\n')
    .filter((line) => line.startsWith('-') && !line.startsWith('---'))
    .map((line) => line.slice(1));
}

function buildRecommendations(analyses, issues) {
  const recs = [];

  if (issues.some((i) => i.severity === 'critical')) {
    recs.push('优先阻断 CRITICAL 问题后再合并，必要时先移除风险代码路径。');
  }
  if (issues.some((i) => i.title.includes('allowance'))) {
    recs.push('对 approve 流程补充 allowance 防护与回归测试。');
  }
  if (issues.some((i) => i.title.includes('硬编码密钥'))) {
    recs.push('立即轮换疑似泄露凭据，并迁移到安全密钥管理方案。');
  }
  if (analyses.some((a) => a.hasCriticalLogicChange && !a.hasTestChange)) {
    recs.push('为关键逻辑补充最小可复现测试：成功路径、失败路径、边界条件。');
  }

  if (recs.length === 0 && issues.length > 0) {
    recs.push('建议在合并前逐项处理上述问题，并补充对应测试与回归说明。');
  }

  return recs.slice(0, MAX_RECOMMENDATIONS);
}

export function generateDeepReviewReport({ prompt, summary, issues, analyses, backend }) {
  const context = extractContextFromPrompt(prompt);

  const files = analyses.flatMap((a) => a.files || []);
  const bySeverity = {
    critical: issues.filter((i) => i.severity === 'critical').length,
    high: issues.filter((i) => i.severity === 'high').length,
    medium: issues.filter((i) => i.severity === 'medium').length,
    low: issues.filter((i) => i.severity === 'low').length,
  };

  const lines = [];
  lines.push('# PR Deep Review Report');
  lines.push('');
  lines.push(`- Generated at: ${new Date().toISOString()}`);
  lines.push(`- Backend: ${backend}`);
  if (context.repoFullName) lines.push(`- Repository: ${context.repoFullName}`);
  if (context.prNumber) lines.push(`- PR: #${context.prNumber}`);
  if (context.prTitle) lines.push(`- Title: ${context.prTitle}`);
  if (context.headRef) lines.push(`- Head: ${context.headRef}`);
  if (context.baseRef) lines.push(`- Base: ${context.baseRef}`);
  lines.push('');

  lines.push('## Executive Summary');
  lines.push('');
  lines.push(`- Overall: ${summary}`);
  lines.push(`- Issue count: ${issues.length} (critical ${bySeverity.critical}, high ${bySeverity.high}, medium ${bySeverity.medium}, low ${bySeverity.low})`);
  lines.push(`- Files analyzed in reviewed chunks: ${files.length}`);
  lines.push('');

  lines.push('## Risk Matrix');
  lines.push('');
  lines.push('| Severity | Count |');
  lines.push('|---|---:|');
  lines.push(`| critical | ${bySeverity.critical} |`);
  lines.push(`| high | ${bySeverity.high} |`);
  lines.push(`| medium | ${bySeverity.medium} |`);
  lines.push(`| low | ${bySeverity.low} |`);
  lines.push('');

  lines.push('## Issue Details');
  lines.push('');
  if (!issues.length) {
    lines.push('- no_issue');
  } else {
    for (const issue of issues) {
      lines.push(`### [${String(issue.severity || 'medium').toUpperCase()}] ${issue.title}`);
      lines.push(`- File: \`${issue.file}\``);
      lines.push(`- Reason: ${issue.reason}`);
      lines.push(`- Suggestion: ${issue.suggestion}`);
      lines.push('');
    }
  }

  lines.push('## File-by-file Analysis');
  lines.push('');
  if (!files.length) {
    lines.push('- No file stats available.');
  } else {
    for (const f of files) {
      lines.push(`### ${f.file}`);
      lines.push(`- Changes: +${f.added} / -${f.removed}`);
      if (f.flags?.length) {
        lines.push(`- Signals: ${f.flags.join(', ')}`);
      } else {
        lines.push('- Signals: none');
      }
      lines.push('');
    }
  }

  const recommendations = buildRecommendations(analyses, issues);
  lines.push('## Recommended Next Actions');
  lines.push('');
  if (!recommendations.length) {
    lines.push('- 当前未检测到必须阻断的问题，建议人工 spot-check 关键文件。');
  } else {
    for (const r of recommendations) {
      lines.push(`- ${r}`);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('_Generated by PR Review Agent (deep-analysis report mode)._');

  return lines.join('\n');
}

function extractContextFromPrompt(prompt) {
  const text = String(prompt || '');
  const ctx = {
    repoFullName: '',
    prNumber: '',
    prTitle: '',
    headRef: '',
    baseRef: '',
  };

  // Extract repo JSON block
  const repoMatch = text.match(/Repository:\n([\s\S]*?)\n\nPull Request:/);
  if (repoMatch) {
    try {
      const repo = JSON.parse(repoMatch[1]);
      ctx.repoFullName = repo.full_name || '';
    } catch {
      // ignore
    }
  }

  // Extract PR JSON block
  const prMatch = text.match(/Pull Request:\n([\s\S]*?)\n\nChanged files:/);
  if (prMatch) {
    try {
      const pr = JSON.parse(prMatch[1]);
      ctx.prNumber = pr.number || '';
      ctx.prTitle = pr.title || '';
      ctx.headRef = pr.head || '';
      ctx.baseRef = pr.base || '';
    } catch {
      // ignore
    }
  }

  return ctx;
}

export function extractReviewJson(rawText) {
  const normalized = String(rawText || '').trim();

  // openclaw output can include diagnostic lines before the final JSON block.
  const trailingJsonMatch = normalized.match(/\{[\s\S]*\}\s*$/);
  const jsonCandidate = trailingJsonMatch ? trailingJsonMatch[0] : normalized;

  // Try parse top-level JSON from tool output first.
  let candidate = jsonCandidate;
  let top = null;
  try {
    top = JSON.parse(jsonCandidate);
    if (typeof top === 'string') {
      candidate = top;
    } else if (top && typeof top === 'object') {
      candidate = top.output
        || top.text
        || top.message
        || top.reply
        || top.outputs?.[0]?.text
        || jsonCandidate;
    }
  } catch {
    // keep original text
  }

  // Remove markdown fences if present.
  const fenceMatch = candidate.match(/```json\s*([\s\S]*?)\s*```/) ||
    candidate.match(/```\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    candidate = fenceMatch[1].trim();
  }

  // Try direct parse.
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object' && 'summary' in parsed && 'issues' in parsed) {
      return parsed;
    }
  } catch {
    // continue
  }

  // Try extracting object containing "summary".
  const objMatch = candidate.match(/\{[\s\S]*"summary"[\s\S]*\}/);
  if (objMatch) {
    const parsed = JSON.parse(objMatch[0]);
    if (parsed && typeof parsed === 'object' && 'summary' in parsed && 'issues' in parsed) {
      return parsed;
    }
  }

  // Bubble up model/tool error text when available.
  if (top?.outputs?.[0]?.text) {
    throw new Error(`model_output_not_json:${String(top.outputs[0].text).slice(0, 300)}`);
  }

  throw new Error('no_json_found');
}
