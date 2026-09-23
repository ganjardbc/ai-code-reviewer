import type { IGitService, IWorkspaceManager } from '../../domain/interfaces/git.interface.js';
import type { IAiProvider } from '../../domain/interfaces/ai-provider.interface.js';
import type { IPromptBuilder } from '../services/prompt.service.js';
import type { IOutputParser } from '../services/parser.service.js';
import type { IGithubClient, IGitlabClient } from '../../domain/interfaces/vcs-client.interface.js';
import type { JobContext, JobPayload } from '../../domain/interfaces/queue.interface.js';
import type { INotifier } from '../../domain/interfaces/notifier.interface.js';
import { isPermanentError } from '../../domain/errors/app-errors.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { buildPrUrl, gitAuthFor, headFetchRef, repoLabel } from './job-info.util.js';

export interface ProcessReviewDeps {
  gitService: IGitService;
  workspaceManager: IWorkspaceManager;
  aiProvider: IAiProvider;
  promptBuilder: IPromptBuilder;
  outputParser: IOutputParser;
  githubClient: IGithubClient;
  gitlabClient: IGitlabClient;
  notifier?: INotifier;
}

function ms(start: bigint): number {
  return Math.round(Number(process.hrtime.bigint() - start) / 1e6);
}

export class ProcessReviewUseCase {
  constructor(private readonly deps: ProcessReviewDeps) {}

