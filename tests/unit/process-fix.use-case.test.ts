import '../mocks/env.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessFixUseCase } from '../../src/application/use-cases/process-fix.use-case.js';
import type { ProcessFixDeps } from '../../src/application/use-cases/process-fix.use-case.js';
import type { JobPayload } from '../../src/domain/interfaces/queue.interface.js';

function makeDeps(overrides: Partial<ProcessFixDeps> = {}): ProcessFixDeps {
  return {
    gitService: {
      clone: vi.fn().mockResolvedValue(undefined),
      checkout: vi.fn().mockResolvedValue(undefined),
      generateDiff: vi.fn().mockResolvedValue(''),
      commitAll: vi.fn().mockResolvedValue(true),
      push: vi.fn().mockResolvedValue(undefined),
    },
    workspaceManager: {
      createWorkspace: vi.fn().mockResolvedValue('/tmp/ai-reviewer-test/job-1'),
      cleanupWorkspace: vi.fn().mockResolvedValue(undefined),
      validatePath: vi.fn().mockReturnValue(true),
    },
    aiProvider: {
      review: vi.fn(),
      fix: vi.fn().mockResolvedValue({ fixes: [] }),
    },
    fixPromptBuilder: {
      buildFix: vi.fn().mockReturnValue('fix prompt'),
    },
    githubClient: {
      postReview: vi.fn(),
      getPullRequest: vi.fn(),
      listOutstandingBotComments: vi.fn().mockResolvedValue([]),
      postIssueComment: vi.fn().mockResolvedValue(undefined),
    },
    gitlabClient: {
      postReview: vi.fn(),
      getMergeRequest: vi.fn(),
      listOutstandingBotComments: vi.fn().mockResolvedValue([]),
      postMrNote: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  } as ProcessFixDeps;
}

const BASE_JOB: JobPayload = {
  jobId: 'job-1',
  jobType: 'fix',
  provider: 'github',
  cloneUrl: 'https://github.com/myorg/myrepo.git',
  headRef: 'feature-x',
  baseRef: 'main',
  headSha: 'abc1234',
  prNumber: 42,
  repoOwner: 'myorg',
  repoName: 'myrepo',
};

describe('ProcessFixUseCase', () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mktemp();
  });

  function mktemp(): string {
    return mkdtempSync(join(tmpdir(), 'fix-usecase-'));
  }

  it('skips work when there are no outstanding bot comments', async () => {
    const deps = makeDeps();
    const useCase = new ProcessFixUseCase(deps);

    await useCase.execute(BASE_JOB);

    expect(deps.githubClient.listOutstandingBotComments).toHaveBeenCalledWith('myorg', 'myrepo', 42);
    expect(deps.gitService.clone).not.toHaveBeenCalled();
    expect(deps.workspaceManager.cleanupWorkspace).toHaveBeenCalled();
  });

  it('applies fixes, commits, pushes, and posts a summary comment', async () => {
    const repoPath = join(workspaceRoot, 'repo');
    mkdirSync(join(repoPath, 'src'), { recursive: true });
    writeFileSync(join(repoPath, 'src', 'auth.ts'), 'export function login() {}\n');

    const deps = makeDeps({
      workspaceManager: {
        createWorkspace: vi.fn().mockResolvedValue(workspaceRoot),
        cleanupWorkspace: vi.fn().mockResolvedValue(undefined),
        validatePath: vi.fn().mockReturnValue(true),
      },
      githubClient: {
        postReview: vi.fn(),
        getPullRequest: vi.fn(),
        listOutstandingBotComments: vi.fn().mockResolvedValue([
          { filePath: 'src/auth.ts', lineNumber: 1, message: 'Missing validation' },
        ]),
        postIssueComment: vi.fn().mockResolvedValue(undefined),
      },
      aiProvider: {
        review: vi.fn(),
        fix: vi.fn().mockResolvedValue({
          fixes: [{ filePath: 'src/auth.ts', content: 'export function login() { validate(); }\n' }],
        }),
      },
      notifier: {
        notifyReviewComplete: vi.fn(),
        notifyReviewFailed: vi.fn(),
        notifyFixComplete: vi.fn().mockResolvedValue(undefined),
        notifyFixFailed: vi.fn().mockResolvedValue(undefined),
      },
    });

    const useCase = new ProcessFixUseCase(deps);
    await useCase.execute(BASE_JOB);

    const auth = { username: 'x-access-token', token: 'test-gh-token' };
    expect(deps.gitService.clone).toHaveBeenCalledWith(BASE_JOB.cloneUrl, BASE_JOB.headRef, join(workspaceRoot, 'repo'), auth);
    expect(deps.aiProvider.fix).toHaveBeenCalledWith('fix prompt');
    expect(deps.gitService.commitAll).toHaveBeenCalled();
    // Credentials travel via GitAuth, never inside the push URL.
    expect(deps.gitService.push).toHaveBeenCalledWith(join(workspaceRoot, 'repo'), BASE_JOB.cloneUrl, BASE_JOB.headRef, auth);
    expect(deps.githubClient.postIssueComment).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'myorg', repo: 'myrepo', pullNumber: 42 }),
    );
    expect(deps.notifier?.notifyFixComplete).toHaveBeenCalledWith(
      expect.objectContaining({ filesFixed: 1, provider: 'github', prNumber: 42 }),
    );

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('notifies fix failure when the git/AI pipeline throws', async () => {
    const deps = makeDeps({
      githubClient: {
        postReview: vi.fn(),
        getPullRequest: vi.fn(),
        listOutstandingBotComments: vi.fn().mockResolvedValue([
          { filePath: 'src/auth.ts', lineNumber: 1, message: 'Missing validation' },
        ]),
        postIssueComment: vi.fn().mockResolvedValue(undefined),
      },
      gitService: {
        clone: vi.fn().mockRejectedValue(new Error('clone failed')),
        checkout: vi.fn(),
        generateDiff: vi.fn(),
        commitAll: vi.fn(),
        push: vi.fn(),
      },
      notifier: {
        notifyReviewComplete: vi.fn(),
        notifyReviewFailed: vi.fn(),
        notifyFixComplete: vi.fn().mockResolvedValue(undefined),
        notifyFixFailed: vi.fn().mockResolvedValue(undefined),
      },
    });

    const useCase = new ProcessFixUseCase(deps);
    await expect(useCase.execute(BASE_JOB)).rejects.toThrow('clone failed');

    expect(deps.notifier?.notifyFixFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: 'clone failed', prNumber: 42 }),
    );
    expect(deps.notifier?.notifyFixComplete).not.toHaveBeenCalled();
  });

  function failingCloneDeps(): ProcessFixDeps {
    const deps = makeDeps({
      workspaceManager: {
        createWorkspace: vi.fn().mockResolvedValue(workspaceRoot),
        cleanupWorkspace: vi.fn().mockResolvedValue(undefined),
        validatePath: vi.fn().mockReturnValue(true),
      },
      notifier: {
        notifyReviewComplete: vi.fn(),
        notifyReviewFailed: vi.fn(),
        notifyFixComplete: vi.fn().mockResolvedValue(undefined),
        notifyFixFailed: vi.fn().mockResolvedValue(undefined),
      },
    });
    vi.mocked(deps.githubClient.listOutstandingBotComments).mockResolvedValue([
      { filePath: 'src/auth.ts', lineNumber: 1, message: 'Missing validation' },
    ]);
    vi.mocked(deps.gitService.clone).mockRejectedValue(new Error('clone failed'));
    return deps;
  }

  it('does not send a failure notification while BullMQ will still retry', async () => {
    const deps = failingCloneDeps();
    const useCase = new ProcessFixUseCase(deps);

    await expect(useCase.execute(BASE_JOB, { isFinalAttempt: false })).rejects.toThrow('clone failed');
    expect(deps.notifier?.notifyFixFailed).not.toHaveBeenCalled();
  });

  it('clones from and pushes to the fork for fork PRs', async () => {
    const deps = failingCloneDeps();
    const useCase = new ProcessFixUseCase(deps);
    const forkJob = { ...BASE_JOB, headCloneUrl: 'https://github.com/contributor/myrepo.git' };

    await expect(useCase.execute(forkJob)).rejects.toThrow('clone failed');
    expect(deps.gitService.clone).toHaveBeenCalledWith(
      'https://github.com/contributor/myrepo.git',
      BASE_JOB.headRef,
      join(workspaceRoot, 'repo'),
      { username: 'x-access-token', token: 'test-gh-token' },
    );
  });

  it('ignores AI fixes for files outside the requested scope', async () => {
    const repoPath = join(workspaceRoot, 'repo');
    mkdirSync(join(repoPath, 'src'), { recursive: true });
    writeFileSync(join(repoPath, 'src', 'auth.ts'), 'original content\n');

    const deps = makeDeps({
      workspaceManager: {
        createWorkspace: vi.fn().mockResolvedValue(workspaceRoot),
        cleanupWorkspace: vi.fn().mockResolvedValue(undefined),
        validatePath: vi.fn().mockReturnValue(true),
      },
      githubClient: {
        postReview: vi.fn(),
        getPullRequest: vi.fn(),
        listOutstandingBotComments: vi.fn().mockResolvedValue([
          { filePath: 'src/auth.ts', lineNumber: 1, message: 'Missing validation' },
        ]),
        postIssueComment: vi.fn().mockResolvedValue(undefined),
      },
      aiProvider: {
        review: vi.fn(),
        fix: vi.fn().mockResolvedValue({
          fixes: [
            { filePath: 'src/auth.ts', content: 'fixed content\n' },
            { filePath: '../../etc/passwd', content: 'malicious\n' },
            { filePath: 'src/unrelated.ts', content: 'unrelated fix\n' },
          ],
        }),
      },
    });

    const useCase = new ProcessFixUseCase(deps);
    await useCase.execute(BASE_JOB);

    expect(deps.gitService.commitAll).toHaveBeenCalledWith(
      join(workspaceRoot, 'repo'),
      expect.stringContaining('1 file'),
    );

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('dedupes duplicate fix entries for the same file instead of double-counting', async () => {
    const repoPath = join(workspaceRoot, 'repo');
    mkdirSync(join(repoPath, 'src'), { recursive: true });
    writeFileSync(join(repoPath, 'src', 'auth.ts'), 'original content\n');

    const deps = makeDeps({
      workspaceManager: {
        createWorkspace: vi.fn().mockResolvedValue(workspaceRoot),
        cleanupWorkspace: vi.fn().mockResolvedValue(undefined),
        validatePath: vi.fn().mockReturnValue(true),
      },
      githubClient: {
        postReview: vi.fn(),
        getPullRequest: vi.fn(),
        listOutstandingBotComments: vi.fn().mockResolvedValue([
          { filePath: 'src/auth.ts', lineNumber: 1, message: 'Missing validation' },
        ]),
        postIssueComment: vi.fn().mockResolvedValue(undefined),
      },
      aiProvider: {
        review: vi.fn(),
        fix: vi.fn().mockResolvedValue({
          fixes: [
            { filePath: 'src/auth.ts', content: 'fixed content v1\n' },
            { filePath: 'src/auth.ts', content: 'fixed content v2\n' },
          ],
        }),
      },
    });

    const useCase = new ProcessFixUseCase(deps);
    await useCase.execute(BASE_JOB);

    expect(deps.gitService.commitAll).toHaveBeenCalledWith(
      join(workspaceRoot, 'repo'),
      expect.stringContaining('1 file'),
    );
    expect(deps.gitService.commitAll).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('2 files'),
    );

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('skips commit/push when nothing was actually fixed', async () => {
    const deps = makeDeps({
      githubClient: {
        postReview: vi.fn(),
        getPullRequest: vi.fn(),
        listOutstandingBotComments: vi.fn().mockResolvedValue([
          { filePath: 'src/missing.ts', lineNumber: 1, message: 'issue' },
        ]),
        postIssueComment: vi.fn().mockResolvedValue(undefined),
      },
    });

    const useCase = new ProcessFixUseCase(deps);
    await useCase.execute(BASE_JOB);

    expect(deps.gitService.commitAll).not.toHaveBeenCalled();
    expect(deps.gitService.push).not.toHaveBeenCalled();
    expect(deps.githubClient.postIssueComment).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'myorg', repo: 'myrepo', pullNumber: 42 }),
    );
  });
});
