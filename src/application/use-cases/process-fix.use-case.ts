import { readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { IGitService, IWorkspaceManager } from '../../domain/interfaces/git.interface.js';
import type { IAiProvider } from '../../domain/interfaces/ai-provider.interface.js';
import type { IFixPromptBuilder, FixFileInput } from '../services/prompt.service.js';
import type { IGithubClient, IGitlabClient, OutstandingComment } from '../../domain/interfaces/vcs-client.interface.js';
import type { JobContext, JobPayload } from '../../domain/interfaces/queue.interface.js';
import type { INotifier } from '../../domain/interfaces/notifier.interface.js';
import { isPermanentError } from '../../domain/errors/app-errors.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { buildPrUrl, gitAuthFor, repoLabel } from './job-info.util.js';

export interface ProcessFixDeps {
  gitService: IGitService;
  workspaceManager: IWorkspaceManager;
  aiProvider: IAiProvider;
  fixPromptBuilder: IFixPromptBuilder;
  githubClient: IGithubClient;
  gitlabClient: IGitlabClient;
  notifier?: INotifier;
}

function ms(start: bigint): number {
  return Math.round(Number(process.hrtime.bigint() - start) / 1e6);
}

async function resolveWithinRepo(repoPath: string, filePath: string): Promise<string | undefined> {
  const root = resolve(repoPath);
  const abs = resolve(join(root, filePath));
  if (!abs.startsWith(root + '/')) return undefined;

  // Lexical containment isn't enough: a symlink inside the repo can point
  // outside the workspace. Resolve the real path and re-check containment
  // so reads/writes can't escape via a malicious symlink in the PR branch.
  // The workspace root itself may also sit behind a symlink (e.g. macOS
  // /tmp -> /private/tmp), so resolve it the same way before comparing.
  let real: string;
  let realRoot: string;
  try {
    [real, realRoot] = await Promise.all([realpath(abs), realpath(root)]);
  } catch {
    return undefined;
  }
  return real === realRoot || real.startsWith(realRoot + '/') ? real : undefined;
}

export class ProcessFixUseCase {
  constructor(private readonly deps: ProcessFixDeps) {}

  async execute(job: JobPayload, ctx: JobContext = { isFinalAttempt: true }): Promise<void> {
    const { gitService, workspaceManager, aiProvider, fixPromptBuilder, githubClient, gitlabClient, notifier } = this.deps;

    const jobStart = process.hrtime.bigint();
    const workspacePath = await workspaceManager.createWorkspace();
    const repoPath = `${workspacePath}/repo`;

    logger.info('Fix job started', undefined, {
      jobId: job.jobId,
      provider: job.provider,
      headRef: job.headRef,
    });

    try {
      const outstanding = await this.fetchOutstandingComments(job, githubClient, gitlabClient);

      if (outstanding.length === 0) {
        logger.info('No outstanding AI comments to fix', undefined, { jobId: job.jobId });
        await this.postNoFixNeeded(job, githubClient, gitlabClient, 'No outstanding review comments to fix.');
        await this.notifyNoFixApplied(job, jobStart, notifier);
        return;
      }

      // Fixes are pushed to the head branch, which lives in the fork for
      // fork PRs/MRs (needs "allow edits from maintainers" on the platform).
      const headRepoUrl = job.headCloneUrl ?? job.cloneUrl;
      const auth = gitAuthFor(job);
      await gitService.clone(headRepoUrl, job.headRef, repoPath, auth);

      const fixInputs = await this.readAffectedFiles(repoPath, outstanding);
      if (fixInputs.length === 0) {
        logger.info('No fixable files found in workspace', undefined, { jobId: job.jobId });
        await this.postNoFixNeeded(job, githubClient, gitlabClient, 'Outstanding comments reference files not found in the workspace; nothing to fix.');
        await this.notifyNoFixApplied(job, jobStart, notifier);
        return;
      }

      const prompt = fixPromptBuilder.buildFix(fixInputs);

      const aiStart = process.hrtime.bigint();
      const fixResult = await aiProvider.fix(prompt);
      logger.info('AI fix done', undefined, {
        jobId: job.jobId,
        fixCount: fixResult.fixes.length,
        durationMs: ms(aiStart),
      });

      const allowedPaths = new Set(fixInputs.map((f) => f.filePath));
      const appliedPaths = new Set<string>();
      const toWrite: Array<{ abs: string; content: string }> = [];
      for (const f of fixResult.fixes) {
        if (appliedPaths.has(f.filePath)) {
          logger.warn('Ignoring duplicate fix for the same file', undefined, { filePath: f.filePath });
          continue;
        }
        if (!allowedPaths.has(f.filePath)) {
          logger.warn('Ignoring fix for file outside requested scope', undefined, { filePath: f.filePath });
          continue;
        }
        const abs = await resolveWithinRepo(repoPath, f.filePath);
        if (!abs) {
          logger.warn('Ignoring fix with unsafe path', undefined, { filePath: f.filePath });
          continue;
        }
        appliedPaths.add(f.filePath);
        toWrite.push({ abs, content: f.content });
      }
      await Promise.all(toWrite.map((w) => writeFile(w.abs, w.content, 'utf-8')));
      const applied = appliedPaths.size;

      if (applied === 0) {
        logger.info('No fixes applied', undefined, { jobId: job.jobId });
        await this.postNoFixNeeded(job, githubClient, gitlabClient, 'AI could not produce a safe fix for the outstanding comments.');
        await this.notifyNoFixApplied(job, jobStart, notifier);
        return;
      }

      const committed = await gitService.commitAll(
        repoPath,
        `fix: apply AI review fixes (${applied} file${applied > 1 ? 's' : ''})`,
      );
      if (!committed) {
        logger.info('Nothing to commit after applying fixes', undefined, { jobId: job.jobId });
        await this.postNoFixNeeded(job, githubClient, gitlabClient, 'AI fixes matched the current file content; nothing to commit.');
        await this.notifyNoFixApplied(job, jobStart, notifier);
        return;
      }

      await gitService.push(repoPath, headRepoUrl, job.headRef, auth);

      // The fix is already committed and pushed at this point — a failure
      // in the summary comment or notification must not be allowed to
      // rethrow and trigger a job retry, since a retry would find nothing
      // left to commit and report the misleading "nothing to commit" outcome
      // even though the fix already succeeded.
      const totalMs = ms(jobStart);
      try {
        await this.postSummary(job, applied, githubClient, gitlabClient);
        await notifier?.notifyFixComplete({
          jobId: job.jobId,
          provider: job.provider,
          repoLabel: repoLabel(job),
          prNumber: (job.prNumber ?? job.mrIid)!,
          filesFixed: applied,
          durationMs: totalMs,
          prUrl: buildPrUrl(job),
        });
      } catch (postErr) {
        logger.warn('Fix pushed successfully but post-push summary/notification failed', undefined, {
          jobId: job.jobId,
          reason: postErr instanceof Error ? postErr.message : String(postErr),
        });
      }

      logger.info('Fix job completed', undefined, { jobId: job.jobId, totalDurationMs: totalMs });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error('Fix job failed', err instanceof Error ? err : new Error(String(err)), {
        jobId: job.jobId,
        totalDurationMs: ms(jobStart),
      });
      // Stay quiet on attempts BullMQ will retry, or one flaky failure
      // would produce a "failed" notification per attempt.
      if (ctx.isFinalAttempt || isPermanentError(err)) {
        await notifier?.notifyFixFailed({
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

  private async fetchOutstandingComments(
    job: JobPayload,
    githubClient: IGithubClient,
    gitlabClient: IGitlabClient,
  ): Promise<OutstandingComment[]> {
    if (job.provider === 'github') {
      if (!job.repoOwner || !job.repoName || !job.prNumber) {
        throw new Error('Missing GitHub metadata: repoOwner, repoName, prNumber required');
      }
      return githubClient.listOutstandingBotComments(job.repoOwner, job.repoName, job.prNumber);
    }

    if (!job.projectId || !job.mrIid) {
      throw new Error('Missing GitLab metadata: projectId, mrIid required');
    }
    return gitlabClient.listOutstandingBotComments(job.projectId, job.mrIid);
  }

  private async readAffectedFiles(repoPath: string, outstanding: OutstandingComment[]): Promise<FixFileInput[]> {
    const byFile = new Map<string, OutstandingComment[]>();
    for (const c of outstanding) {
      const arr = byFile.get(c.filePath) ?? [];
      arr.push(c);
      byFile.set(c.filePath, arr);
    }

    const results = await Promise.all(
      Array.from(byFile.entries()).map(async ([filePath, issues]): Promise<FixFileInput | undefined> => {
        const abs = await resolveWithinRepo(repoPath, filePath);
        if (!abs) {
          logger.warn('Skipping fix for path outside repo', undefined, { filePath });
          return undefined;
        }

        try {
          const content = await readFile(abs, 'utf-8');
          return { filePath, content, issues: issues.map((i) => ({ lineNumber: i.lineNumber, message: i.message })) };
        } catch {
          logger.warn('Skipping fix: file not found in workspace', undefined, { filePath });
          return undefined;
        }
      }),
    );

    return results.filter((r): r is FixFileInput => r !== undefined);
  }

  private async postNoFixNeeded(
    job: JobPayload,
    githubClient: IGithubClient,
    gitlabClient: IGitlabClient,
    reason: string,
  ): Promise<void> {
    const body = `ℹ️ /fix: ${reason}`;

    if (job.provider === 'github' && job.repoOwner && job.repoName && job.prNumber) {
      await githubClient.postIssueComment({ owner: job.repoOwner, repo: job.repoName, pullNumber: job.prNumber, body });
    } else if (job.provider === 'gitlab' && job.projectId && job.mrIid) {
      await gitlabClient.postMrNote({ projectId: job.projectId, mrIid: job.mrIid, body });
    }
  }

  private async notifyNoFixApplied(job: JobPayload, jobStart: bigint, notifier?: INotifier): Promise<void> {
    await notifier?.notifyFixComplete({
      jobId: job.jobId,
      provider: job.provider,
      repoLabel: repoLabel(job),
      prNumber: (job.prNumber ?? job.mrIid)!,
      filesFixed: 0,
      durationMs: ms(jobStart),
      prUrl: buildPrUrl(job),
    });
  }

  private async postSummary(
    job: JobPayload,
    applied: number,
    githubClient: IGithubClient,
    gitlabClient: IGitlabClient,
  ): Promise<void> {
    const body = `✅ Applied AI fixes to ${applied} file(s) and pushed to \`${job.headRef}\`.`;

    if (job.provider === 'github' && job.repoOwner && job.repoName && job.prNumber) {
      await githubClient.postIssueComment({ owner: job.repoOwner, repo: job.repoName, pullNumber: job.prNumber, body });
    } else if (job.provider === 'gitlab' && job.projectId && job.mrIid) {
      await gitlabClient.postMrNote({ projectId: job.projectId, mrIid: job.mrIid, body });
    }
  }
}
