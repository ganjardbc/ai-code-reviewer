import { Octokit } from '@octokit/rest';
import type {
  IGithubClient,
  PostReviewOptions,
  PullRequestInfo,
  OutstandingComment,
  PostFixReplyOptions,
} from '../../domain/interfaces/vcs-client.interface.js';
import { config } from '../../config/index.js';
import { logger } from '../logging/logger.js';
import { withBotMarker, hasBotMarker } from './bot-marker.js';

const REVIEW_THREADS_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            isResolved
            comments(first: 100) {
              nodes { body path line author { login } }
            }
          }
        }
      }
    }
  }
`;

interface ReviewThreadComment {
  body: string;
  path: string;
  line: number | null;
  author: { login: string } | null;
}

interface ReviewThreadsResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{ isResolved: boolean; comments: { nodes: ReviewThreadComment[] } }>;
      };
    };
  };
}

export class GithubService implements IGithubClient {
  private readonly octokit: Octokit;
  private botLoginPromise: Promise<string> | undefined;

  constructor() {
    this.octokit = new Octokit({ auth: config.GITHUB_ACCESS_TOKEN });
  }

  private async getBotLogin(): Promise<string> {
    if (!this.botLoginPromise) {
      this.botLoginPromise = this.octokit.users.getAuthenticated().then((res) => res.data.login);
    }
    return this.botLoginPromise;
  }

  async postReview(options: PostReviewOptions): Promise<void> {
    const { owner, repo, pullNumber, commitSha, comments } = options;

    if (comments.length === 0) {
      logger.info('No comments to post for GitHub PR', undefined, { owner, repo, pullNumber });
      return;
    }

    const reviewComments = comments.map((c) => ({
      path: c.filePath,
      line: c.lineNumber,
      side: 'RIGHT' as const,
      body: withBotMarker(`**[${c.severity}]** ${c.message}`),
    }));

    try {
      await this.octokit.pulls.createReview({
        owner,
        repo,
        pull_number: pullNumber,
        commit_id: commitSha,
        event: 'COMMENT',
        comments: reviewComments,
      });

      logger.info('Posted GitHub PR review', undefined, {
        owner,
        repo,
        pullNumber,
        commentCount: comments.length,
      });
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('Batch GitHub review failed, falling back to per-comment posting', undefined, {
        owner,
        repo,
        pullNumber,
        reason: msg,
      });
    }

    // GitHub rejects the entire batch review if even one comment's line
    // isn't part of the diff (a common AI hallucination). Fall back to
    // posting comments one at a time so a single bad line doesn't drop
    // every valid comment, mirroring the GitLab per-comment strategy.
    let posted = 0;
    const failures: string[] = [];
    for (const c of comments) {
      try {
        await this.octokit.pulls.createReview({
          owner,
          repo,
          pull_number: pullNumber,
          commit_id: commitSha,
          event: 'COMMENT',
          comments: [{ path: c.filePath, line: c.lineNumber, side: 'RIGHT', body: withBotMarker(`**[${c.severity}]** ${c.message}`) }],
        });
        posted++;
      } catch {
        try {
          await this.octokit.issues.createComment({
            owner,
            repo,
            issue_number: pullNumber,
            body: withBotMarker(`**[${c.severity}]** \`${c.filePath}:${c.lineNumber}\` ${c.message}`),
          });
          posted++;
        } catch (err2) {
          const msg2 = err2 instanceof Error ? err2.message : String(err2);
          failures.push(`${c.filePath}:${c.lineNumber} — ${msg2}`);
          logger.error('Failed to post GitHub comment', err2 instanceof Error ? err2 : new Error(msg2), {
            owner,
            repo,
            pullNumber,
            filePath: c.filePath,
            lineNumber: c.lineNumber,
          });
        }
      }
    }

    logger.info('Posted GitHub PR review comments', undefined, {
      owner,
      repo,
      pullNumber,
      posted,
      failed: failures.length,
    });

    if (posted === 0) {
      throw new Error(`Failed to post any GitHub review comments: ${failures.join('; ')}`);
    }
  }

  async getPullRequest(owner: string, repo: string, pullNumber: number): Promise<PullRequestInfo> {
    const { data } = await this.octokit.pulls.get({ owner, repo, pull_number: pullNumber });
    const headCloneUrl = data.head.repo?.clone_url;
    return {
      headRef: data.head.ref,
      baseRef: data.base.ref,
      headSha: data.head.sha,
      cloneUrl: data.base.repo.clone_url,
      headCloneUrl: headCloneUrl && headCloneUrl !== data.base.repo.clone_url ? headCloneUrl : undefined,
      state: data.state,
    };
  }

  async listOutstandingBotComments(owner: string, repo: string, pullNumber: number): Promise<OutstandingComment[]> {
    const botLogin = await this.getBotLogin();
    const outstanding: OutstandingComment[] = [];
    let cursor: string | null = null;

    do {
      const response: ReviewThreadsResponse = await this.octokit.graphql(REVIEW_THREADS_QUERY, {
        owner,
        repo,
        number: pullNumber,
        cursor,
      });

      const threads = response.repository.pullRequest.reviewThreads;

      for (const thread of threads.nodes) {
        if (thread.isResolved) continue;

        for (const comment of thread.comments.nodes) {
          // Marker string alone is forgeable by any commenter — the author
          // must also be the bot's own account, or a forged comment could
          // steer /fix into writing attacker-controlled content.
          if (comment.author?.login !== botLogin) continue;
          if (!hasBotMarker(comment.body)) continue;

          // A null `line` means the comment's diff position is outdated (the
          // file changed since it was posted) — skip it rather than fixing
          // the wrong line, mirroring the old REST-based `line != null` filter.
          if (!comment.path || comment.line == null) continue;

          outstanding.push({ filePath: comment.path, lineNumber: comment.line, message: comment.body });
        }
      }

      cursor = threads.pageInfo.hasNextPage ? threads.pageInfo.endCursor : null;
    } while (cursor);

    return outstanding;
  }

  async postIssueComment(options: PostFixReplyOptions): Promise<void> {
    const { owner, repo, pullNumber, body } = options;
    await this.octokit.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body,
    });
  }

  async hasWriteAccess(owner: string, repo: string, username: string): Promise<boolean> {
    try {
      const { data } = await this.octokit.repos.getCollaboratorPermissionLevel({ owner, repo, username });
      return data.permission === 'admin' || data.permission === 'write';
    } catch (err) {
      // 404 = not a collaborator at all; anything else is a real failure.
      if ((err as { status?: number }).status === 404) return false;
      throw err;
    }
  }
}

export const githubService = new GithubService();
