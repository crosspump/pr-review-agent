import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

export async function runReviewWithAgent({ prompt, cwd }) {
  try {
    // Split prompt into chunks (max ~10KB per chunk)
    const chunks = splitIntoChunks(prompt, 10000);
    
    console.log(`Reviewing ${chunks.length} chunks (testing with first 3)...`);
    
    // For testing: only review first 3 chunks
    const chunksToReview = chunks.slice(0, 3);
    
    const chunkResults = [];
    
    for (let i = 0; i < chunksToReview.length; i++) {
      const chunk = chunksToReview[i];
      
      console.log(`Reviewing chunk ${i + 1}/${chunksToReview.length}...`);
      
      const result = await reviewChunkWithSpawn(chunk, i + 1, chunksToReview.length);
      chunkResults.push(result);
    }
    
    // Merge results
    const allIssues = chunkResults.flatMap(r => r.issues || []);
    
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
    } else if (uniqueIssues.some(i => i.severity === 'critical' || i.severity === 'high')) {
      summary = `发现 ${uniqueIssues.length} 个问题，包含高危风险`;
    } else {
      summary = `发现 ${uniqueIssues.length} 个潜在问题`;
    }
    
    return {
      summary,
      issues: uniqueIssues,
    };
  } catch (error) {
    console.error('Chunked review failed:', error);
    return {
      summary: `Review failed: ${error.message}`,
      issues: [],
    };
  }
}

function splitIntoChunks(text, maxChunkSize) {
  const chunks = [];
  let currentChunk = '';
  
  // Split by file diffs to keep related changes together
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

async function reviewChunkWithSpawn(chunk, chunkNum, totalChunks) {
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

  try {
    // Write prompt to temp file for the spawned script to read
    const tempId = randomBytes(8).toString('hex');
    const promptPath = join(tmpdir(), `pr-review-${tempId}.txt`);
    const resultPath = join(tmpdir(), `pr-review-${tempId}.json`);
    
    await writeFile(promptPath, reviewPrompt, 'utf8');
    
    // Spawn via script that uses sessions_spawn tool
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    
    const scriptPath = join(process.cwd(), 'scripts', 'spawn-chunk-reviewer.sh');
    
    await execFileAsync('bash', [scriptPath, promptPath, resultPath], {
      timeout: 70000,
      maxBuffer: 16 * 1024 * 1024,
    });
    
    // Read result
    const resultText = await import('node:fs/promises').then(fs => fs.readFile(resultPath, 'utf8'));
    
    // Cleanup
    await unlink(promptPath).catch(() => {});
    await unlink(resultPath).catch(() => {});
    
    // Parse JSON
    let jsonText = resultText.trim();
    
    // Remove markdown fences if present
    const fenceMatch = jsonText.match(/```json\s*([\s\S]*?)\s*```/) || 
                      jsonText.match(/```\s*([\s\S]*?)\s*```/);
    if (fenceMatch) {
      jsonText = fenceMatch[1].trim();
    }
    
    // Try to find JSON object
    const objMatch = jsonText.match(/\{[\s\S]*"summary"[\s\S]*\}/);
    if (objMatch) {
      jsonText = objMatch[0];
    }
    
    const result = JSON.parse(jsonText);
    return result;
  } catch (error) {
    console.error(`Chunk ${chunkNum} review failed:`, error.message);
    
    // Fallback to heuristic for this chunk
    return reviewChunkHeuristic(chunk);
  }
}

function reviewChunkHeuristic(chunk) {
  const issues = [];
  const lowerChunk = chunk.toLowerCase();
  
  // Extract file paths from diff headers
  const fileMatches = chunk.match(/diff --git a\/(.*?) b\//g);
  const files = fileMatches ? fileMatches.map(m => m.match(/a\/(.*?) b\//)?.[1] || 'unknown') : ['unknown'];
  
  // Web3 Security Checks
  if (lowerChunk.includes('approve(') && !lowerChunk.includes('allowance')) {
    issues.push({
      file: files[0] || 'contract interaction',
      severity: 'high',
      title: 'Unchecked approve() call',
      reason: 'approve() without checking current allowance may lead to unexpected token permissions',
      suggestion: 'Check current allowance before calling approve(), or use increaseAllowance/decreaseAllowance',
    });
  }
  
  if (lowerChunk.includes('transfer(') && !lowerChunk.includes('safetransfer') && !lowerChunk.includes('require')) {
    issues.push({
      file: files[0] || 'contract interaction',
      severity: 'medium',
      title: 'Unchecked transfer() call',
      reason: 'transfer() return value should be checked to ensure success',
      suggestion: 'Use SafeERC20 or check transfer() return value',
    });
  }
  
  // Security: Hardcoded secrets
  if (lowerChunk.match(/['"]([a-z0-9]{32,})['"]/i) && 
      (lowerChunk.includes('api') || lowerChunk.includes('key') || lowerChunk.includes('token'))) {
    issues.push({
      file: files[0] || 'security',
      severity: 'critical',
      title: 'Possible hardcoded API key or secret',
      reason: 'Hardcoded secrets in code can be exposed in version control',
      suggestion: 'Move secrets to environment variables or secure config',
    });
  }
  
  return {
    summary: issues.length > 0 ? `Found ${issues.length} issues in chunk` : 'no_issue',
    issues,
  };
}
