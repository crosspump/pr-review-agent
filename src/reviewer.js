export async function runReviewWithAgent({ prompt, cwd }) {
  const reviewInstructions = [
    'Reviewing GitHub pull request diff with enhanced heuristics.',
    'Checking for: Web3 risks, security issues, missing error handling, and code quality.',
  ].join('\n');

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
      
      const result = reviewChunkHeuristic(chunk);
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
  
  if (lowerChunk.includes('chainid') && !lowerChunk.includes('validation') && !lowerChunk.includes('71')) {
    issues.push({
      file: files[0] || 'network config',
      severity: 'medium',
      title: 'ChainId usage without validation',
      reason: 'ChainId should be validated to prevent wrong-network transactions',
      suggestion: 'Add chainId validation before contract interactions',
    });
  }
  
  // Error Handling
  if ((lowerChunk.includes('fetch(') || lowerChunk.includes('await ')) && 
      !lowerChunk.includes('try') && !lowerChunk.includes('catch') &&
      !lowerChunk.includes('.catch(')) {
    issues.push({
      file: files[0] || 'async operations',
      severity: 'low',
      title: 'Missing error handling for async operations',
      reason: 'Unhandled promise rejections can cause silent failures',
      suggestion: 'Wrap async operations in try-catch blocks or use .catch()',
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
  
  // Code Quality: Console logs in production code
  if (lowerChunk.includes('console.log') || lowerChunk.includes('console.error')) {
    issues.push({
      file: files[0] || 'code quality',
      severity: 'low',
      title: 'Console statements in code',
      reason: 'Console logs should be removed or replaced with proper logging in production',
      suggestion: 'Use a proper logging library or remove debug console statements',
    });
  }
  
  return {
    summary: issues.length > 0 ? `Found ${issues.length} issues in chunk` : 'no_issue',
    issues,
  };
}
