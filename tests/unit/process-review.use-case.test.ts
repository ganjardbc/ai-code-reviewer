import '../mocks/env.js';
import { describe, it, expect, vi } from 'vitest';
import { ProcessReviewUseCase } from '../../src/application/use-cases/process-review.use-case.js';
import type { ProcessReviewDeps } from '../../src/application/use-cases/process-review.use-case.js';
import type { JobPayload } from '../../src/domain/interfaces/queue.interface.js';
import { ValidationError } from '../../src/domain/errors/app-errors.js';

const WORKSPACE = '/tmp/ai-reviewer-test/job-review';
const COMMENT = { filePath: 'src/a.ts', lineNumber: 3, message: 'Bug', severity: 'WARNING' as const };

function makeDeps(overrides: Partial<ProcessReviewDeps> = {}): ProcessReviewDeps {
  return {
    gitService: {
      clone: vi.fn().mockResolvedValue(undefined),
      fetchRef: vi.fn().mockResolvedValue(undefined),
      checkout: vi.fn().mockResolvedValue(undefined),
      generateDiff: vi.fn().mockResolvedValue('diff --git a/src/a.ts b/src/a.ts\n+x'),
      commitAll: vi.fn(),
      push: vi.fn(),
    },
    workspaceManager: {
      createWorkspace: vi.fn().mockResolvedValue(WORKSPACE),
      cleanupWorkspace: vi.fn().mockResolvedValue(undefined),
      validatePath: vi.fn().mockReturnValue(true),
    },
    aiProvider: {
      review: vi.fn().mockResolvedValue({ comments: [COMMENT] }),
      fix: vi.fn(),
    },
    promptBuilder: { build: vi.fn().mockReturnValue('prompt') },
    outputParser: { parse: vi.fn() },
    githubClient: {
      postReview: vi.fn().mockResolvedValue(undefined),
      getPullRequest: vi.fn().mockResolvedValue({ headSha: 'abc1234', state: 'open' }),
      listOutstandingBotComments: vi.fn(),
      postIssueComment: vi.fn().mockResolvedValue(undefined),
      hasWriteAccess: vi.fn(),
    },
    gitlabClient: {
      postReview: vi.fn().mockResolvedValue(undefined),
      getMergeRequest: vi.fn().mockResolvedValue({ baseSha: 'b', startSha: 's', headSha: 'def5678' }),
      listOutstandingBotComments: vi.fn(),
      postMrNote: vi.fn().mockResolvedValue(undefined),
      hasDeveloperAccess: vi.fn(),
    },
    notifier: {
      notifyReviewComplete: vi.fn().mockResolvedValue(undefined),
      notifyReviewFailed: vi.fn().mockResolvedValue(undefined),
      notifyFixComplete: vi.fn(),
      notifyFixFailed: vi.fn(),
    },
    ...overrides,
  } as ProcessReviewDeps;
}

const GITHUB_JOB: JobPayload = {
  jobId: 'job-r1',
  jobType: 'review',
  trigger: 'event',
  provider: 'github',
  cloneUrl: 'https://github.com/myorg/myrepo.git',
  headCloneUrl: 'https://github.com/contributor/myrepo.git',
  headRef: 'feature-x',
  baseRef: 'main',
  headSha: 'abc1234',
  prNumber: 42,
  repoOwner: 'myorg',
  repoName: 'myrepo',
};

const GITLAB_JOB: JobPayload = {
  jobId: 'job-r2',
  jobType: 'review',
  trigger: 'event',
  provider: 'gitlab',
  cloneUrl: 'https://gitlab.com/myorg/myrepo.git',
  headRef: 'feature-y',
  baseRef: 'main',
  headSha: 'def5678',
  mrIid: 5,
  projectId: 123,
  baseSha: 'b',
  startSha: 's',
};

