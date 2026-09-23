import type { FastifyInstance } from 'fastify';
import { config } from '../../../config/index.js';
import {
  verifyGithubSignature,
  verifyGitlabToken,
  isSafeBranchName,
} from '../../../infrastructure/vcs/security.js';
import {
  githubWebhookSchema,
  githubIssueCommentSchema,
  gitlabWebhookSchema,
  gitlabNoteHookSchema,
} from '../../dto/webhook.dto.js';
import { logger } from '../../../infrastructure/logging/logger.js';
import { reviewQueue } from '../../../infrastructure/queue/client.js';
import { githubService } from '../../../infrastructure/vcs/github.service.js';
import { gitlabService } from '../../../infrastructure/vcs/gitlab.service.js';
import type { JobPayload } from '../../../domain/interfaces/queue.interface.js';
import type { PullRequestInfo } from '../../../domain/interfaces/vcs-client.interface.js';

const GITHUB_PR_ACTIONS = new Set(['opened', 'reopened', 'synchronize']);
const GITLAB_MR_ACTIONS = new Set(['open', 'reopen', 'update']);
const REVIEW_COMMAND = /^\s*\/review\b/i;
const FIX_COMMAND = /^\s*\/fix\b/i;

/**
 * Deterministic BullMQ job id: a webhook redelivery, or an MR `update` event
 * that didn't change the head commit, maps to the same id and BullMQ skips
 * the duplicate add. BullMQ rejects ':' in custom ids, so sanitize parts.
 */
function dedupJobId(...parts: Array<string | number>): string {
  return parts.map((p) => String(p).replace(/[^A-Za-z0-9._-]/g, '_')).join('-');
}

