export async function githubRequest(config, pathname, options = {}) {
  const url = new URL(pathname, config.githubApiBase);
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'pr-review-agent',
    ...(options.headers || {}),
  };

  if (config.githubToken) {
    headers.Authorization = `Bearer ${config.githubToken}`;
  }

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body,
  });

  const text = await response.text();
  const data = text ? safeJsonParse(text) ?? text : null;

  if (!response.ok) {
    const details = typeof data === 'string' ? data : JSON.stringify(data);
    throw new Error(`GitHub API ${response.status} ${response.statusText}: ${details}`);
  }

  return data;
}

export async function fetchPullRequestFiles(config, repoFullName, prNumber) {
  const files = [];
  let page = 1;

  while (true) {
    const batch = await githubRequest(
      config,
      `/repos/${repoFullName}/pulls/${prNumber}/files?per_page=100&page=${page}`,
    );

    files.push(...batch);

    if (!Array.isArray(batch) || batch.length < 100 || files.length >= config.maxFiles) {
      break;
    }

    page += 1;
  }

  return files.slice(0, config.maxFiles);
}

export async function listOpenPullRequests(config, repoFullName) {
  const pulls = [];
  let page = 1;

  while (true) {
    const batch = await githubRequest(
      config,
      `/repos/${repoFullName}/pulls?state=open&sort=updated&direction=desc&per_page=100&page=${page}`,
    );

    pulls.push(...batch);

    if (!Array.isArray(batch) || batch.length < 100) {
      break;
    }

    page += 1;
  }

  return pulls;
}

export async function fetchRepository(config, repoFullName) {
  return githubRequest(config, `/repos/${repoFullName}`);
}

export async function postIssueComment(config, repoFullName, prNumber, body) {
  return githubRequest(config, `/repos/${repoFullName}/issues/${prNumber}/comments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body }),
  });
}

export async function postPullRequestReview(config, repoFullName, prNumber, review) {
  return githubRequest(config, `/repos/${repoFullName}/pulls/${prNumber}/reviews`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(review),
  });
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
