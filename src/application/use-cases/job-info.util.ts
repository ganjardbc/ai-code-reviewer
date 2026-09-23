import type { JobPayload } from '../../domain/interfaces/queue.interface.js';
import type { GitAuth } from '../../domain/interfaces/git.interface.js';
import { config } from '../../config/index.js';

export function gitAuthFor(job: JobPayload): GitAuth {
  return job.provider === 'github'
    ? { username: 'x-access-token', token: config.GITHUB_ACCESS_TOKEN }
    : { username: 'oauth2', token: config.GITLAB_ACCESS_TOKEN };
}

/**
 * The PR/MR head as exposed on the *base* repository. Both platforms publish
 * it there even for fork PRs, so reviews never need access to the fork.
 */
export function headFetchRef(job: JobPayload): string {
  if (job.provider === 'github') {
    if (!job.prNumber) throw new Error('Missing GitHub metadata: prNumber required');
    return `refs/pull/${job.prNumber}/head`;
  }
  if (!job.mrIid) throw new Error('Missing GitLab metadata: mrIid required');
  return `refs/merge-requests/${job.mrIid}/head`;
}

export function buildPrUrl(job: JobPayload): string | undefined {
  if (job.provider === 'github' && job.repoOwner && job.repoName && job.prNumber) {
    return `https://github.com/${job.repoOwner}/${job.repoName}/pull/${job.prNumber}`;
  }
  if (job.provider === 'gitlab' && job.mrIid) {
    const url = new URL(job.cloneUrl);
    url.username = '';
    url.password = '';
    const base = url.toString().replace(/\.git$/, '');
    return `${base}/-/merge_requests/${job.mrIid}`;
  }
  return undefined;
}

export function repoLabel(job: JobPayload): string {
  if (job.repoOwner && job.repoName) return `${job.repoOwner}/${job.repoName}`;
  return job.repoName ?? String(job.projectId ?? 'unknown');
}
