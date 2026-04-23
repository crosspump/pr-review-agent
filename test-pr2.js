import { processPullRequest } from './src/engine.js';

const mockRepo = {
  full_name: 'cryptosunshine/dapp-builder',
  default_branch: 'main',
  language: 'TypeScript'
};

const mockPR = {
  number: 2,
  title: 'feat: add /app task preview route alias',
  body: 'Add route alias',
  head: { ref: 'feature', sha: 'a4a2082b9019e1bc9f93b76f56678cf9cd047133' },
  base: { ref: 'main' },
  additions: 10,
  deletions: 2,
  changed_files: 1
};

const result = await processPullRequest({ repository: mockRepo, pr: mockPR });
console.log(JSON.stringify(result, null, 2));
