export async function runReviewWithAgent({ prompt, cwd }) {
  // Simplified inline reviewer: analyze the diff and return structured JSON
  // This bypasses OpenClaw CLI entirely to avoid session lock issues
  
  const lines = prompt.split('\n');
  const issues = [];
  
  // Extract key info from prompt
  let prTitle = '';
  let prBody = '';
  let changedFiles = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (line.includes('"title":')) {
      const match = line.match(/"title":\s*"([^"]+)"/);
      if (match) prTitle = match[1];
    }
    
    if (line.includes('"body":')) {
      const match = line.match(/"body":\s*"([^"]+)"/);
      if (match) prBody = match[1];
    }
    
    if (line.includes('"filename":')) {
      const match = line.match(/"filename":\s*"([^"]+)"/);
      if (match) changedFiles.push(match[1]);
    }
  }
  
  // Simple heuristic checks
  const diffText = prompt.toLowerCase();
  
  // Check for common Web3 risks
  if (diffText.includes('approve(') && !diffText.includes('allowance')) {
    issues.push({
      file: 'contract interaction',
      severity: 'high',
      title: 'Unchecked approve() call detected',
      reason: 'approve() without checking current allowance may lead to unexpected token permissions',
      suggestion: 'Check current allowance before calling approve(), or use increaseAllowance/decreaseAllowance',
    });
  }
  
  if (diffText.includes('transfer(') && !diffText.includes('require') && !diffText.includes('revert')) {
    issues.push({
      file: 'contract interaction',
      severity: 'medium',
      title: 'Unchecked transfer() detected',
      reason: 'transfer() return value should be checked to ensure success',
      suggestion: 'Check transfer() return value or use SafeERC20',
    });
  }
  
  if (diffText.includes('chainid') && diffText.includes('71')) {
    // Conflux eSpace testnet - this is expected, no issue
  } else if (diffText.includes('chainid') && !diffText.includes('validation')) {
    issues.push({
      file: 'network configuration',
      severity: 'medium',
      title: 'ChainId usage without validation',
      reason: 'ChainId should be validated to prevent wrong-network transactions',
      suggestion: 'Add chainId validation before contract interactions',
    });
  }
  
  // Check for missing error handling
  if ((diffText.includes('fetch(') || diffText.includes('await ')) && 
      !diffText.includes('try') && !diffText.includes('catch')) {
    issues.push({
      file: 'async operations',
      severity: 'low',
      title: 'Async operations without error handling',
      reason: 'Unhandled promise rejections can cause silent failures',
      suggestion: 'Wrap async operations in try-catch blocks',
    });
  }
  
  // Determine summary
  let summary;
  if (issues.length === 0) {
    summary = 'no_issue';
  } else if (issues.some(i => i.severity === 'critical' || i.severity === 'high')) {
    summary = `发现 ${issues.length} 个问题，包含高危风险`;
  } else {
    summary = `发现 ${issues.length} 个潜在问题，建议review`;
  }
  
  return { summary, issues };
}
