import { fetchRepository, listOpenPullRequests } from './src/github.js';
import { getConfig } from './src/lib.js';
import { processPullRequest } from './src/engine.js';

const config = getConfig();
const repository = await fetchRepository(config, config.repoFullName);
const pulls = await listOpenPullRequests(config, config.repoFullName);
const pr = pulls.find((item) => item.number === 1);

if (!pr) {
  throw new Error('PR #1 not found');
}

const result = await processPullRequest({ repository, pr });
console.log(JSON.stringify(result, null, 2));