  async execute(job: JobPayload, ctx: JobContext = { isFinalAttempt: true }): Promise<void> {
    const {
      gitService,
      workspaceManager,
      aiProvider,
      promptBuilder,
      githubClient,
      gitlabClient,
      notifier,
    } = this.deps;

    const jobStart = process.hrtime.bigint();

    const current = await this.resolveCurrentHead(job, githubClient, gitlabClient);
    if (current === 'stale') return;
    job = current;

    const workspacePath = await workspaceManager.createWorkspace();
    const repoPath = `${workspacePath}/repo`;

    logger.info('Review job started', undefined, {
      jobId: job.jobId,
      provider: job.provider,
      repo: job.repoName ?? String(job.projectId),
      headRef: job.headRef,
      baseRef: job.baseRef,
    });

    try {
      const cloneStart = process.hrtime.bigint();
      // Clone the base repo and fetch the head via the platform's PR/MR ref:
      // works for fork PRs without needing (or having) access to the fork.
      const auth = gitAuthFor(job);
      await gitService.clone(job.cloneUrl, job.baseRef, repoPath, auth);
      await gitService.fetchRef(repoPath, headFetchRef(job), auth);
      await gitService.checkout(repoPath, job.headSha);
      logger.info('Git clone+checkout done', undefined, { jobId: job.jobId, durationMs: ms(cloneStart) });

      const diffStart = process.hrtime.bigint();
      const diff = await gitService.generateDiff(repoPath, job.baseRef, auth);
      const diffBytes = Buffer.byteLength(diff, 'utf-8');
      logger.info('Diff generated', undefined, { jobId: job.jobId, diffBytes, durationMs: ms(diffStart) });

      if (!diff.trim()) {
        logger.info('Empty diff — skipping review', undefined, { jobId: job.jobId });
        return;
      }

      const prompt = promptBuilder.build(diff);
      const truncated = prompt.includes('[TRUNCATED:');

      const aiStart = process.hrtime.bigint();
      const reviewResult = await aiProvider.review(prompt);
      logger.info('AI review done', undefined, {
        jobId: job.jobId,
        commentCount: reviewResult.comments.length,
        truncated,
        durationMs: ms(aiStart),
      });

      if (reviewResult.comments.length === 0) {
        logger.info('No comments to post', undefined, { jobId: job.jobId });
        await this.postNoIssuesFeedback(job, githubClient, gitlabClient);

        const totalMs = ms(jobStart);
        await notifier?.notifyReviewComplete({
          jobId: job.jobId,
          provider: job.provider,
          repoLabel: repoLabel(job),
          prNumber: (job.prNumber ?? job.mrIid)!,
          commentCount: 0,
          durationMs: totalMs,
          prUrl: buildPrUrl(job),
        });
        return;
      }

      const vcsStart = process.hrtime.bigint();

      if (job.provider === 'github') {
        if (!job.repoOwner || !job.repoName || !job.prNumber) {
          throw new Error('Missing GitHub metadata: repoOwner, repoName, prNumber required');
        }
        await githubClient.postReview({
          owner: job.repoOwner,
          repo: job.repoName,
          pullNumber: job.prNumber,
          commitSha: job.headSha,
          comments: reviewResult.comments,
        });
      } else if (job.provider === 'gitlab') {
        if (!job.projectId || !job.mrIid) {
          throw new Error('Missing GitLab metadata: projectId, mrIid required');
        }
        await gitlabClient.postReview({
          projectId: job.projectId,
          mrIid: job.mrIid,
          baseSha: job.baseSha ?? job.headSha,
          startSha: job.startSha ?? job.headSha,
          headSha: job.headSha,
          comments: reviewResult.comments,
        });
      }

      logger.info('VCS comments posted', undefined, {
        jobId: job.jobId,
        provider: job.provider,
        commentCount: reviewResult.comments.length,
        durationMs: ms(vcsStart),
      });

      const totalMs = ms(jobStart);
      logger.info('Review job completed', undefined, {
        jobId: job.jobId,
        totalDurationMs: totalMs,
      });

      await notifier?.notifyReviewComplete({
        jobId: job.jobId,
        provider: job.provider,
        repoLabel: repoLabel(job),
        prNumber: (job.prNumber ?? job.mrIid)!,
        commentCount: reviewResult.comments.length,
        durationMs: totalMs,
        prUrl: buildPrUrl(job),
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error('Review job failed', err instanceof Error ? err : new Error(String(err)), {
        jobId: job.jobId,
        totalDurationMs: ms(jobStart),
      });
      // Stay quiet on attempts BullMQ will retry, or one flaky failure
      // would produce a "failed" notification per attempt.
      if (ctx.isFinalAttempt || isPermanentError(err)) {
        await notifier?.notifyReviewFailed({
          jobId: job.jobId,
          provider: job.provider,
          repoLabel: repoLabel(job),
          prNumber: (job.prNumber ?? job.mrIid) ?? 0,
          errorMessage,
        });
      }
      throw err;
    } finally {
      await workspaceManager.cleanupWorkspace(workspacePath);
    }
  }

  /**
   * Returns the job to run against the PR/MR's current head, or 'stale' when
   * an event-triggered job has been superseded by a newer push (that push
   * enqueued its own job). Comment-triggered jobs are retargeted to the new
   * head instead, since nothing else will answer the /review request.
   * Lookup failures fall through to the enqueued SHA rather than failing.
   */
  private async resolveCurrentHead(
    job: JobPayload,
    githubClient: IGithubClient,
    gitlabClient: IGitlabClient,
  ): Promise<JobPayload | 'stale'> {
    let latest: { headSha: string; baseSha?: string; startSha?: string };
    try {
      if (job.provider === 'github' && job.repoOwner && job.repoName && job.prNumber) {
        latest = await githubClient.getPullRequest(job.repoOwner, job.repoName, job.prNumber);
      } else if (job.provider === 'gitlab' && job.projectId && job.mrIid) {
        latest = await gitlabClient.getMergeRequest(job.projectId, job.mrIid);
      } else {
        return job;
      }
    } catch (err) {
      logger.warn('Could not verify PR/MR head, reviewing enqueued commit', undefined, {
        jobId: job.jobId,
        reason: err instanceof Error ? err.message : String(err),
      });
      return job;
    }

    if (latest.headSha === job.headSha) return job;

    if (job.trigger !== 'comment') {
      logger.info('Skipping stale review: PR/MR head moved since enqueue', undefined, {
        jobId: job.jobId,
        enqueuedSha: job.headSha,
        currentSha: latest.headSha,
      });
      return 'stale';
    }

    logger.info('Retargeting comment-triggered review to current PR/MR head', undefined, {
      jobId: job.jobId,
      enqueuedSha: job.headSha,
      currentSha: latest.headSha,
    });
    return {
      ...job,
      headSha: latest.headSha,
      baseSha: latest.baseSha ?? job.baseSha,
      startSha: latest.startSha ?? job.startSha,
    };
  }

  private async postNoIssuesFeedback(
    job: JobPayload,
    githubClient: IGithubClient,
    gitlabClient: IGitlabClient,
  ): Promise<void> {
    const body = '✅ AI review found no issues in this change.';

    if (job.provider === 'github' && job.repoOwner && job.repoName && job.prNumber) {
      await githubClient.postIssueComment({ owner: job.repoOwner, repo: job.repoName, pullNumber: job.prNumber, body });
    } else if (job.provider === 'gitlab' && job.projectId && job.mrIid) {
      await gitlabClient.postMrNote({ projectId: job.projectId, mrIid: job.mrIid, body });
    }
  }
}