/** Returns the head repo URL only when it differs from the base (i.e. a fork). */
function forkUrl(headUrl: string | null | undefined, baseUrl: string): string | undefined {
  return headUrl && headUrl !== baseUrl ? headUrl : undefined;
}

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post('/github', async (request, reply) => {
    if (!verifyGithubSignature(request.rawBody, request.headers['x-hub-signature-256'] as string | undefined, config.GITHUB_WEBHOOK_SECRET)) {
      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Invalid webhook token or signature mismatch.',
      });
    }

    const event = request.headers['x-github-event'] as string | undefined;

    if (event === 'issue_comment') {
      const parsed = githubIssueCommentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: parsed.error.issues[0]?.message ?? 'Invalid payload',
        });
      }

      const payload = parsed.data;

      if (payload.action !== 'created') {
        return reply.status(200).send({ status: 'ignored', reason: 'Not a new comment' });
      }

      if (!payload.issue.pull_request) {
        return reply.status(200).send({ status: 'ignored', reason: 'Comment on issue, not PR' });
      }

      const isFixCommand = FIX_COMMAND.test(payload.comment.body);
      const isReviewCommand = !isFixCommand && REVIEW_COMMAND.test(payload.comment.body);

      if (!isFixCommand && !isReviewCommand) {
        return reply.status(200).send({ status: 'ignored', reason: 'No /review or /fix command found' });
      }

      const jobType: 'review' | 'fix' = isFixCommand ? 'fix' : 'review';

      if (jobType === 'review' && !config.ENABLE_REVIEW_BY_COMMENT) {
        return reply.status(200).send({ status: 'disabled', reason: 'Review by comment is disabled' });
      }
      if (jobType === 'fix' && !config.ENABLE_FIX_BY_COMMENT) {
        return reply.status(200).send({ status: 'disabled', reason: 'Fix by comment is disabled' });
      }

      const owner = payload.repository.owner.login;
      const repo = payload.repository.name;
      const prNumber = payload.issue.number;
      const commenter = payload.comment.user.login;

      // Anyone who can comment (any GitHub user, on a public repo) could
      // otherwise burn AI spend or make the bot push commits to the PR branch.
      let authorized: boolean;
      try {
        authorized = await githubService.hasWriteAccess(owner, repo, commenter);
      } catch (err) {
        logger.error('Failed to check commenter permission', err instanceof Error ? err : new Error(String(err)), { owner, repo, commenter });
        return reply.status(500).send({ statusCode: 500, error: 'Internal Server Error', message: 'Failed to verify commenter permission' });
      }
      if (!authorized) {
        logger.warn('Ignoring command from commenter without write access', undefined, { owner, repo, prNumber, commenter, jobType });
        return reply.status(200).send({ status: 'ignored', reason: 'Commenter lacks write access' });
      }

      let pr: PullRequestInfo;
      try {
        pr = await githubService.getPullRequest(owner, repo, prNumber);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('Failed to fetch PR for comment trigger', err instanceof Error ? err : new Error(msg), { owner, repo, prNumber });
        return reply.status(500).send({ statusCode: 500, error: 'Internal Server Error', message: 'Failed to fetch PR details' });
      }

      if (pr.state !== 'open') {
        return reply.status(200).send({ status: 'ignored', reason: 'Pull request is not open' });
      }

      if (!isSafeBranchName(pr.headRef) || !isSafeBranchName(pr.baseRef)) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Branch name contains invalid characters.',
        });
      }

      const jobId = dedupJobId('github', jobType, 'comment', payload.comment.id);
      const jobData: JobPayload = {
        jobId,
        jobType,
        trigger: 'comment',
        provider: 'github',
        cloneUrl: pr.cloneUrl,
        headCloneUrl: pr.headCloneUrl,
        headRef: pr.headRef,
        baseRef: pr.baseRef,
        headSha: pr.headSha,
        prNumber,
        repoOwner: owner,
        repoName: repo,
      };

      const queuedId = await reviewQueue.addJob(`github-${jobType}`, jobData as unknown as Record<string, unknown>, { jobId });

      logger.info('GitHub PR comment trigger enqueued', undefined, {
        jobId: queuedId,
        jobType,
        repo: `${owner}/${repo}`,
        pr: prNumber,
        head: pr.headRef,
        base: pr.baseRef,
      });

      return reply.status(202).send({ status: 'enqueued', jobId: queuedId });
    }

    if (event && event !== 'pull_request') {
      return reply.status(200).send({
        status: 'ignored',
        reason: `Unsupported event: ${event}`,
      });
    }

    const parsed = githubWebhookSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: parsed.error.issues[0]?.message ?? 'Invalid payload',
      });
    }

    const payload = parsed.data;

    if (!GITHUB_PR_ACTIONS.has(payload.action)) {
      return reply.status(200).send({ status: 'ignored', action: payload.action });
    }

    if (!config.ENABLE_REVIEW_BY_MR_OPEN) {
      return reply.status(200).send({ status: 'disabled', reason: 'Review by merge request is disabled' });
    }

    const headRef = payload.pull_request.head.ref;
    const baseRef = payload.pull_request.base.ref;

    if (!isSafeBranchName(headRef) || !isSafeBranchName(baseRef)) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Branch name contains invalid characters.',
      });
    }

    const jobId = dedupJobId('github', 'review', payload.repository.owner.login, payload.repository.name, payload.number, payload.pull_request.head.sha);
    const jobData: JobPayload = {
      jobId,
      jobType: 'review',
      trigger: 'event',
      provider: 'github',
      cloneUrl: payload.repository.clone_url,
      headCloneUrl: forkUrl(payload.pull_request.head.repo?.clone_url, payload.repository.clone_url),
      headRef,
      baseRef,
      headSha: payload.pull_request.head.sha,
      prNumber: payload.number,
      repoOwner: payload.repository.owner.login,
      repoName: payload.repository.name,
    };

    const queuedId = await reviewQueue.addJob('github-review', jobData as unknown as Record<string, unknown>, { jobId });

    logger.info('GitHub PR webhook enqueued', undefined, {
      jobId: queuedId,
      repo: `${payload.repository.owner.login}/${payload.repository.name}`,
      pr: payload.number,
      head: headRef,
      base: baseRef,
    });

    return reply.status(202).send({ status: 'enqueued', jobId: queuedId });
  });

  app.post('/gitlab', async (request, reply) => {
    if (!verifyGitlabToken(request.headers['x-gitlab-token'] as string | undefined, config.GITLAB_WEBHOOK_SECRET)) {
      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Invalid webhook token or signature mismatch.',
      });
    }

    const event = request.headers['x-gitlab-event'] as string | undefined;

    if (event === 'Note Hook') {
      const parsed = gitlabNoteHookSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: parsed.error.issues[0]?.message ?? 'Invalid payload',
        });
      }

      const payload = parsed.data;

      if (payload.object_attributes.noteable_type !== 'MergeRequest') {
        return reply.status(200).send({ status: 'ignored', reason: 'Note not on MergeRequest' });
      }

      const isFixCommand = FIX_COMMAND.test(payload.object_attributes.note);
      const isReviewCommand = !isFixCommand && REVIEW_COMMAND.test(payload.object_attributes.note);

      if (!isFixCommand && !isReviewCommand) {
        return reply.status(200).send({ status: 'ignored', reason: 'No /review or /fix command found' });
      }

      const jobType: 'review' | 'fix' = isFixCommand ? 'fix' : 'review';

      const mr = payload.merge_request;
      if (!mr) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Missing merge_request in Note Hook payload',
        });
      }

      if (jobType === 'review' && !config.ENABLE_REVIEW_BY_COMMENT) {
        return reply.status(200).send({ status: 'disabled', reason: 'Review by comment is disabled' });
      }
      if (jobType === 'fix' && !config.ENABLE_FIX_BY_COMMENT) {
        return reply.status(200).send({ status: 'disabled', reason: 'Fix by comment is disabled' });
      }

      if (mr.state !== 'opened') {
        return reply.status(200).send({ status: 'ignored', reason: 'Merge request is not open' });
      }

      // Anyone who can comment on the MR could otherwise burn AI spend or
      // make the bot push commits to the source branch.
      let authorized: boolean;
      try {
        authorized = await gitlabService.hasDeveloperAccess(payload.project.id, payload.user.id);
      } catch (err) {
        logger.error('Failed to check commenter permission', err instanceof Error ? err : new Error(String(err)), { projectId: payload.project.id, userId: payload.user.id });
        return reply.status(500).send({ statusCode: 500, error: 'Internal Server Error', message: 'Failed to verify commenter permission' });
      }
      if (!authorized) {
        logger.warn('Ignoring command from commenter without Developer access', undefined, { projectId: payload.project.id, mrIid: mr.iid, userId: payload.user.id, jobType });
        return reply.status(200).send({ status: 'ignored', reason: 'Commenter lacks Developer access' });
      }

      if (!isSafeBranchName(mr.source_branch) || !isSafeBranchName(mr.target_branch)) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Branch name contains invalid characters.',
        });
      }

      let diffRefs = mr.diff_refs;
      if (!diffRefs) {
        try {
          const mrInfo = await gitlabService.getMergeRequest(payload.project.id, mr.iid);
          diffRefs = { base_sha: mrInfo.baseSha, start_sha: mrInfo.startSha, head_sha: mrInfo.headSha };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn('Failed to fetch MR diff_refs, inline comments unavailable', undefined, { projectId: payload.project.id, mrIid: mr.iid, reason: msg });
        }
      }

      const jobId = dedupJobId('gitlab', jobType, 'comment', payload.object_attributes.id);
      const jobData: JobPayload = {
        jobId,
        jobType,
        trigger: 'comment',
        provider: 'gitlab',
        cloneUrl: mr.target.git_http_url,
        headCloneUrl: forkUrl(mr.source?.git_http_url, mr.target.git_http_url),
        headRef: mr.source_branch,
        baseRef: mr.target_branch,
        headSha: mr.last_commit.id,
        mrIid: mr.iid,
        projectId: payload.project.id,
        baseSha: diffRefs?.base_sha,
        startSha: diffRefs?.start_sha,
      };

      const queuedId = await reviewQueue.addJob(`gitlab-${jobType}`, jobData as unknown as Record<string, unknown>, { jobId });

      logger.info('GitLab MR comment trigger enqueued', undefined, {
        jobId: queuedId,
        jobType,
        projectId: payload.project.id,
        mrIid: mr.iid,
        source: mr.source_branch,
        target: mr.target_branch,
      });

      return reply.status(202).send({ status: 'enqueued', jobId: queuedId });
    }

    if (event && event !== 'Merge Request Hook') {
      return reply.status(200).send({
        status: 'ignored',
        reason: `Unsupported event: ${event}`,
      });
    }

    const parsed = gitlabWebhookSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: parsed.error.issues[0]?.message ?? 'Invalid payload',
      });
    }

    const payload = parsed.data;

    if (!GITLAB_MR_ACTIONS.has(payload.object_attributes.action)) {
      return reply.status(200).send({ status: 'ignored', action: payload.object_attributes.action });
    }

    if (!config.ENABLE_REVIEW_BY_MR_OPEN) {
      return reply.status(200).send({ status: 'disabled', reason: 'Review by merge request is disabled' });
    }

    const sourceBranch = payload.object_attributes.source_branch;
    const targetBranch = payload.object_attributes.target_branch;

    if (!isSafeBranchName(sourceBranch) || !isSafeBranchName(targetBranch)) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Branch name contains invalid characters.',
      });
    }

    const jobId = dedupJobId('gitlab', 'review', payload.project.id, payload.object_attributes.iid, payload.object_attributes.last_commit.id);
    const jobData: JobPayload = {
      jobId,
      jobType: 'review',
      trigger: 'event',
      provider: 'gitlab',
      cloneUrl: payload.object_attributes.target.git_http_url,
      headCloneUrl: forkUrl(payload.object_attributes.source?.git_http_url, payload.object_attributes.target.git_http_url),
      headRef: sourceBranch,
      baseRef: targetBranch,
      headSha: payload.object_attributes.last_commit.id,
      mrIid: payload.object_attributes.iid,
      projectId: payload.project.id,
      baseSha: payload.object_attributes.diff_refs?.base_sha,
      startSha: payload.object_attributes.diff_refs?.start_sha,
    };

    const queuedId = await reviewQueue.addJob('gitlab-review', jobData as unknown as Record<string, unknown>, { jobId });

    logger.info('GitLab MR webhook enqueued', undefined, {
      jobId: queuedId,
      projectId: payload.project.id,
      mrIid: payload.object_attributes.iid,
      source: sourceBranch,
      target: targetBranch,
    });

    return reply.status(202).send({ status: 'enqueued', jobId: queuedId });
  });
}