describe('ProcessReviewUseCase', () => {
  it('clones the base repo and checks out the head via the PR ref, even for forks', async () => {
    const deps = makeDeps();
    await new ProcessReviewUseCase(deps).execute(GITHUB_JOB);

    const auth = { username: 'x-access-token', token: 'test-gh-token' };
    const repoPath = `${WORKSPACE}/repo`;
    expect(deps.gitService.clone).toHaveBeenCalledWith(GITHUB_JOB.cloneUrl, 'main', repoPath, auth);
    expect(deps.gitService.fetchRef).toHaveBeenCalledWith(repoPath, 'refs/pull/42/head', auth);
    expect(deps.gitService.checkout).toHaveBeenCalledWith(repoPath, 'abc1234');
    expect(deps.gitService.generateDiff).toHaveBeenCalledWith(repoPath, 'main', auth);
    expect(deps.githubClient.postReview).toHaveBeenCalledWith(expect.objectContaining({ commitSha: 'abc1234' }));
  });

  it('uses the merge-request head ref and oauth2 credentials for GitLab', async () => {
    const deps = makeDeps();
    await new ProcessReviewUseCase(deps).execute(GITLAB_JOB);

    expect(deps.gitService.fetchRef).toHaveBeenCalledWith(
      `${WORKSPACE}/repo`,
      'refs/merge-requests/5/head',
      { username: 'oauth2', token: 'test-gl-token' },
    );
  });

  it('skips an event-triggered review whose head was superseded by a newer push', async () => {
    const deps = makeDeps();
    vi.mocked(deps.githubClient.getPullRequest).mockResolvedValue({
      headRef: 'feature-x', baseRef: 'main', headSha: 'newer99', cloneUrl: GITHUB_JOB.cloneUrl, state: 'open',
    });

    await new ProcessReviewUseCase(deps).execute(GITHUB_JOB);

    expect(deps.workspaceManager.createWorkspace).not.toHaveBeenCalled();
    expect(deps.aiProvider.review).not.toHaveBeenCalled();
    expect(deps.notifier?.notifyReviewComplete).not.toHaveBeenCalled();
  });

  it('retargets a comment-triggered review to the current head instead of skipping', async () => {
    const deps = makeDeps();
    vi.mocked(deps.gitlabClient.getMergeRequest).mockResolvedValue({ baseSha: 'b2', startSha: 's2', headSha: 'fed9999' });

    await new ProcessReviewUseCase(deps).execute({ ...GITLAB_JOB, trigger: 'comment' });

    expect(deps.gitService.checkout).toHaveBeenCalledWith(`${WORKSPACE}/repo`, 'fed9999');
    expect(deps.gitlabClient.postReview).toHaveBeenCalledWith(
      expect.objectContaining({ headSha: 'fed9999', baseSha: 'b2', startSha: 's2' }),
    );
  });

  it('reviews the enqueued commit when the head lookup fails', async () => {
    const deps = makeDeps();
    vi.mocked(deps.githubClient.getPullRequest).mockRejectedValue(new Error('rate limited'));

    await new ProcessReviewUseCase(deps).execute(GITHUB_JOB);

    expect(deps.gitService.checkout).toHaveBeenCalledWith(`${WORKSPACE}/repo`, 'abc1234');
  });

  it('only notifies failure on the final attempt', async () => {
    const deps = makeDeps();
    vi.mocked(deps.gitService.clone).mockRejectedValue(new Error('network down'));
    const useCase = new ProcessReviewUseCase(deps);

    await expect(useCase.execute(GITHUB_JOB, { isFinalAttempt: false })).rejects.toThrow('network down');
    expect(deps.notifier?.notifyReviewFailed).not.toHaveBeenCalled();

    await expect(useCase.execute(GITHUB_JOB, { isFinalAttempt: true })).rejects.toThrow('network down');
    expect(deps.notifier?.notifyReviewFailed).toHaveBeenCalledTimes(1);
    expect(deps.workspaceManager.cleanupWorkspace).toHaveBeenCalledTimes(2);
  });

  it('notifies immediately on a permanent error even before the final attempt', async () => {
    const deps = makeDeps();
    vi.mocked(deps.gitService.checkout).mockRejectedValue(new ValidationError('Invalid commit SHA'));

    await expect(new ProcessReviewUseCase(deps).execute(GITHUB_JOB, { isFinalAttempt: false })).rejects.toThrow();
    expect(deps.notifier?.notifyReviewFailed).toHaveBeenCalledTimes(1);
  });
});
